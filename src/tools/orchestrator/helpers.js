import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  update,
  buildExecutorContext,
  matchDecisionForBlocker,
} from '../state/index.js';
import { getGitHead, getGsdDir } from '../../utils.js';

const MAX_DEBUG_RETRY = 3;
const MAX_RESUME_DEPTH = 3;
const CONTEXT_RESUME_THRESHOLD = 40;

// ── Result Contracts ──
// Provided in dispatch responses so agents produce valid results on the first call.
const RESULT_CONTRACTS = {
  executor: {
    task_id: 'string — must match dispatched task_id',
    outcome: '"checkpointed" | "blocked" | "failed"',
    summary: 'string — non-empty description of work done',
    checkpoint_commit: 'string — required when outcome="checkpointed"',
    files_changed: 'string[] — list of modified file paths',
    decisions: '{ id, title, rationale }[] — architectural decisions made',
    blockers: '{ description, type }[] — what blocked progress (when outcome="blocked")',
    contract_changed: 'boolean — true if external API/behavior contract changed',
    confidence: '"high" | "medium" | "low" (optional) — executor self-assessed confidence; affects review level',
    evidence: '{ type, detail }[] — verification evidence (test results, lint, etc.)',
  },
  reviewer: {
    scope: '"task" | "phase"',
    scope_id: 'string | number — task id (e.g. "1.2") or phase number',
    review_level: '"L2" | "L1-batch" | "L1"',
    spec_passed: 'boolean',
    quality_passed: 'boolean',
    critical_issues: '{ reason|description, task_id?, invalidates_downstream? }[] — blocking issues',
    important_issues: '{ description, task_id? }[]',
    minor_issues: '{ description, task_id? }[]',
    accepted_tasks: 'string[] — task ids that passed review',
    rework_tasks: 'string[] — task ids that need rework (disjoint with accepted_tasks)',
    evidence: '{ type, detail }[]',
  },
  researcher: {
    result: {
      decision_ids: 'string[] — ids of decisions addressed',
      volatility: '"low" | "medium" | "high"',
      expires_at: 'string — ISO date when research expires',
      sources: '{ id, type, ref, title?, accessed_at? }[] — research sources',
    },
    decision_index: '{ [id]: { id, title, rationale, status, summary } } — keyed by decision id',
    artifacts: '{ "STACK.md", "ARCHITECTURE.md", "PITFALLS.md", "SUMMARY.md" } — all four required',
  },
  debugger: {
    task_id: 'string — must match debug target',
    outcome: '"root_cause_found" | "fix_suggested" | "failed"',
    root_cause: 'string — non-empty root cause description',
    evidence: '{ type, detail }[]',
    hypothesis_tested: '{ hypothesis, result: "confirmed"|"rejected", evidence }[]',
    fix_direction: 'string — recommended fix approach',
    fix_attempts: 'number — non-negative integer (>=3 requires outcome="failed")',
    blockers: '{ description, type }[]',
    architecture_concern: 'boolean',
  },
};

function isTerminalWorkflowMode(workflowMode) {
  return workflowMode === 'completed' || workflowMode === 'failed';
}

function parseTimestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readContextHealth(basePath) {
  const gsdDir = await getGsdDir(basePath);
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

  const gsdDir = await getGsdDir(basePath);
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

  const hints = [];

  const currentGitHead = await getGitHead(basePath);
  if (state.git_head && currentGitHead && state.git_head !== currentGitHead) {
    hints.push({
      workflow_mode: 'reconcile_workspace',
      action: 'await_manual_intervention',
      updates: { workflow_mode: 'reconcile_workspace' },
      saved_git_head: state.git_head,
      current_git_head: currentGitHead,
      message: 'Saved git_head does not match the current workspace HEAD',
    });
  }

  const changed_files = await detectPlanDrift(basePath, state.context?.last_session);
  if (changed_files.length > 0) {
    hints.push({
      workflow_mode: 'replan_required',
      action: 'await_manual_intervention',
      updates: { workflow_mode: 'replan_required' },
      changed_files,
      message: 'Plan artifacts changed after the last recorded session',
    });
  }

  const skipDirectionDrift = state.workflow_mode === 'awaiting_user'
    && state.current_review?.stage === 'direction_drift';
  if (!skipDirectionDrift) {
    const driftPhase = getDirectionDriftPhase(state);
    if (driftPhase) {
      hints.push({
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
      });
    }
  }

  const expired_research = collectExpiredResearch(state);
  if (expired_research.length > 0) {
    hints.push({
      workflow_mode: 'research_refresh_needed',
      action: 'dispatch_researcher',
      updates: { workflow_mode: 'research_refresh_needed' },
      expired_research,
      message: 'Research cache expired and must be refreshed before execution resumes',
    });
  }

  // P0-2: Dirty-phase detection — rollback current_phase to earliest phase
  // that has needs_revalidation tasks, ensuring earlier invalidated work
  // is re-executed before proceeding with later phases.
  // Use filter+reduce (not .find) to guarantee lowest-ID match regardless of array order.
  const dirtyPhases = (state.phases || []).filter(p =>
    p.id < state.current_phase
    && (p.todo || []).some(t => t.lifecycle === 'needs_revalidation'),
  );
  const earliestDirtyPhase = dirtyPhases.length > 0
    ? dirtyPhases.reduce((min, p) => (p.id < min.id ? p : min))
    : null;
  if (earliestDirtyPhase) {
    hints.push({
      workflow_mode: 'executing_task',
      action: 'rollback_to_dirty_phase',
      updates: {
        workflow_mode: 'executing_task',
        current_phase: earliestDirtyPhase.id,
        current_task: null,
        current_review: null,
      },
      dirty_phase: { id: earliestDirtyPhase.id, name: earliestDirtyPhase.name },
      message: `Phase ${earliestDirtyPhase.id} has invalidated tasks; rolling back from phase ${state.current_phase}`,
    });
  }

  if (hints.length === 0) return { override: null };

  return {
    override: hints[0],
    // Always report all hint messages so caller can surface pending issues
    hints: hints.map(h => h.message),
  };
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

function buildErrorFingerprint(result) {
  const parts = [];
  if (result.blockers?.length > 0) {
    const b = result.blockers[0];
    parts.push(typeof b === 'string' ? b : (b.reason || b.type || ''));
  }
  if (result.files_changed?.length > 0) {
    parts.push([...result.files_changed].sort().join(','));
  }
  const combined = parts.filter(Boolean).join('|');
  return combined.length > 0 ? combined.slice(0, 120) : result.summary.slice(0, 80);
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

async function persist(basePath, updates, { _append_decisions, _propagation_tasks } = {}) {
  const result = await update({ updates, basePath, _append_decisions, _propagation_tasks });
  if (result.error) {
    return result;
  }
  return null;
}

// persist variant that returns merged state from update(), avoiding re-reads
async function persistAndRead(basePath, updates, { _append_decisions, _propagation_tasks } = {}) {
  const result = await update({ updates, basePath, _append_decisions, _propagation_tasks });
  if (result.error) {
    return { error: true, ...result };
  }
  return result.state;
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
    result_contract: RESULT_CONTRACTS.executor,
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

  const refreshed = await persistAndRead(basePath, {
    phases: [{ id: phase.id, todo: patches }],
  });
  if (refreshed.error) return refreshed;

  const refreshedPhase = getCurrentPhase(refreshed);
  return {
    autoUnblocked,
    blockers: getBlockedTasks(refreshedPhase),
  };
}

export {
  MAX_DEBUG_RETRY,
  MAX_RESUME_DEPTH,
  CONTEXT_RESUME_THRESHOLD,
  RESULT_CONTRACTS,
  isTerminalWorkflowMode,
  parseTimestamp,
  readContextHealth,
  collectExpiredResearch,
  getDirectionDriftPhase,
  detectPlanDrift,
  evaluatePreflight,
  getCurrentPhase,
  getTaskById,
  getBlockedTasks,
  getReviewTargets,
  getPhaseAndTask,
  getDebugTarget,
  buildDecisionEntries,
  buildErrorFingerprint,
  getBlockedReasonFromResult,
  persist,
  persistAndRead,
  buildExecutorDispatch,
  tryAutoUnblock,
};
