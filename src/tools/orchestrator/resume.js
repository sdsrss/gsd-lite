import { ERROR_CODES, phaseReviewSatisfied, read, selectRunnableTask, PROVENANCE_NOTE, ORCHESTRATOR_AUTHORED } from '../state/index.js';
import { getGitHead, getGsdDir } from '../../utils.js';
import { join } from 'node:path';
import { stat, unlink } from 'node:fs/promises';
import {
  MAX_RESUME_DEPTH,
  CONTEXT_RESUME_THRESHOLD,
  evaluatePreflight,
  readContextHealth,
  collectExpiredResearch,
  getCurrentPhase,
  getTaskById,
  getBlockedTasks,
  getReviewTargets,
  safeTaskRefs,
  getDebugTarget,
  persist,
  buildExecutorDispatch,
  tryAutoUnblock,
} from './helpers.js';

// The options resume reports in `recovery_options`. This array is the single
// source for both the advertisement and the accepted values, so the two cannot
// drift apart again — they were never connected before: nothing read the
// options back, which made the advertisement the entire feature.
export const RECOVERY_OPTIONS = ['retry_failed', 'skip_failed', 'replan'];

/**
 * The running task resumeExecutingTask would pick back up, or null.
 *
 * Pulled out so the scheduler and the recovery guard cannot hold different
 * opinions about it. They did, and it cost three revisions.
 */
function findResumableRunningTask(phase, state) {
  const running = state.current_task
    ? getTaskById(phase, state.current_task)
    : (phase?.todo || []).find((t) => t.lifecycle === 'running');
  return running?.lifecycle === 'running' ? running : null;
}

/**
 * Will resume find anything to do in this phase? The single source of truth.
 *
 * resumeExecutingTask asks two questions in order — is a task already running
 * (it re-dispatches that first), and then what does selectRunnableTask say — and
 * applyRecovery's skip_failed guard has to reach the same answer or it refuses a
 * recovery that would have worked. It refused three times, each revision getting
 * a hand-maintained second opinion wrong in a new place: plan-wide instead of
 * per-phase, then a lifecycle filter, then selectRunnableTask alone, which is
 * only the second half of the question and cannot see a `running` sibling at all.
 *
 * Worse than refusing: the failed-mode response kept advertising skip_failed
 * afterwards, so resume offered an option that failed every time — the
 * advertisement-with-no-handler defect this release exists to close, reappearing
 * inside the fix for it.
 *
 * One function, two callers. The remaining duplication is that resume asks the
 * question by doing it while this asks by predicting; removing that is tracked
 * separately.
 */
function phaseHasWork(phase, state) {
  if (!phase) return false;
  if (findResumableRunningTask(phase, state)) return true;
  const selection = selectRunnableTask(phase, state);
  if (!selection || selection.error === true) return false;
  return !!selection.task || !!selection.mode;
}

/**
 * Apply a user's recovery decision to a stuck workflow.
 *
 * Called only when resume's own response offered `recovery_options` — see the
 * gate near the end of resumeWorkflow for why that is the condition rather than
 * a list of workflow modes. Three states offer them today: `failed`, an
 * `awaiting_user` hold carrying a current_review stage, and a phase with a
 * failed task and no runnable work (still `executing_task`). All three were
 * dead ends before this release.
 *
 * - retry_failed: failed tasks return to the queue with a fresh retry budget,
 *   and a phase held for exhausted review retries gets its counter zeroed. A
 *   reset that did not happen would send the task straight back over the limit.
 * - skip_failed: the failures stay on the record and the workflow moves on to
 *   whatever else can still run. Marking them accepted would be a lie, and the
 *   phase cannot be accepted while they sit there — which is correct.
 * - replan: hand the plan back to the planner. state-patch works in `failed`
 *   now so there is something to edit.
 */
