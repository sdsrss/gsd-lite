// Shared E2E test utilities
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, read, update, addEvidence, phaseComplete, pruneEvidence } from '../src/tools/state/index.js';

export async function createTempDir() {
  return mkdtemp(join(tmpdir(), 'gsd-e2e-'));
}

export async function removeTempDir(dir) {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Initialize a project with customizable phases.
 * Default: 2 phases, 2+1 tasks, L1 levels, simple dependency chain.
 */
export async function initProject(basePath, opts = {}) {
  return init({
    project: opts.project || 'e2e-test',
    phases: opts.phases || [
      { name: 'Phase 1', tasks: [
        { index: 1, name: 'Task A', level: 'L1', requires: [] },
        { index: 2, name: 'Task B', level: 'L1', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }] },
      ]},
      { name: 'Phase 2', tasks: [
        { index: 1, name: 'Task C', level: 'L1', requires: [{ kind: 'phase', id: 1, gate: 'accepted' }] },
      ]},
    ],
    research: opts.research ?? false,
    basePath,
  });
}

/** Walk task: pending → running → checkpointed */
export async function checkpointTask(basePath, phaseId, taskId, commit) {
  await update({ updates: { phases: [{ id: phaseId, todo: [{ id: taskId, lifecycle: 'running' }] }] }, basePath });
  await update({ updates: { phases: [{ id: phaseId, todo: [{ id: taskId, lifecycle: 'checkpointed', checkpoint_commit: commit || `commit-${taskId}` }] }] }, basePath });
}

/** Walk task: pending → running → checkpointed → accepted */
export async function acceptTask(basePath, phaseId, taskId, commit) {
  await checkpointTask(basePath, phaseId, taskId, commit);
  await update({ updates: { phases: [{ id: phaseId, todo: [{ id: taskId, lifecycle: 'accepted' }] }] }, basePath });
}

/** Write .gsd/.context-health file */
export async function writeContextHealth(basePath, percentage) {
  await writeFile(join(basePath, '.gsd', '.context-health'), String(percentage));
}

/** Complete a phase through the full handoff gate */
export async function completePhase(basePath, phaseId, opts = {}) {
  await update({ updates: { phases: [{ id: phaseId, lifecycle: 'reviewing' }] }, basePath });
  await update({ updates: { phases: [{ id: phaseId, phase_review: { status: 'accepted' } }] }, basePath });
  return phaseComplete({
    phase_id: phaseId,
    basePath,
    verification: opts.verification || { lint: { exit_code: 0 }, typecheck: { exit_code: 0 }, test: { exit_code: 0 } },
    direction_ok: opts.direction_ok ?? true,
  });
}

export { read, update, addEvidence, phaseComplete, pruneEvidence };
