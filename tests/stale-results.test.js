import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, read, update } from '../src/tools/state/index.js';
import { handleExecutorResult, handleDebuggerResult } from '../src/tools/orchestrator/index.js';

async function withProject(name, fn) {
  const dir = await mkdtemp(join(tmpdir(), `gsd-${name}-`));
  try {
    await init({
      project: name,
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A', level: 'L2' }, { index: 2, name: 'Task B' }] }],
      basePath: dir,
    });
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function step(basePath, updates, label) {
  const result = await update({ updates, basePath });
  assert.ok(!result.error, `setup: ${label} — ${result.code}: ${result.message}`);
}

/** Park task 1.1 checkpointed with a task review in flight — the state a second executor result can corrupt. */
async function underReview(basePath) {
  await step(basePath, { workflow_mode: 'executing_task', current_task: '1.1' }, 'to executing_task');
  await step(basePath, { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, 'start 1.1');
  await step(basePath, {
    workflow_mode: 'reviewing_task',
    current_review: { scope: 'task', scope_id: '1.1', stage: 'spec' },
    phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'checkpointed' }] }],
  }, 'checkpoint 1.1 into review');
}

const executorFailure = {
  task_id: '1.1',
  outcome: 'failed',
  summary: 'a late result from a run that was already superseded',
  checkpoint_commit: null,
  files_changed: [],
  decisions: [],
  blockers: [],
  contract_changed: false,
  evidence: [],
};

// The result handlers checked that a task exists and sits in the current phase,
// but never that it was still being worked on. A duplicate or slow dispatch
// landing after the task checkpointed therefore rewrote a review in progress.
describe('result handlers reject results for tasks that are not running', () => {
  it('refuses a late executor failure for a checkpointed task under review', async () => {
    await withProject('stale-exec', async (dir) => {
      await underReview(dir);
      const before = await read({ basePath: dir });

      const result = await handleExecutorResult({ result: executorFailure, basePath: dir });
      assert.equal(result.error, true, 'a late result must not be accepted');
      assert.equal(result.code, 'TRANSITION_ERROR');

      const after = await read({ basePath: dir });
      assert.equal(after.workflow_mode, 'reviewing_task', 'the review was cancelled');
      assert.deepEqual(after.current_review, before.current_review, 'the review target was dropped');
      const task = after.phases[0].todo.find(t => t.id === '1.1');
      assert.equal(task.lifecycle, 'checkpointed');
      assert.equal(task.retry_count || 0, 0, 'a retry was recorded against work that did not fail');
    });
  });

  it('refuses a late executor result for an accepted task', async () => {
    await withProject('stale-exec-accepted', async (dir) => {
      await step(dir, { workflow_mode: 'executing_task', current_task: '1.1' }, 'to executing_task');
      await step(dir, { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, 'start 1.1');
      await step(dir, { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'accepted' }] }] }, 'accept 1.1');

      const result = await handleExecutorResult({ result: executorFailure, basePath: dir });
      assert.equal(result.error, true);
      assert.equal(result.code, 'TRANSITION_ERROR');
      assert.equal((await read({ basePath: dir })).phases[0].todo.find(t => t.id === '1.1').lifecycle, 'accepted');
    });
  });

  // `root_cause_found`, not `failed`. The failed branch patches lifecycle
  // `failed`, and checkpointed → failed is already rejected whole by
  // TASK_LIFECYCLE with the same error code — so asserting on that input passes
  // with this guard deleted and proves nothing. The root_cause_found patch
  // carries no lifecycle at all, sails through validation, and is the one input
  // only this guard stops.
  it('refuses a late debugger root-cause result for a checkpointed task under review', async () => {
    await withProject('stale-debug', async (dir) => {
      await underReview(dir);
      const before = await read({ basePath: dir });

      const result = await handleDebuggerResult({
        result: {
          task_id: '1.1',
          outcome: 'root_cause_found',
          root_cause: 'stale',
          fix_direction: 'none',
          evidence: [],
          hypothesis_tested: [{ hypothesis: 'the run was superseded', result: 'confirmed', evidence: 'test fixture' }],
          fix_attempts: 1,
          blockers: [],
          architecture_concern: false,
        },
        basePath: dir,
      });
      assert.equal(result.error, true, 'a late root-cause result must not be accepted');
      assert.equal(result.code, 'TRANSITION_ERROR');

      const after = await read({ basePath: dir });
      assert.equal(after.workflow_mode, 'reviewing_task', 'the in-flight review was cancelled');
      assert.deepEqual(after.current_review, before.current_review, 'the review target was dropped');
      assert.equal(after.phases[0].todo.find(t => t.id === '1.1').lifecycle, 'checkpointed');
    });
  });

  it('still accepts a result for a running task', async () => {
    await withProject('live-running', async (dir) => {
      await step(dir, { workflow_mode: 'executing_task', current_task: '1.1' }, 'to executing_task');
      await step(dir, { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, 'start 1.1');

      const result = await handleExecutorResult({ result: executorFailure, basePath: dir });
      assert.ok(!result.error, `a live result must still be accepted: ${result.code}: ${result.message}`);
    });
  });

  it('still accepts a result for a pending task dispatched in parallel', async () => {
    // Parallel dispatch leaves the task pending until its result arrives; the
    // handler auto-starts it. That path must survive the new guard.
    await withProject('live-pending', async (dir) => {
      await step(dir, { workflow_mode: 'executing_task', current_task: '1.1' }, 'to executing_task');

      const result = await handleExecutorResult({ result: executorFailure, basePath: dir });
      assert.ok(!result.error, `a pending parallel task must still be accepted: ${result.code}: ${result.message}`);
    });
  });
});