async function applyRecovery(state, basePath, recovery) {
  const phases = state.phases || [];
  // R-21: optimistic-lock the read→persist window the way the three result
  // handlers do. This is the widest write in the file — it touches lifecycles
  // across every unaccepted phase from a state read further up — so an external
  // write landing in between should surface as VERSION_CONFLICT, not be
  // clobbered.
  const expectedVersion = state._version;

  if (recovery === 'replan') {
    const persistError = await persist(basePath, {
      workflow_mode: 'planning',
      current_task: null,
      current_review: null,
    }, { expectedVersion });
    if (persistError) return persistError;
    return {
      success: true,
      action: 'recovery_applied',
      recovery,
      workflow_mode: 'planning',
      message: 'Workflow returned to planning. Revise the plan, then resume.',
    };
  }

  const phasePatches = [];
  const retriedTasks = [];
  const skippedTasks = [];

  for (const phase of phases) {
    // An accepted phase is finished history and must not be rewritten. Looping
    // every phase reset the phase_review of phases accepted rounds earlier —
    // turning {status:'accepted', retry_count:3} into {status:'pending',
    // retry_count:0} while lifecycle stayed 'accepted'. That falsifies the review
    // record, and if preflight later rolls current_phase back onto it,
    // selectRunnableTask re-triggers a review on a phase already signed off.
    // A failed task cannot live in an accepted phase anyway — validateState
    // rejects that — so skipping them costs nothing.
    if (phase.lifecycle === 'accepted') continue;

    const patch = { id: phase.id };
    let touched = false;

    if (phase.lifecycle === 'failed') {
      patch.lifecycle = 'active';
      touched = true;
    }

    // A phase parked by review-retry exhaustion carries a counter that is already
    // at the limit. Clearing the hold without clearing the counter just reruns
    // the exhaustion on the next review.
    if (recovery === 'retry_failed' && (phase.phase_review?.retry_count || 0) > 0) {
      patch.phase_review = { ...phase.phase_review, status: 'pending', retry_count: 0 };
      touched = true;
    }

    const failed = (phase.todo || []).filter((t) => t.lifecycle === 'failed');
    if (failed.length > 0) {
      if (recovery === 'retry_failed') {
        patch.todo = failed.map((t) => ({ id: t.id, lifecycle: 'pending', retry_count: 0 }));
        touched = true;
        retriedTasks.push(...failed.map((t) => t.id));
      } else {
        skippedTasks.push(...failed.map((t) => t.id));
      }
    }

    if (touched) phasePatches.push(patch);
  }

  // skip_failed means "leave these failed and get on with the rest". When there
  // is no rest, it achieves nothing — and saying so is the whole point. It used
  // to report success, change not one field, and leave resume re-issuing the
  // same prompt: five calls in a row all returned recovery_applied:'skip_failed'
  // with the task still failed. A phase holding a failed task can never be
  // accepted, so that loop had no exit. Refusing here is the loud failure; the
  // false success was the quiet one.
  if (recovery === 'skip_failed') {
    // Two things this took three tries to get right, so both are written down.
    //
    // It is scoped to the CURRENT phase, not the whole plan. Asking "is there
    // work left anywhere" made the guard inert for every project with more than
    // one phase: a pending task in phase 2 satisfied it while changing nothing
    // about phase 1. The stranding is per-phase — resumeExecutingTask only ever
    // looks at getCurrentPhase(state), and the handoff gate in crud.js counts a
    // `failed` task as not-accepted, so a phase holding one never completes and
    // current_phase never advances past it. Later-phase work is unreachable, not
    // a reason to proceed.
    //
    // And the question is "would resume come back offering skip_failed again",
    // the only loop this guard exists to stop — not "is a task runnable right
    // now", which is stricter and refused things that worked. selectRunnableTask
    // has four answers and three of them are somewhere to go: a task to dispatch,
    // `trigger_review` (the phase review runs on its own), or `awaiting_user`
    // with blockers — a different, loud state whose remedy is unblock_tasks. Only
    // the fourth, no task and no mode, is the no-op. A lifecycle filter written
    // by hand got this wrong in both directions at once: too loose on a task
    // whose dependency is the failed one, too strict on a blocked sibling. Ask
    // the consumer's own function; writing a proxy for it was the original bug
    // here, and rewriting a narrower proxy was the second one.
    const currentPhase = getCurrentPhase(state);
    const selection = currentPhase ? selectRunnableTask(currentPhase, state) : null;
    if (!phaseHasWork(currentPhase, state)) {
      const strandedElsewhere = phases.some((phase) => phase.id !== currentPhase?.id
        && phase.lifecycle !== 'accepted'
        && (phase.todo || []).some((t) => t.lifecycle !== 'accepted' && t.lifecycle !== 'failed'));
      // selectRunnableTask already worked out why each task cannot run. Passing
      // that through turns "cannot proceed" into something the caller can act on
      // without going to read state.json by hand.
      const stuckHere = (selection?.diagnostics || [])
        .map((d) => `${d.id} (${d.reasons.join(', ')})`)
        .join('; ');
      return {
        error: true,
        code: ERROR_CODES.TRANSITION_ERROR,
        // Say which of the three situations this is. "No other work remains" is
        // true in exactly one of them, and saying it in the other two reads as a
        // lie to anyone looking at a pending task in phase 2, or at a task that
        // is only stuck on the dependency that just failed.
        message: `skip_failed cannot proceed: ${skippedTasks.length} task(s) failed in phase ${currentPhase?.id ?? '?'} `
          + (stuckHere
            ? `and nothing else in that phase can run — ${stuckHere}. `
            : strandedElsewhere
              ? 'and nothing else in that phase can run. Later phases still hold work, but the phase cannot be '
                + 'accepted while these sit there, so that work is unreachable from here. '
              : 'and no other work remains, so there is nothing to continue with. ')
          + 'Use retry_failed to requeue them, or replan to change the plan.',
        failed_tasks: skippedTasks,
        recovery_options: RECOVERY_OPTIONS.filter((o) => o !== 'skip_failed'),
      };
    }
  }

  const persistError = await persist(basePath, {
    workflow_mode: 'executing_task',
    current_task: null,
    current_review: null,
    ...(phasePatches.length > 0 ? { phases: phasePatches } : {}),
  }, { expectedVersion });
  if (persistError) return persistError;

  return {
    success: true,
    action: 'recovery_applied',
    recovery,
    workflow_mode: 'executing_task',
    ...(recovery === 'retry_failed' ? { retried_tasks: retriedTasks } : { skipped_tasks: skippedTasks }),
    message: recovery === 'retry_failed'
      ? `Recovery applied: ${retriedTasks.length} task(s) requeued with a fresh retry budget.`
      : `Recovery applied: ${skippedTasks.length} task(s) left failed; continuing with the remaining work.`,
  };
}

/**
 * Build a compact display-ready summary from state and response.
 * Included in every successful resumeWorkflow response to avoid redundant state reads.
 * @param {object} state - The state at the time of the resume call
 * @param {object} [response] - The response object (may contain task_id from dispatched task)
 */
