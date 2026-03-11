// State CRUD tools

import { join, dirname } from 'node:path';
import { stat } from 'node:fs/promises';
import { ensureDir, readJson, writeJson, writeAtomic, getStatePath, getGitHead, isPlainObject } from '../utils.js';
import {
  CANONICAL_FIELDS,
  TASK_LIFECYCLE,
  validateResearchArtifacts,
  validateResearchDecisionIndex,
  validateResearcherResult,
  validateState,
  validateTransition,
  createInitialState,
} from '../schema.js';
import { runAll } from './verify.js';

const RESEARCH_FILES = ['STACK.md', 'ARCHITECTURE.md', 'PITFALLS.md', 'SUMMARY.md'];

// C-1: Serialize all state mutations to prevent TOCTOU races
let _mutationQueue = Promise.resolve();
function withStateLock(fn) {
  const p = _mutationQueue.then(fn);
  _mutationQueue = p.catch(() => {});
  return p;
}

function inferWorkflowModeAfterResearch(state) {
  if (state.current_review?.scope === 'phase') return 'reviewing_phase';
  if (state.current_review?.scope === 'task') return 'reviewing_task';
  return 'executing_task';
}

function normalizeResearchArtifacts(artifacts) {
  const normalized = {};
  for (const fileName of RESEARCH_FILES) {
    const content = artifacts[fileName];
    normalized[fileName] = content.endsWith('\n') ? content : `${content}\n`;
  }
  return normalized;
}

/**
 * Initialize a new GSD project: creates .gsd/, state.json, plan.md, phases/
 */
export async function init({ project, phases, research, force = false, basePath = process.cwd() }) {
  if (!project || typeof project !== 'string') {
    return { error: true, message: 'project must be a non-empty string' };
  }
  if (!Array.isArray(phases)) {
    return { error: true, message: 'phases must be an array' };
  }
  const gsdDir = join(basePath, '.gsd');
  const statePath = join(gsdDir, 'state.json');

  // Guard: reject re-initialization unless force is set
  if (!force) {
    try {
      await stat(statePath);
      return { error: true, message: 'state.json already exists; pass force: true to reinitialize' };
    } catch {} // File doesn't exist, proceed
  }

  const phasesDir = join(gsdDir, 'phases');

  await ensureDir(phasesDir);
  if (research) {
    await ensureDir(join(gsdDir, 'research'));
  }

  const state = createInitialState({ project, phases });
  if (state.error) return state;
  state.git_head = await getGitHead(basePath);

  // Create plan.md placeholder (atomic write)
  await writeAtomic(
    join(gsdDir, 'plan.md'),
    `# ${project}\n\nPlan placeholder — populate during planning phase.\n`,
  );

  // Create phase placeholder .md files (atomic writes)
  for (const phase of state.phases) {
    await writeAtomic(
      join(phasesDir, `phase-${phase.id}.md`),
      `# Phase ${phase.id}: ${phase.name}\n\nTasks and details go here.\n`,
    );
  }

  const trackedFiles = [
    join(gsdDir, 'plan.md'),
    ...state.phases.map((phase) => join(phasesDir, `phase-${phase.id}.md`)),
  ];
  const mtimes = await Promise.all(trackedFiles.map(async (filePath) => (await stat(filePath)).mtimeMs));
  state.context.last_session = new Date(Math.ceil(Math.max(...mtimes))).toISOString();
  await writeJson(join(gsdDir, 'state.json'), state);

  return { success: true };
}

/**
 * Read state.json, optionally filtering to specific fields.
 */
export async function read({ fields, basePath = process.cwd() } = {}) {
  const statePath = getStatePath(basePath);
  if (!statePath) {
    return { error: true, message: 'No .gsd directory found' };
  }

  const result = await readJson(statePath);
  if (!result.ok) {
    return { error: true, message: result.error };
  }
  const state = result.data;

  if (fields && Array.isArray(fields) && fields.length > 0) {
    const filtered = {};
    for (const key of fields) {
      if (key in state) {
        filtered[key] = state[key];
      }
    }
    return filtered;
  }

  return state;
}

