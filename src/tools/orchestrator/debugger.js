import { ERROR_CODES, read } from '../state/index.js';
import { ACTIONABLE_LIFECYCLES, validateDebuggerResult } from '../../schema.js';
import {
  getPhaseAndTask,
  persist,
  persistAndRead,
  buildExecutorDispatch,
} from './helpers.js';

export async function handleDebuggerResult({ result, basePath = process.cwd() } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { error: true, message: 'result must be an object' };
  }
  const validation = validateDebuggerResult(result);
  if (!validation.valid) {
    return { error: true, message: `Invalid debugger result: ${validation.errors.join('; ')}` };
  }

  // Note: read() is outside the state lock — safe under single-session sequential execution.
  // See executor.js for rationale.
  const state = await read({ basePath });
  if (state.error) return state;
  const { phase, task } = getPhaseAndTask(state, result.task_id);
  if (!phase || !task) {
    return { error: true, message: `Task ${result.task_id} not found` };
  }
  // R-22 (audit L5): reject a result for a task outside the current phase.
  if (phase.id !== state.current_phase) {
    return { error: true, message: `Task ${result.task_id} is in phase ${phase.id}, not the current phase ${state.current_phase}; result rejected` };
  }
  // Same staleness guard as the executor handler. The case it actually catches
  // is `outcome: 'root_cause_found'`: that patch carries no lifecycle, so it
  // passes lifecycle validation and, for a task that already checkpointed into
  // review, resets workflow_mode to executing_task and nulls current_review —
  // the review is simply gone.
  //
  // The `failed` / `architecture_concern: true` branch does NOT need this guard:
  // its patch sets lifecycle `failed`, update() is atomic, and checkpointed →
  // failed is already rejected whole by TASK_LIFECYCLE. Testing the guard with
  // that input proves nothing, because the pre-existing validator answers it
  // with the same error code.
  if (!ACTIONABLE_LIFECYCLES.includes(task.lifecycle)) {
    return {
      error: true,
      code: ERROR_CODES.TRANSITION_ERROR,
      message: `Task ${task.id} is '${task.lifecycle}', not ${ACTIONABLE_LIFECYCLES.join(' or ')}; this result is stale and was rejected`,
    };
  }

  // R-21 (audit L4): optimistic-lock the read→persist window (one persist per call).
  const expectedVersion = state._version;

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

    // Determine effective workflow mode: if no tasks can make progress, escalate
    let effectiveWorkflowMode;
    if (phaseFailed) {
      effectiveWorkflowMode = 'failed';
    } else {
      const hasProgressable = (phase.todo || []).some(t =>
        t.id !== task.id && !['accepted', 'failed'].includes(t.lifecycle),
      );
      effectiveWorkflowMode = hasProgressable ? 'executing_task' : 'awaiting_user';
    }

    const phasePatch = { id: phase.id };
    if (phaseFailed) {
      phasePatch.lifecycle = 'failed';
    }
    phasePatch.todo = [{ id: task.id, lifecycle: 'failed', debug_context }];

    const persistError = await persist(basePath, {
      workflow_mode: effectiveWorkflowMode,
      current_task: null,
      current_review: null,
      phases: [phasePatch],
    }, { expectedVersion });
    if (persistError) return persistError;

    return {
      success: true,
      action: phaseFailed ? 'phase_failed' : 'task_failed',
      workflow_mode: effectiveWorkflowMode,
      phase_id: phase.id,
      task_id: task.id,
    };
  }

  // Reset retry_count after successful debugging so executor gets fresh attempts
  const refreshed = await persistAndRead(basePath, {
    workflow_mode: 'executing_task',
    current_task: task.id,
    current_review: null,
    phases: [{
      id: phase.id,
      todo: [{
        id: task.id,
        retry_count: 0,
        debug_context,
      }],
    }],
  }, { expectedVersion });
  if (refreshed.error) return refreshed;

  const refreshedInfo = getPhaseAndTask(refreshed, task.id);
  return buildExecutorDispatch(refreshed, refreshedInfo.phase, refreshedInfo.task, {
    resumed_from_debugger: true,
    debugger_guidance: refreshedInfo.task.debug_context,
  }, basePath);
}
