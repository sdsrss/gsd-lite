import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKFLOW_TRANSITIONS, SYSTEM_HOLD_MODES } from '../src/schema.js';
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

  for (const from of nonTerminal) {
    for (const to of SYSTEM_HOLD_MODES) {
      if (from === to) continue; // self-transitions skip the whitelist entirely
      it(`${from} → ${to}`, () => {
        assert.ok(
          WORKFLOW_TRANSITIONS[from].includes(to),
          `preflight can impose '${to}' from '${from}', so the whitelist must allow it`,
        );
      });
    }
  }
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