function _buildResumeSummary(state, response) {
  const phase = getCurrentPhase(state);
  const totalTasks = phase?.todo?.length || 0;
  const doneTasks = (phase?.todo || []).filter(t =>
    t.lifecycle === 'accepted' || t.lifecycle === 'checkpointed',
  ).length;

  // Use task_id from response if available (sub-functions persist current_task after state read)
  const taskId = response?.task_id || state.current_task;
  const currentTask = taskId
    ? (phase?.todo || []).find(t => t.id === taskId)
    : null;

  const decisions = state.decisions || [];
  const recentDecisions = decisions.slice(-3).map(d => ({
    id: d.id,
    summary: d.summary,
  }));

  return {
    workflow_mode: state.workflow_mode,
    current_phase: `${state.current_phase || '?'}/${state.total_phases || '?'}`,
    current_task: currentTask
      ? { id: currentTask.id, name: currentTask.name || null }
      : (taskId ? { id: taskId, name: null } : null),
    phase_progress: `${doneTasks}/${totalTasks}`,
    ...(recentDecisions.length > 0 ? { recent_decisions: recentDecisions } : {}),
  };
}

async function resumeAwaitingClear(state, basePath, _depth = 0) {
  const health = await readContextHealth(basePath);
  if (health !== null && health < CONTEXT_RESUME_THRESHOLD) {
    const persistError = await persist(basePath, {
      workflow_mode: 'awaiting_clear',
      context: {
        ...state.context,
        remaining_percentage: health,
      },
    });
    if (persistError) return persistError;

    return {
      success: true,
      action: 'await_manual_intervention',
      workflow_mode: 'awaiting_clear',
      remaining_percentage: health,
      message: 'Context health is still below the resume threshold; run /clear and retry /gsd:resume',
    };
  }

  const updates = { workflow_mode: 'executing_task' };
  if (health !== null) {
    updates.context = {
      ...state.context,
      remaining_percentage: health,
    };
  }
  const persistError = await persist(basePath, updates);
  if (persistError) return persistError;
  return resumeWorkflow({ basePath, _depth: _depth + 1 });
}