/**
 * Update state.json with canonical field guard and full validation.
 */
export async function update({ updates, basePath = process.cwd() } = {}) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return { error: true, message: 'updates must be a non-null object' };
  }
  // Guard: reject non-canonical fields
  const nonCanonical = Object.keys(updates).filter(
    (key) => !CANONICAL_FIELDS.includes(key),
  );
  if (nonCanonical.length > 0) {
    return {
      error: true,
      message: `Non-canonical fields rejected: ${nonCanonical.join(', ')}`,
    };
  }

  const statePath = getStatePath(basePath);
  if (!statePath) {
    return { error: true, message: 'No .gsd directory found' };
  }

  return withStateLock(async () => {
    const result = await readJson(statePath);
    if (!result.ok) {
      return { error: true, message: result.error };
    }
    const state = result.data;

    // Validate lifecycle transitions before merging
    if (updates.phases && Array.isArray(updates.phases)) {
      for (const newPhase of updates.phases) {
        const oldPhase = state.phases.find(p => p.id === newPhase.id);
        if (!oldPhase) continue;

        // Check phase lifecycle transition
        if (newPhase.lifecycle && newPhase.lifecycle !== oldPhase.lifecycle) {
          const tr = validateTransition('phase', oldPhase.lifecycle, newPhase.lifecycle);
          if (!tr.valid) return { error: true, message: tr.error };
        }

        // Check task lifecycle transitions
        if (Array.isArray(newPhase.todo)) {
          for (const newTask of newPhase.todo) {
            const oldTask = (oldPhase.todo || []).find(t => t.id === newTask.id);
            if (!oldTask) continue;
            if (newTask.lifecycle && newTask.lifecycle !== oldTask.lifecycle) {
              const tr = validateTransition('task', oldTask.lifecycle, newTask.lifecycle);
              if (!tr.valid) return { error: true, message: tr.error };
            }
          }
        }
      }
    }

    // Deep merge phases by ID instead of shallow replace [I-1]
    const merged = { ...state, ...updates };
    if (updates.phases && Array.isArray(updates.phases)) {
      merged.phases = state.phases.map(oldPhase => {
        const newPhase = updates.phases.find(p => p.id === oldPhase.id);
        if (!newPhase) return oldPhase;
        const mergedPhase = { ...oldPhase, ...newPhase };
        if (isPlainObject(oldPhase.phase_review) || isPlainObject(newPhase.phase_review)) {
          mergedPhase.phase_review = { ...oldPhase.phase_review, ...newPhase.phase_review };
        }
        if (isPlainObject(oldPhase.phase_handoff) || isPlainObject(newPhase.phase_handoff)) {
          mergedPhase.phase_handoff = { ...oldPhase.phase_handoff, ...newPhase.phase_handoff };
        }
        // Deep merge tasks within phase by ID
        if (Array.isArray(newPhase.todo)) {
          mergedPhase.todo = oldPhase.todo.map(oldTask => {
            const newTask = newPhase.todo.find(t => t.id === oldTask.id);
            return newTask ? { ...oldTask, ...newTask } : oldTask;
          });
          // Add any new tasks not in old phase
          for (const newTask of newPhase.todo) {
            if (!oldPhase.todo.find(t => t.id === newTask.id)) {
              mergedPhase.todo.push(newTask);
            }
          }
        }
        return mergedPhase;
      });
      // Add any new phases not in old state
      for (const newPhase of updates.phases) {
        if (!state.phases.find(p => p.id === newPhase.id)) {
          merged.phases.push(newPhase);
        }
      }
    }

    // Validate full state after merge
    const validation = validateState(merged);
    if (!validation.valid) {
      return {
        error: true,
        message: `Validation failed: ${validation.errors.join('; ')}`,
      };
    }

    await writeJson(statePath, merged);
    return { success: true };
  });
}

/**
 * Complete a phase: checks handoff gate, transitions lifecycle, increments current_phase.
 */
