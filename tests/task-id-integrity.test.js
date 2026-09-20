import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { validateState } from '../src/schema.js';
import { init, patchPlan, read, setLockPath, update } from '../src/tools/state/index.js';

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' };

/**
 * Task ids are `<phase>.<index>` by construction, and everything that resolves
 * one assumes that: `remove_task` finds the first phase holding a task with
 * that id, `selectRunnableTask` resolves task dependencies within a phase, and
 * `current_task` is a bare id with no phase alongside it.
 *
 * `createInitialState` and `patchPlan add_task` both enforce the shape. Plain
 * `update()` did not: it merges caller-supplied phases and pushes any task it
 * has not seen before, and validateState asked only for a non-empty string. So
 * a second task could be introduced under an id that already existed in
 * another phase — and then `remove_task` deleted whichever one it found first,
 * which is not necessarily the one the caller named.
 */
async function withProject(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-taskid-'));
  try {
    execSync('git init && git commit --allow-empty -m init', { cwd: dir, env: gitEnv, stdio: 'ignore' });
    setLockPath(null);
    await init({
      project: 'task-id',
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

describe('task ids stay unique and well-formed however a task arrives', () => {
  it('update() refuses to inject a task whose id already exists in another phase', async () => {
    await withProject(async (dir) => {
      const state = await read({ basePath: dir });
      const uiPhase = state.phases.find(p => p.id === 2);
      // A fully shaped task, cloned from a real one. A half-filled object is
      // refused for missing level/review_required, which would make this pass
      // without the id ever being looked at.
      const clone = (id, name) => ({ ...uiPhase.todo[0], id, name });

      const result = await update({
        updates: {
          phases: [{
            id: 2,
            todo: [...uiPhase.todo, clone('1.1', 'impostor')],
          }],
        },
        basePath: dir,
      });

      assert.ok(result?.error, 'a duplicate id must be refused where it is introduced');
      const after = await read({ basePath: dir });
      assert.equal(after.phases[1].todo.length, 1, 'nothing should have been injected');
    });
  });

  it('update() refuses an id that does not belong to the phase it is injected into', async () => {
    await withProject(async (dir) => {
      const state = await read({ basePath: dir });
      const uiPhase = state.phases.find(p => p.id === 2);
      // A fully shaped task, cloned from a real one. A half-filled object is
      // refused for missing level/review_required, which would make this pass
      // without the id ever being looked at.
      const clone = (id, name) => ({ ...uiPhase.todo[0], id, name });

      const result = await update({
        updates: {
          phases: [{
            id: 2,
            todo: [...uiPhase.todo, clone('7.9', 'stray')],
          }],
        },
        basePath: dir,
      });

      assert.ok(result?.error, 'ids are <phase>.<index>, and every resolver relies on it');
    });
  });

  it('validateState still accepts a state that already carries a duplicate, so it stays repairable', () => {
    // The invariant is enforced where ids enter, not retroactively. Refusing
    // such a state here would fail every write to it — including the patch
    // that would fix it — which is the same wedge in a different place. The
    // operations that cannot act safely on it refuse on their own terms.
    const state = {
      ...baseState(),
      phases: [
        { id: 1, name: 'Core', lifecycle: 'active', tasks: 1, done: 0, todo: [task('1.1')], phase_review: { status: 'pending', retry_count: 0 }, phase_handoff: {} },
        { id: 2, name: 'UI', lifecycle: 'pending', tasks: 1, done: 0, todo: [task('1.1')], phase_review: { status: 'pending', retry_count: 0 }, phase_handoff: {} },
      ],
    };
    // Asserting on the narrowest thing that can be wrong: this fixture is not a
    // complete state and reports other errors, so "valid === true" would be
    // testing the fixture, not the rule.
    const errors = validateState(state).errors.join('; ');
    assert.doesNotMatch(errors, /duplicate/i, 'a pre-existing duplicate must not fail validation');
    assert.doesNotMatch(errors, /1\.1.*must be "1\./, 'nor must the id shape be enforced retroactively');
  });

  it('remove_task refuses rather than guessing when an id is ambiguous', async () => {
    // Reachable only from a state written by an older version or by hand —
    // update() refuses to create it now. Picking the first match deletes work
    // the caller did not name, and says it succeeded.
    await withProject(async (dir) => {
      const state = await read({ basePath: dir });
      state.phases[1].todo.push({ id: '1.1', name: 'impostor', lifecycle: 'pending', requires: [], retry_count: 0, level: 'L1', review_required: true, verification_required: false, checkpoint_commit: null, files_changed: [], research_basis: [], evidence_refs: [], blocked_reason: null, unblock_condition: null });
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(dir, '.gsd', 'state.json'), JSON.stringify(state, null, 2));

      const result = await patchPlan({
        operations: [{ op: 'remove_task', task_id: '1.1' }],
        basePath: dir,
      });

      assert.ok(result?.error, 'an ambiguous removal must refuse, not pick one');
      assert.match(`${result.message}`, /1\.1/);
      const after = await read({ basePath: dir });
      assert.equal(after.phases[0].todo.some(t => t.id === '1.1'), true, 'the named task must still be there');
    });
  });
});

function task(id) {
  return {
    id, name: `task ${id}`, lifecycle: 'pending', level: 'L1', requires: [], retry_count: 0,
    review_required: true, verification_required: false, checkpoint_commit: null,
    files_changed: [], decisions: [], research_basis: [], evidence_refs: [],
    blocked_reason: null, unblock_condition: null,
  };
}

function baseState() {
  return {
    project: 'task-id', schema_version: '1.0', workflow_mode: 'executing_task',
    plan_version: 1, current_phase: 1, total_phases: 2, current_task: null,
    current_review: null, evidence: {}, decisions: [], research: null,
    context_health: null, git: {}, history: [],
  };
}