async function resumeExecutingTask(state, basePath) {
  const phase = getCurrentPhase(state);
  if (!phase) {
    return { error: true, message: `Current phase ${state.current_phase} not found` };
  }

  if (state.current_review?.stage === 'debugging') {
    const debugTaskId = state.current_review.scope_id || state.current_task;
    const task = getTaskById(phase, debugTaskId);
    if (!task) {
      return { error: true, message: `Debug target task ${debugTaskId} not found in current phase` };
    }
    return {
      success: true,
      action: 'dispatch_debugger',
      workflow_mode: 'executing_task',
      phase_id: phase.id,
      current_review: state.current_review,
      debug_target: getDebugTarget(phase, task, state.current_review),
    };
  }

  // Find the running task — either from current_task or by scanning (orphan
  // recovery). Shared with the skip_failed guard so the two cannot disagree
  // about whether this phase has somewhere to go.
  const runningTask = findResumableRunningTask(phase, state);

  if (runningTask) {
    const isRetrying = (runningTask.retry_count || 0) > 0;
    const persistError = await persist(basePath, {
      workflow_mode: 'executing_task',
      current_task: runningTask.id,
      current_review: null,
    });
    if (persistError) return persistError;
    return buildExecutorDispatch(state, phase, runningTask, {
      resumed: true,
      interruption_recovered: !isRetrying,
      ...(isRetrying ? {
        retry_after_failure: true,
        retry_count: runningTask.retry_count,
        last_failure_summary: runningTask.last_failure_summary,
      } : {}),
    });
  }

  const selection = selectRunnableTask(phase, state);
  if (selection.error) return selection;

  if (selection.task) {
    const task = selection.task;
    // Compound transition: auto-reset to pending for states that require it
    // needs_revalidation/blocked/failed all transition through pending before running
    if (['needs_revalidation', 'blocked', 'failed'].includes(task.lifecycle)) {
      const resetError = await persist(basePath, {
        phases: [{ id: phase.id, todo: [{ id: task.id, lifecycle: 'pending' }] }],
      });
      if (resetError) return resetError;
    }
    const persistError = await persist(basePath, {
      workflow_mode: 'executing_task',
      current_task: task.id,
      current_review: null,
      phases: [{
        id: phase.id,
        todo: [{ id: task.id, lifecycle: 'running' }],
      }],
    });
    if (persistError) return persistError;
    const dispatch = buildExecutorDispatch(state, phase, task);
    // Expose parallel-available tasks so callers can dispatch multiple subagents
    if (selection.parallel_available?.length > 0) {
      dispatch.parallel_available = selection.parallel_available.map(t => ({
        id: t.id,
        name: t.name,
        level: t.level || 'L1',
      }));
    }
    return dispatch;
  }

  if (selection.mode === 'trigger_review') {
    const current_review = { scope: 'phase', scope_id: phase.id };
    const updates = {
      workflow_mode: 'reviewing_phase',
      current_task: null,
      current_review,
    };
    // Auto-advance phase lifecycle to 'reviewing' if currently 'active'
    if (phase.lifecycle === 'active') {
      updates.phases = [{ id: phase.id, lifecycle: 'reviewing' }];
    }
    const persistError = await persist(basePath, updates);
    if (persistError) return persistError;

    return {
      success: true,
      action: 'trigger_review',
      workflow_mode: 'reviewing_phase',
      phase_id: phase.id,
      current_review,
    };
  }

  if (selection.mode === 'awaiting_user') {
    const phaseBlockers = getBlockedTasks(phase);
    const blockers = phaseBlockers.length > 0
      ? phaseBlockers
      : (selection.blockers || []);
    const persistError = await persist(basePath, {
      workflow_mode: 'awaiting_user',
      current_task: null,
      current_review: null,
    });
    if (persistError) return persistError;

    return {
      success: true,
      action: 'awaiting_user',
      workflow_mode: 'awaiting_user',
      phase_id: phase.id,
      blockers,
    };
  }

  // P0-1: Auto phase completion — when all tasks accepted and review passed,
  // signal complete_phase instead of going idle
  // Every task done (or none to do, for an empty milestone), and the phase's
  // review requirement met — the same predicate phaseComplete's handoff gate
  // uses, so this cannot advertise a completion that the next call refuses.
  //
  // The old form asked `allAccepted && reviewPassed` where reviewPassed itself
  // included allAccepted, so the review half could not change the answer: it
  // read as a check and was not one. It landed on the right answer anyway,
  // because selectRunnableTask returns trigger_review above whenever a phase
  // review is still outstanding — a guard that is correct only as long as
  // another function was consulted first, which is the shape of #10. This one
  // asks the question itself.
  const workDone = phase.todo.length === 0 || phase.todo.every(t => t.lifecycle === 'accepted');
  if (workDone && phaseReviewSatisfied(phase)) {
    // Auto-advance phase lifecycle to 'reviewing' if currently 'active'
    // (mirrors trigger_review path at line 480-482)
    if (phase.lifecycle === 'active') {
      const advanceError = await persist(basePath, {
        phases: [{ id: phase.id, lifecycle: 'reviewing' }],
      });
      if (advanceError) return advanceError;
    }
    // Check if this is the last phase — suggest PR creation
    const isLastPhase = phase.id === state.total_phases;
    return {
      success: true,
      action: 'complete_phase',
      workflow_mode: 'executing_task',
      phase_id: phase.id,
      message: 'All tasks accepted and review passed; phase ready for completion',
      ...(isLastPhase ? {
        pr_suggestion: {
          recommended: true,
          message: 'All phases complete. Consider creating a PR with `gh pr create`.',
        },
      } : {}),
    };
  }

  // R-08 (audit M7): a phase left with a permanently-failed task and no runnable
  // work must surface the failure for a recovery decision rather than reporting
  // 'idle' (which reads as "nothing to do" and silently strands the failure).
  const failedTasks = (phase.todo || []).filter(t => t.lifecycle === 'failed');
  if (failedTasks.length > 0) {
    const persistError = await persist(basePath, {
      current_task: null,
      current_review: null,
    });
    if (persistError) return persistError;

    return {
      success: true,
      action: 'await_recovery_decision',
      workflow_mode: 'executing_task',
      phase_id: phase.id,
      failed_tasks: failedTasks.map(t => ({
        id: t.id,
        name: t.name,
        phase_id: phase.id,
        retry_count: t.retry_count || 0,
        last_failure_summary: t.last_failure_summary || null,
        debug_context: t.debug_context || null,
      })),
      recovery_options: RECOVERY_OPTIONS,
      message: `Phase ${phase.id} has ${failedTasks.length} failed task(s) and no runnable work; a recovery decision is required.`,
    };
  }

  const persistError = await persist(basePath, {
    current_task: null,
    current_review: null,
  });
  if (persistError) return persistError;

  return {
    success: true,
    action: 'idle',
    workflow_mode: 'executing_task',
    phase_id: phase.id,
    message: 'No runnable task found in current phase',
  };
}

