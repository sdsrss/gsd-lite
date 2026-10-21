import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import {
  update,
  buildExecutorContext,
  matchDecisionForBlocker,
  computePlanHashes,
} from '../state/index.js';
import { getGitHead, getGsdDir } from '../../utils.js';
import { taskRefsForAgent } from '../../agent-payload.js';

const MAX_DEBUG_RETRY = 3;
// Fix directions a debugger may hand out for one task before the next failure
// fails the phase (agents/debugger.md, "修复方向最多试 3 次").
const MAX_FIX_DIRECTIONS = 3;
const MAX_RESUME_DEPTH = 3;
const CONTEXT_RESUME_THRESHOLD = 40;
const MAX_PHASE_REVIEW_RETRY = 5;
// The modes a research refresh may interrupt: the ones that are executing or
// reviewing, and the refresh itself. Named this way round on purpose: the first
// version listed the modes to leave alone, named two, and refreshed over
// planning, reconcile_workspace, replan_required and awaiting_clear, each of
// which then resumed execution. Any mode not listed waits until the project is
// back to executing, and a mode added later is left alone by default.
const REFRESH_MODES = ['executing_task', 'reviewing_task', 'reviewing_phase', 'research_refresh_needed'];
// The modes preflight may override: the ones about to execute or review, and
// the three holds whose own handling expects the check to run again
// (reconcile_workspace's branch in resume.js relies on it, see M10 there).
// Named as the set allowed, like REFRESH_MODES: any mode not listed — a
// pause, planning, a decision owed, a /clear — waits until it is back to
// work, and a mode added later is left alone by default.
const PREFLIGHT_MODES = ['executing_task', 'reviewing_task', 'reviewing_phase', 'reconcile_workspace', 'replan_required', 'research_refresh_needed'];

// R-17: the former RESULT_CONTRACTS reference block was embedded in dispatch
// responses as `result_contract` and then unconditionally stripped by the server
// before reaching the agent (dead + drift-prone). The authoritative agent result
// contracts live in agents/*.md (executor/reviewer/researcher/debugger); this
// duplicate was removed so there is a single source of truth.

// Modes in which preflight must not run. `completed` is terminal. `failed` is
// not terminal any more — it has recovery edges — but it is still held for a
// user decision, and preflight's overrides (reconcile_workspace, replan_required,
// research_refresh_needed) are not reachable from it. Running preflight there
// would only produce a VALIDATION_FAILED on every resume.
function skipsPreflight(workflowMode) {
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

async function detectPlanDrift(basePath, storedHashes) {
  if (!storedHashes || typeof storedHashes !== 'object') return [];

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
    const relPath = relative(gsdDir, filePath);
    const storedHash = storedHashes[relPath];
    if (!storedHash) continue; // New file or no stored hash — skip
    try {
      const content = await readFile(filePath, 'utf-8');
      const currentHash = createHash('sha256').update(content).digest('hex');
      if (currentHash !== storedHash) {
        changedFiles.push(relPath);
      }
    } catch {
      // File removed — count as drift
      changedFiles.push(relPath);
    }
  }

  return changedFiles.sort();
}

