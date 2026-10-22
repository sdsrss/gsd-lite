// state-update checks a workflow_mode change against WORKFLOW_TRANSITIONS, but
// the check lived in validateStateUpdate's fast path, and an update carrying
// phases (or the server's own appended decisions or propagation) is validated
// by validateState instead, which knows nothing about where the workflow came
// from. Adding `phases` to a call therefore took it past the table:
// reconcile_workspace → planning with a phase rename was written. The rule
// holds on every path or on none.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, read, update } from '../src/tools/state/index.js';
import { HOLD_MODES, WORKFLOW_MODES, validateState } from '../src/schema.js';

async function project(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-transition-paths-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const created = await init({ project: 'paths', phases: [{ name: 'P1', tasks: [{ name: 'T1' }, { name: 'T2' }] }], basePath: dir });
  assert.ok(!created.error, JSON.stringify(created));
  return dir;
}

// The state in `mode`, made valid for it: a review mode carries its review,
// a hold the mode it interrupted.
function inMode(state, mode) {
  const next = structuredClone(state);
  next.workflow_mode = mode;
  next.current_review = mode === 'reviewing_task' ? { scope: 'task', scope_id: '1.1', stage: 'spec' }
    : mode === 'reviewing_phase' ? { scope: 'phase', scope_id: 1 } : null;
  next.suspended_modes = HOLD_MODES.includes(mode) ? ['executing_task'] : [];
  return next;
}

// Each way into update() that skips the fast path, carrying nothing else
// that could be refused: a phase rename, an appended decision, a propagation
// of a task whose contract did not change.
const FULL_PATHS = {
  phases: (to) => ({ updates: { workflow_mode: to, phases: [{ id: 1, name: 'P1, renamed' }] } }),
  'appended decisions': (to) => ({ updates: { workflow_mode: to }, _append_decisions: [{ id: 'd:1', summary: 'a decision', phase: 1 }] }),
  propagation: (to) => ({ updates: { workflow_mode: to }, _propagation_tasks: [{ phase_id: 1, task_id: '1.1', contract_changed: false }] }),
};

// The transition refusal in a result, which may list other problems after it.
const refusal = (result) => result.message?.match(/Invalid workflow_mode transition: [^;]*/)?.[0];

describe('the workflow_mode transition table holds on every update path', () => {
  it('an off-table change is refused with phases, decisions or propagation, as it is alone', async (t) => {
    const dir = await project(t);
    const statePath = join(dir, '.gsd', 'state.json');
    const base = JSON.parse(await readFile(statePath, 'utf8'));
    let refusedAlone = 0;
    const leaks = [];
    for (const from of WORKFLOW_MODES.filter((mode) => mode !== 'completed')) {
      const start = inMode(base, from);
      assert.deepEqual(validateState(start).errors, [], `premise: a valid state in ${from}`);
      for (const to of WORKFLOW_MODES.filter((mode) => mode !== from)) {
        await writeFile(statePath, JSON.stringify(start));
        const alone = await update({ updates: { workflow_mode: to }, basePath: dir });
        if (!refusal(alone)) continue;
        refusedAlone += 1;
        for (const [path, call] of Object.entries(FULL_PATHS)) {
          await writeFile(statePath, JSON.stringify(start));
          const result = await update({ ...call(to), basePath: dir });
          if (!result.error || refusal(result) !== refusal(alone)) leaks.push(`${from} → ${to} with ${path}: ${result.error ? result.message : 'written'}`);
        }
      }
    }
    assert.ok(refusedAlone > 20, `premise: the table refuses moves (${refusedAlone})`);
    assert.deepEqual(leaks, []);
  });

  // The two rows the repro found, pinned as literals: the enumeration above
  // is derived from the table and cannot see a row go missing from it.
  it('reconcile_workspace → planning with a phase rename is refused, and nothing is written', async (t) => {
    const dir = await project(t);
    await update({ updates: { workflow_mode: 'reconcile_workspace' }, basePath: dir });
    const before = await read({ basePath: dir });
    const result = await update({ updates: { workflow_mode: 'planning', phases: [{ id: 1, name: 'renamed' }] }, basePath: dir });
    assert.equal(result.error, true);
    assert.match(result.message, /Invalid workflow_mode transition: 'reconcile_workspace' → 'planning'/);
    const after = await read({ basePath: dir });
    assert.equal(after._version, before._version);
    assert.equal(after.phases[0].name, 'P1');
  });

  it('releasing a hold back to what it interrupted stays allowed with phases', async (t) => {
    const dir = await project(t);
    await update({ updates: { workflow_mode: 'planning' }, basePath: dir });
    await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: dir });
    assert.deepEqual((await read({ basePath: dir })).suspended_modes, ['planning'], 'premise: the pause interrupted planning');
    const result = await update({ updates: { workflow_mode: 'planning', phases: [{ id: 1, name: 'renamed' }] }, basePath: dir });
    assert.ok(!result.error, result.message);
    assert.equal((await read({ basePath: dir })).workflow_mode, 'planning');
  });
});
