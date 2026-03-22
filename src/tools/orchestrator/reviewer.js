import { read } from '../state/index.js';
import { validateReviewerResult } from '../../schema.js';
import {
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
  const reviewStatus = needsRework ? 'rework_required' : 'accepted';

  // done is auto-recomputed by update() — no manual tracking needed
  const phaseUpdates = {
    id: phase.id,
    phase_review: {
      status: reviewStatus,
      ...(needsRework
        ? { retry_count: (phase.phase_review?.retry_count || 0) + 1 }
        : { retry_count: 0 }),
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
    accepted_count: result.accepted_tasks?.length || 0,
    rework_count: result.rework_tasks?.length || 0,
    critical_count: result.critical_issues?.length || 0,
  };
}
