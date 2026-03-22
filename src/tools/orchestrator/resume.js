import { read, selectRunnableTask } from '../state/index.js';
import { getGitHead } from '../../utils.js';
import {
  MAX_RESUME_DEPTH,
  CONTEXT_RESUME_THRESHOLD,
  RESULT_CONTRACTS,
  evaluatePreflight,
  readContextHealth,
  collectExpiredResearch,
  getCurrentPhase,
  getTaskById,
  getBlockedTasks,
  getReviewTargets,
  getDebugTarget,
  persist,
  buildExecutorDispatch,
  tryAutoUnblock,
} from './helpers.js';

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
      result_contract: RESULT_CONTRACTS.debugger,
    };
  }

  if (state.current_task) {
    const currentTask = getTaskById(phase, state.current_task);
    if (currentTask?.lifecycle === 'running') {
      const isRetrying = (currentTask.retry_count || 0) > 0;
      const persistError = await persist(basePath, {
        workflow_mode: 'executing_task',
        current_task: currentTask.id,
        current_review: null,
      });
      if (persistError) return persistError;
      return buildExecutorDispatch(state, phase, currentTask, {
        resumed: true,
        interruption_recovered: !isRetrying,
        ...(isRetrying ? {
          retry_after_failure: true,
          retry_count: currentTask.retry_count,
          last_failure_summary: currentTask.last_failure_summary,
        } : {}),
      });
    }
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
  const allAccepted = phase.todo.length > 0 && phase.todo.every(t => t.lifecycle === 'accepted');
  const reviewPassed = phase.phase_review?.status === 'accepted'
    || phase.phase_handoff?.required_reviews_passed === true;
  if (allAccepted && reviewPassed) {
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

export async function resumeWorkflow({ basePath = process.cwd(), _depth = 0, unblock_tasks } = {}) {
  if (_depth >= MAX_RESUME_DEPTH) {
    return { error: true, message: `resumeWorkflow recursive depth limit exceeded (max ${MAX_RESUME_DEPTH})` };
  }

  const state = await read({ basePath });
  if (state.error) {
    return state;
  }

  // Force-unblock specified tasks before normal resume flow
  if (Array.isArray(unblock_tasks) && unblock_tasks.length > 0 && _depth === 0) {
    const phase = getCurrentPhase(state);
    if (phase) {
      const patches = [];
      for (const taskId of unblock_tasks) {
        const task = (phase.todo || []).find(t => t.id === taskId);
        if (task?.lifecycle === 'blocked') {
          patches.push({ id: taskId, lifecycle: 'pending', blocked_reason: null, unblock_condition: null });
        }
      }
      if (patches.length > 0) {
        const persistError = await persist(basePath, {
          workflow_mode: 'executing_task',
          current_task: null,
          current_review: null,
          phases: [{ id: phase.id, todo: patches }],
        });
        if (persistError) return persistError;
        // Re-read state after unblock and continue
        return resumeWorkflow({ basePath, _depth: _depth + 1 });
      }
    }
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
      ...(preflight.override.dirty_phase ? { dirty_phase: preflight.override.dirty_phase } : {}),
      ...(preflight.hints && preflight.hints.length > 1 ? { pending_issues: preflight.hints.slice(1) } : {}),
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

      if (autoUnblock.blockers.length === 0) {
        const persistError = await persist(basePath, {
          workflow_mode: 'executing_task',
          current_task: null,
          current_review: null,
        });
        if (persistError) return persistError;
        const resumed = await resumeWorkflow({ basePath, _depth: _depth + 1 });
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
          files_changed: task.files_changed || [],
        })),
        result_contract: RESULT_CONTRACTS.reviewer,
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
        result_contract: RESULT_CONTRACTS.reviewer,
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
        pr_suggestion: {
          recommended: true,
          message: 'Project complete. Consider creating a PR with `gh pr create` if not already done.',
        },
      };
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
      return {
        success: true,
        action: 'await_recovery_decision',
        workflow_mode: state.workflow_mode,
        failed_phases: failedPhases,
        failed_tasks: failedTasks,
        recovery_options: ['retry_failed', 'skip_failed', 'replan'],
        message: 'Workflow is in failed state. Recovery options available.',
      };
    }
    case 'paused_by_user':
      return {
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
    case 'planning':
      return {
        success: true,
        action: 'await_manual_intervention',
        workflow_mode: state.workflow_mode,
        guidance: 'Complete planning and call state-init to initialize the project',
        message: 'Project is in planning mode; complete the plan and initialize with state-init',
      };
    case 'reconcile_workspace': {
      const reconGitHead = await getGitHead(basePath);
      return {
        success: true,
        action: 'reconcile_workspace',
        workflow_mode: state.workflow_mode,
        expected_head: state.git_head,
        actual_head: reconGitHead,
        guidance: 'Workspace git HEAD has diverged. Verify changes and update git_head via state-update, then set workflow_mode to executing_task',
        message: `Git HEAD mismatch: saved=${state.git_head}, current=${reconGitHead}`,
      };
    }
    case 'replan_required':
      return {
        success: true,
        action: 'replan_required',
        workflow_mode: state.workflow_mode,
        guidance: 'Plan files modified since last session. Review changes, update the plan if needed, then set workflow_mode to executing_task via state-update',
        message: 'Plan artifacts modified since last session; review and re-align before resuming',
      };
    case 'research_refresh_needed': {
      const expiredResearch = collectExpiredResearch(state);
      return {
        success: true,
        action: 'dispatch_researcher',
        workflow_mode: state.workflow_mode,
        expired_research: expiredResearch,
        guidance: 'Research cache expired. Dispatch researcher sub-agent to refresh, then call orchestrator-handle-researcher-result',
        message: 'Research has expired and must be refreshed before execution can resume',
      };
    }
    default:
      return {
        error: true,
        message: `workflow_mode "${state.workflow_mode}" is not yet supported by the orchestrator skeleton`,
      };
  }
}
