import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { init, read, patchPlan, setLockPath } from '../src/tools/state/index.js';
import { selectRunnableTask } from '../src/tools/state/logic.js';

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

  it('rejects non-positive-integer index (would create malformed IDs / NaN cascade)', async () => {
    for (const index of [0, -1, 1.5, 'x', '2a']) {
      const result = await patchPlan({
        operations: [{ op: 'add_task', phase_id: 1, task: { name: 'Bad', index } }],
        basePath: tempDir,
      });
      assert.equal(result.error, true, `index ${JSON.stringify(index)} should be rejected`);
      assert.match(result.message, /index must be a positive integer/);
    }
    // No malformed IDs were written
    const state = await read({ basePath: tempDir });
    assert.ok(state.phases[0].todo.every(t => /^1\.\d+$/.test(t.id)), 'all task IDs well-formed');
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

  it('rejects order with duplicate task IDs (clear message, not "circular dependency")', async () => {
    const result = await patchPlan({
      operations: [{ op: 'reorder_tasks', phase_id: 1, order: ['1.1', '1.1', '1.2'] }],
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /duplicate task IDs/);

    // State must be untouched (order rejected before write)
    const state = await read({ basePath: tempDir });
    assert.equal(state.phases[0].todo.length, 3);
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

  it('rejects a forward phase dependency via add_dependency (R-06)', async () => {
    // Task 1.1 (phase 1) cannot depend on the later phase 2.
    const result = await patchPlan({
      operations: [{ op: 'add_dependency', task_id: '1.1', requires: { kind: 'phase', id: 2 } }],
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /forward\/self reference/);
    // Name the task, not just the phase — a multi-op patch needs to say which
    // dependency failed.
    assert.match(result.message, /Task 1\.1/);
  });

  it('accepts a backward phase dependency via add_dependency (R-06)', async () => {
    // Task 2.1 (phase 2) already depends on phase 1; add the dep to a phase-2
    // task freshly to confirm the backward direction is allowed.
    await patchPlan({
      operations: [{ op: 'add_task', phase_id: 2, task: { name: 'Task E' } }],
      basePath: tempDir,
    });
    const result = await patchPlan({
      operations: [{ op: 'add_dependency', task_id: '2.2', requires: { kind: 'phase', id: 1 } }],
      basePath: tempDir,
    });
    assert.equal(result.success, true);
  });

  it('rejects a forward phase dependency on a newly added task (R-06)', async () => {
    const result = await patchPlan({
      operations: [{ op: 'add_task', phase_id: 1, task: { name: 'Task X', requires: [{ kind: 'phase', id: 2 }] } }],
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /forward\/self reference/);
  });
});

// There are three plan-authoring paths that accept a `requires` array:
// createInitialState (schema.js), add_dependency and add_task (crud.js). The
// first two validate shape / gate / target; add_task used to validate only
// phase-kind deps, so a malformed task-kind dep reached state.json unchecked.
// That is not cosmetic: selectRunnableTask silently treats a dep it cannot
// resolve as satisfied, so the ordering the caller asked for just disappears.
//
// This gate covers task-kind `requires` entries on add_task. It does NOT cover
// deps written into state.json by hand or by a future fourth path — those still
// reach selectRunnableTask unvalidated.
describe('patchPlan — add_task dependency validation parity', () => {
  beforeEach(setup);
  afterEach(() => rm(tempDir, { recursive: true, force: true }));

  const BAD_DEPS = [
    ['dangling task id', { kind: 'task', id: '9.9' }, /not found/],
    ['cross-phase task dep', { kind: 'task', id: '1.1' }, /cross-phase/, 2],
    ['out-of-set gate', { kind: 'task', id: '1.1', gate: 'bogus' }, /gate/],
    ['non-object entry', '1.1', /object/],
    ['unknown kind', { kind: 'wat', id: '1.1' }, /kind/],
  ];

  for (const [label, dep, pattern, phaseId = 1] of BAD_DEPS) {
    it(`rejects ${label}`, async () => {
      const result = await patchPlan({
        operations: [{ op: 'add_task', phase_id: phaseId, task: { name: 'Bad dep', requires: [dep] } }],
        basePath: tempDir,
      });
      assert.equal(result.error, true, `add_task accepted a ${label}`);
      assert.match(result.message, pattern);

      // Nothing was persisted — the patch is all-or-nothing.
      const state = await read({ basePath: tempDir });
      assert.ok(
        !state.phases.some(p => p.todo.some(t => t.name === 'Bad dep')),
        'rejected add_task must not persist the task',
      );
    });
  }

  // Without the array guard, a caller passing one dependency instead of a list
  // gets an uncaught TypeError out of patchPlan rather than a structured error.
  for (const bad of [{ kind: 'task', id: '1.1' }, 42, 'oops']) {
    it(`rejects a non-array requires (${JSON.stringify(bad)}) without throwing`, async () => {
      const result = await patchPlan({
        operations: [{ op: 'add_task', phase_id: 1, task: { name: 'Bad shape', requires: bad } }],
        basePath: tempDir,
      });
      assert.equal(result.error, true);
      assert.match(result.message, /array/i);
    });
  }

  it('still accepts a well-formed same-phase task dependency', async () => {
    const result = await patchPlan({
      operations: [{
        op: 'add_task',
        phase_id: 1,
        task: { name: 'Good dep', requires: [{ kind: 'task', id: '1.1', gate: 'checkpoint' }] },
      }],
      basePath: tempDir,
    });
    assert.equal(result.success, true, result.message);
    const state = await read({ basePath: tempDir });
    const added = state.phases[0].todo.find(t => t.name === 'Good dep');
    assert.deepEqual(added.requires, [{ kind: 'task', id: '1.1', gate: 'checkpoint' }]);
  });

  // The behavioural consequence, not just the error message: an unresolvable dep
  // makes selectRunnableTask offer the dependent task for parallel dispatch
  // alongside the very prerequisite it declared.
  it('no task reachable through add_task can silently lose its declared ordering', async () => {
    for (const [, dep, , phaseId = 1] of BAD_DEPS) {
      await patchPlan({
        operations: [{ op: 'add_task', phase_id: phaseId, task: { name: 'Bad dep', requires: [dep] } }],
        basePath: tempDir,
      });
    }
    const state = await read({ basePath: tempDir });
    const phase = state.phases[0];
    const selection = selectRunnableTask(phase, state);
    const offered = [selection.task, ...(selection.parallel_available || [])].filter(Boolean);
    const prereq = phase.todo.find(t => t.id === '1.1');

    assert.equal(prereq.lifecycle, 'pending', 'precondition: 1.1 has not run yet');
    for (const task of offered) {
      const declaresPrereq = (task.requires || []).some(d => String(d?.id ?? d) === '1.1');
      assert.ok(
        !declaresPrereq,
        `task ${task.id} declares a dependency on 1.1 yet was offered as runnable while 1.1 is ${prereq.lifecycle}`,
      );
    }
  });
});

// add_task derives the next id as Math.max(existing indices) + 1. Two inputs
// poison that arithmetic permanently: an index at Number.MAX_SAFE_INTEGER (which
// Number.isInteger accepts) makes +1 stop advancing, and a task id without a dot
// makes parseInt return NaN, which Math.max then propagates forever. Either way
// every later auto-indexed add_task on that phase fails with "already exists"
// and the phase can never take another task.
//
// Covers add_task's own derivation. A task id written into state.json by another
// path is still only defended against here, not rejected at its source.
describe('patchPlan — add_task index derivation cannot wedge a phase', () => {
  beforeEach(setup);
  afterEach(() => rm(tempDir, { recursive: true, force: true }));

  it('rejects an explicit index that is an integer but not a safe integer', async () => {
    // Number.isInteger(1e21) is true, so this is the only shape that tells the
    // two predicates apart — without it the isSafeInteger guard is untested.
    const result = await patchPlan({
      operations: [{ op: 'add_task', phase_id: 1, task: { name: 'Huge', index: 1e21 } }],
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /index/i);
  });

  it('keeps accepting tasks after one is added at MAX_SAFE_INTEGER', async () => {
    const far = await patchPlan({
      operations: [{ op: 'add_task', phase_id: 1, task: { name: 'Far', index: Number.MAX_SAFE_INTEGER } }],
      basePath: tempDir,
    });
    assert.equal(far.success, true, far.message);

    const next = await patchPlan({
      operations: [{ op: 'add_task', phase_id: 1, task: { name: 'Next' } }],
      basePath: tempDir,
    });
    // Either derive a usable index, or refuse with an explanation — but never
    // hand back an unsafe id that wedges every subsequent add.
    if (next.success) {
      const state = await read({ basePath: tempDir });
      const added = state.phases[0].todo.find(t => t.name === 'Next');
      const index = Number(added.id.split('.')[1]);
      assert.ok(Number.isSafeInteger(index), `derived unsafe task index in id ${added.id}`);
      const again = await patchPlan({
        operations: [{ op: 'add_task', phase_id: 1, task: { name: 'Again' } }],
        basePath: tempDir,
      });
      assert.equal(again.success, true, `phase wedged after two adds: ${again.message}`);
    } else {
      assert.match(next.message, /index/i, 'a refusal must say what the caller should do');
      assert.doesNotMatch(next.message, /already exists/i, '"already exists" does not describe an index overflow');
    }
  });

  it('never derives an id from a task id that has no numeric index', async () => {
    // Simulates a task id that reached state.json without add_task's shape.
    const state = await read({ basePath: tempDir });
    state.phases[0].todo.push({
      id: 'weird', name: 'no-dot', lifecycle: 'pending', level: 'L1', requires: [],
      retry_count: 0, review_required: true, verification_required: true,
      checkpoint_commit: null, research_basis: [], evidence_refs: [],
    });
    await writeFile(join(tempDir, '.gsd', 'state.json'), JSON.stringify(state, null, 2));

    const result = await patchPlan({
      operations: [{ op: 'add_task', phase_id: 1, task: { name: 'After weird' } }],
      basePath: tempDir,
    });
    assert.equal(result.success, true, result.message);

    const after = await read({ basePath: tempDir });
    const ids = after.phases[0].todo.map(t => t.id);
    assert.ok(!ids.some(id => id.includes('NaN')), `persisted a NaN task id: ${ids.join(', ')}`);

    const again = await patchPlan({
      operations: [{ op: 'add_task', phase_id: 1, task: { name: 'And another' } }],
      basePath: tempDir,
    });
    assert.equal(again.success, true, `phase wedged by a dotless id: ${again.message}`);
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
