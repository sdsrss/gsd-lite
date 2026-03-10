import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTempDir,
  removeTempDir,
  initProject,
  acceptTask,
  completePhase,
  read,
  update,
  addEvidence,
  pruneEvidence,
} from './e2e-helpers.js';
import { readJson } from '../src/utils.js';

/**
 * Helper: create a 3-phase project with one task per phase.
 * Phase dependencies: P2 requires P1 accepted, P3 requires P2 accepted.
 */
async function init3Phase(basePath) {
  return initProject(basePath, {
    phases: [
      { name: 'P1', tasks: [{ index: 1, name: 'A', level: 'L0', requires: [] }] },
      { name: 'P2', tasks: [{ index: 1, name: 'B', level: 'L0', requires: [{ kind: 'phase', id: 1, gate: 'accepted' }] }] },
      { name: 'P3', tasks: [{ index: 1, name: 'C', level: 'L0', requires: [{ kind: 'phase', id: 2, gate: 'accepted' }] }] },
    ],
  });
}

/**
 * Helper: accept a task in a phase and set done count.
 */
async function acceptAndCountDone(basePath, phaseId, taskId, done) {
  await acceptTask(basePath, phaseId, taskId);
  await update({ updates: { phases: [{ id: phaseId, done }] }, basePath });
}

