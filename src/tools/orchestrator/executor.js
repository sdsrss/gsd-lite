import { read, reclassifyReviewLevel } from '../state/index.js';
import { validateExecutorResult } from '../../schema.js';
import {
  MAX_DEBUG_RETRY,
  RESULT_CONTRACTS,
  getPhaseAndTask,
  getBlockedTasks,
  buildDecisionEntries,
  buildErrorFingerprint,
  getBlockedReasonFromResult,
  persist,
} from './helpers.js';

export async function handleExecutorResult({ result, basePath = process.cwd() } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { error: true, message: 'result must be an object' };
  }
  const validation = validateExecutorResult(result);
  if (!validation.valid) {
    return { error: true, message: `Invalid executor result: ${validation.errors.join('; ')}` };
  }

  // Note: read() is outside the state lock. This is safe because the MCP server
  // processes tool calls sequentially (single-session, promise-queue serialized).
  // persist() below re-acquires the lock and applies changes atomically.
  const state = await read({ basePath });
  if (state.error) return state;
  const { phase, task } = getPhaseAndTask(state, result.task_id);
  if (!phase || !task) {
    return { error: true, message: `Task ${result.task_id} not found` };
  }

  // Auto-start parallel tasks: if a task is still pending (dispatched via parallel_available
  // but not explicitly started by orchestrator-resume), transition it to running first.
  if (task.lifecycle === 'pending') {
    const startError = await persist(basePath, {
      phases: [{ id: phase.id, todo: [{ id: task.id, lifecycle: 'running' }] }],
    });
    if (startError) return startError;
    task.lifecycle = 'running';
  }

  // Build new decision entries — actual append happens atomically inside update()'s lock
  const newDecisions = buildDecisionEntries(result.decisions, phase.id, task.id, (state.decisions || []).length);

  if (result.outcome === 'checkpointed') {
    const reviewLevel = reclassifyReviewLevel(task, result);
    const isL0 = reviewLevel === 'L0';
    const autoAccept = isL0 || task.review_required === false;

    const current_review = !isL0 && (reviewLevel === 'L2' || reviewLevel === 'L3') && task.review_required !== false
      ? { scope: 'task', scope_id: task.id, stage: 'spec' }
      : null;
    const workflow_mode = current_review ? 'reviewing_task' : 'executing_task';

    // Single atomic persist: auto-accept goes directly running → accepted,
    // otherwise running → checkpointed (awaiting review)
    const taskPatch = {
      id: task.id,
      lifecycle: autoAccept ? 'accepted' : 'checkpointed',
      checkpoint_commit: result.checkpoint_commit,
      files_changed: result.files_changed || [],
      evidence_refs: result.evidence || [],
      level: reviewLevel,
      blocked_reason: null,
      unblock_condition: null,
      debug_context: null,
    };
    const phasePatch = { id: phase.id, todo: [taskPatch] };
    // done is auto-recomputed by update() — no manual increment needed

    // Bundle evidence into the same atomic persist to prevent inconsistency
    const evidenceUpdates = {};
    for (const ev of (result.evidence || [])) {
      if (ev && typeof ev === 'object' && typeof ev.id === 'string' && typeof ev.scope === 'string') {
        evidenceUpdates[ev.id] = ev;
      }
    }

    const persistError = await persist(basePath, {
      workflow_mode,
      current_task: null,
      current_review,
      phases: [phasePatch],
      ...(Object.keys(evidenceUpdates).length > 0 ? { evidence: evidenceUpdates } : {}),
    }, { _append_decisions: newDecisions });
    if (persistError) return persistError;

    return {
      success: true,
      action: current_review ? 'dispatch_reviewer' : 'continue_execution',
      workflow_mode,
      task_id: task.id,
      review_level: reviewLevel,
      current_review,
      auto_accepted: autoAccept,
      ...(current_review ? { result_contract: RESULT_CONTRACTS.reviewer } : {}),
    };
  }

  if (result.outcome === 'blocked') {
    const { blocked_reason, unblock_condition } = getBlockedReasonFromResult(result);
    const persistError = await persist(basePath, {
      workflow_mode: 'awaiting_user',
      current_task: null,
      current_review: null,
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
    }, { _append_decisions: newDecisions });
    if (persistError) return persistError;

    return {
      success: true,
      action: 'awaiting_user',
      workflow_mode: 'awaiting_user',
      task_id: task.id,
      blockers: getBlockedTasks({ todo: [{ id: task.id, lifecycle: 'blocked', blocked_reason, unblock_condition }] }),
    };
  }

  // Task stays in 'running' lifecycle intentionally — executor outcome 'failed' means
  // "attempt failed, ready for retry or debugger", NOT lifecycle 'failed'. The task only
  // transitions to lifecycle 'failed' via handleDebuggerResult when debugging is exhausted.
  const retry_count = (task.retry_count || 0) + 1;
  const error_fingerprint = typeof result.error_fingerprint === 'string' && result.error_fingerprint.length > 0
    ? result.error_fingerprint
    : buildErrorFingerprint(result);
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
  }, { _append_decisions: newDecisions });
  if (persistError) return persistError;

  return {
    success: true,
    action: shouldDebug ? 'dispatch_debugger' : 'retry_executor',
    workflow_mode: 'executing_task',
    task_id: task.id,
    retry_count,
    current_review,
    result_contract: shouldDebug ? RESULT_CONTRACTS.debugger : RESULT_CONTRACTS.executor,
  };
}
