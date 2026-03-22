import { read } from '../state/index.js';
import { validateReviewerResult } from '../../schema.js';
import {
  MAX_PHASE_REVIEW_RETRY,
  getCurrentPhase,
  getTaskById,
  persist,
} from './helpers.js';

export async function handleReviewerResult({ result, basePath = process.cwd() } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { error: true, message: 'result must be an object' };
  }
  const validation = validateReviewerResult(result);
  if (!validation.valid) {
    return { error: true, message: `Invalid reviewer result: ${validation.errors.join('; ')}` };
  }

  // Note: read() is outside the state lock — safe under single-session sequential execution.
  // See executor.js for rationale.
  const state = await read({ basePath });
  if (state.error) return state;

  const phase = result.scope === 'phase'
    ? (state.phases || []).find((p) => p.id === Number(result.scope_id)) || null
    : getCurrentPhase(state);
  if (!phase) {
    return { error: true, message: `Phase not found for scope_id ${result.scope_id}` };
  }

  const taskPatches = [];

  // Accept tasks
  for (const taskId of (result.accepted_tasks || [])) {
    const task = getTaskById(phase, taskId);
    if (!task) continue;
    if (task.lifecycle === 'checkpointed') {
      taskPatches.push({ id: taskId, lifecycle: 'accepted' });
    }
  }

  // Rework tasks — persist reviewer feedback so executor knows what to fix
  for (const taskId of (result.rework_tasks || [])) {
    const task = getTaskById(phase, taskId);
    if (!task) continue;
    if (task.lifecycle === 'checkpointed' || task.lifecycle === 'accepted') {
      const taskIssues = [
        ...(result.critical_issues || []).filter(i => !i.task_id || i.task_id === taskId),
        ...(result.important_issues || []).filter(i => !i.task_id || i.task_id === taskId),
      ].map(i => i.reason ?? i.description ?? '');
      taskPatches.push({
        id: taskId,
        lifecycle: 'needs_revalidation',
        retry_count: 0,
        evidence_refs: [],
        last_review_feedback: taskIssues.length > 0 ? taskIssues : null,
      });
    }
  }

  // Collect propagation targets — actual invalidation runs atomically inside update()'s lock
  const propagationTasks = [];
  for (const issue of (result.critical_issues || [])) {
    if (issue.invalidates_downstream && issue.task_id) {
      propagationTasks.push({ phase_id: phase.id, task_id: issue.task_id, contract_changed: true });
    }
  }

  const hasCritical = (result.critical_issues || []).length > 0;
  // Gate on spec_passed/quality_passed in addition to critical_issues:
  // a reviewer returning spec_passed:false or quality_passed:false indicates
  // rework is needed even without explicit critical_issues entries.
  const specFailed = result.spec_passed === false;
  const qualityFailed = result.quality_passed === false;
  const needsRework = hasCritical || specFailed || qualityFailed;

  // Safety: if rework is needed but no tasks were targeted for rework,
  // fall back to marking all non-accepted checkpointed/accepted tasks as needs_revalidation
  // to prevent infinite review loops (no runnable tasks → trigger_review → same result).
  if (needsRework && taskPatches.filter(p => p.lifecycle === 'needs_revalidation').length === 0) {
    for (const task of (phase.todo || [])) {
      if (task.lifecycle === 'checkpointed' || task.lifecycle === 'accepted') {
        taskPatches.push({
          id: task.id,
          lifecycle: 'needs_revalidation',
          retry_count: 0,
          evidence_refs: [],
          last_review_feedback: ['Reviewer indicated rework needed but did not specify tasks; all completed tasks require revalidation'],
        });
      }
    }
  }

  // Compute retry count once for both exhaustion check and state update
  const currentRetryCount = phase.phase_review?.retry_count || 0;
  const nextRetryCount = needsRework ? currentRetryCount + 1 : 0;

  // Phase review retry limit: prevent infinite reviewing↔active cycles
  if (needsRework && nextRetryCount > MAX_PHASE_REVIEW_RETRY) {
    const persistError = await persist(basePath, {
      workflow_mode: 'awaiting_user',
      current_task: null,
      current_review: {
        scope: 'phase',
        scope_id: phase.id,
        stage: 'review_retry_exhausted',
        retry_count: nextRetryCount,
      },
      phases: [{
        id: phase.id,
        lifecycle: phase.lifecycle === 'reviewing' ? 'active' : phase.lifecycle,
        phase_review: { status: 'rework_required', retry_count: nextRetryCount },
      }],
    });
    if (persistError) return persistError;

    return {
      success: true,
      action: 'review_retry_exhausted',
      workflow_mode: 'awaiting_user',
      phase_id: phase.id,
      retry_count: nextRetryCount,
      message: `Phase ${phase.id} review failed ${nextRetryCount} times (limit: ${MAX_PHASE_REVIEW_RETRY}). User intervention required.`,
    };
  }

  const reviewStatus = needsRework ? 'rework_required' : 'accepted';

  // done is auto-recomputed by update() — no manual tracking needed
  const phaseUpdates = {
    id: phase.id,
    phase_review: {
      status: reviewStatus,
      retry_count: nextRetryCount,
    },
    todo: taskPatches,
  };

  // Transition phase back to active when rework is needed
  if (needsRework && phase.lifecycle === 'reviewing') {
    phaseUpdates.lifecycle = 'active';
  }

  if (!needsRework && result.scope === 'phase') {
    phaseUpdates.phase_handoff = { required_reviews_passed: true };
  }

  const workflowMode = 'executing_task';

  // Bundle evidence into the same atomic persist
  const evidenceUpdates = {};
  for (const ev of (result.evidence || [])) {
    if (ev && typeof ev === 'object' && typeof ev.id === 'string' && typeof ev.scope === 'string') {
      evidenceUpdates[ev.id] = ev;
    }
  }

  const persistError = await persist(basePath, {
    workflow_mode: workflowMode,
    current_task: null,
    current_review: null,
    phases: [phaseUpdates],
    ...(Object.keys(evidenceUpdates).length > 0 ? { evidence: evidenceUpdates } : {}),
  }, { _propagation_tasks: propagationTasks });
  if (persistError) return persistError;

  return {
    success: true,
    action: needsRework ? 'rework_required' : 'review_accepted',
    workflow_mode: workflowMode,
    phase_id: phase.id,
    review_status: reviewStatus,
    accepted_count: taskPatches.filter(p => p.lifecycle === 'accepted').length,
    rework_count: taskPatches.filter(p => p.lifecycle === 'needs_revalidation').length,
    critical_count: result.critical_issues?.length || 0,
  };
}