async function _resumeWorkflow({ basePath = process.cwd(), _depth = 0, unblock_tasks, confirm_review, recovery } = {}) {
  if (_depth >= MAX_RESUME_DEPTH) {
    return { error: true, message: `resumeWorkflow recursive depth limit exceeded (max ${MAX_RESUME_DEPTH})` };
  }

  const state = await read({ basePath });
  if (state.error) {
    return state;
  }

  // Clear session-end marker if present (crash recovery)
  try {
    const gsdDir = await getGsdDir(basePath);
    if (gsdDir) await unlink(join(gsdDir, '.session-end')).catch(() => {});
  } catch {}

  // `unblock_tasks` is declared as an array of task IDs. A non-array used to
  // fail Array.isArray and be dropped with no error at all — the same silent
  // no-op this release fixes for state-read's `fields`.
  if (unblock_tasks !== undefined && unblock_tasks !== null && !Array.isArray(unblock_tasks)) {
    return { error: true, code: ERROR_CODES.INVALID_INPUT, message: `unblock_tasks must be an array of task IDs (got ${typeof unblock_tasks})` };
  }

  // Validate `recovery` here, next to the other parameter check, rather than at
  // the point of use. It used to be validated inside the block that applies it,
  // which sits below the unblock_tasks branch — so `{unblock_tasks: [...],
  // recovery: 'nonsense'}` returned success with the garbage silently ignored,
  // the same silent no-op this release fixes eleven lines above.
  if (recovery !== undefined && recovery !== null && !RECOVERY_OPTIONS.includes(recovery)) {
    return {
      error: true,
      code: ERROR_CODES.INVALID_INPUT,
      message: `recovery must be one of ${RECOVERY_OPTIONS.join(', ')} (got ${JSON.stringify(recovery)})`,
    };
  }

  // Force-unblock specified tasks before normal resume flow
  if (Array.isArray(unblock_tasks) && unblock_tasks.length > 0 && _depth === 0) {
    const phase = getCurrentPhase(state);
    // Defensive: read() validates current_phase against the phase list before we
    // get here, so this is unreachable through the tool surface today. It exists
    // so a future caller cannot reintroduce the silent skip this block removed.
    if (!phase) {
      return { error: true, code: ERROR_CODES.NOT_FOUND, message: `No task was unblocked — current phase ${state.current_phase} not found` };
    }
    const patches = [];
    // Track what could not be unblocked. Silently skipping a typo'd or
    // already-running task id made `/gsd:resume --unblock 9.9` look like it
    // worked — the caller got a plain dispatch result with no hint that its
    // request was a no-op.
    const skipped = [];
    for (const taskId of unblock_tasks) {
      const task = (phase.todo || []).find(t => t.id === taskId);
      if (!task) {
        skipped.push({ id: taskId, reason: `not found in phase ${phase.id}` });
      } else if (task.lifecycle !== 'blocked') {
        skipped.push({ id: taskId, reason: `not blocked (lifecycle: ${task.lifecycle})` });
      } else {
        patches.push({ id: taskId, lifecycle: 'pending', blocked_reason: null, unblock_condition: null });
      }
    }
    if (patches.length === 0 && skipped.length > 0) {
      // Nothing was changed, so failing here is safe and tells the caller why.
      return {
        error: true,
        code: ERROR_CODES.NOT_FOUND,
        message: `No task was unblocked — ${skipped.map(s => `${s.id}: ${s.reason}`).join('; ')}`,
        unblock_skipped: skipped,
      };
    }
    if (patches.length > 0) {
      const persistError = await persist(basePath, {
        workflow_mode: 'executing_task',
        current_task: null,
        current_review: null,
        phases: [{ id: phase.id, todo: patches }],
      });
      if (persistError) return persistError;
      // Re-read state after unblock and continue (recursive call adds its own summary)
      const resumed = await resumeWorkflow({ basePath, _depth: _depth + 1 });
      // The unblock itself persisted; if the resume that follows it failed,
      // return that error unadorned rather than mixing success-shaped keys
      // into an error object.
      if (resumed.error) return resumed;
      return {
        ...resumed,
        unblocked: patches.map(p => p.id),
        ...(skipped.length > 0 ? { unblock_skipped: skipped } : {}),
      };
    }
  }

  // R-03: resolve a pending L3 human-confirmation hold (audit H3). 'confirm'
  // accepts the held task(s); 'reject' sends them back for rework. Mirrors the
  // unblock_tasks force-resolution idiom above.
  if (confirm_review && _depth === 0
      && state.workflow_mode === 'awaiting_user'
      && state.current_review?.stage === 'human_confirmation') {
    const phase = getCurrentPhase(state);
    const pending = state.current_review.pending_tasks
      || (state.current_review.scope_id != null ? [state.current_review.scope_id] : []);
    if (confirm_review === 'confirm') {
      const patches = pending
        .filter((id) => getTaskById(phase, id)?.lifecycle === 'checkpointed')
        .map((id) => ({ id, lifecycle: 'accepted' }));
      const persistError = await persist(basePath, {
        workflow_mode: 'executing_task',
        current_task: null,
        current_review: null,
        phases: phase ? [{ id: phase.id, todo: patches }] : [],
      });
      if (persistError) return persistError;
      return resumeWorkflow({ basePath, _depth: _depth + 1 });
    }
    if (confirm_review === 'reject') {
      const patches = pending
        .filter((id) => {
          const lc = getTaskById(phase, id)?.lifecycle;
          return lc === 'checkpointed' || lc === 'accepted';
        })
        .map((id) => ({
          id,
          lifecycle: 'needs_revalidation',
          retry_count: 0,
          evidence_refs: [],
          last_review_feedback: ['Human reviewer rejected L3 acceptance; rework required'],
        }));
      const persistError = await persist(basePath, {
        workflow_mode: 'executing_task',
        current_task: null,
        current_review: null,
        phases: phase ? [{ id: phase.id, todo: patches }] : [],
      });
      if (persistError) return persistError;
      return resumeWorkflow({ basePath, _depth: _depth + 1 });
    }
  }

  const preflight = await evaluatePreflight(state, basePath);
  let result;

  if (preflight.override) {
    const persistError = await persist(basePath, preflight.override.updates);
    if (persistError) return persistError;

    result = {
      success: true,
      action: preflight.override.action,
      workflow_mode: preflight.override.workflow_mode,
      message: preflight.override.message,
      ...(preflight.override.drift_phase ? { drift_phase: preflight.override.drift_phase } : {}),
      ...(preflight.override.saved_git_head ? { saved_git_head: preflight.override.saved_git_head } : {}),
      ...(preflight.override.current_git_head ? { current_git_head: preflight.override.current_git_head } : {}),
      ...(preflight.override.changed_files ? { changed_files: preflight.override.changed_files } : {}),
      ...(preflight.override.expired_research ? { expired_research: preflight.override.expired_research } : {}),
      ...(preflight.override.dirty_phase ? { dirty_phase: preflight.override.dirty_phase } : {}),
      ...(preflight.hints && preflight.hints.length > 1 ? { pending_issues: preflight.hints.slice(1) } : {}),
    };
  } else {
    switch (state.workflow_mode) {
      case 'executing_task':
        result = await resumeExecutingTask(state, basePath);
        break;
      case 'awaiting_clear':
        result = await resumeAwaitingClear(state, basePath, _depth);
        break;
      case 'awaiting_user': {
        if (state.current_review?.stage === 'human_confirmation') {
          // R-03: L3 task held for explicit human sign-off. Surface the security
          // implications; the user resolves via resume confirm_review: confirm|reject.
          result = {
            success: true,
            action: 'awaiting_human_confirmation',
            workflow_mode: 'awaiting_user',
            phase_id: state.current_phase,
            pending_tasks: state.current_review.pending_tasks || [],
            security_implications: state.current_review.security_implications || [],
            current_review: state.current_review,
            message: 'L3 task(s) passed review but require explicit human confirmation before acceptance',
          };
          break;
        }
        if (state.current_review?.stage === 'direction_drift') {
          const driftPhaseId = state.current_review.scope_id || state.current_phase;
          const driftPhase = state.phases?.find((phase) => phase.id === driftPhaseId) || null;
          result = {
            success: true,
            action: 'awaiting_user',
            workflow_mode: 'awaiting_user',
            phase_id: driftPhaseId,
            drift_phase: driftPhase ? { id: driftPhase.id, name: driftPhase.name } : { id: driftPhaseId, name: null },
            auto_unblocked: [],
            blockers: [],
            current_review: state.current_review,
            message: 'Direction drift detected; user decision is required before execution can continue',
          };
          break;
        }

        // Any other named stage is still a hold. Only two were recognised above,
        // so everything else — `review_retry_exhausted` most importantly — fell
        // into tryAutoUnblock, which finds no blocked task, writes the mode back
        // to executing_task and recurses. The phase goes straight back into the
        // review it just failed for the fifth time, with retry_count still
        // climbing, and "user intervention required" never required anything.
        // Treating the whole class as a hold also means a stage added later
        // cannot be silently cleared by a resume that has not been taught it.
        if (state.current_review?.stage) {
          result = {
            success: true,
            action: 'await_manual_intervention',
            workflow_mode: 'awaiting_user',
            phase_id: state.current_review.scope_id ?? state.current_phase,
            current_review: state.current_review,
            recovery_options: RECOVERY_OPTIONS,
            message: `Workflow is held at review stage '${state.current_review.stage}' and needs a user decision. `
              + `Resolve it by resuming with one of: ${RECOVERY_OPTIONS.join(', ')}.`,
          };
          break;
        }

        const phase = getCurrentPhase(state);
        const autoUnblock = await tryAutoUnblock(state, phase, basePath);
        if (autoUnblock.error) return autoUnblock;

        if (autoUnblock.blockers.length === 0) {
          const persistError = await persist(basePath, {
            workflow_mode: 'executing_task',
            current_task: null,
            current_review: null,
          });
          if (persistError) return persistError;
          // Recursive call adds its own summary
          const resumed = await resumeWorkflow({ basePath, _depth: _depth + 1 });
          if (resumed.error) return resumed;
          return { ...resumed, auto_unblocked: autoUnblock.autoUnblocked };
        }

        result = {
          success: true,
          action: 'awaiting_user',
          workflow_mode: 'awaiting_user',
          phase_id: state.current_phase,
          auto_unblocked: autoUnblock.autoUnblocked,
          blockers: autoUnblock.blockers,
          message: autoUnblock.blockers.length > 0
            ? 'Blocked tasks still require user input'
            : 'No blocked tasks remain',
        };
        break;
      }
      case 'reviewing_phase': {
        const phase = getCurrentPhase(state);
        const current_review = state.current_review || { scope: 'phase', scope_id: state.current_phase };
        const persistError = state.current_review ? null : await persist(basePath, { current_review });
        if (persistError) return persistError;

        result = {
          success: true,
          action: 'dispatch_reviewer',
          workflow_mode: 'reviewing_phase',
          review_scope: 'phase',
          phase_id: phase?.id || state.current_phase,
          current_review,
          review_targets: getReviewTargets(phase, 'phase', current_review.scope_id).map((task) => ({
            id: task.id,
            level: task.level,
            ...safeTaskRefs(task),
          })),
        };
        break;
      }
      case 'reviewing_task': {
        const phase = getCurrentPhase(state);
        const current_review = state.current_review || (state.current_task
          ? { scope: 'task', scope_id: state.current_task, stage: 'spec' }
          : null);
        if (!current_review?.scope_id) {
          return { error: true, message: 'reviewing_task mode requires current_review.scope_id or current_task' };
        }
        const persistError = state.current_review ? null : await persist(basePath, { current_review });
        if (persistError) return persistError;

        const [task] = getReviewTargets(phase, 'task', current_review.scope_id);
        result = {
          success: true,
          action: 'dispatch_reviewer',
          workflow_mode: 'reviewing_task',
          review_scope: 'task',
          phase_id: phase?.id || state.current_phase,
          current_review,
          review_target: task ? {
            id: task.id,
            level: task.level,
            ...safeTaskRefs(task),
          } : null,
        };
        break;
      }
      case 'completed':
        result = {
          success: true,
          action: 'noop',
          workflow_mode: state.workflow_mode,
          completed_phases: (state.phases || []).filter((phase) => phase.lifecycle === 'accepted').length,
          total_phases: state.total_phases,
          message: 'Workflow already completed',
          pr_suggestion: {
            recommended: true,
            message: 'Project complete. Consider creating a PR with `gh pr create` if not already done.',
          },
        };
        break;
      case 'failed': {
        const failedPhases = [];
        const failedTasks = [];
        for (const phase of state.phases || []) {
          if (phase.lifecycle === 'failed') failedPhases.push({ id: phase.id, name: phase.name });
          for (const t of phase.todo || []) {
            if (t.lifecycle === 'failed') {
              failedTasks.push({
                id: t.id,
                name: t.name,
                phase_id: phase.id,
                retry_count: t.retry_count || 0,
                last_failure_summary: t.last_failure_summary || null,
                debug_context: t.debug_context || null,
              });
            }
          }
        }
        result = {
          success: true,
          action: 'await_recovery_decision',
          workflow_mode: state.workflow_mode,
          failed_phases: failedPhases,
          failed_tasks: failedTasks,
          recovery_options: RECOVERY_OPTIONS,
          message: 'Workflow is in failed state. Recovery options available.',
        };
        break;
      }
      case 'paused_by_user':
        result = {
          success: true,
          action: 'await_manual_intervention',
          workflow_mode: state.workflow_mode,
          resume_to: state.current_review?.scope === 'phase'
            ? 'reviewing_phase'
            : state.current_review?.scope === 'task'
              ? 'reviewing_task'
              : 'executing_task',
          current_review: state.current_review || null,
          current_task: state.current_task || null,
          message: 'Project is paused. Confirm to resume execution.',
        };
        break;
      case 'planning':
        result = {
          success: true,
          action: 'await_manual_intervention',
          workflow_mode: state.workflow_mode,
          guidance: 'Plan is being revised. Run /gsd:start or /gsd:prd to continue planning, or state-update workflow_mode back to executing_task when ready.',
          message: 'Project is in planning mode (plan revision). Finish the plan then set workflow_mode back to executing_task.',
        };
        break;
      case 'reconcile_workspace': {
        const reconGitHead = await getGitHead(basePath);
        result = {
          success: true,
          action: 'reconcile_workspace',
          workflow_mode: state.workflow_mode,
          expected_head: state.git_head,
          actual_head: reconGitHead,
          guidance: 'Workspace git HEAD has diverged. Verify changes and update git_head via state-update, then set workflow_mode to executing_task',
          message: `Git HEAD mismatch: saved=${state.git_head}, current=${reconGitHead}`,
        };
        break;
      }
      case 'replan_required':
        result = {
          success: true,
          action: 'replan_required',
          workflow_mode: state.workflow_mode,
          guidance: 'Plan files modified since last session. Review changes, update the plan if needed, then set workflow_mode to executing_task via state-update',
          message: 'Plan artifacts modified since last session; review and re-align before resuming',
        };
        break;
      case 'research_refresh_needed': {
        const expiredResearch = collectExpiredResearch(state);
        result = {
          success: true,
          action: 'dispatch_researcher',
          workflow_mode: state.workflow_mode,
          expired_research: expiredResearch,
          guidance: 'Research cache expired. Dispatch researcher sub-agent to refresh, then call orchestrator-handle-researcher-result',
          message: 'Research has expired and must be refreshed before execution can resume',
        };
        break;
      }
      default:
        return {
          error: true,
          message: `workflow_mode "${state.workflow_mode}" is not yet supported by the orchestrator skeleton`,
        };
    }
  }

  // Attach display-ready summary to all successful responses
  if (result?.success && !result.summary) {
    const summary = _buildResumeSummary(state, result);
    // Use the response's workflow_mode if it differs from state (e.g., preflight override)
    if (result.workflow_mode && result.workflow_mode !== state.workflow_mode) {
      summary.workflow_mode = result.workflow_mode;
    }
    result.summary = summary;
  }

  return result;
}

