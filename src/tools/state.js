// State CRUD tools

import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { ensureDir, readJson, writeJson, getStatePath } from '../utils.js';
import {
  CANONICAL_FIELDS,
  validateState,
  validateTransition,
  createInitialState,
} from '../schema.js';

/**
 * Initialize a new GSD project: creates .gsd/, state.json, plan.md, phases/
 */
export async function init({ project, phases, basePath = process.cwd() }) {
  const gsdDir = join(basePath, '.gsd');
  const phasesDir = join(gsdDir, 'phases');

  await ensureDir(gsdDir);
  await ensureDir(phasesDir);

  const state = createInitialState({ project, phases });
  await writeJson(join(gsdDir, 'state.json'), state);

  // Create plan.md placeholder
  await writeFile(
    join(gsdDir, 'plan.md'),
    `# ${project}\n\nPlan placeholder — populate during planning phase.\n`,
    'utf-8',
  );

  // Create phase placeholder .md files
  for (const phase of state.phases) {
    await writeFile(
      join(phasesDir, `phase-${phase.id}.md`),
      `# Phase ${phase.id}: ${phase.name}\n\nTasks and details go here.\n`,
      'utf-8',
    );
  }

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

  const state = await readJson(statePath);
  if (state.error) {
    return state;
  }

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
export async function update({ updates, basePath = process.cwd() }) {
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

  const state = await readJson(statePath);
  if (state.error) {
    return state;
  }

  // Merge updates into state
  const merged = { ...state, ...updates };

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
}

/**
 * Complete a phase: checks handoff gate, transitions lifecycle, increments current_phase.
 */
export async function phaseComplete({ phase_id, basePath = process.cwd() }) {
  const statePath = getStatePath(basePath);
  if (!statePath) {
    return { error: true, message: 'No .gsd directory found' };
  }

  const state = await readJson(statePath);
  if (state.error) {
    return state;
  }

  const phase = state.phases.find((p) => p.id === phase_id);
  if (!phase) {
    return { error: true, message: `Phase ${phase_id} not found` };
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

  // Validate phase lifecycle transition
  const transitionResult = validateTransition(
    'phase',
    phase.lifecycle,
    'accepted',
  );
  if (!transitionResult.valid) {
    return { error: true, message: transitionResult.error };
  }

  // Apply transition
  phase.lifecycle = 'accepted';
  phase.phase_handoff.required_reviews_passed = true;
  phase.phase_handoff.tests_passed = true;

  // Increment current_phase if this was the active phase
  if (state.current_phase === phase_id && phase_id < state.total_phases) {
    state.current_phase = phase_id + 1;
  }

  await writeJson(statePath, state);
  return { success: true };
}

/**
 * Add an evidence entry to state.evidence keyed by id.
 */
export async function addEvidence({ id, data, basePath = process.cwd() }) {
  const statePath = getStatePath(basePath);
  if (!statePath) {
    return { error: true, message: 'No .gsd directory found' };
  }

  const state = await readJson(statePath);
  if (state.error) {
    return state;
  }

  if (!state.evidence) {
    state.evidence = {};
  }

  state.evidence[id] = data;
  await writeJson(statePath, state);
  return { success: true };
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

  const state = await readJson(statePath);
  if (state.error) {
    return state;
  }

  if (!state.evidence) {
    return { success: true, archived: 0 };
  }

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
    const archivePath = join(dirname(statePath), 'evidence-archive.json');
    const existing = await readJson(archivePath);
    const archive = existing.error ? {} : existing;
    Object.assign(archive, toArchive);
    await writeJson(archivePath, archive);

    state.evidence = toKeep;
    await writeJson(statePath, state);
  }

  return { success: true, archived: archivedCount };
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

const MAX_RETRY = 3;

/**
 * Select the next runnable task from a phase, respecting dependency gates.
 * Returns { task } if a runnable task is found,
 * { mode: 'trigger_review' } if all remaining are checkpointed,
 * { mode: 'awaiting_user', blockers } if all are blocked,
 * { task: undefined } if nothing can run.
 */
export function selectRunnableTask(phase, state) {
  const runnableTasks = [];

  for (const task of phase.todo) {
    if (!['pending', 'needs_revalidation'].includes(task.lifecycle)) continue;
    if (task.retry_count >= MAX_RETRY) continue;
    if (task.blocked_reason) continue;

    let depsOk = true;
    for (const dep of (task.requires || [])) {
      if (dep.kind === 'task') {
        const depTask = phase.todo.find(t => t.id === dep.id);
        if (!depTask) { depsOk = false; break; }
        const gate = dep.gate || 'accepted';
        if (gate === 'checkpoint' && !['checkpointed', 'accepted'].includes(depTask.lifecycle)) { depsOk = false; break; }
        if (gate === 'accepted' && depTask.lifecycle !== 'accepted') { depsOk = false; break; }
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

  const blockedTasks = phase.todo.filter(t => t.lifecycle === 'blocked');
  if (blockedTasks.length > 0) {
    return { mode: 'awaiting_user', blockers: blockedTasks.map(t => ({ id: t.id, reason: t.blocked_reason })) };
  }

  return { task: undefined };
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

  for (const task of phase.todo) {
    if (affected.has(task.id)) {
      task.lifecycle = 'needs_revalidation';
      task.evidence_refs = [];
    }
  }
}
