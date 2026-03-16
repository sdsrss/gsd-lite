import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, update, read, setLockPath } from '../src/tools/state.js';

describe('concurrent state operations (P2-11)', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-concurrent-'));
    // Enable file-level locking for cross-process safety
    setLockPath(join(tempDir, '.gsd', '.state-lock'));
  });

  afterEach(async () => {
    setLockPath(null);
    await rm(tempDir, { recursive: true, force: true });
  });

  it('serializes concurrent in-process updates without data loss', async () => {
    await init({
      project: 'concurrent-test',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });

    // Fire 10 concurrent updates that each increment a counter via context
    const concurrentCount = 10;
    const promises = [];
    for (let i = 0; i < concurrentCount; i++) {
      promises.push(
        update({
          updates: { context: { remaining_percentage: 100 - i, last_session: new Date().toISOString() } },
          basePath: tempDir,
        }),
      );
    }

    const results = await Promise.all(promises);
    // All should succeed (serialized by mutation queue)
    for (const r of results) {
      assert.equal(r.success, true, `update failed: ${JSON.stringify(r)}`);
    }

    // State should be consistent — last write wins
    const state = await read({ basePath: tempDir });
    assert.ok(Number.isFinite(state.context.remaining_percentage));
  });

  it('handles concurrent lifecycle transitions without corruption', async () => {
    await init({
      project: 'concurrent-lifecycle',
      phases: [{
        name: 'Core',
        tasks: [
          { index: 1, name: 'Task A' },
          { index: 2, name: 'Task B' },
          { index: 3, name: 'Task C' },
        ],
      }],
      basePath: tempDir,
    });

    // Advance all tasks to running concurrently
    const runningPromises = ['1.1', '1.2', '1.3'].map(id =>
      update({
        updates: { phases: [{ id: 1, todo: [{ id, lifecycle: 'running' }] }] },
        basePath: tempDir,
      }),
    );

    const runningResults = await Promise.all(runningPromises);
    for (const r of runningResults) {
      assert.equal(r.success, true, `running transition failed: ${JSON.stringify(r)}`);
    }

    // Verify all tasks are running
    const state = await read({ basePath: tempDir });
    for (const task of state.phases[0].todo) {
      assert.equal(task.lifecycle, 'running', `task ${task.id} should be running`);
    }
  });

  it('concurrent reads do not block concurrent writes', async () => {
    await init({
      project: 'read-write-concurrent',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });

    // Mix reads and writes concurrently
    const ops = [];
    for (let i = 0; i < 5; i++) {
      ops.push(read({ basePath: tempDir }));
      ops.push(update({
        updates: { context: { remaining_percentage: 80 + i, last_session: new Date().toISOString() } },
        basePath: tempDir,
      }));
    }

    const results = await Promise.all(ops);
    // All operations should complete without error
    for (const r of results) {
      assert.ok(!r.error, `operation failed: ${JSON.stringify(r)}`);
    }
  });

  it('state.json remains valid JSON after concurrent writes', async () => {
    await init({
      project: 'json-integrity',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });

    // Fire rapid concurrent updates
    const promises = [];
    for (let i = 0; i < 20; i++) {
      promises.push(
        update({
          updates: { context: { remaining_percentage: i * 5, last_session: new Date().toISOString() } },
          basePath: tempDir,
        }),
      );
    }
    await Promise.all(promises);

    // Verify JSON is still valid
    const raw = await readFile(join(tempDir, '.gsd', 'state.json'), 'utf-8');
    const parsed = JSON.parse(raw); // Should not throw
    assert.equal(parsed.project, 'json-integrity');
    assert.ok(Array.isArray(parsed.phases));
  });

  it('file lock prevents stale lock from blocking operations', async () => {
    await init({
      project: 'stale-lock',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });

    // Create a stale lock file (old mtime)
    const { writeFile: wf } = await import('node:fs/promises');
    const lockPath = join(tempDir, '.gsd', '.state-lock');
    await wf(lockPath, '99999', { flag: 'w' });
    // Backdate the lock to make it stale (> LOCK_STALE_MS which is 10s)
    const { utimes } = await import('node:fs/promises');
    const past = new Date(Date.now() - 15000);
    await utimes(lockPath, past, past);

    // Update should still succeed after detecting stale lock
    const result = await update({
      updates: { context: { remaining_percentage: 42, last_session: new Date().toISOString() } },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    const state = await read({ basePath: tempDir });
    assert.equal(state.context.remaining_percentage, 42);
  });
});
