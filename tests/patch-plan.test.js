import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { init, read, patchPlan, setLockPath } from '../src/tools/state/index.js';

let tempDir;

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' };

async function setup() {
  tempDir = await mkdtemp(join(tmpdir(), 'gsd-patch-'));
  execSync('git init && git commit --allow-empty -m "init"', { cwd: tempDir, env: gitEnv, stdio: 'ignore' });
  setLockPath(null);
  await init({
    project: 'patch-test',
    phases: [
      {
        name: 'Core',
        tasks: [
          { name: 'Task A' },
          { name: 'Task B', requires: [{ kind: 'task', id: '1.1' }] },
          { name: 'Task C' },
        ],
      },
      {
        name: 'UI',
        tasks: [
          { name: 'Task D', requires: [{ kind: 'phase', id: 1 }] },
        ],
      },
    ],
    basePath: tempDir,
  });
}

describe('patchPlan — add_task', () => {
  beforeEach(setup);
  afterEach(() => rm(tempDir, { recursive: true, force: true }));

  it('adds a task to a phase', async () => {
    const result = await patchPlan({
      operations: [{ op: 'add_task', phase_id: 1, task: { name: 'Task X' } }],
      basePath: tempDir,
    });
    assert.equal(result.success, true);
    assert.equal(result.applied.length, 1);

    const state = await read({ basePath: tempDir });
    const newTask = state.phases[0].todo.find(t => t.name === 'Task X');
    assert.ok(newTask);
    assert.equal(newTask.id, '1.4');
    assert.equal(newTask.lifecycle, 'pending');
    assert.equal(newTask.level, 'L1');
    assert.equal(state.phases[0].tasks, 4);
  });

  it('adds a task after a specific task', async () => {
    const result = await patchPlan({
      operations: [{ op: 'add_task', phase_id: 1, task: { name: 'Between AB', after: '1.1' } }],
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    const state = await read({ basePath: tempDir });
    const ids = state.phases[0].todo.map(t => t.id);
    const newIdx = ids.indexOf('1.4');
    const afterIdx = ids.indexOf('1.1');
    assert.equal(newIdx, afterIdx + 1);
  });

  it('rejects adding to accepted phase', async () => {
    // Accept phase 1 manually
    const state = await read({ basePath: tempDir });
    state.phases[0].lifecycle = 'accepted';
    // Write directly for test setup
    const { writeJson } = await import('../src/utils.js');
    await writeJson(join(tempDir, '.gsd', 'state.json'), state);

    const result = await patchPlan({
      operations: [{ op: 'add_task', phase_id: 1, task: { name: 'Late task' } }],
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /accepted/);
  });

  it('rejects duplicate task ID', async () => {
    const result = await patchPlan({
      operations: [{ op: 'add_task', phase_id: 1, task: { name: 'Dup', index: 1 } }],
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /already exists/);
  });
});

describe('patchPlan — remove_task', () => {
  beforeEach(setup);
  afterEach(() => rm(tempDir, { recursive: true, force: true }));

  it('removes a pending task with no dependents', async () => {
    const result = await patchPlan({
      operations: [{ op: 'remove_task', task_id: '1.3' }],
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    const state = await read({ basePath: tempDir });
    assert.equal(state.phases[0].todo.length, 2);
    assert.ok(!state.phases[0].todo.some(t => t.id === '1.3'));
  });

  it('rejects removing a task with dependents', async () => {
    const result = await patchPlan({
      operations: [{ op: 'remove_task', task_id: '1.1' }],
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /depends on it/);
  });

  it('rejects removing a non-existent task', async () => {
    const result = await patchPlan({
      operations: [{ op: 'remove_task', task_id: '9.9' }],
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /not found/);
  });
});

describe('patchPlan — reorder_tasks', () => {
  beforeEach(setup);
  afterEach(() => rm(tempDir, { recursive: true, force: true }));

  it('reorders tasks within a phase', async () => {
    const result = await patchPlan({
      operations: [{ op: 'reorder_tasks', phase_id: 1, order: ['1.3', '1.1', '1.2'] }],
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    const state = await read({ basePath: tempDir });
    const ids = state.phases[0].todo.map(t => t.id);
    assert.deepEqual(ids, ['1.3', '1.1', '1.2']);
  });

  it('rejects incomplete order', async () => {
    const result = await patchPlan({
      operations: [{ op: 'reorder_tasks', phase_id: 1, order: ['1.1', '1.2'] }],
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /exactly the same task IDs/);
  });
});

describe('patchPlan — update_task', () => {
  beforeEach(setup);
  afterEach(() => rm(tempDir, { recursive: true, force: true }));

  it('updates allowed task fields', async () => {
    const result = await patchPlan({
      operations: [{ op: 'update_task', task_id: '1.1', name: 'Renamed A', level: 'L2' }],
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    const state = await read({ basePath: tempDir });
    const task = state.phases[0].todo.find(t => t.id === '1.1');
    assert.equal(task.name, 'Renamed A');
    assert.equal(task.level, 'L2');
  });

  it('rejects when no valid fields provided', async () => {
    const result = await patchPlan({
      operations: [{ op: 'update_task', task_id: '1.1', lifecycle: 'accepted' }],
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /No valid fields/);
  });
});

describe('patchPlan — add_dependency', () => {
  beforeEach(setup);
  afterEach(() => rm(tempDir, { recursive: true, force: true }));

  it('adds a dependency to a task', async () => {
    const result = await patchPlan({
      operations: [{ op: 'add_dependency', task_id: '1.3', requires: { kind: 'task', id: '1.2' } }],
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    const state = await read({ basePath: tempDir });
    const task = state.phases[0].todo.find(t => t.id === '1.3');
    assert.ok(task.requires.some(d => d.kind === 'task' && d.id === '1.2'));
  });

  it('rejects circular dependency', async () => {
    // 1.2 depends on 1.1. Adding 1.1 → 1.2 would create a cycle.
    const result = await patchPlan({
      operations: [{ op: 'add_dependency', task_id: '1.1', requires: { kind: 'task', id: '1.2' } }],
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /Circular dependency/);
  });

  it('rejects invalid gate', async () => {
    const result = await patchPlan({
      operations: [{ op: 'add_dependency', task_id: '1.3', requires: { kind: 'task', id: '1.1', gate: 'typo' } }],
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /gate must be one of/);
  });

  it('rejects duplicate dependency', async () => {
    const result = await patchPlan({
      operations: [{ op: 'add_dependency', task_id: '1.2', requires: { kind: 'task', id: '1.1' } }],
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /already depends/);
  });
});

describe('patchPlan — general', () => {
  beforeEach(setup);
  afterEach(() => rm(tempDir, { recursive: true, force: true }));

  it('increments plan_version', async () => {
    const before = await read({ basePath: tempDir });
    const v = before.plan_version;

    await patchPlan({
      operations: [{ op: 'add_task', phase_id: 1, task: { name: 'New' } }],
      basePath: tempDir,
    });

    const after = await read({ basePath: tempDir });
    assert.equal(after.plan_version, v + 1);
  });

  it('rejects empty operations', async () => {
    const result = await patchPlan({ operations: [], basePath: tempDir });
    assert.equal(result.error, true);
  });

  it('rejects invalid operation type', async () => {
    const result = await patchPlan({
      operations: [{ op: 'delete_phase' }],
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /Invalid operation/);
  });

  it('applies multiple operations atomically', async () => {
    const result = await patchPlan({
      operations: [
        { op: 'add_task', phase_id: 1, task: { name: 'Task X' } },
        { op: 'update_task', task_id: '1.1', name: 'Renamed A' },
      ],
      basePath: tempDir,
    });
    assert.equal(result.success, true);
    assert.equal(result.applied.length, 2);

    const state = await read({ basePath: tempDir });
    assert.ok(state.phases[0].todo.some(t => t.name === 'Task X'));
    assert.equal(state.phases[0].todo.find(t => t.id === '1.1').name, 'Renamed A');
  });
});