/**
 * Resume the workflow, applying a recovery decision when one was asked for.
 *
 * The recovery gate lives out here, wrapping every return path, because that is
 * the only way the rule it implements can actually hold: `recovery` is accepted
 * exactly when this resume offered `recovery_options`.
 *
 * One honest limit on the rule. `awaiting_user(human_confirmation) →
 * executing_task → failed` carries the stage into the `failed` branch, which
 * offers recovery_options without consulting it, so recovery IS accepted there
 * and clears current_review. That is a defence-in-depth gap, not an acceptance
 * bypass: the task stays `checkpointed`, and the gate that actually enforces L3
 * sign-off is level-driven in reviewer.js, so the next phase review re-raises
 * it. Preserving the field here was tried and does nothing — resumeExecutingTask
 * clears current_review on every dispatch path anyway, which is also why a
 * plain state-update already clears it on main. The field is a hold marker, not
 * the gate.
 *
 * Inside _resumeWorkflow the rule was true of the paths that reach the bottom of
 * the function and false of the ones that do not. `unblock_tasks`,
 * `confirm_review` and the awaiting_user auto-unblock branch all return early —
 * and the auto-unblock branch can return `await_recovery_decision` WITH
 * `recovery_options` after recursing. So a user answering the prompt the
 * response printed had their answer dropped under a success: the
 * advertisement-with-no-handler bug this release is named for, at a third site,
 * introduced by the fix for the first two. A gate placed anywhere inside a
 * function with early returns is a gate on some of them.
 */
