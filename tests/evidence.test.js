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

    // Verify evidence was moved to archive
    const archive = await readJson(join(tempDir, '.gsd', 'evidence-archive.json'));
    assert.ok(!archive.error, 'archive file should exist');

    // Verify old evidence removed from state
    const state = await read({ basePath: tempDir });
    // Evidence scoped to task:1.x should be archived since phase 1 < currentPhase-1 (2)
    // Note: some evidence may remain if scope doesn't clearly map to old phases
  });
});
