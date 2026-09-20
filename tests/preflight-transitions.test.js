import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKFLOW_TRANSITIONS, SYSTEM_HOLD_MODES, validateStateUpdate } from '../src/schema.js';
import { init, read, update } from '../src/tools/state/index.js';
import { resumeWorkflow } from '../src/tools/orchestrator/index.js';

// Preflight does not ask permission. evaluatePreflight detects a condition —
// HEAD moved, the plan file changed, research expired, direction drifted — and
// persists the matching workflow_mode through the same update() path a tool
// call uses, which means WORKFLOW_TRANSITIONS gets a vote on a state the system
// has already decided is true. Where the whitelist said no, resume returned
// VALIDATION_FAILED, nothing was written, and the next resume hit the same wall.
describe('every non-terminal mode can be moved into a system hold', () => {
  const nonTerminal = Object.keys(WORKFLOW_TRANSITIONS)
    .filter((mode) => mode !== 'completed' && mode !== 'failed');

  // Drive the validator that actually gates the write, not the table.
  //
  // The first version asserted `WORKFLOW_TRANSITIONS[from].includes(to)` — the
  // expression schema.js uses to BUILD the table — so it restated its own
  // constructor. These go through validateStateUpdate, which is what persist()
  // calls.
  //
  // How to falsify this suite, because the obvious way does not work: emptying
  // WORKFLOW_TRANSITIONS_BASE leaves all 36 green, since the composer adds
  // SYSTEM_HOLD_MODES back on top. That is the composer doing its job, not the
  // test failing to check. The real check is whether this catches the bug it was
  // written for — replace the composed table with the hand-maintained one from
  // before the fix and 20 of the 36 go red, `replan_required →
  // reconcile_workspace` (the audit's worked example) among them.
  //
  // What it does NOT cover: a change to SYSTEM_HOLD_MODES itself, which this
  // follows rather than pins. It guards against a return to a hand-listed table
  // with gaps, which is where the bug came from.
  const stateIn = (mode) => ({
    schema_version: 'v1',
    project: 'matrix',
    workflow_mode: mode,
    current_phase: 1,
    current_task: null,
    total_phases: 1,
    phases: [{ id: 1, name: 'P', lifecycle: 'active', todo: [], phase_review: { status: 'pending', retry_count: 0 } }],
  });

  for (const from of nonTerminal) {
    for (const to of SYSTEM_HOLD_MODES) {
      if (from === to) continue; // self-transitions skip the whitelist entirely
      it(`${from} → ${to}`, () => {
        const result = validateStateUpdate(stateIn(from), { workflow_mode: to });
        assert.ok(
          result.valid,
          `preflight can impose '${to}' from '${from}', so the validator must accept it: ${(result.errors || []).join('; ')}`,
        );
      });
    }
  }

  it('rejects a transition that is genuinely not allowed', () => {
    // Vacuity guard: if validateStateUpdate stopped checking transitions at all,
    // every assertion above would pass for the wrong reason.
    const result = validateStateUpdate(stateIn('reconcile_workspace'), { workflow_mode: 'completed' });
    assert.equal(result.valid, false, 'the transition check is not running');
  });
});

describe('preflight overrides survive the transition whitelist', () => {
  async function gitProject(name, fn) {
    const dir = await mkdtemp(join(tmpdir(), `gsd-${name}-`));
    try {
      execSync('git init', { cwd: dir, stdio: 'ignore' });
      execSync('git config user.email test@example.com', { cwd: dir, stdio: 'ignore' });
      execSync('git config user.name Test', { cwd: dir, stdio: 'ignore' });
      writeFileSync(join(dir, 'README.md'), 'init\n');
      execSync('git add -A && git commit -m init', { cwd: dir, stdio: 'ignore' });
      await init({
        project: name,
        phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
        basePath: dir,
      });
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // The audit's worked example: sitting in replan_required, the user edits the
  // plan and commits. HEAD moves, so preflight wants reconcile_workspace — but
  // replan_required only listed executing_task and paused_by_user, so every
  // resume from then on returned VALIDATION_FAILED and changed nothing.
  it('reconciles a moved HEAD while in replan_required', async () => {
    await gitProject('preflight-replan', async (dir) => {
      const entered = await update({ updates: { workflow_mode: 'executing_task' }, basePath: dir });
      assert.ok(!entered.error, `setup: ${entered.message}`);
      const held = await update({ updates: { workflow_mode: 'replan_required' }, basePath: dir });
      assert.ok(!held.error, `setup: ${held.message}`);

      writeFileSync(join(dir, 'plan.md'), 'revised\n');
      execSync('git add -A && git commit -m revise', { cwd: dir, stdio: 'ignore' });

      const result = await resumeWorkflow({ basePath: dir });
      assert.ok(!result.error, `resume should reconcile, not fail: ${result.code}: ${result.message}`);
      assert.equal(result.workflow_mode, 'reconcile_workspace');
      assert.equal((await read({ basePath: dir })).workflow_mode, 'reconcile_workspace',
        'the override must actually persist, or the next resume repeats it');
    });
  });

  it('reconciles a moved HEAD while already in reconcile_workspace', async () => {
    // Self-transition: the condition is still true on the next resume. This one
    // always worked (the whitelist skips same-mode writes) and is pinned so the
    // widening below cannot quietly break it.
    await gitProject('preflight-self', async (dir) => {
      await update({ updates: { workflow_mode: 'executing_task' }, basePath: dir });
      await update({ updates: { workflow_mode: 'reconcile_workspace' }, basePath: dir });

      writeFileSync(join(dir, 'x.md'), 'moved\n');
      execSync('git add -A && git commit -m move', { cwd: dir, stdio: 'ignore' });

      const result = await resumeWorkflow({ basePath: dir });
      assert.ok(!result.error, `resume failed: ${result.code}: ${result.message}`);
      assert.equal(result.workflow_mode, 'reconcile_workspace');
    });
  });
});