/**
 * `.gsd/.research-commit-pending` is written before the research artifacts are
 * renamed in and removed once the state referencing them has been written. It
 * surviving means a crash landed between the two, so the artifacts on disk and
 * the research recorded in state.json may not agree.
 *
 * storeResearch has maintained that marker since it was added and nothing ever
 * read it — the comment said "on recovery (future iteration)". This is that
 * reader. It reports rather than repairs: which side is right depends on what
 * the interrupted run was doing, and re-running research rewrites both.
 *
 * The marker is deliberately left in place. Clearing it on report would turn a
 * standing condition into a one-shot notice that whoever was not looking at
 * that moment never sees again; re-running research clears it by finishing the
 * write it belongs to.
 */
async function attachResearchWarning(basePath, result) {
  if (!result || result.error) return result;
  try {
    const gsdDir = await getGsdDir(basePath);
    if (!gsdDir) return result;
    const pending = await stat(join(gsdDir, '.research-commit-pending')).then(() => true).catch(() => false);
    if (!pending) return result;
    return {
      ...result,
      warnings: [
        ...(result.warnings || []),
        {
          code: 'RESEARCH_COMMIT_PENDING',
          message: 'A previous research write did not finish (.gsd/.research-commit-pending is still there), '
            + 'so the files in .gsd/research/ and the research recorded in state.json may not agree. '
            + 'Re-run research to rewrite both, or delete that file if you have checked the artifacts yourself.',
        },
      ],
    };
  } catch {
    // Diagnosing a half-written research state must not be what stops a resume.
    return result;
  }
}

