import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('evidence store', () => {
  let tempDir;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-evidence-'));
    const { init } = await import('../src/tools/state.js');
    await init({
      project: 'evidence-test',
      phases: [
        { name: 'phase-1', tasks: [{ index: 1, name: 'task-1' }] },
        { name: 'phase-2', tasks: [{ index: 1, name: 'task-2' }] },
      ],
      basePath: tempDir,
    });
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('adds evidence entry', async () => {
    const { addEvidence, read } = await import('../src/tools/state.js');
    await addEvidence({
      id: 'ev:test:task-1',
      data: {
        command: 'npm test',
        scope: 'task:1.1',
        exit_code: 0,
        timestamp: new Date().toISOString(),
        summary: 'tests passed',
      },
      basePath: tempDir,
    });
    const state = await read({ basePath: tempDir });
    assert.ok(state.evidence['ev:test:task-1']);
    assert.equal(state.evidence['ev:test:task-1'].exit_code, 0);
  });

  it('adds multiple evidence entries', async () => {
    const { addEvidence, read } = await import('../src/tools/state.js');
    await addEvidence({
      id: 'ev:lint:phase-1',
      data: {
        command: 'npm run lint',
        scope: 'task:1.1',
        exit_code: 0,
        timestamp: new Date().toISOString(),
        summary: 'lint passed',
      },
      basePath: tempDir,
    });
    const state = await read({ basePath: tempDir });
    assert.ok(state.evidence['ev:test:task-1']);
    assert.ok(state.evidence['ev:lint:phase-1']);
  });

  it('prunes evidence on phase handoff (archives old phases)', async () => {
    const { pruneEvidence, read } = await import('../src/tools/state.js');
    const { readJson } = await import('../src/utils.js');

    // Add evidence scoped to phase 1
    const { addEvidence } = await import('../src/tools/state.js');
    await addEvidence({
      id: 'ev:test:old-phase-1',
      data: { command: 'test', scope: 'task:1.1', exit_code: 0, timestamp: new Date().toISOString(), summary: 'old' },
      basePath: tempDir,
    });

    // Prune for currentPhase=3 (keep phases 3 and 2, archive phase 1 and older)
    const result = await pruneEvidence({ currentPhase: 3, basePath: tempDir });
    assert.equal(result.success, true);
    assert.ok(result.archived > 0, 'should have archived at least one entry');

    // Verify evidence was moved to archive
    const archiveResult = await readJson(join(tempDir, '.gsd', 'evidence-archive.json'));
    assert.ok(archiveResult.ok, 'archive file should exist and be readable');
    assert.ok(archiveResult.data['ev:test:old-phase-1'], 'archived entry should be in archive');
    assert.equal(archiveResult.data['ev:test:old-phase-1'].scope, 'task:1.1');

    // Verify old evidence removed from active state
    const state = await read({ basePath: tempDir });
    assert.equal(state.evidence['ev:test:old-phase-1'], undefined, 'archived evidence should be removed from state');
  });

  it('prunes phase 1 evidence when currentPhase=2 (off-by-one regression)', async () => {
    const { addEvidence, pruneEvidence, read } = await import('../src/tools/state.js');

    // Add evidence scoped to phase 1
    await addEvidence({
      id: 'ev:test:phase1-prune-at-2',
      data: { command: 'test', scope: 'task:1.1', exit_code: 0, timestamp: new Date().toISOString(), summary: 'p1 at cp2' },
      basePath: tempDir,
    });

    // When currentPhase=2, phase 1 evidence should be pruned (keep only current phase)
    const result = await pruneEvidence({ currentPhase: 2, basePath: tempDir });
    assert.equal(result.success, true);
    assert.ok(result.archived >= 1, 'should archive phase 1 evidence when currentPhase=2');

    const state = await read({ basePath: tempDir });
    assert.equal(state.evidence['ev:test:phase1-prune-at-2'], undefined, 'phase 1 evidence should be archived when currentPhase=2');
  });

  it('auto-prunes evidence when exceeding MAX_EVIDENCE_ENTRIES', async () => {
    const { addEvidence, read, update } = await import('../src/tools/state.js');

    // Pre-fill evidence with 200 entries (the MAX) scoped to phase 1
    const bulkEvidence = {};
    for (let i = 0; i < 200; i++) {
      bulkEvidence[`ev:bulk:${i}`] = {
        command: 'test',
        scope: 'task:1.1',
        exit_code: 0,
        timestamp: new Date().toISOString(),
        summary: `bulk-${i}`,
      };
    }
    await update({ updates: { evidence: bulkEvidence, current_phase: 2 }, basePath: tempDir });

    // Adding one more should trigger auto-prune
    const result = await addEvidence({
      id: 'ev:trigger-prune',
      data: { command: 'test', scope: 'task:2.1', exit_code: 0, timestamp: new Date().toISOString(), summary: 'trigger' },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    const state = await read({ basePath: tempDir });
    // Phase-1 evidence should have been auto-archived, only phase-2+ should remain
    assert.ok(Object.keys(state.evidence).length <= 201, 'evidence count should be reduced after auto-prune');
    assert.ok(state.evidence['ev:trigger-prune'], 'newly added evidence should be present');
  });

  describe('parseScopePhase via pruneEvidence', () => {
    let scopeDir;

    before(async () => {
      scopeDir = await mkdtemp(join(tmpdir(), 'gsd-scope-'));
      const { init } = await import('../src/tools/state.js');
      await init({
        project: 'scope-test',
        phases: [
          { name: 'phase-1', tasks: [{ index: 1, name: 't1' }] },
          { name: 'phase-2', tasks: [{ index: 1, name: 't2' }] },
          { name: 'phase-3', tasks: [{ index: 1, name: 't3' }] },
        ],
        basePath: scopeDir,
      });
    });

    after(async () => {
      await rm(scopeDir, { recursive: true, force: true });
    });

    it('archives standard scope "task:1.1" when currentPhase=3', async () => {
      const { addEvidence, pruneEvidence, read } = await import('../src/tools/state.js');
      await addEvidence({
        id: 'ev:scope:phase1',
        data: { command: 'test', scope: 'task:1.1', exit_code: 0, timestamp: new Date().toISOString(), summary: 'p1' },
        basePath: scopeDir,
      });

      const result = await pruneEvidence({ currentPhase: 3, basePath: scopeDir });
      assert.equal(result.success, true);
      assert.equal(result.archived, 1);

      const state = await read({ basePath: scopeDir });
      assert.equal(state.evidence['ev:scope:phase1'], undefined, 'phase 1 evidence should be archived');
    });

    it('archives standard scope "task:2.3" when currentPhase=3 (keep only current phase)', async () => {
      const { addEvidence, pruneEvidence, read } = await import('../src/tools/state.js');
      await addEvidence({
        id: 'ev:scope:phase2',
        data: { command: 'test', scope: 'task:2.3', exit_code: 0, timestamp: new Date().toISOString(), summary: 'p2' },
        basePath: scopeDir,
      });

      // threshold = currentPhase = 3, so phase 2 (2 < 3) is archived
      const result = await pruneEvidence({ currentPhase: 3, basePath: scopeDir });
      assert.equal(result.success, true);
      assert.equal(result.archived, 1);

      const state = await read({ basePath: scopeDir });
      assert.equal(state.evidence['ev:scope:phase2'], undefined, 'phase 2 evidence should be archived when currentPhase=3');
    });

    it('retains multi-digit scope "task:10.5" when currentPhase=3', async () => {
      const { addEvidence, pruneEvidence, read } = await import('../src/tools/state.js');
      await addEvidence({
        id: 'ev:scope:phase10',
        data: { command: 'test', scope: 'task:10.5', exit_code: 0, timestamp: new Date().toISOString(), summary: 'p10' },
        basePath: scopeDir,
      });

      const result = await pruneEvidence({ currentPhase: 3, basePath: scopeDir });
      assert.equal(result.success, true);
      assert.equal(result.archived, 0);

      const state = await read({ basePath: scopeDir });
      assert.ok(state.evidence['ev:scope:phase10'], 'multi-digit phase evidence should be retained');
    });

    it('retains non-task scope "global" (parseScopePhase returns null)', async () => {
      const { addEvidence, pruneEvidence, read } = await import('../src/tools/state.js');
      await addEvidence({
        id: 'ev:scope:global',
        data: { command: 'check', scope: 'global', exit_code: 0, timestamp: new Date().toISOString(), summary: 'global' },
        basePath: scopeDir,
      });

      const result = await pruneEvidence({ currentPhase: 3, basePath: scopeDir });
      assert.equal(result.success, true);
      assert.equal(result.archived, 0);

      const state = await read({ basePath: scopeDir });
      assert.ok(state.evidence['ev:scope:global'], 'non-task scope evidence should be retained');
    });

    it('retains evidence with missing scope (null → never archived)', async () => {
      const { update, pruneEvidence, read } = await import('../src/tools/state.js');
      // Bypass addEvidence validation to inject entry without scope
      const state = await read({ basePath: scopeDir });
      state.evidence['ev:scope:noscope'] = { command: 'test', exit_code: 0, timestamp: new Date().toISOString(), summary: 'no scope' };
      await update({ updates: { evidence: state.evidence }, basePath: scopeDir });

      const result = await pruneEvidence({ currentPhase: 3, basePath: scopeDir });
      assert.equal(result.success, true);
      assert.equal(result.archived, 0);

      const after = await read({ basePath: scopeDir });
      assert.ok(after.evidence['ev:scope:noscope'], 'missing-scope evidence should be retained');
    });

    it('handles empty evidence without crashing', async () => {
      const { update, pruneEvidence } = await import('../src/tools/state.js');
      await update({ updates: { evidence: {} }, basePath: scopeDir });

      const result = await pruneEvidence({ currentPhase: 3, basePath: scopeDir });
      assert.equal(result.success, true);
      assert.equal(result.archived, 0);
    });
  });
});
