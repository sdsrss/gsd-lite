import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, read, update } from '../src/tools/state/index.js';
import {
  handleResearcherResult,
} from '../src/tools/orchestrator/index.js';
import { persist, persistAndRead } from '../src/tools/orchestrator/helpers.js';

// === Fix H2: persist()/persistAndRead() forward expectedVersion to update() ===

describe('H2: persist() forwards expectedVersion to update()', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-h2-'));
    await init({
      project: 'h2-version-test',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('persist() succeeds when expectedVersion matches on-disk version', async () => {
    const state = await read({ basePath: tempDir });
    // Pass correct expectedVersion (state._version should be 0 after init)
    const result = await persist(tempDir, { current_task: '1.1' }, { expectedVersion: state._version });
    assert.equal(result, null, 'persist should return null on success');
  });

  it('persist() returns VERSION_CONFLICT when expectedVersion is stale', async () => {
    // Bump version by updating state
    await update({ updates: { current_task: '1.1' }, basePath: tempDir });

    // Try persist with stale version 0 (on-disk is now 1)
    const result = await persist(tempDir, { workflow_mode: 'executing_task' }, { expectedVersion: 0 });
    assert.ok(result !== null, 'persist should return error on version conflict');
    assert.equal(result.error, true);
    assert.equal(result.code, 'VERSION_CONFLICT');
  });

  it('persist() backward compatible: no expectedVersion skips check', async () => {
    // Bump version
    await update({ updates: { current_task: '1.1' }, basePath: tempDir });

    // persist without expectedVersion should succeed regardless
    const result = await persist(tempDir, { workflow_mode: 'executing_task' }, {});
    assert.equal(result, null, 'persist should succeed without expectedVersion');
  });

  it('persistAndRead() succeeds when expectedVersion matches', async () => {
    const state = await read({ basePath: tempDir });
    const result = await persistAndRead(tempDir, { current_task: '1.1' }, { expectedVersion: state._version });
    assert.ok(!result.error, `unexpected error: ${result?.message}`);
    assert.equal(result.current_task, '1.1');
  });

  it('persistAndRead() returns VERSION_CONFLICT when expectedVersion is stale', async () => {
    // Bump version
    await update({ updates: { current_task: '1.1' }, basePath: tempDir });

    // Try persistAndRead with stale version 0
    const result = await persistAndRead(tempDir, { workflow_mode: 'executing_task' }, { expectedVersion: 0 });
    assert.equal(result.error, true);
    assert.equal(result.code, 'VERSION_CONFLICT');
  });
});

// === Fix H4: Research write atomicity sentinel ===

describe('H4: research write atomicity sentinel', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-h4-'));
    await init({
      project: 'h4-sentinel-test',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      research: true,
      basePath: tempDir,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('sentinel file is cleaned up after successful research write', async () => {
    const result = await handleResearcherResult({
      basePath: tempDir,
      result: {
        decision_ids: ['d1'],
        volatility: 'low',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        sources: [{ id: 's1', type: 'docs', ref: 'https://example.com' }],
      },
      decision_index: {
        d1: { id: 'd1', title: 'Use X', summary: 'Use framework X', rationale: 'popular', status: 'decided' },
      },
      artifacts: {
        'STACK.md': '# Stack\nTest',
        'ARCHITECTURE.md': '# Arch\nTest',
        'PITFALLS.md': '# Pitfalls\nTest',
        'SUMMARY.md': '# Summary\nTest',
      },
    });
    assert.equal(result.success, true);

    // Sentinel should NOT exist after successful write
    const sentinelPath = join(tempDir, '.gsd', '.research-commit-pending');
    assert.equal(existsSync(sentinelPath), false, 'sentinel should be removed after successful write');
  });

  it('storeResearch code contains sentinel write and cleanup logic', async () => {
    const logicSrc = await readFile(join(process.cwd(), 'src', 'tools', 'state', 'logic.js'), 'utf-8');
    // Sentinel should be written before artifact renames
    assert.ok(logicSrc.includes('.research-commit-pending'), 'logic.js should reference sentinel file');
    assert.ok(logicSrc.includes('writeFileSync'), 'logic.js should use writeFileSync for sentinel');
    assert.ok(logicSrc.includes('unlinkSync'), 'logic.js should use unlinkSync to clean up sentinel');
  });
});

// === Fix M4: unhandledRejection always outputs to stderr ===

describe('M4: unhandledRejection handler writes to stderr', () => {
  it('server.js has unconditional stderr write for unhandledRejection', async () => {
    // Read server.js source and verify the handler writes to stderr unconditionally
    const serverSrc = await readFile(join(process.cwd(), 'src', 'server.js'), 'utf-8');

    // The handler should NOT be conditional on GSD_DEBUG
    const hasConditionalDebug = /process\.on\('unhandledRejection'[\s\S]*?GSD_DEBUG[\s\S]*?\}\)/m.test(serverSrc);
    assert.equal(hasConditionalDebug, false, 'unhandledRejection handler should not be conditional on GSD_DEBUG');

    // The handler should use process.stderr.write
    const hasStderrWrite = /process\.on\('unhandledRejection'[\s\S]*?process\.stderr\.write/m.test(serverSrc);
    assert.equal(hasStderrWrite, true, 'unhandledRejection handler should use process.stderr.write');
  });
});
