import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  read,
  storeResearch,
  update,
  addEvidence,
  selectRunnableTask,
  buildExecutorContext,
  matchDecisionForBlocker,
  reclassifyReviewLevel,
  propagateInvalidation,
} from './state.js';
import { validateDebuggerResult, validateExecutorResult, validateResearcherResult, validateReviewerResult } from '../schema.js';
import { getGitHead, getGsdDir } from '../utils.js';

const MAX_DEBUG_RETRY = 3;
const CONTEXT_RESUME_THRESHOLD = 40;

function isTerminalWorkflowMode(workflowMode) {
  return workflowMode === 'completed' || workflowMode === 'failed';
}

function parseTimestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readContextHealth(basePath) {
  const gsdDir = getGsdDir(basePath);
  if (!gsdDir) return null;
  try {
    const raw = await readFile(join(gsdDir, '.context-health'), 'utf-8');
    const health = Number.parseInt(raw, 10);
    return Number.isFinite(health) ? health : null;
  } catch {
    return null;
  }
}

function collectExpiredResearch(state) {
  const expired = [];
  const now = Date.now();
  const researchExpiry = parseTimestamp(state.research?.expires_at);
  if (researchExpiry !== null && researchExpiry <= now) {
    expired.push({ id: 'research', expires_at: state.research.expires_at });
  }

  for (const [id, entry] of Object.entries(state.research?.decision_index || {})) {
    const expiresAt = parseTimestamp(entry?.expires_at);
    if (expiresAt !== null && expiresAt <= now) {
      expired.push({
        id,
        summary: entry.summary || null,
        expires_at: entry.expires_at,
      });
    }
  }

  return expired;
}

function getDirectionDriftPhase(state) {
  const currentPhase = state.phases?.find((phase) => phase.id === state.current_phase);
  if (currentPhase?.phase_handoff?.direction_ok === false && currentPhase.lifecycle !== 'accepted') {
    return currentPhase;
  }

  return (state.phases || []).find((phase) => (
    phase?.phase_handoff?.direction_ok === false && phase.lifecycle !== 'accepted'
  )) || null;
}

async function detectPlanDrift(basePath, lastSession) {
  const lastSessionTs = parseTimestamp(lastSession);
  if (lastSessionTs === null) return [];

  const gsdDir = getGsdDir(basePath);
  if (!gsdDir) return [];

  const candidates = [join(gsdDir, 'plan.md')];
  try {
    const phaseFiles = await readdir(join(gsdDir, 'phases'));
    for (const fileName of phaseFiles) {
      if (fileName.endsWith('.md')) {
        candidates.push(join(gsdDir, 'phases', fileName));
      }
    }
  } catch {}

  const changedFiles = [];
  for (const filePath of candidates) {
    try {
      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs > lastSessionTs) {
        changedFiles.push(relative(gsdDir, filePath));
      }
    } catch {}
  }

  return changedFiles.sort();
}

async function evaluatePreflight(state, basePath) {
  if (isTerminalWorkflowMode(state.workflow_mode)) {
    return { override: null };
  }

  const currentGitHead = getGitHead(basePath);
  if (state.git_head && currentGitHead && state.git_head !== currentGitHead) {
    return {
      override: {
        workflow_mode: 'reconcile_workspace',
        action: 'await_manual_intervention',
        updates: { workflow_mode: 'reconcile_workspace' },
        saved_git_head: state.git_head,
        current_git_head: currentGitHead,
        message: 'Saved git_head does not match the current workspace HEAD',
      },
    };
  }

  const changed_files = await detectPlanDrift(basePath, state.context?.last_session);
  if (changed_files.length > 0) {
    return {
      override: {
        workflow_mode: 'replan_required',
        action: 'await_manual_intervention',
        updates: { workflow_mode: 'replan_required' },
        changed_files,
        message: 'Plan artifacts changed after the last recorded session',
      },
    };
  }

  if (state.workflow_mode === 'awaiting_user' && state.current_review?.stage === 'direction_drift') {
    return { override: null };
  }

  const driftPhase = getDirectionDriftPhase(state);
  if (driftPhase) {
    return {
      override: {
        workflow_mode: 'awaiting_user',
        action: 'awaiting_user',
        updates: {
          workflow_mode: 'awaiting_user',
          current_task: null,
          current_review: {
            scope: 'phase',
            scope_id: driftPhase.id,
            stage: 'direction_drift',
            summary: `Direction drift detected for phase ${driftPhase.id}`,
          },
        },
        drift_phase: { id: driftPhase.id, name: driftPhase.name },
        message: `Direction drift detected for phase ${driftPhase.id}; user decision required before resuming`,
      },
    };
  }

  const expired_research = collectExpiredResearch(state);
  if (expired_research.length > 0) {
    return {
      override: {
        workflow_mode: 'research_refresh_needed',
        action: 'dispatch_researcher',
        updates: { workflow_mode: 'research_refresh_needed' },
        expired_research,
        message: 'Research cache expired and must be refreshed before execution resumes',
      },
    };
  }

  return { override: null };
}

