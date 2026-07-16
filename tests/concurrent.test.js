import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, update, read, setLockPath } from '../src/tools/state/index.js';
import { withFileLock, LOCK_STALE_MS, LOCK_RETRY_MS, LOCK_MAX_RETRIES } from '../src/utils.js';

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
    assert.ok(
      state.context.remaining_percentage >= 91 && state.context.remaining_percentage <= 100,
      `remaining_percentage should be 91-100, got ${state.context.remaining_percentage}`
    );
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

  it('file lock protects cross-process concurrent writes', async () => {
    // Initialize state first
    await init({
      project: 'cross-process-concurrent',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });

    // Write a worker script as a temp .mjs file
    const { writeFile: wf, unlink: ul } = await import('node:fs/promises');
    const { fork } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const workerPath = join(tempDir, 'concurrent-worker.mjs');
    const stateModulePath = join(fileURLToPath(import.meta.url), '../../src/tools/state/index.js');

    const workerScript = `
import { update, setLockPath } from ${JSON.stringify(stateModulePath)};

const basePath = process.argv[2];
const lockPath = process.argv[3];
const workerId = process.argv[4];

setLockPath(lockPath);

try {
  const result = await update({
    updates: { context: { remaining_percentage: Number(workerId), last_session: new Date().toISOString() } },
    basePath,
  });
  process.send({ workerId, success: result.success, error: result.error || null });
} catch (err) {
  process.send({ workerId, success: false, error: err.message });
}
`;
    await wf(workerPath, workerScript);

    const lockPath = join(tempDir, '.gsd', '.state-lock');
    const workerCount = 5;

    // Fork workers that all write concurrently
    const workerResults = await Promise.all(
      Array.from({ length: workerCount }, (_, i) => {
        return new Promise((resolve, reject) => {
          const child = fork(workerPath, [tempDir, lockPath, String(i)], {
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          });
          let result = null;
          child.on('message', (msg) => { result = msg; });
          child.on('exit', (code) => {
            if (result) resolve(result);
            else reject(new Error(`worker ${i} exited with code ${code} and no result`));
          });
          child.on('error', reject);
          // Timeout safety
          setTimeout(() => reject(new Error(`worker ${i} timed out`)), 15000);
        });
      }),
    );

    // All workers should have succeeded
    for (const r of workerResults) {
      assert.equal(r.success, true, `worker ${r.workerId} failed: ${JSON.stringify(r)}`);
    }

    // Final state must be valid JSON with consistent structure
    const raw = await readFile(join(tempDir, '.gsd', 'state.json'), 'utf-8');
    const parsed = JSON.parse(raw); // Must not throw
    assert.equal(parsed.project, 'cross-process-concurrent');
    assert.ok(Array.isArray(parsed.phases), 'phases must be an array');
    assert.ok(parsed.context, 'context must exist');
    assert.ok(Number.isFinite(parsed.context.remaining_percentage), 'remaining_percentage must be a number');
    // The value must be one of the worker IDs (0-4) — last writer wins
    assert.ok(
      parsed.context.remaining_percentage >= 0 && parsed.context.remaining_percentage <= 4,
      `remaining_percentage ${parsed.context.remaining_percentage} should be a valid worker ID (0-4)`,
    );

    // Clean up worker script
    await ul(workerPath);
  });

  it('withFileLock throws on lock exhaustion instead of silent proceed', async () => {
    // Create a non-stale lock file that will never be released (mtime = now)
    const lockPath = join(tempDir, 'exhaust-test.lock');
    await fsWriteFile(lockPath, '99999', { flag: 'w' });

    // withFileLock should throw after retries exhaust (lock is fresh, not stale).
    // Use a small injected budget so the test stays fast; default budget is 12s.
    await assert.rejects(
      () => withFileLock(lockPath, async () => 'should not reach', { staleMs: 60_000, retryMs: 5, maxRetries: 10 }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Lock acquisition timeout/);
        return true;
      },
    );
  });

  it('release only removes the lock when its token still matches (R-01 anti-steal)', async () => {
    const lockPath = join(tempDir, 'token-release.lock');
    await withFileLock(lockPath, async () => {
      // Simulate another process stealing + re-acquiring the lock mid-operation.
      await fsWriteFile(lockPath, 'someone-elses-token', { flag: 'w' });
    });
    // Our release must NOT delete the other holder's lock — token mismatch.
    const content = await readFile(lockPath, 'utf-8');
    assert.equal(content, 'someone-elses-token', 'foreign lock must survive our release');
  });

  it('stale-break leaves a re-acquired lock intact (R-01 compare-and-delete)', async () => {
    const lockPath = join(tempDir, 'stale-reacquire.lock');
    // A genuinely stale lock (old mtime).
    await fsWriteFile(lockPath, 'old-holder', { flag: 'w' });
    const { utimes } = await import('node:fs/promises');
    const past = new Date(Date.now() - 15000);
    await utimes(lockPath, past, past);

    // Fresh acquirer succeeds by breaking the stale lock, then holds it while a
    // second waiter runs. The waiter must not delete the fresh holder's lock.
    let waiterEntered = false;
    const holder = withFileLock(lockPath, async () => {
      await new Promise(r => setTimeout(r, 300));
      return 'held';
    }, { staleMs: 10_000, retryMs: 20, maxRetries: 200 });
    await new Promise(r => setTimeout(r, 50));
    const waiter = withFileLock(lockPath, async () => {
      waiterEntered = true;
      return 'waited';
    }, { staleMs: 10_000, retryMs: 20, maxRetries: 200 });

    assert.equal(await holder, 'held');
    assert.equal(await waiter, 'waited');
    assert.equal(waiterEntered, true);
  });

  it('concurrent stale-breakers are mutually exclusive — never both enter fn (R-01 atomic reclaim)', async () => {
    const lockPath = join(tempDir, 'reclaim-race.lock');
    // A genuinely stale lock that every waiter will try to break at once.
    await fsWriteFile(lockPath, 'dead-holder', { flag: 'w' });
    const { utimes } = await import('node:fs/promises');
    const past = new Date(Date.now() - 15000);
    await utimes(lockPath, past, past);

    // Under the old blind-unlink stale-break, a waiter could delete a lock a
    // peer had just re-acquired and then acquire its own, running fn()
    // concurrently. The rename-based atomic reclaim serializes breakers, so the
    // critical section must never overlap.
    let inside = 0;
    let overlapped = false;
    const critical = async () => {
      inside += 1;
      if (inside > 1) overlapped = true;
      await new Promise(r => setTimeout(r, 40));
      inside -= 1;
      return 'done';
    };
    const opts = { staleMs: 10_000, retryMs: 8, maxRetries: 400 };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => withFileLock(lockPath, critical, opts)),
    );

    assert.deepEqual(results, ['done', 'done', 'done', 'done'], 'all waiters complete');
    assert.equal(overlapped, false, 'stale-breakers must never run fn() concurrently');
    // Lock file is released (compare-and-delete on the last holder).
    await assert.rejects(() => readFile(lockPath, 'utf-8'), /ENOENT/);
  });

  it('default retry budget covers the stale threshold (R-09)', () => {
    // A waiter must be able to wait out the entire window before a held lock
    // ages into staleness — otherwise it falsely times out on legitimate holds.
    assert.ok(
      LOCK_MAX_RETRIES * LOCK_RETRY_MS >= LOCK_STALE_MS,
      `retry budget ${LOCK_MAX_RETRIES * LOCK_RETRY_MS}ms must be >= stale threshold ${LOCK_STALE_MS}ms`,
    );
  });

  it('waiter survives a legitimate hold longer than a too-small budget (R-09)', async () => {
    const lockPath = join(tempDir, 'budget.lock');
    // Holder keeps the lock ~600ms with a 2s stale threshold (lock never goes
    // stale). Waiter uses a budget (1.2s) >= stale — it must wait, not time out.
    const holder = withFileLock(lockPath, async () => {
      await new Promise(r => setTimeout(r, 600));
      return 'holder-done';
    }, { staleMs: 2000, retryMs: 20, maxRetries: 100 });
    await new Promise(r => setTimeout(r, 50));
    const waiter = withFileLock(lockPath, async () => 'waiter-done',
      { staleMs: 2000, retryMs: 20, maxRetries: 60 });
    assert.equal(await holder, 'holder-done');
    assert.equal(await waiter, 'waiter-done');
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