describe('E2E evidence lifecycle: archival across phase transitions', () => {

  describe('TC1: Phase 2 complete -> phase 1 evidence archived', () => {
    let basePath;

    before(async () => {
      basePath = await createTempDir();
      await init3Phase(basePath);

      // Phase 1: accept task 1.1, add evidence, complete
      await acceptAndCountDone(basePath, 1, '1.1', 1);
      await addEvidence({ id: 'ev:1.1', data: { scope: 'task:1.1', type: 'test', data: { p: 1 } }, basePath });
      await completePhase(basePath, 1);

      // Phase 2: accept task 2.1, add evidence, complete
      await acceptAndCountDone(basePath, 2, '2.1', 1);
      await addEvidence({ id: 'ev:2.1', data: { scope: 'task:2.1', type: 'test', data: { p: 2 } }, basePath });
      await completePhase(basePath, 2);
    });

    after(async () => { await removeTempDir(basePath); });

    it('ev:1.1 archived, ev:2.1 still in state', async () => {
      // After phase 2 complete: current_phase=3, threshold=2
      // Phase 1 evidence (phase=1) < 2 -> archived
      // Phase 2 evidence (phase=2) >= 2 -> kept
      const state = await read({ basePath });
      assert.equal(state.current_phase, 3);
      assert.equal(state.evidence['ev:1.1'], undefined, 'ev:1.1 should be gone from state');
      assert.ok(state.evidence['ev:2.1'], 'ev:2.1 should still be in state');

      const archive = await readJson(join(basePath, '.gsd', 'evidence-archive.json'));
      assert.equal(archive.ok, true);
      assert.ok(archive.data['ev:1.1'], 'ev:1.1 should be in archive');
      assert.equal(archive.data['ev:1.1'].scope, 'task:1.1');
    });
  });

  describe('TC2: Phase 3 complete -> phase 1+2 evidence archived', () => {
    let basePath;

    before(async () => {
      basePath = await createTempDir();
      // 4-phase project so phase 3 complete advances to phase 4
      await initProject(basePath, {
        phases: [
          { name: 'P1', tasks: [{ index: 1, name: 'A', level: 'L0', requires: [] }] },
          { name: 'P2', tasks: [{ index: 1, name: 'B', level: 'L0', requires: [{ kind: 'phase', id: 1, gate: 'accepted' }] }] },
          { name: 'P3', tasks: [{ index: 1, name: 'C', level: 'L0', requires: [{ kind: 'phase', id: 2, gate: 'accepted' }] }] },
          { name: 'P4', tasks: [{ index: 1, name: 'D', level: 'L0', requires: [{ kind: 'phase', id: 3, gate: 'accepted' }] }] },
        ],
      });

      // Phase 1
      await acceptAndCountDone(basePath, 1, '1.1', 1);
      await addEvidence({ id: 'ev:1.1', data: { scope: 'task:1.1', type: 'test', data: { p: 1 } }, basePath });
      await completePhase(basePath, 1);

      // Phase 2
      await acceptAndCountDone(basePath, 2, '2.1', 1);
      await addEvidence({ id: 'ev:2.1', data: { scope: 'task:2.1', type: 'test', data: { p: 2 } }, basePath });
      await completePhase(basePath, 2);

      // Phase 3
      await acceptAndCountDone(basePath, 3, '3.1', 1);
      await addEvidence({ id: 'ev:3.1', data: { scope: 'task:3.1', type: 'test', data: { p: 3 } }, basePath });
      await completePhase(basePath, 3);
    });

    after(async () => { await removeTempDir(basePath); });

    it('phase 1+2 evidence in archive, phase 3 kept in state', async () => {
      // After phase 3 complete: current_phase=4, threshold=3
      const state = await read({ basePath });
      assert.equal(state.current_phase, 4);
      assert.equal(state.evidence['ev:1.1'], undefined, 'ev:1.1 should be archived');
      assert.equal(state.evidence['ev:2.1'], undefined, 'ev:2.1 should be archived');
      assert.ok(state.evidence['ev:3.1'], 'ev:3.1 should still be in state');

      const archive = await readJson(join(basePath, '.gsd', 'evidence-archive.json'));
      assert.equal(archive.ok, true);
      assert.ok(archive.data['ev:1.1'], 'ev:1.1 in archive');
      assert.ok(archive.data['ev:2.1'], 'ev:2.1 in archive');
      assert.equal(archive.data['ev:3.1'], undefined, 'ev:3.1 should NOT be in archive');
    });
  });

  describe('TC3: Cumulative archival — multiple phaseComplete calls merge into archive', () => {
    let basePath;

    before(async () => {
      basePath = await createTempDir();
      await init3Phase(basePath);

      // Phase 1: add evidence, accept, complete
      await addEvidence({ id: 'ev:1.1', data: { scope: 'task:1.1', type: 'test', data: { p: 1 } }, basePath });
      await acceptAndCountDone(basePath, 1, '1.1', 1);
      await completePhase(basePath, 1);
      // current_phase=2, threshold=1. Phase 1 evidence: phase=1, 1 < 1 = false -> NOT archived yet

      // Phase 2: add evidence, accept, complete
      await addEvidence({ id: 'ev:2.1', data: { scope: 'task:2.1', type: 'test', data: { p: 2 } }, basePath });
      await acceptAndCountDone(basePath, 2, '2.1', 1);
      await completePhase(basePath, 2);
      // current_phase=3, threshold=2. Phase 1 (1 < 2) -> archived. Phase 2 (2 < 2) = false -> kept
    });

    after(async () => { await removeTempDir(basePath); });

    it('archive contains phase 1 evidence after phase 2 complete', async () => {
      const state = await read({ basePath });
      assert.equal(state.current_phase, 3);

      // Phase 1 evidence archived, phase 2 evidence kept
      assert.equal(state.evidence['ev:1.1'], undefined, 'ev:1.1 should be archived');
      assert.ok(state.evidence['ev:2.1'], 'ev:2.1 should be in state');

      const archive = await readJson(join(basePath, '.gsd', 'evidence-archive.json'));
      assert.equal(archive.ok, true);
      assert.ok(archive.data['ev:1.1'], 'ev:1.1 in archive');
    });

    it('manually prune again to archive phase 2 evidence too (merge check)', async () => {
      // Manual prune with currentPhase=4 so threshold=3 archives both phase 1 and 2
      const result = await pruneEvidence({ currentPhase: 4, basePath });
      assert.equal(result.success, true);
      assert.equal(result.archived, 1); // only ev:2.1 remaining to archive

      const state = await read({ basePath });
      assert.equal(state.evidence['ev:2.1'], undefined, 'ev:2.1 should now be archived');

      // Archive should have BOTH phase 1 and phase 2 evidence (merged, not overwritten)
      const archive = await readJson(join(basePath, '.gsd', 'evidence-archive.json'));
      assert.equal(archive.ok, true);
      assert.ok(archive.data['ev:1.1'], 'ev:1.1 still in archive after merge');
      assert.ok(archive.data['ev:2.1'], 'ev:2.1 now in archive after merge');
    });
  });

  describe('TC4: Non-standard scope evidence never archived', () => {
    let basePath;

    before(async () => {
      basePath = await createTempDir();
      await init3Phase(basePath);
      await addEvidence({ id: 'ev:global', data: { scope: 'global', type: 'config', data: { key: 'val' } }, basePath });
      await addEvidence({ id: 'ev:system', data: { scope: 'system:config', type: 'env', data: { k: 'v' } }, basePath });
    });

    after(async () => { await removeTempDir(basePath); });

    it('non-standard scopes remain in state even with high currentPhase', async () => {
      const result = await pruneEvidence({ currentPhase: 100, basePath });
      assert.equal(result.success, true);
      assert.equal(result.archived, 0, 'nothing should be archived');

      const state = await read({ basePath });
      assert.ok(state.evidence['ev:global'], 'global scope evidence kept');
      assert.ok(state.evidence['ev:system'], 'system:config scope evidence kept');
    });
  });

  describe('TC5: Empty evidence -> no archive created', () => {
    let basePath;

    before(async () => {
      basePath = await createTempDir();
      await init3Phase(basePath);
    });

    after(async () => { await removeTempDir(basePath); });

    it('pruneEvidence with no evidence returns archived=0 and no archive file', async () => {
      const result = await pruneEvidence({ currentPhase: 5, basePath });
      assert.equal(result.success, true);
      assert.equal(result.archived, 0);

      // evidence-archive.json should NOT exist
      await assert.rejects(
        access(join(basePath, '.gsd', 'evidence-archive.json')),
        'evidence-archive.json should not exist',
      );
    });
  });

  describe('TC6: All evidence in current range -> archived=0', () => {
    let basePath;

    before(async () => {
      basePath = await createTempDir();
      await init3Phase(basePath);
      await addEvidence({ id: 'ev:2.1', data: { scope: 'task:2.1', type: 'test', data: {} }, basePath });
      await addEvidence({ id: 'ev:3.1', data: { scope: 'task:3.1', type: 'test', data: {} }, basePath });
    });

    after(async () => { await removeTempDir(basePath); });

    it('pruneEvidence with currentPhase=2 archives nothing (threshold=1)', async () => {
      // threshold = 2 - 1 = 1. Phase 2 (2 < 1 = false), Phase 3 (3 < 1 = false) -> both kept
      const result = await pruneEvidence({ currentPhase: 2, basePath });
      assert.equal(result.success, true);
      assert.equal(result.archived, 0);

      const state = await read({ basePath });
      assert.ok(state.evidence['ev:2.1'], 'ev:2.1 still in state');
      assert.ok(state.evidence['ev:3.1'], 'ev:3.1 still in state');
    });
  });

  describe('TC7: phaseComplete auto-triggers pruning (integration)', () => {
    let basePath;

    before(async () => {
      basePath = await createTempDir();
      await init3Phase(basePath);

      // Add evidence for phase 1 and phase 2 tasks
      await addEvidence({ id: 'ev:1.1', data: { scope: 'task:1.1', type: 'test', data: { p: 1 } }, basePath });
      await addEvidence({ id: 'ev:2.1', data: { scope: 'task:2.1', type: 'test', data: { p: 2 } }, basePath });

      // Complete phase 1 -> current_phase=2, threshold=1. Phase 1 (1 < 1) = false -> stays
      await acceptAndCountDone(basePath, 1, '1.1', 1);
      await completePhase(basePath, 1);
    });

    after(async () => { await removeTempDir(basePath); });

    it('after phase 1 complete, phase 1 evidence stays (threshold=1, 1 < 1 = false)', async () => {
      const state = await read({ basePath });
      assert.equal(state.current_phase, 2);
      assert.ok(state.evidence['ev:1.1'], 'ev:1.1 should still be in state');
      assert.ok(state.evidence['ev:2.1'], 'ev:2.1 should still be in state');
    });

    it('after phase 2 complete, phase 1 evidence auto-archived via phaseComplete', async () => {
      // Complete phase 2 -> current_phase=3, threshold=2. Phase 1 (1 < 2) = true -> archived
      await acceptAndCountDone(basePath, 2, '2.1', 1);
      await completePhase(basePath, 2);

      const state = await read({ basePath });
      assert.equal(state.current_phase, 3);
      assert.equal(state.evidence['ev:1.1'], undefined, 'ev:1.1 should be auto-archived');
      assert.ok(state.evidence['ev:2.1'], 'ev:2.1 should still be in state (phase=2, 2 < 2 = false)');

      // Verify archive file created by phaseComplete
      const archive = await readJson(join(basePath, '.gsd', 'evidence-archive.json'));
      assert.equal(archive.ok, true);
      assert.ok(archive.data['ev:1.1'], 'ev:1.1 should be in archive');
    });
  });

  describe('TC8: First archive creation (no existing archive file)', () => {
    let basePath;

    before(async () => {
      basePath = await createTempDir();
      await init3Phase(basePath);
      await addEvidence({ id: 'ev:1.1', data: { scope: 'task:1.1', type: 'test', data: { first: true } }, basePath });
    });

    after(async () => { await removeTempDir(basePath); });

    it('pruneEvidence creates evidence-archive.json from scratch', async () => {
      // Verify archive does not exist yet
      await assert.rejects(
        access(join(basePath, '.gsd', 'evidence-archive.json')),
        'archive should not exist before pruning',
      );

      // currentPhase=3 -> threshold=2. Phase 1 (1 < 2) -> archived
      const result = await pruneEvidence({ currentPhase: 3, basePath });
      assert.equal(result.success, true);
      assert.equal(result.archived, 1);

      // Archive now exists with correct content
      const archive = await readJson(join(basePath, '.gsd', 'evidence-archive.json'));
      assert.equal(archive.ok, true);
      assert.ok(archive.data['ev:1.1'], 'ev:1.1 in archive');
      assert.equal(archive.data['ev:1.1'].scope, 'task:1.1');
      assert.equal(archive.data['ev:1.1'].data.first, true);

      // Verify it's gone from state
      const state = await read({ basePath });
      assert.equal(state.evidence['ev:1.1'], undefined, 'ev:1.1 removed from state');
    });
  });

});