function verificationPassed(verification) {
  if (!verification || typeof verification !== 'object') return false;
  if ('passed' in verification) return verification.passed === true;
  return ['lint', 'typecheck', 'test'].every((key) => (
    verification[key]
    && typeof verification[key].exit_code === 'number'
    && verification[key].exit_code === 0
  ));
}

function verificationSummary(verification) {
  if (!verification || typeof verification !== 'object') return 'no verification details';
  return ['lint', 'typecheck', 'test']
    .filter((key) => verification[key])
    .map((key) => `${key}:${verification[key].exit_code}`)
    .join(', ');
}

export async function phaseComplete({
  phase_id,
  basePath = process.cwd(),
  verification,
  run_verify = false,
  direction_ok,
} = {}) {
  if (typeof phase_id !== 'number') {
    return { error: true, message: 'phase_id must be a number' };
  }
  if (verification != null && (typeof verification !== 'object' || Array.isArray(verification))) {
    return { error: true, message: 'verification must be an object when provided' };
  }
  if (typeof run_verify !== 'boolean') {
    return { error: true, message: 'run_verify must be a boolean' };
  }
  if (direction_ok !== undefined && typeof direction_ok !== 'boolean') {
    return { error: true, message: 'direction_ok must be a boolean when provided' };
  }
  const statePath = getStatePath(basePath);
  if (!statePath) {
    return { error: true, message: 'No .gsd directory found' };
  }

  return withStateLock(async () => {
    const result = await readJson(statePath);
    if (!result.ok) {
      return { error: true, message: result.error };
    }
    const state = result.data;

    const phase = state.phases.find((p) => p.id === phase_id);
    if (!phase) {
      return { error: true, message: `Phase ${phase_id} not found` };
    }
    if (!Array.isArray(phase.todo)) {
      return { error: true, message: `Phase ${phase_id} has invalid todo list` };
    }
    if (!phase.phase_handoff || typeof phase.phase_handoff !== 'object') {
      return { error: true, message: `Phase ${phase_id} is missing phase_handoff metadata` };
    }

    // Validate phase lifecycle transition FIRST (fail-fast) [I-4]
    const transitionResult = validateTransition(
      'phase',
      phase.lifecycle,
      'accepted',
    );
    if (!transitionResult.valid) {
      return { error: true, message: transitionResult.error };
    }

    // Check handoff gate: all tasks must be accepted
    const pendingTasks = phase.todo.filter((t) => t.lifecycle !== 'accepted');
    if (pendingTasks.length > 0) {
      return {
        error: true,
        message: `Handoff gate not met: ${pendingTasks.length} task(s) not accepted — ${pendingTasks.map((t) => `${t.id}:${t.lifecycle}`).join(', ')}`,
      };
    }

    // Check critical issues
    if (phase.phase_handoff.critical_issues_open > 0) {
      return {
        error: true,
        message: `Handoff gate not met: ${phase.phase_handoff.critical_issues_open} critical issue(s) open`,
      };
    }

    const reviewPassed = phase.phase_review?.status === 'accepted'
      || phase.phase_handoff.required_reviews_passed === true;
    if (!reviewPassed) {
      return {
        error: true,
        message: 'Handoff gate not met: required reviews not passed',
      };
    }

    const verificationResult = verification || (run_verify ? await runAll(basePath) : null);
    const testsPassed = verificationResult
      ? verificationPassed(verificationResult)
      : phase.phase_handoff.tests_passed === true;
    if (!testsPassed) {
      return {
        error: true,
        message: `Handoff gate not met: verification checks failed — ${verificationSummary(verificationResult)}`,
      };
    }

    const directionOk = direction_ok ?? phase.phase_handoff.direction_ok;
    if (directionOk === false) {
      state.workflow_mode = 'awaiting_user';
      state.current_task = null;
      state.current_review = {
        scope: 'phase',
        scope_id: phase.id,
        stage: 'direction_drift',
        summary: `Direction drift detected for phase ${phase.id}`,
      };
      phase.phase_handoff.direction_ok = false;
      const driftValidation = validateState(state);
      if (!driftValidation.valid) {
        return { error: true, message: `Validation failed: ${driftValidation.errors.join('; ')}` };
      }
      await writeJson(statePath, state);
      return {
        error: true,
        message: 'Handoff gate not met: direction drift detected, awaiting user decision',
        workflow_mode: 'awaiting_user',
        phase_id: phase.id,
      };
    }

    // Apply transition
    phase.lifecycle = 'accepted';
    phase.phase_handoff.required_reviews_passed = reviewPassed;
    phase.phase_handoff.tests_passed = testsPassed;
    if (direction_ok !== undefined) {
      phase.phase_handoff.direction_ok = direction_ok;
    }

    // Increment current_phase if this was the active phase
    if (state.current_phase === phase_id && phase_id < state.total_phases) {
      state.current_phase = phase_id + 1;
      // Activate the next phase
      const nextPhase = state.phases.find((p) => p.id === state.current_phase);
      if (nextPhase && nextPhase.lifecycle === 'pending') {
        nextPhase.lifecycle = 'active';
      }
    }

    // Update git_head to current commit
    const gsdDir = dirname(statePath);
    state.git_head = await getGitHead(dirname(gsdDir));

    // Prune evidence from old phases (in-memory to avoid double read/write)
    await _pruneEvidenceFromState(state, state.current_phase, gsdDir);

    await writeJson(statePath, state);
    return { success: true };
  });
}