function getCurrentPhase(state) {
  return state.phases?.find((phase) => phase.id === state.current_phase)
    || state.phases?.find((phase) => phase.lifecycle === 'active')
    || null;
}

function getTaskById(phase, taskId) {
  return phase?.todo?.find((task) => task.id === taskId) || null;
}

function getBlockedTasks(phase) {
  return (phase?.todo || [])
    .filter((task) => task.lifecycle === 'blocked')
    .map((task) => ({
      id: task.id,
      reason: task.blocked_reason || 'Blocked without reason',
      unblock_condition: task.unblock_condition || null,
    }));
}

function getReviewTargets(phase, reviewScope, scopeId) {
  if (!phase) return [];
  if (reviewScope === 'task') {
    const task = getTaskById(phase, scopeId);
    return task ? [task] : [];
  }
  return (phase.todo || []).filter((task) => task.level !== 'L0' && task.lifecycle === 'checkpointed');
}

function getPhaseAndTask(state, taskId) {
  for (const phase of (state.phases || [])) {
    const task = getTaskById(phase, taskId);
    if (task) return { phase, task };
  }
  return { phase: null, task: null };
}

function getDebugTarget(phase, task, currentReview) {
  if (!phase || !task) return null;
  return {
    id: task.id,
    level: task.level || 'L1',
    retry_count: task.retry_count || 0,
    error_fingerprint: task.last_error_fingerprint || currentReview?.error_fingerprint || null,
    last_failure_summary: task.last_failure_summary || currentReview?.summary || null,
    files_changed: task.files_changed || [],
    checkpoint_commit: task.checkpoint_commit || null,
    debug_context: task.debug_context || null,
  };
}

function buildDecisionEntries(decisions, phaseId, taskId, existingCount = 0) {
  return (decisions || [])
    .map((decision, index) => {
      if (typeof decision === 'string' && decision.length > 0) {
        return {
          id: `decision:${phaseId}:${taskId}:${existingCount + index + 1}`,
          summary: decision,
          phase: phaseId,
          task: taskId,
        };
      }
      if (decision && typeof decision === 'object' && typeof decision.summary === 'string') {
        return {
          id: decision.id || `decision:${phaseId}:${taskId}:${existingCount + index + 1}`,
          phase: decision.phase ?? phaseId,
          task: decision.task ?? taskId,
          ...decision,
        };
      }
      return null;
    })
    .filter(Boolean);
}

function getBlockedReasonFromResult(result) {
  const firstBlocker = (result.blockers || [])[0];
  if (!firstBlocker) return { blocked_reason: result.summary, unblock_condition: null };
  if (typeof firstBlocker === 'string') {
    return { blocked_reason: firstBlocker, unblock_condition: null };
  }
  return {
    blocked_reason: firstBlocker.reason || result.summary,
    unblock_condition: firstBlocker.unblock_condition || null,
  };
}

async function persist(basePath, updates) {
  const result = await update({ updates, basePath });
  if (result.error) {
    return result;
  }
  return null;
}

async function resumeAwaitingClear(state, basePath) {
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
  return resumeWorkflow({ basePath });
}

function buildExecutorDispatch(state, phase, task, extras = {}) {
  const context = buildExecutorContext(state, task.id, phase.id);
  if (context.error) return context;
  return {
    success: true,
    action: 'dispatch_executor',
    workflow_mode: 'executing_task',
    phase_id: phase.id,
    task_id: task.id,
    executor_context: context,
    ...extras,
  };
}

