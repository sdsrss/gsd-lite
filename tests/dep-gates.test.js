import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createInitialState } from '../src/schema.js';
import { init, patchPlan, setLockPath } from '../src/tools/state/index.js';
import { selectRunnableTask } from '../src/tools/state/logic.js';

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' };

/**
 * Scheduler ⇔ validator, for every (kind, gate) pair.
 *
 * `{kind: 'task', gate: 'phase_complete'}` was accepted by all three
 * plan-authoring paths and refused by selectRunnableTask on every call, so the
 * task never became runnable, the phase never reached all-accepted, and
 * current_phase never advanced past it. The plan was valid, the project was
 * finished, and the only ways out were replan or editing state.json by hand.
 *
 * The gate vocabulary is per kind, and the three authoring paths each checked
 * it against one flat set. An earlier fix split the vocabulary by hand and
 * dropped 'checkpoint' from the phase side, over-rejecting plans that worked;
 * it was reverted (98b47f8). So this does not test the reported pair — it
 * enumerates both kinds against every gate value plus the default and an
 * out-of-vocabulary one, and asserts three things at once:
 *
 *   1. the three authoring paths agree with each other,
 *   2. they agree with the table below,
 *   3. the scheduler honours exactly what they accept.
 *
 * The table is the anti-vacuity guard: without it, "validator rejects
 * everything, scheduler satisfies nothing" would pass (1) and (3) happily.
 * Every `true` below is a branch in selectRunnableTask that can be satisfied;
 * every `false` is one that cannot, for any state.
 */
const DEFAULT = '(default)';
const label = (gate) => (gate === undefined ? DEFAULT : String(gate));

const EXPECTED = {
  // logic.js: gate 'checkpoint' → dep task checkpointed|accepted; 'accepted'
  // (also the default) → dep task accepted; anything else → never runnable.
  task: { checkpoint: true, accepted: true, phase_complete: false, sometime: false, [DEFAULT]: true },
  // logic.js: a phase dep is satisfied when the dep phase is accepted. The gate
  // does not narrow it further, so every gate in the vocabulary is reachable —
  // but a value outside the vocabulary is still refused on both sides.
  phase: { checkpoint: true, accepted: true, phase_complete: true, sometime: false, [DEFAULT]: true },
};

const GATES = ['checkpoint', 'accepted', 'phase_complete', 'sometime', undefined];

function makeDep(kind, gate) {
  const dep = kind === 'task' ? { kind: 'task', id: '1.1' } : { kind: 'phase', id: 1 };
  if (gate !== undefined) dep.gate = gate;
  return dep;
}

/**
 * Can the scheduler ever run a task carrying this dependency? Measured in the
 * best case the dependency could possibly be in — dep task accepted, dep phase
 * accepted — so a `false` means "no state satisfies this", not "not yet".
 */
function schedulerSatisfies(kind, gate) {
  const dep = makeDep(kind, gate);
  if (kind === 'task') {
    const phase = {
      id: 1,
      lifecycle: 'active',
      todo: [
        { id: '1.1', name: 'A', lifecycle: 'accepted', retry_count: 0, requires: [] },
        { id: '1.2', name: 'B', lifecycle: 'pending', retry_count: 0, requires: [dep] },
      ],
    };
    const state = { phases: [phase] };
    return selectRunnableTask(phase, state).task?.id === '1.2';
  }
  const donePhase = {
    id: 1,
    lifecycle: 'accepted',
    todo: [{ id: '1.1', name: 'A', lifecycle: 'accepted', retry_count: 0, requires: [] }],
  };
  const phase = {
    id: 2,
    lifecycle: 'active',
    todo: [{ id: '2.1', name: 'C', lifecycle: 'pending', retry_count: 0, requires: [dep] }],
  };
  const state = { phases: [donePhase, phase] };
  return selectRunnableTask(phase, state).task?.id === '2.1';
}

/** Authoring path 1: the plan handed to state-init. */
function initAccepts(kind, gate) {
  const dep = makeDep(kind, gate);
  const phases = kind === 'task'
    ? [{ name: 'Core', tasks: [{ name: 'A' }, { name: 'B', requires: [dep] }] }]
    : [{ name: 'Core', tasks: [{ name: 'A' }] }, { name: 'UI', tasks: [{ name: 'C', requires: [dep] }] }];
  return !createInitialState({ project: 'dep-gates', phases }).error;
}

async function withProject(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-depgates-'));
  try {
    execSync('git init && git commit --allow-empty -m init', { cwd: dir, env: gitEnv, stdio: 'ignore' });
    setLockPath(null);
    await init({
      project: 'dep-gates',
      phases: [
        { name: 'Core', tasks: [{ name: 'A' }, { name: 'B' }] },
        { name: 'UI', tasks: [{ name: 'C' }] },
      ],
      basePath: dir,
    });
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Authoring path 2: state-patch add_task. */
function addTaskAccepts(kind, gate) {
  return withProject(async (dir) => {
    const result = await patchPlan({
      operations: [{
        op: 'add_task',
        phase_id: kind === 'task' ? 1 : 2,
        task: { name: 'Added', requires: [makeDep(kind, gate)] },
      }],
      basePath: dir,
    });
    return result.success === true;
  });
}

/** Authoring path 3: state-patch add_dependency. */
function addDependencyAccepts(kind, gate) {
  return withProject(async (dir) => {
    const result = await patchPlan({
      operations: [{
        op: 'add_dependency',
        task_id: kind === 'task' ? '1.2' : '2.1',
        requires: makeDep(kind, gate),
      }],
      basePath: dir,
    });
    return result.success === true;
  });
}

describe('dependency gates: the scheduler honours exactly what the validators accept', () => {
  for (const kind of ['task', 'phase']) {
    for (const gate of GATES) {
      it(`${kind} dependency, gate=${label(gate)}`, async () => {
        const expected = EXPECTED[kind][label(gate)];

        const authoring = [
          ['state-init', initAccepts(kind, gate)],
          ['add_task', await addTaskAccepts(kind, gate)],
          ['add_dependency', await addDependencyAccepts(kind, gate)],
        ];
        for (const [path, accepts] of authoring) {
          assert.equal(accepts, expected, `${path} should ${expected ? 'accept' : 'reject'} {kind:${kind}, gate:${label(gate)}}`);
        }

        assert.equal(
          schedulerSatisfies(kind, gate),
          expected,
          expected
            ? `selectRunnableTask never runs a task gated {kind:${kind}, gate:${label(gate)}}, but the plan-authoring paths accept it — that phase can never complete`
            : `selectRunnableTask runs a task gated {kind:${kind}, gate:${label(gate)}} that the plan-authoring paths reject`,
        );
      });
    }
  }
});