/**
 * Which fields of a resume response carry content read from the project.
 *
 * Marking only `executor_context` was not enough, and the gap was not academic:
 * state-sourced strings ride on responses that have no executor_context at all.
 * `summary.recent_decisions[].summary` and `summary.current_task.name` are
 * attached to every successful resume, `last_failure_summary` sits at the top
 * level, and the reviewer/debugger/researcher dispatches carried no marker of
 * any kind — three of the four dispatch paths.
 */
function envelopeAuthored(result) {
  return ORCHESTRATOR_AUTHORED.filter((field) => {
    const [head, tail] = field.split('.');
    return tail ? result[head] && tail in result[head] : head in result;
  });
}

function withProvenance(result) {
  if (!result || result.error) return result;
  // A promise reaching here reads as a response with no state-sourced fields —
  // every lookup is undefined, the list comes back empty, and the note is
  // silently not attached. That is how the first version of this shipped: the
  // call below had lost its `await`. Refuse instead of no-opping.
  if (typeof result.then === 'function') {
    throw new TypeError('withProvenance received a promise — await the response first');
  }
  return {
    ...result,
    input_provenance: { orchestrator_authored: envelopeAuthored(result), note: PROVENANCE_NOTE },
  };
}

export async function resumeWorkflow(args = {}) {
  const result = await _resumeWorkflowWithRecovery(args);
  return withProvenance(await attachResearchWarning(args.basePath ?? process.cwd(), result));
}

async function _resumeWorkflowWithRecovery(args = {}) {
  const { basePath = process.cwd(), _depth = 0, recovery, unblock_tasks, confirm_review } = args;

  // Validate the value before anything runs, so a bad one cannot ride along
  // with unblock_tasks or confirm_review and be dropped as a no-op.
  if (recovery !== undefined && recovery !== null && !RECOVERY_OPTIONS.includes(recovery)) {
    return {
      error: true,
      code: ERROR_CODES.INVALID_INPUT,
      message: `recovery must be one of ${RECOVERY_OPTIONS.join(', ')} (got ${JSON.stringify(recovery)})`,
    };
  }

  // And refuse the contradiction before anything runs, for the same reason one
  // line up. These are three different ways to resolve a hold and only one can be
  // what the caller meant. The check has to sit AHEAD of _resumeWorkflow: both
  // unblock_tasks and confirm_review persist and return early, so the
  // recovery_options check further down used to fire after their write had
  // already landed — the call returned TRANSITION_ERROR with an L3 sign-off
  // committed behind it, which a caller reading the error as "nothing happened"
  // would be wrong about.
  const conflicting = [
    Array.isArray(unblock_tasks) && unblock_tasks.length > 0 ? 'unblock_tasks' : null,
    confirm_review ? 'confirm_review' : null,
  ].filter(Boolean);
  if (recovery && conflicting.length > 0) {
    return {
      error: true,
      code: ERROR_CODES.INVALID_INPUT,
      message: `recovery cannot be combined with ${conflicting.join(' or ')} — each resolves a hold a different way, `
        + 'and running both would commit one before rejecting the other. Send one per call.',
    };
  }

  const result = await _resumeWorkflow(args);
  if (!recovery || _depth !== 0 || result?.error) return result;

  if (!result?.recovery_options) {
    return {
      error: true,
      code: ERROR_CODES.TRANSITION_ERROR,
      message: `recovery is only accepted when resume offers recovery_options; this workflow returned '${result?.action}' (workflow_mode '${result?.workflow_mode}').`
        + (result?.action === 'awaiting_human_confirmation'
          ? ' An L3 human-confirmation hold is resolved with confirm_review: "confirm" or "reject".'
          : ''),
    };
  }

  // Re-read rather than reusing _resumeWorkflow's snapshot: producing the result
  // can itself persist, so that snapshot's _version is already behind and
  // applyRecovery's optimistic lock would reject its own caller's write.
  const current = await read({ basePath });
  if (current.error) return current;
  const applied = await applyRecovery(current, basePath, recovery);
  if (applied.error) return applied;
  const resumed = await _resumeWorkflow({ basePath, _depth: _depth + 1 });
  if (resumed.error) return resumed;
  return { ...resumed, recovery_applied: recovery };
}
