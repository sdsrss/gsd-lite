import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, read, update } from '../src/tools/state/index.js';
import { handleExecutorResult } from '../src/tools/orchestrator/index.js';
import { ERROR_CODES } from '../src/tools/state/constants.js';
import { createInitialState } from '../src/schema.js';
import { readJson } from '../src/utils.js';

describe('optimistic concurrency version control (#8)', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-version-'));
    await init({
      project: 'version-test',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('_version in initial state', () => {
    it('init sets _version to 0', async () => {
      const result = await readJson(join(tempDir, '.gsd', 'state.json'));
      assert.equal(result.ok, true);
      assert.equal(result.data._version, 0);
    });

    it('createInitialState includes _version: 0', () => {
      const state = createInitialState({
        project: 'test',
        phases: [{ name: 'P1', tasks: [{ index: 1, name: 'T1' }] }],
      });
      assert.equal(state._version, 0);
    });
  });

  describe('_version auto-increment on update', () => {
    it('increments _version on each successful update', async () => {
      const r1 = await update({
        updates: { current_task: '1.1' },
        basePath: tempDir,
      });
      assert.equal(r1.success, true);
      assert.equal(r1.state._version, 1);

      const r2 = await update({
        updates: { context: { remaining_percentage: 80, last_session: new Date().toISOString() } },
        basePath: tempDir,
      });
      assert.equal(r2.success, true);
      assert.equal(r2.state._version, 2);
    });

    it('_version is persisted to disk', async () => {
      await update({
        updates: { current_task: '1.1' },
        basePath: tempDir,
      });
      const result = await readJson(join(tempDir, '.gsd', 'state.json'));
      assert.equal(result.data._version, 1);
    });
  });

  describe('expectedVersion conflict detection', () => {
    it('succeeds when expectedVersion matches on-disk version', async () => {
      const result = await update({
        updates: { current_task: '1.1' },
        expectedVersion: 0,
        basePath: tempDir,
      });
      assert.equal(result.success, true);
      assert.equal(result.state._version, 1);
    });

    it('returns VERSION_CONFLICT when expectedVersion does not match', async () => {
      // First update bumps _version to 1
      await update({
        updates: { current_task: '1.1' },
        basePath: tempDir,
      });

      // Try to update with stale version 0
      const result = await update({
        updates: { context: { remaining_percentage: 50, last_session: new Date().toISOString() } },
        expectedVersion: 0,
        basePath: tempDir,
      });
      assert.equal(result.error, true);
      assert.equal(result.code, 'VERSION_CONFLICT');
      assert.ok(result.message.includes('expected version 0'));
      assert.ok(result.message.includes('found 1'));
    });

    it('backward compatible: no expectedVersion skips the check', async () => {
      // Bump version
      await update({
        updates: { current_task: '1.1' },
        basePath: tempDir,
      });

      // Update without expectedVersion should always succeed
      const result = await update({
        updates: { context: { remaining_percentage: 90, last_session: new Date().toISOString() } },
        basePath: tempDir,
      });
      assert.equal(result.success, true);
    });
  });

  describe('_version is not a canonical field', () => {
    it('rejects _version in updates parameter', async () => {
      const result = await update({
        updates: { _version: 99 },
        basePath: tempDir,
      });
      assert.equal(result.error, true);
      assert.ok(result.message.includes('_version'));
    });
  });

  describe('VERSION_CONFLICT error code', () => {
    it('VERSION_CONFLICT is in ERROR_CODES', () => {
      assert.equal(ERROR_CODES.VERSION_CONFLICT, 'VERSION_CONFLICT');
    });
  });

  describe('_version passes validation', () => {
    it('state with _version passes full validation', async () => {
      // Read with validation should not fail on _version field
      const result = await read({ basePath: tempDir, validate: true });
      assert.ok(!result.error, `unexpected error: ${result.message}`);
      assert.equal(result._version, 0);
    });

    it('state with _version passes validation after update', async () => {
      await update({
        updates: { current_task: '1.1' },
        basePath: tempDir,
      });
      const result = await read({ basePath: tempDir, validate: true });
      assert.ok(!result.error, `unexpected error: ${result.message}`);
      assert.equal(result._version, 1);
    });
  });

  describe('R-21: orchestrator handlers pass expectedVersion (optimistic lock)', () => {
    it('two concurrent executor results on the same task surface VERSION_CONFLICT', async () => {
      // Put task 1.1 into running so both handler calls take the checkpointed path.
      await update({
        updates: { current_task: '1.1', phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] },
        basePath: tempDir,
      });

      const mkResult = (commit) => ({
        task_id: '1.1',
        outcome: 'checkpointed',
        summary: 'work',
        checkpoint_commit: commit,
        files_changed: ['a.js'],
        decisions: [],
        blockers: [],
        contract_changed: false,
        evidence: [],
      });

      // Both handlers read the same _version (reads run outside the state lock),
      // then their persists serialize: the first wins, the second's expectedVersion
      // is now stale → VERSION_CONFLICT rather than a silent clobber.
      const [a, b] = await Promise.all([
        handleExecutorResult({ result: mkResult('c1'), basePath: tempDir }),
        handleExecutorResult({ result: mkResult('c2'), basePath: tempDir }),
      ]);

      const outcomes = [a, b];
      const conflicts = outcomes.filter(r => r.error && r.code === ERROR_CODES.VERSION_CONFLICT);
      const successes = outcomes.filter(r => r.success);
      assert.equal(conflicts.length, 1, `exactly one call should conflict: ${JSON.stringify(outcomes)}`);
      assert.equal(successes.length, 1, 'exactly one call should succeed');
    });
  });
});