async function tryAutoUnblock(state, phase, basePath) {
  const blockedTasks = (phase?.todo || []).filter((task) => task.lifecycle === 'blocked');
  const decisions = state.decisions || [];
  if (blockedTasks.length === 0 || decisions.length === 0) {
    return { autoUnblocked: [], blockers: getBlockedTasks(phase) };
  }

  const patches = [];
  const autoUnblocked = [];

  for (const task of blockedTasks) {
    const matchedDecision = matchDecisionForBlocker(decisions, task.blocked_reason);
    if (!matchedDecision) continue;
    patches.push({
      id: task.id,
      lifecycle: 'pending',
      blocked_reason: null,
      unblock_condition: null,
    });
    autoUnblocked.push({
      task_id: task.id,
      decision_id: matchedDecision.id,
      decision_summary: matchedDecision.summary,
    });
  }

  if (patches.length === 0) {
    return { autoUnblocked: [], blockers: getBlockedTasks(phase) };
  }

  const persistError = await persist(basePath, {
    phases: [{ id: phase.id, todo: patches }],
  });
  if (persistError) return persistError;

  const refreshed = await read({ basePath });
  if (refreshed.error) return refreshed;
  const refreshedPhase = getCurrentPhase(refreshed);
  return {
    autoUnblocked,
    blockers: getBlockedTasks(refreshedPhase),
  };
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

  if (state.current_task) {
    const currentTask = getTaskById(phase, state.current_task);
    if (currentTask?.lifecycle === 'running') {
      const persistError = await persist(basePath, {
        workflow_mode: 'executing_task',
        current_task: currentTask.id,
        current_review: null,
      });
      if (persistError) return persistError;
      return buildExecutorDispatch(state, phase, currentTask, {
        resumed: true,
        interruption_recovered: true,
      });
    }
  }

  const selection = selectRunnableTask(phase, state);
  if (selection.error) return selection;

  if (selection.task) {
    const task = selection.task;
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
    return buildExecutorDispatch(state, phase, task);
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

export async function resumeWorkflow({ basePath = process.cwd() } = {}) {
  const state = await read({ basePath });
  if (state.error) {
    return state;
  }

  const preflight = await evaluatePreflight(state, basePath);
  if (preflight.override) {
    const persistError = await persist(basePath, preflight.override.updates);
    if (persistError) return persistError;

    return {
      success: true,
      action: preflight.override.action,
      workflow_mode: preflight.override.workflow_mode,
      message: preflight.override.message,
      ...(preflight.override.drift_phase ? { drift_phase: preflight.override.drift_phase } : {}),
      ...(preflight.override.saved_git_head ? { saved_git_head: preflight.override.saved_git_head } : {}),
      ...(preflight.override.current_git_head ? { current_git_head: preflight.override.current_git_head } : {}),
      ...(preflight.override.changed_files ? { changed_files: preflight.override.changed_files } : {}),
      ...(preflight.override.expired_research ? { expired_research: preflight.override.expired_research } : {}),
    };
  }

  switch (state.workflow_mode) {
    case 'executing_task':
      return resumeExecutingTask(state, basePath);
    case 'awaiting_clear':
      return resumeAwaitingClear(state, basePath);
    case 'awaiting_user': {
      if (state.current_review?.stage === 'direction_drift') {
        const driftPhaseId = state.current_review.scope_id || state.current_phase;
        const driftPhase = state.phases?.find((phase) => phase.id === driftPhaseId) || null;
        return {
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
      }

      const phase = getCurrentPhase(state);
      const autoUnblock = await tryAutoUnblock(state, phase, basePath);
      if (autoUnblock.error) return autoUnblock;

      if (autoUnblock.autoUnblocked.length > 0 && autoUnblock.blockers.length === 0) {
        const persistError = await persist(basePath, {
          workflow_mode: 'executing_task',
          current_task: null,
          current_review: null,
        });
        if (persistError) return persistError;
        const resumed = await resumeWorkflow({ basePath });
        if (resumed.error) return resumed;
        return { ...resumed, auto_unblocked: autoUnblock.autoUnblocked };
      }

      return {
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
    }
    case 'reviewing_phase': {
      const phase = getCurrentPhase(state);
      const current_review = state.current_review || { scope: 'phase', scope_id: state.current_phase };
      const persistError = state.current_review ? null : await persist(basePath, { current_review });
      if (persistError) return persistError;

      return {
        success: true,
        action: 'dispatch_reviewer',
        workflow_mode: 'reviewing_phase',
        review_scope: 'phase',
        phase_id: phase?.id || state.current_phase,
        current_review,
        review_targets: getReviewTargets(phase, 'phase', current_review.scope_id).map((task) => ({
          id: task.id,
          level: task.level,
          checkpoint_commit: task.checkpoint_commit || null,
        })),
      };
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
      return {
        success: true,
        action: 'dispatch_reviewer',
        workflow_mode: 'reviewing_task',
        review_scope: 'task',
        phase_id: phase?.id || state.current_phase,
        current_review,
        review_target: task ? {
          id: task.id,
          level: task.level,
          checkpoint_commit: task.checkpoint_commit || null,
          files_changed: task.files_changed || [],
        } : null,
      };
    }
    case 'completed':
      return {
        success: true,
        action: 'noop',
        workflow_mode: state.workflow_mode,
        completed_phases: (state.phases || []).filter((phase) => phase.lifecycle === 'accepted').length,
        total_phases: state.total_phases,
        message: 'Workflow already completed',
      };
    case 'failed':
      return {
        success: true,
        action: 'noop',
        workflow_mode: state.workflow_mode,
        failed_phases: (state.phases || []).filter((phase) => phase.lifecycle === 'failed').map((phase) => phase.id),
        failed_tasks: (state.phases || []).flatMap((phase) =>
          (phase.todo || []).filter((task) => task.lifecycle === 'failed').map((task) => task.id)),
        message: 'Workflow is in failed state',
      };
    case 'paused_by_user':
    case 'planning':
    case 'reconcile_workspace':
    case 'replan_required':
    case 'research_refresh_needed':
      return {
        success: true,
        action: 'await_manual_intervention',
        workflow_mode: state.workflow_mode,
        message: `workflow_mode "${state.workflow_mode}" is recognized but not yet automated by the orchestrator`,
      };
    default:
      return {
        error: true,
        message: `workflow_mode "${state.workflow_mode}" is not yet supported by the orchestrator skeleton`,
      };
  }
}

export async function handleExecutorResult({ result, basePath = process.cwd() } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { error: true, message: 'result must be an object' };
  }
  const validation = validateExecutorResult(result);
  if (!validation.valid) {
    return { error: true, message: `Invalid executor result: ${validation.errors.join('; ')}` };
  }

  const state = await read({ basePath });
  if (state.error) return state;
  const { phase, task } = getPhaseAndTask(state, result.task_id);
  if (!phase || !task) {
    return { error: true, message: `Task ${result.task_id} not found` };
  }

  const decisionEntries = buildDecisionEntries(result.decisions, phase.id, task.id, (state.decisions || []).length);
  const decisions = [...(state.decisions || []), ...decisionEntries];

  if (result.outcome === 'checkpointed') {
    const reviewLevel = reclassifyReviewLevel(task, result);
    const isL0 = reviewLevel === 'L0';

    const current_review = !isL0 && reviewLevel === 'L2' && task.review_required !== false
      ? { scope: 'task', scope_id: task.id, stage: 'spec' }
      : null;
    const workflow_mode = current_review ? 'reviewing_task' : 'executing_task';

    // First persist: checkpoint the task (running → checkpointed)
    const persistError = await persist(basePath, {
      workflow_mode,
      current_task: null,
      current_review,
      decisions,
      phases: [{
        id: phase.id,
        todo: [{
          id: task.id,
          lifecycle: 'checkpointed',
          checkpoint_commit: result.checkpoint_commit,
          files_changed: result.files_changed || [],
          evidence_refs: result.evidence || [],
          level: reviewLevel,
          blocked_reason: null,
          unblock_condition: null,
          debug_context: null,
        }],
      }],
    });
    if (persistError) return persistError;

    // Store structured evidence entries
    for (const ev of (result.evidence || [])) {
      if (ev && typeof ev === 'object' && typeof ev.id === 'string' && typeof ev.scope === 'string') {
        await addEvidence({ id: ev.id, data: ev, basePath });
      }
    }

    // L0 auto-accept: promote checkpointed → accepted in a second persist
    if (isL0) {
      const acceptError = await persist(basePath, {
        phases: [{
          id: phase.id,
          done: (phase.done || 0) + 1,
          todo: [{ id: task.id, lifecycle: 'accepted' }],
        }],
      });
      if (acceptError) return acceptError;
    }

    return {
      success: true,
      action: current_review ? 'dispatch_reviewer' : 'continue_execution',
      workflow_mode,
      task_id: task.id,
      review_level: reviewLevel,
      current_review,
      auto_accepted: isL0,
    };
  }

  if (result.outcome === 'blocked') {
    const { blocked_reason, unblock_condition } = getBlockedReasonFromResult(result);
    const persistError = await persist(basePath, {
      workflow_mode: 'awaiting_user',
      current_task: null,
      current_review: null,
      decisions,
      phases: [{
        id: phase.id,
        todo: [{
          id: task.id,
          lifecycle: 'blocked',
          blocked_reason,
          unblock_condition,
          evidence_refs: result.evidence || [],
        }],
      }],
    });
    if (persistError) return persistError;

    return {
      success: true,
      action: 'awaiting_user',
      workflow_mode: 'awaiting_user',
      task_id: task.id,
      blockers: getBlockedTasks({ todo: [{ id: task.id, lifecycle: 'blocked', blocked_reason, unblock_condition }] }),
    };
  }

  const retry_count = (task.retry_count || 0) + 1;
  const error_fingerprint = typeof result.error_fingerprint === 'string' && result.error_fingerprint.length > 0
    ? result.error_fingerprint
    : result.summary.slice(0, 80);
  const shouldDebug = retry_count >= MAX_DEBUG_RETRY;
  const current_review = shouldDebug
    ? {
        scope: 'task',
        scope_id: task.id,
        stage: 'debugging',
        retry_count,
        error_fingerprint,
        summary: result.summary,
      }
    : null;

  const persistError = await persist(basePath, {
    workflow_mode: 'executing_task',
    current_task: task.id,
    current_review,
    decisions,
    phases: [{
      id: phase.id,
      todo: [{
        id: task.id,
        retry_count,
        last_error_fingerprint: error_fingerprint,
        last_failure_summary: result.summary,
        last_failure_blockers: result.blockers || [],
        evidence_refs: result.evidence || [],
      }],
    }],
  });
  if (persistError) return persistError;

  return {
    success: true,
    action: shouldDebug ? 'dispatch_debugger' : 'retry_executor',
    workflow_mode: 'executing_task',
    task_id: task.id,
    retry_count,
    current_review,
  };
}

export async function handleDebuggerResult({ result, basePath = process.cwd() } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { error: true, message: 'result must be an object' };
  }
  const validation = validateDebuggerResult(result);
  if (!validation.valid) {
    return { error: true, message: `Invalid debugger result: ${validation.errors.join('; ')}` };
  }

  const state = await read({ basePath });
  if (state.error) return state;
  const { phase, task } = getPhaseAndTask(state, result.task_id);
  if (!phase || !task) {
    return { error: true, message: `Task ${result.task_id} not found` };
  }

  const debug_context = {
    root_cause: result.root_cause,
    fix_direction: result.fix_direction,
    evidence: result.evidence,
    hypothesis_tested: result.hypothesis_tested,
    fix_attempts: result.fix_attempts,
    blockers: result.blockers,
    architecture_concern: result.architecture_concern,
  };

  if (result.outcome === 'failed' || result.architecture_concern === true) {
    const phaseFailed = result.architecture_concern === true;
    const phasePatch = { id: phase.id };
    if (phaseFailed) {
      phasePatch.lifecycle = 'failed';
    }
    phasePatch.todo = [{ id: task.id, lifecycle: 'failed', debug_context }];

    const persistError = await persist(basePath, {
      workflow_mode: phaseFailed ? 'failed' : 'executing_task',
      current_task: null,
      current_review: null,
      phases: [phasePatch],
    });
    if (persistError) return persistError;

    return {
      success: true,
      action: phaseFailed ? 'phase_failed' : 'task_failed',
      workflow_mode: phaseFailed ? 'failed' : 'executing_task',
      phase_id: phase.id,
      task_id: task.id,
    };
  }

  const persistError = await persist(basePath, {
    workflow_mode: 'executing_task',
    current_task: task.id,
    current_review: null,
    phases: [{
      id: phase.id,
      todo: [{
        id: task.id,
        debug_context,
      }],
    }],
  });
  if (persistError) return persistError;

  const refreshed = await read({ basePath });
  if (refreshed.error) return refreshed;
  const refreshedInfo = getPhaseAndTask(refreshed, task.id);
  return buildExecutorDispatch(refreshed, refreshedInfo.phase, refreshedInfo.task, {
    resumed_from_debugger: true,
    debugger_guidance: refreshedInfo.task.debug_context,
  });
}

export async function handleReviewerResult({ result, basePath = process.cwd() } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { error: true, message: 'result must be an object' };
  }
  const validation = validateReviewerResult(result);
  if (!validation.valid) {
    return { error: true, message: `Invalid reviewer result: ${validation.errors.join('; ')}` };
  }

  const state = await read({ basePath });
  if (state.error) return state;

  const phase = result.scope === 'phase'
    ? (state.phases || []).find((p) => p.id === result.scope_id) || getCurrentPhase(state)
    : getCurrentPhase(state);
  if (!phase) {
    return { error: true, message: `Phase not found for scope_id ${result.scope_id}` };
  }

  const taskPatches = [];
  let doneIncrement = 0;

  // Accept tasks
  for (const taskId of (result.accepted_tasks || [])) {
    const task = getTaskById(phase, taskId);
    if (!task) continue;
    if (task.lifecycle === 'checkpointed') {
      taskPatches.push({ id: taskId, lifecycle: 'accepted' });
      doneIncrement += 1;
    }
  }

  // Rework tasks
  for (const taskId of (result.rework_tasks || [])) {
    const task = getTaskById(phase, taskId);
    if (!task) continue;
    if (task.lifecycle === 'checkpointed' || task.lifecycle === 'accepted') {
      taskPatches.push({ id: taskId, lifecycle: 'needs_revalidation', evidence_refs: [] });
    }
  }

  // Propagation for critical issues with invalidates_downstream
  for (const issue of (result.critical_issues || [])) {
    if (issue.invalidates_downstream && issue.task_id) {
      propagateInvalidation(phase, issue.task_id, true);
    }
  }

  // Collect propagation-affected task patches (tasks mutated in-memory by propagateInvalidation)
  for (const task of (phase.todo || [])) {
    if (task.lifecycle === 'needs_revalidation' && !taskPatches.some((p) => p.id === task.id)) {
      taskPatches.push({ id: task.id, lifecycle: 'needs_revalidation', evidence_refs: [] });
    }
  }

  const hasCritical = (result.critical_issues || []).length > 0;
  const reviewStatus = hasCritical ? 'rework_required' : 'accepted';

  const phaseUpdates = {
    id: phase.id,
    done: (phase.done || 0) + doneIncrement,
    phase_review: {
      status: reviewStatus,
      ...(hasCritical ? { retry_count: (phase.phase_review?.retry_count || 0) + 1 } : {}),
    },
    todo: taskPatches,
  };

  if (!hasCritical && result.scope === 'phase') {
    phaseUpdates.phase_handoff = { required_reviews_passed: true };
  }

  const workflowMode = hasCritical ? 'executing_task' : state.workflow_mode;

  const persistError = await persist(basePath, {
    workflow_mode: workflowMode,
    current_review: null,
    phases: [phaseUpdates],
  });
  if (persistError) return persistError;

  // Store evidence entries if provided
  for (const ev of (result.evidence || [])) {
    if (ev && typeof ev === 'object' && typeof ev.id === 'string' && typeof ev.scope === 'string') {
      await addEvidence({ id: ev.id, data: ev, basePath });
    }
  }

  return {
    success: true,
    action: hasCritical ? 'rework_required' : 'review_accepted',
    workflow_mode: workflowMode,
    phase_id: phase.id,
    review_status: reviewStatus,
    accepted_count: result.accepted_tasks?.length || 0,
    rework_count: result.rework_tasks?.length || 0,
    critical_count: result.critical_issues?.length || 0,
  };
}

export async function handleResearcherResult({ result, artifacts, decision_index, basePath = process.cwd() } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { error: true, message: 'result must be an object' };
  }

  const validation = validateResearcherResult(result);
  if (!validation.valid) {
    return { error: true, message: `Invalid researcher result: ${validation.errors.join('; ')}` };
  }

  const persisted = await storeResearch({ result, artifacts, decision_index, basePath });
  if (persisted.error) return persisted;

  const resumed = await resumeWorkflow({ basePath });
  if (resumed.error) return resumed;

  return {
    ...resumed,
    stored_files: persisted.stored_files,
    decision_ids: persisted.decision_ids,
    research_warnings: persisted.warnings,
  };
}

export { getBlockedTasks, getCurrentPhase, getReviewTargets };