async function evaluatePreflight(state, basePath) {
  if (skipsPreflight(state.workflow_mode)) {
    return { override: null };
  }

  // Nothing here may override a mode in which somebody owes an answer, or one
  // that resume is about to leave for the mode it interrupted (PREFLIGHT_MODES
  // names the ones it may). Every override
  // persists a new workflow_mode, and a dirty-phase rollback also writes
  // executing_task and current_review: null — which unpaused a paused project,
  // ended a plan revision, and cleared a decision held in awaiting_user (an L3
  // confirmation, exhausted review retries), all server-side. Each of these
  // returns to work by its own path, and the next resume checks then:
  //   paused_by_user  — the user said stop; nothing changes until they resume
  //   planning        — the plan files are being edited; that is not drift
  //   awaiting_user   — the decision comes first (R-03: an L3 confirmation
  //                     cleared by an override left the task re-sweepable
  //                     into a later phase review with no gate)
  //   awaiting_clear  — resume restores the interrupted mode and resumes again
  if (!PREFLIGHT_MODES.includes(state.workflow_mode)) {
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

  // DO NOT add a "state carries no git_head" hint here. It was tried and
  // removed, and both reasons are structural rather than fixable by narrowing
  // the predicate further:
  //
  // 1. It cannot stop anything. The hint's only vocabulary is
  //    `reconcile_workspace` / `await_manual_intervention`, and
  //    `workflows/execution-flow.md` — which `commands/resume.md` names the
  //    single source of truth — puts that pair OUTSIDE the terminal set and
  //    tells the orchestrator to set git_head and continue the loop. The gate
  //    cost one extra state-update and changed nothing.
  // 2. It cries wolf on a normal flow. `git rev-parse --short HEAD` exits 128
  //    in a repo with no commits yet, so `git init` → scaffold → state-init →
  //    first commit records `git_head: null` and then trips the pair. Any
  //    transient getGitHead failure does the same permanently: utils.js catches
  //    every throw, including its 5s timeout, and writes null once and forever.
  //
  // A security prompt that fires on ordinary work trains people to click
  // through it, which is worse than not having it. The defence that does hold
  // is mechanical and lives in src/agent-payload.js: taskRefsForAgent
  // constrains the state-sourced values that agents/reviewer.md substitutes
  // into a shell command and a file read.

  // Plan drift detection — only run when no prior blocking hint (git_head mismatch)
  // exists, because establishing a baseline in a suspect workspace state would
  // anchor hashes to potentially wrong files.
  if (hints.length === 0) {
    const storedHashes = state.context?.plan_hashes;
    if (!storedHashes || Object.keys(storedHashes).length === 0) {
      // No baseline hashes — compute and persist them now (first resume after init).
      // This avoids false drift when state-init creates placeholders that the agent
      // subsequently overwrites with real plan content.
      const freshHashes = await computePlanHashes(basePath);
      if (Object.keys(freshHashes).length > 0) {
        const hashPersistErr = await persist(basePath, { context: { plan_hashes: freshHashes } });
        if (hashPersistErr) return { override: hashPersistErr };
      }
    } else {
      const changed_files = await detectPlanDrift(basePath, storedHashes);
      if (changed_files.length > 0) {
        hints.push({
          workflow_mode: 'replan_required',
          action: 'await_manual_intervention',
          updates: { workflow_mode: 'replan_required' },
          changed_files,
          message: 'Plan artifacts changed after the last recorded session',
        });
      }
    }
  }

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

  // Dirty-phase detection — rollback current_phase to earliest phase
  // that has needs_revalidation tasks, ensuring earlier invalidated work
  // is re-executed before proceeding with later phases.
  // Priority: placed before research expiry because dirty-phase rollback is a
  // safety-critical action (prevents executing later phases on stale foundations).
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

  // Only over execution or review: a refresh restores the workflow from
  // current_review afterwards, so a hold the user or the planner owes an
  // answer to (awaiting_user, paused_by_user, planning, reconcile, replan,
  // awaiting_clear) came back as execution without that answer.
  const expired_research = REFRESH_MODES.includes(state.workflow_mode) ? collectExpiredResearch(state) : [];
  if (expired_research.length > 0) {
    hints.push({
      workflow_mode: 'research_refresh_needed',
      action: 'dispatch_researcher',
      updates: { workflow_mode: 'research_refresh_needed' },
      expired_research,
      current_decision_index: state.research?.decision_index || {},
      message: 'Research cache expired and must be refreshed before execution resumes',
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
  // Every checkpointed task, the same set selectRunnableTask triggers the
  // review on. Leaving L0 out (an L0 task normally auto-accepts and is never
  // checkpointed; a level lowered after checkpoint is) gave the reviewer
  // nothing to accept it by, and the review came back every resume.
  return (phase.todo || []).filter((task) => task.lifecycle === 'checkpointed');
}

function getPhaseAndTask(state, taskId) {
  for (const phase of (state.phases || [])) {
    const task = getTaskById(phase, taskId);
    if (task) return { phase, task };
  }
  return { phase: null, task: null };
}

function getDebugTarget(phase, task, currentReview, workspaceRoot) {
  if (!phase || !task) return null;
  return {
    id: task.id,
    level: task.level || 'L1',
    retry_count: task.retry_count || 0,
    error_fingerprint: task.last_error_fingerprint || currentReview?.error_fingerprint || null,
    last_failure_summary: task.last_failure_summary || currentReview?.summary || null,
    ...taskRefsForAgent(task, workspaceRoot),
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
      if (decision && typeof decision === 'object' && (typeof decision.summary === 'string' || typeof decision.title === 'string')) {
        const summary = decision.summary || decision.title;
        return {
          id: decision.id || `decision:${phaseId}:${taskId}:${existingCount + index + 1}`,
          phase: decision.phase ?? phaseId,
          task: decision.task ?? taskId,
          ...decision,
          summary,
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
  return combined.length > 0 ? combined.slice(0, 120) : (result.summary || '').slice(0, 80);
}

function getBlockedReasonFromResult(result) {
  const firstBlocker = (result.blockers || [])[0];
  if (!firstBlocker) return { blocked_reason: result.summary, unblock_condition: null };
  if (typeof firstBlocker === 'string') {
    return { blocked_reason: firstBlocker, unblock_condition: null };
  }
  return {
    // `description` is the field the MCP tool schema advertised for several
    // releases while this function only ever read `reason`, so every blocker an
    // agent produced by following the published contract lost its text and
    // fell back to the generic summary. The schema says `reason` now; this
    // keeps reading the old name so executors still following the shipped text
    // are not silently degraded.
    blocked_reason: firstBlocker.reason || firstBlocker.description || result.summary,
    unblock_condition: firstBlocker.unblock_condition || null,
  };
}

async function persist(basePath, updates, { _append_decisions, _propagation_tasks, expectedVersion } = {}) {
  const result = await update({ updates, basePath, expectedVersion, _append_decisions, _propagation_tasks });
  if (result.error) {
    return result;
  }
  return null;
}

// persist variant that returns merged state from update(), avoiding re-reads
async function persistAndRead(basePath, updates, { _append_decisions, _propagation_tasks, expectedVersion } = {}) {
  const result = await update({ updates, basePath, expectedVersion, _append_decisions, _propagation_tasks });
  if (result.error) {
    return { error: true, ...result };
  }
  return result.state;
}

function buildExecutorDispatch(state, phase, task, extras = {}, workspaceRoot) {
  const context = buildExecutorContext(state, task.id, phase.id, workspaceRoot);
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
  MAX_FIX_DIRECTIONS,
  MAX_RESUME_DEPTH,
  CONTEXT_RESUME_THRESHOLD,
  MAX_PHASE_REVIEW_RETRY,
  REFRESH_MODES,
  skipsPreflight,
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