/**
 * Add an evidence entry to state.evidence keyed by id.
 */
export async function addEvidence({ id, data, basePath = process.cwd() }) {
  // I-8: Validate inputs
  if (!id || typeof id !== 'string') {
    return { error: true, message: 'id must be a non-empty string' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { error: true, message: 'data must be a non-null object' };
  }
  if (typeof data.scope !== 'string') {
    return { error: true, message: 'data.scope must be a string' };
  }

  const statePath = getStatePath(basePath);
  if (!statePath) {
    return { error: true, message: 'No .gsd directory found' };
  }

  return withStateLock(async () => {
    const result = await readJson(statePath);
    if (!result.ok) {
      return { error: true, message: result.error };
    }
    const state = result.data;

    if (!state.evidence) {
      state.evidence = {};
    }

    state.evidence[id] = data;
    await writeJson(statePath, state);
    return { success: true };
  });
}

/**
 * Internal: prune evidence in-memory and write archive file.
 * Mutates state.evidence. Returns count of archived entries.
 */
async function _pruneEvidenceFromState(state, currentPhase, gsdDir) {
  if (!state.evidence) return 0;

  const threshold = currentPhase - 1;
  const toArchive = {};
  const toKeep = {};

  for (const [id, entry] of Object.entries(state.evidence)) {
    const phaseNum = parseScopePhase(entry.scope);
    if (phaseNum !== null && phaseNum < threshold) {
      toArchive[id] = entry;
    } else {
      toKeep[id] = entry;
    }
  }

  const archivedCount = Object.keys(toArchive).length;

  if (archivedCount > 0) {
    const archivePath = join(gsdDir, 'evidence-archive.json');
    const existing = await readJson(archivePath);
    const archive = existing.ok ? existing.data : {};
    Object.assign(archive, toArchive);
    await writeJson(archivePath, archive);

    state.evidence = toKeep;
  }

  return archivedCount;
}

/**
 * Prune evidence: archive entries from phases older than currentPhase - 1.
 * Scope format is "task:X.Y" where X is the phase number.
 */
export async function pruneEvidence({ currentPhase, basePath = process.cwd() }) {
  const statePath = getStatePath(basePath);
  if (!statePath) {
    return { error: true, message: 'No .gsd directory found' };
  }

  return withStateLock(async () => {
    const result = await readJson(statePath);
    if (!result.ok) {
      return { error: true, message: result.error };
    }
    const state = result.data;

    const gsdDir = dirname(statePath);
    const archived = await _pruneEvidenceFromState(state, currentPhase, gsdDir);
    if (archived > 0) await writeJson(statePath, state);

    return { success: true, archived };
  });
}

/**
 * Parse phase number from scope string like "task:X.Y" → X.
 * Returns null if scope is missing or doesn't match.
 */
function parseScopePhase(scope) {
  if (typeof scope !== 'string') return null;
  const match = scope.match(/^task:(\d+)\./);
  return match ? parseInt(match[1], 10) : null;
}

// ── Automation functions ──

const DEFAULT_MAX_RETRY = 3;

/**
 * Select the next runnable task from a phase, respecting dependency gates.
 * Returns { task } if a runnable task is found,
 * { mode: 'trigger_review' } if all remaining are checkpointed,
 * { mode: 'awaiting_user', blockers } if all are blocked,
 * { task: undefined } if nothing can run.
 * @param {object} phase - Phase object with todo array
 * @param {object} state - Full state object
 * @param {object} [options] - Options
 * @param {number} [options.maxRetry=3] - Maximum retry count before skipping a task
 */
export function selectRunnableTask(phase, state, { maxRetry = DEFAULT_MAX_RETRY } = {}) {
  if (!phase || !Array.isArray(phase.todo)) {
    return { error: true, message: 'Phase todo must be an array' };
  }
  const runnableTasks = [];

  for (const task of phase.todo) {
    if (!['pending', 'needs_revalidation'].includes(task.lifecycle)) continue;
    if (task.retry_count >= maxRetry) continue;
    if (task.blocked_reason) continue;

    let depsOk = true;
    for (const dep of (task.requires || [])) {
      if (dep.kind === 'task') {
        const depTask = phase.todo.find(t => t.id === dep.id);
        if (!depTask) { depsOk = false; break; }
        const gate = dep.gate || 'accepted';
        if (gate === 'checkpoint' && !['checkpointed', 'accepted'].includes(depTask.lifecycle)) { depsOk = false; break; }
        if (gate === 'accepted' && depTask.lifecycle !== 'accepted') { depsOk = false; break; }
        if (gate === 'phase_complete') { depsOk = false; break; } // phase_complete is only valid on phase-kind deps
      } else if (dep.kind === 'phase') {
        const depPhase = (state.phases || []).find(p => p.id === dep.id);
        if (!depPhase || depPhase.lifecycle !== 'accepted') { depsOk = false; break; }
      }
    }
    if (depsOk) runnableTasks.push(task);
  }

  if (runnableTasks.length > 0) {
    return { task: runnableTasks[0] };
  }

  const awaitingReview = phase.todo.filter(t => t.lifecycle === 'checkpointed');
  if (awaitingReview.length > 0) {
    return { mode: 'trigger_review' };
  }

  // All tasks accepted → trigger phase review if not already reviewed
  const allAccepted = phase.todo.length > 0 && phase.todo.every(t => t.lifecycle === 'accepted');
  if (allAccepted && phase.phase_review?.status !== 'accepted') {
    return { mode: 'trigger_review' };
  }

  const blockedTasks = phase.todo.filter(t => t.lifecycle === 'blocked');
  if (blockedTasks.length > 0) {
    return { mode: 'awaiting_user', blockers: blockedTasks.map(t => ({ id: t.id, reason: t.blocked_reason })) };
  }

  // Diagnose why no task is runnable
  const diagnostics = [];
  for (const task of phase.todo) {
    if (task.lifecycle === 'accepted' || task.lifecycle === 'failed') continue;
    const reasons = [];
    if (!['pending', 'needs_revalidation'].includes(task.lifecycle)) {
      reasons.push(`lifecycle=${task.lifecycle}`);
    }
    if (task.retry_count >= maxRetry) {
      reasons.push(`retry_count=${task.retry_count} >= max=${maxRetry}`);
    }
    if (task.blocked_reason) {
      reasons.push(`blocked: ${task.blocked_reason}`);
    }
    for (const dep of (task.requires || [])) {
      if (dep.kind === 'task') {
        const depTask = phase.todo.find(t => t.id === dep.id);
        const gate = dep.gate || 'accepted';
        if (!depTask) {
          reasons.push(`dep ${dep.id} not found`);
        } else if (gate === 'checkpoint' && !['checkpointed', 'accepted'].includes(depTask.lifecycle)) {
          reasons.push(`dep ${dep.id} needs checkpoint (is ${depTask.lifecycle})`);
        } else if (gate === 'accepted' && depTask.lifecycle !== 'accepted') {
          reasons.push(`dep ${dep.id} needs accepted (is ${depTask.lifecycle})`);
        } else if (gate === 'phase_complete') {
          reasons.push(`dep ${dep.id} has phase_complete gate (invalid for task-kind dependency)`);
        }
      } else if (dep.kind === 'phase') {
        const depPhase = (state.phases || []).find(p => p.id === dep.id);
        if (!depPhase || depPhase.lifecycle !== 'accepted') {
          reasons.push(`phase dep ${dep.id} not accepted`);
        }
      }
    }
    if (reasons.length > 0) {
      diagnostics.push({ id: task.id, reasons });
    }
  }

  return { task: undefined, diagnostics };
}

/**
 * Propagate invalidation to downstream dependents when a task is reworked.
 * If contractChanged is true, all transitive dependents get needs_revalidation
 * and their evidence_refs are cleared.
 */
export function propagateInvalidation(phase, reworkTaskId, contractChanged) {
  if (!contractChanged) return;

  const affected = new Set();
  const queue = [reworkTaskId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    for (const task of phase.todo) {
      if (affected.has(task.id)) continue;
      const dependsOnCurrent = (task.requires || []).some(dep =>
        dep.kind === 'task' && dep.id === currentId
      );
      if (dependsOnCurrent) {
        affected.add(task.id);
        queue.push(task.id);
      }
    }
  }

  // C-2: Only transition tasks whose lifecycle allows needs_revalidation
  const canInvalidate = new Set(
    Object.entries(TASK_LIFECYCLE)
      .filter(([, targets]) => targets.includes('needs_revalidation'))
      .map(([state]) => state),
  );
  for (const task of phase.todo) {
    if (affected.has(task.id) && canInvalidate.has(task.lifecycle)) {
      task.lifecycle = 'needs_revalidation';
      task.evidence_refs = [];
    }
  }
}

/**
 * Build executor context for a task: 6-field protocol.
 * Returns { task_spec, research_decisions, predecessor_outputs, project_conventions, workflows, constraints }.
 */
export function buildExecutorContext(state, taskId, phaseId) {
  const phase = state.phases.find(p => p.id === phaseId);
  if (!phase) {
    return { error: true, message: `Phase ${phaseId} not found` };
  }
  if (!Array.isArray(phase.todo)) {
    return { error: true, message: `Phase ${phaseId} has invalid todo list` };
  }
  const task = phase.todo.find(t => t.id === taskId);
  if (!task) {
    return { error: true, message: `Task ${taskId} not found in phase ${phaseId}` };
  }

  const task_spec = `phases/phase-${phaseId}.md`;

  const research_decisions = (task.research_basis || []).map(id => {
    const decision = state.research?.decision_index?.[id];
    return decision ? { id, ...decision } : { id, summary: 'not found' };
  });

  const predecessor_outputs = (task.requires || [])
    .filter(dep => dep.kind === 'task')
    .map(dep => {
      const depTask = phase.todo.find(t => t.id === dep.id);
      return depTask ? { files_changed: depTask.files_changed || [], checkpoint_commit: depTask.checkpoint_commit } : null;
    })
    .filter(Boolean);

  const project_conventions = 'CLAUDE.md';
  const workflows = ['workflows/tdd-cycle.md', 'workflows/deviation-rules.md'];
  if ((task.retry_count || 0) > 0) workflows.push('workflows/debugging.md');
  if ((task.research_basis || []).length > 0) workflows.push('workflows/research.md');
  const constraints = {
    retry_count: task.retry_count || 0,
    level: task.level || 'L1',
    review_required: task.review_required !== false,
  };

  const debugger_guidance = task.debug_context ? {
    root_cause: task.debug_context.root_cause,
    fix_direction: task.debug_context.fix_direction,
    fix_attempts: task.debug_context.fix_attempts,
    evidence: task.debug_context.evidence || [],
  } : null;

  return {
    task_spec,
    research_decisions,
    predecessor_outputs,
    project_conventions,
    workflows,
    constraints,
    debugger_guidance,
  };
}

const SENSITIVE_KEYWORDS = /\b(auth|payment|security|public.?api|login|token|credential|session|oauth)\b/i;

/**
 * Reclassify review level at runtime based on executor results.
 * Upgrades L1→L2 when contract_changed + sensitive keywords or [LEVEL-UP].
 * Never downgrades.
 */
export function reclassifyReviewLevel(task, executorResult) {
  const currentLevel = task.level || 'L1';

  // Never downgrade
  if (currentLevel === 'L2' || currentLevel === 'L3') {
    return currentLevel;
  }

  // Check for explicit [LEVEL-UP] in decisions
  const hasLevelUp = (executorResult.decisions || []).some(d =>
    typeof d === 'string' && d.includes('[LEVEL-UP]')
  );
  if (hasLevelUp) return 'L2';

  // Check for contract change + sensitive keyword in task name
  if (executorResult.contract_changed && SENSITIVE_KEYWORDS.test(task.name || '')) {
    return 'L2';
  }

  return currentLevel;
}

const MIN_TOKEN_LENGTH = 2;
const MIN_OVERLAP = 2;

/**
 * Tokenize a string into lowercase tokens, splitting on whitespace and punctuation.
 * Filters out short tokens (< MIN_TOKEN_LENGTH).
 */
function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[\s,.:;!?()[\]{}<>/\\|@#$%^&*+=~`'"，。：；！？（）【】、]+/)
    .filter(t => t.length >= MIN_TOKEN_LENGTH);
}

/**
 * Match a blocked reason against research decisions by keyword overlap.
 * Returns the best-matching decision or null if no sufficient overlap.
 */
export function matchDecisionForBlocker(decisions, blockedReason) {
  const reasonTokens = new Set(tokenize(blockedReason));
  if (reasonTokens.size === 0) return null;

  let bestMatch = null;
  let bestOverlap = 0;

  for (const decision of decisions) {
    const summaryTokens = tokenize(decision.summary);
    let overlap = 0;
    for (const token of summaryTokens) {
      if (reasonTokens.has(token)) {
        overlap++;
      }
    }
    if (overlap >= MIN_OVERLAP && overlap > bestOverlap) {
      bestOverlap = overlap;
      bestMatch = decision;
    }
  }

  return bestMatch;
}

/**
 * Apply research refresh: compare new research decisions against existing state.
 * 4 rules:
 *   1. Same ID + same summary → update metadata (e.g. expires_at), keep task lifecycle
 *   2. Same ID + changed summary → invalidate dependent tasks (needs_revalidation)
 *   3. Old ID missing from new → invalidate dependent tasks + warning
 *   4. Brand new ID → add to index, no impact on existing tasks
 * Returns { warnings: string[] }.
 */
export function applyResearchRefresh(state, newResearch) {
  const warnings = [];
  const oldIndex = state.research?.decision_index || {};
  const newIndex = newResearch?.decision_index || {};

  // Collect IDs of decisions that changed or were removed
  const invalidatedIds = new Set();

  // Check existing decisions against new
  for (const [id, oldDecision] of Object.entries(oldIndex)) {
    if (id in newIndex) {
      const newDecision = newIndex[id];
      if (oldDecision.summary === newDecision.summary) {
        // Rule 1: same conclusion — update metadata in place
        Object.assign(oldIndex[id], newDecision);
      } else {
        // Rule 2: changed conclusion — replace and invalidate
        oldIndex[id] = newDecision;
        invalidatedIds.add(id);
      }
    } else {
      // Rule 3: old ID missing from new research
      invalidatedIds.add(id);
      warnings.push(`Decision "${id}" removed in new research — dependent tasks invalidated`);
    }
  }

  // Rule 4: brand new IDs — just add them
  for (const [id, newDecision] of Object.entries(newIndex)) {
    if (!(id in oldIndex)) {
      oldIndex[id] = newDecision;
    }
  }

  // Ensure decision_index is set on state
  if (!state.research) state.research = {};
  state.research.decision_index = oldIndex;

  // C-3: Only invalidate tasks whose lifecycle allows needs_revalidation
  if (invalidatedIds.size > 0) {
    const canInvalidate = new Set(
      Object.entries(TASK_LIFECYCLE)
        .filter(([, targets]) => targets.includes('needs_revalidation'))
        .map(([s]) => s),
    );
    for (const phase of (state.phases || [])) {
      for (const task of (phase.todo || [])) {
        const basis = task.research_basis || [];
        const affected = basis.some(id => invalidatedIds.has(id));
        if (affected && canInvalidate.has(task.lifecycle)) {
          task.lifecycle = 'needs_revalidation';
          if (task.evidence_refs) task.evidence_refs = [];
        }
      }
    }
  }

  return { warnings };
}

export async function storeResearch({ result, artifacts, decision_index, basePath = process.cwd() } = {}) {
  const resultValidation = validateResearcherResult(result || {});
  if (!resultValidation.valid) {
    return { error: true, message: `Invalid researcher result: ${resultValidation.errors.join('; ')}` };
  }

  const artifactsValidation = validateResearchArtifacts(artifacts, {
    decisionIds: result.decision_ids,
    volatility: result.volatility,
    expiresAt: result.expires_at,
  });
  if (!artifactsValidation.valid) {
    return { error: true, message: `Invalid research artifacts: ${artifactsValidation.errors.join('; ')}` };
  }

  const decisionIndexValidation = validateResearchDecisionIndex(decision_index, result.decision_ids);
  if (!decisionIndexValidation.valid) {
    return { error: true, message: `Invalid research decision_index: ${decisionIndexValidation.errors.join('; ')}` };
  }

  const statePath = getStatePath(basePath);
  if (!statePath) {
    return { error: true, message: 'No .gsd directory found' };
  }

  return withStateLock(async () => {
    const current = await readJson(statePath);
    if (!current.ok) {
      return { error: true, message: current.error };
    }

    const state = current.data;
    const gsdDir = dirname(statePath);
    const researchDir = join(gsdDir, 'research');
    await ensureDir(researchDir);

    const normalizedArtifacts = normalizeResearchArtifacts(artifacts);
    for (const fileName of RESEARCH_FILES) {
      await writeAtomic(join(researchDir, fileName), normalizedArtifacts[fileName]);
    }

    const nextResearch = {
      volatility: result.volatility,
      expires_at: result.expires_at,
      sources: result.sources,
      decision_index,
      files: RESEARCH_FILES,
      updated_at: new Date().toISOString(),
    };

    const refreshResult = state.research
      ? applyResearchRefresh(state, nextResearch)
      : { warnings: [] };

    state.research = {
      ...(state.research || {}),
      ...nextResearch,
      decision_index: state.research?.decision_index || decision_index,
    };

    if (state.workflow_mode === 'research_refresh_needed') {
      state.workflow_mode = inferWorkflowModeAfterResearch(state);
    }

    const validation = validateState(state);
    if (!validation.valid) {
      return { error: true, message: `State validation failed: ${validation.errors.join('; ')}` };
    }

    await writeJson(statePath, state);
    return {
      success: true,
      workflow_mode: state.workflow_mode,
      stored_files: RESEARCH_FILES,
      decision_ids: result.decision_ids,
      warnings: refreshResult.warnings,
      research: state.research,
    };
  });
}
