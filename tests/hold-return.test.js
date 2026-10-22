// A hold comes back to what it interrupted.
//
// workflow_mode is one slot, and a hold (a pause, a /clear, a decision owed,
// a workspace or plan to reconcile) overwrites it. Releasing the hold used to
// work the way back out from current_review alone, which cannot express
// planning and cannot express a hold under another hold: a pause in planning
// resumed into execution, a /clear over a pause resumed execution outright,
// and the reconcile / replan / give-up-research releases wrote executing_task
// whatever they had interrupted. Preflight also overrode modes where somebody
// owed an answer: a dirty-phase rollback unpaused a paused project, ended a
// plan revision and cleared a held decision, server-side.
//
// The server now keeps the interrupted modes in suspended_modes, a stack, and
// every release reads its top.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../src/schema.js';
import * as stateApi from '../src/tools/state/index.js';
import { handleResearcherResult, resumeWorkflow } from '../src/tools/orchestrator/index.js';
import { checkpointTask, createTempDir, initProject, acceptTask, completePhase, removeTempDir, read, update } from './e2e-helpers.js';

const { WORKFLOW_MODES, WORKFLOW_TRANSITIONS, validateState, migrateState } = schema;

describe('premise', () => {
  it('the schema exports the stack rule and the mode sets it is built on', () => {
    assert.equal(typeof schema.nextSuspendedModes, 'function');
    assert.ok(Array.isArray(schema.WORK_MODES) && Array.isArray(schema.HOLD_MODES) && Array.isArray(schema.TERMINAL_MODES));
    assert.equal(typeof stateApi.resumeTarget, 'function');
  });

  it('every mode is exactly one of work, hold or terminal', () => {
    const { WORK_MODES = [], HOLD_MODES = [], TERMINAL_MODES = [] } = schema;
    assert.deepEqual([...WORK_MODES, ...HOLD_MODES, ...TERMINAL_MODES].sort(), [...WORKFLOW_MODES].sort());
  });
});

describe('the stack rule', () => {
  const next = (...args) => schema.nextSuspendedModes(...args);
  for (const [label, stack, from, to, expected] of [
    ['a hold entered from work remembers the work', [], 'executing_task', 'paused_by_user', ['executing_task']],
    ['releasing to the interrupted mode returns to it', ['executing_task'], 'paused_by_user', 'executing_task', []],
    ['a hold over a hold remembers the hold', ['executing_task'], 'paused_by_user', 'awaiting_clear', ['executing_task', 'paused_by_user']],
    ['and releasing it returns to the hold underneath', ['executing_task', 'paused_by_user'], 'awaiting_clear', 'paused_by_user', ['executing_task']],
    ['a pause in planning comes back to planning', ['planning'], 'paused_by_user', 'planning', []],
    ['leaving for a different work mode abandons what was interrupted', ['reviewing_task'], 'reconcile_workspace', 'executing_task', []],
    ['completion abandons it', ['executing_task'], 'awaiting_user', 'completed', []],
    ['failure abandons it', ['executing_task'], 'awaiting_user', 'failed', []],
    ['work to work keeps nothing', [], 'executing_task', 'reviewing_task', []],
    ['no change changes nothing', ['executing_task'], 'paused_by_user', 'paused_by_user', ['executing_task']],
    ['a stack from an older state counts as empty', undefined, 'executing_task', 'paused_by_user', ['executing_task']],
  ]) {
    it(label, () => {
      assert.deepEqual(next(stack, from, to), expected);
    });
  }

  // Trimming dropped the oldest entry, which is the work mode at the bottom;
  // unwound, a long chain ended in a hold (pre-tag review).
  it('keeps at most MAX_SUSPENDED_MODES, dropping the oldest hold and keeping the work at the bottom', () => {
    const holds = schema.HOLD_MODES;
    let stack = [];
    let from = 'executing_task';
    for (let i = 0; i < schema.MAX_SUSPENDED_MODES + 3; i++) {
      const to = holds[i % holds.length] === from ? holds[(i + 1) % holds.length] : holds[i % holds.length];
      stack = next(stack, from, to);
      from = to;
    }
    assert.equal(stack.length, schema.MAX_SUSPENDED_MODES);
    assert.equal(stack[0], 'executing_task');
    assert.ok(!stack.slice(1).includes('executing_task'));
  });
});

describe('suspended_modes in the state', () => {
  it('is readable and not writable', async (t) => {
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    await initProject(dir);
    const res = await update({ updates: { suspended_modes: ['planning'] }, basePath: dir });
    assert.equal(res.code, 'INVALID_INPUT', JSON.stringify(res));
    const read1 = await read({ fields: ['suspended_modes'], basePath: dir });
    assert.deepEqual(read1, { suspended_modes: [] });
  });

  it('is empty in every work and terminal mode — validation refuses otherwise', async (t) => {
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    await initProject(dir);
    const state = await read({ basePath: dir });
    assert.ok(validateState(state).valid, 'premise: a fresh state is valid');
    assert.match(validateState({ ...state, suspended_modes: ['planning'] }).errors.join('; '), /suspended_modes must be empty in workflow_mode "executing_task"/);
    assert.match(validateState({ ...state, workflow_mode: 'paused_by_user', suspended_modes: ['nonsense'] }).errors.join('; '), /suspended_modes must be an array of at most \d+ workflow modes/);
    assert.ok(validateState({ ...state, workflow_mode: 'paused_by_user', suspended_modes: ['executing_task'] }).valid);
  });

  it('is cleared on load when a work mode carries one, so no state can be stuck behind it', () => {
    const migrated = migrateState({ schema_version: 1, workflow_mode: 'executing_task', suspended_modes: ['planning'], phases: [] });
    assert.deepEqual(migrated.suspended_modes, []);
    assert.deepEqual(migrateState({ schema_version: 1, workflow_mode: 'paused_by_user', phases: [] }).suspended_modes, []);
  });
});

// Every hold, entered from every mode allowed to enter it, then released the
// way the server says to: the release lands back where it started.
describe('every hold returns to the mode it interrupted', () => {
  const MODES = {
    planning: { workflow_mode: 'planning', current_review: null },
    executing_task: { workflow_mode: 'executing_task', current_review: null },
    reviewing_task: { workflow_mode: 'reviewing_task', current_review: { scope: 'task', scope_id: '1.1', stage: 'quality' } },
    reviewing_phase: { workflow_mode: 'reviewing_phase', current_review: { scope: 'phase', scope_id: 1 } },
    awaiting_user: { workflow_mode: 'awaiting_user', current_review: { scope: 'phase', scope_id: 1, stage: 'review_retry_exhausted', retry_count: 6 } },
  };

  async function inMode(t, name) {
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    await initProject(dir);
    await checkpointTask(dir, 1, '1.1');
    const statePath = join(dir, '.gsd', 'state.json');
    const raw = JSON.parse(await readFile(statePath, 'utf8'));
    Object.assign(raw, MODES[name], { suspended_modes: [] });
    await writeFile(statePath, JSON.stringify(raw));
    return dir;
  }

  const enter = async (dir, mode) => {
    const res = await update({ updates: { workflow_mode: mode }, basePath: dir });
    assert.ok(res.success, `entering ${mode}: ${JSON.stringify(res)}`);
  };
  const release = async (dir) => {
    const target = stateApi.resumeTarget(await read({ basePath: dir }));
    const res = await update({ updates: { workflow_mode: target }, basePath: dir });
    assert.ok(res.success, `releasing to ${target}: ${JSON.stringify(res)}`);
    return target;
  };

  for (const from of Object.keys(MODES)) {
    for (const hold of (WORKFLOW_TRANSITIONS[from] || []).filter((m) => (schema.HOLD_MODES || []).includes(m))) {
      it(`${from} → ${hold} → back`, async (t) => {
        const dir = await inMode(t, from);
        await enter(dir, hold);
        assert.equal(await release(dir), from);
        const after = await read({ basePath: dir });
        assert.equal(after.workflow_mode, from);
        assert.deepEqual(after.current_review, MODES[from].current_review, 'the interrupted review is intact');
        assert.deepEqual(after.suspended_modes, []);
      });
    }
  }

  // A hold under a hold: the pause and the owed decision are the two that
  // must survive another one arriving on top.
  for (const [from, first] of [['executing_task', 'paused_by_user'], ['planning', 'paused_by_user'], ['reviewing_task', 'awaiting_user'], ['reviewing_task', 'paused_by_user']]) {
    for (const second of (WORKFLOW_TRANSITIONS[first] || []).filter((m) => (schema.HOLD_MODES || []).includes(m) && m !== first)) {
      it(`${from} → ${first} → ${second} → back → back`, async (t) => {
        const dir = await inMode(t, from);
        await enter(dir, first);
        await enter(dir, second);
        assert.equal(await release(dir), first);
        assert.equal(await release(dir), from);
        assert.deepEqual((await read({ basePath: dir })).suspended_modes, []);
      });
    }
  }
});

describe('the reported cases, resumed', () => {
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  async function gitProject(t) {
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'fixture@example.invalid');
    git(dir, 'config', 'user.name', 'fixture');
    await writeFile(join(dir, 'a.txt'), '1');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'one');
    await initProject(dir);
    await update({ updates: { git_head: git(dir, 'rev-parse', '--short', 'HEAD') }, basePath: dir });
    await resumeWorkflow({ basePath: dir }); // records the plan hashes
    return dir;
  }
  const moveHead = async (dir) => { await writeFile(join(dir, 'a.txt'), '2'); git(dir, 'commit', '-qam', 'two'); };

  it('A: a pause during planning resumes to planning', async (t) => {
    const dir = await gitProject(t);
    await update({ updates: { workflow_mode: 'planning' }, basePath: dir });
    await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: dir });
    const res = await resumeWorkflow({ basePath: dir });
    assert.equal(res.workflow_mode, 'paused_by_user');
    assert.equal(res.resume_to, 'planning');
    const released = await update({ updates: { workflow_mode: res.resume_to }, basePath: dir });
    assert.ok(released.success, JSON.stringify(released));
  });

  it('B: a /clear over a pause comes back paused', async (t) => {
    const dir = await gitProject(t);
    await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: dir });
    await update({ updates: { workflow_mode: 'awaiting_clear' }, basePath: dir });
    const res = await resumeWorkflow({ basePath: dir });
    assert.equal(res.workflow_mode, 'paused_by_user', JSON.stringify(res));
    assert.equal(res.action, 'await_manual_intervention');
    assert.equal(res.resume_to, 'executing_task');
  });

  it('B: a /clear during planning comes back to planning', async (t) => {
    // Context runs low while a plan is revised as well as while one executes.
    const dir = await gitProject(t);
    await update({ updates: { workflow_mode: 'planning' }, basePath: dir });
    const cleared = await update({ updates: { workflow_mode: 'awaiting_clear' }, basePath: dir });
    assert.ok(cleared.success, JSON.stringify(cleared));
    const res = await resumeWorkflow({ basePath: dir });
    assert.equal(res.workflow_mode, 'planning', JSON.stringify(res));
    assert.equal((await read({ basePath: dir })).workflow_mode, 'planning');
  });

  it('B: a /clear over a pause whose HEAD moved comes back paused', async (t) => {
    // The /clear is released first, back to the pause, and the pause is
    // not checked; the HEAD change is found once work resumes.
    const dir = await gitProject(t);
    await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: dir });
    await update({ updates: { workflow_mode: 'awaiting_clear' }, basePath: dir });
    await moveHead(dir);
    const res = await resumeWorkflow({ basePath: dir });
    assert.equal(res.workflow_mode, 'paused_by_user', JSON.stringify(res));
    assert.equal(res.action, 'await_manual_intervention');
    assert.deepEqual((await read({ basePath: dir })).suspended_modes, ['executing_task']);
  });

  it('C: a paused project whose HEAD moved stays paused', async (t) => {
    const dir = await gitProject(t);
    await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: dir });
    await moveHead(dir);
    const res = await resumeWorkflow({ basePath: dir });
    assert.equal(res.workflow_mode, 'paused_by_user', JSON.stringify(res));
    assert.equal((await read({ basePath: dir })).workflow_mode, 'paused_by_user');
  });

  it('D: planning with the plan being edited stays planning', async (t) => {
    const dir = await gitProject(t);
    await update({ updates: { workflow_mode: 'planning' }, basePath: dir });
    await writeFile(join(dir, '.gsd', 'plan.md'), '# revised plan\n');
    const res = await resumeWorkflow({ basePath: dir });
    assert.equal(res.workflow_mode, 'planning', JSON.stringify(res));
  });

  it('D: and finishing the plan does not report the revision as drift', async (t) => {
    const dir = await gitProject(t);
    await update({ updates: { workflow_mode: 'planning' }, basePath: dir });
    await writeFile(join(dir, '.gsd', 'plan.md'), '# revised plan\n');
    await update({ updates: { workflow_mode: 'executing_task' }, basePath: dir });
    const res = await resumeWorkflow({ basePath: dir });
    assert.notEqual(res.workflow_mode, 'replan_required', JSON.stringify(res));
  });

  it('E: a review interrupted by a HEAD change is named as the way back', async (t) => {
    const dir = await gitProject(t);
    await checkpointTask(dir, 1, '1.1');
    const review = { scope: 'task', scope_id: '1.1', stage: 'quality' };
    await update({ updates: { workflow_mode: 'reviewing_task', current_review: review }, basePath: dir });
    await moveHead(dir);
    const res = await resumeWorkflow({ basePath: dir });
    assert.equal(res.workflow_mode, 'reconcile_workspace', JSON.stringify(res));
    assert.equal(res.resume_to, 'reviewing_task');
    const released = await update({ updates: { git_head: git(dir, 'rev-parse', '--short', 'HEAD'), workflow_mode: res.resume_to }, basePath: dir });
    assert.ok(released.success, JSON.stringify(released));
    const again = await resumeWorkflow({ basePath: dir });
    assert.equal(again.action, 'dispatch_reviewer', JSON.stringify(again));
    assert.deepEqual(again.current_review, review);
  });

  for (const mode of ['paused_by_user', 'planning', 'awaiting_user']) {
    it(`F: a dirty earlier phase does not override ${mode}`, async (t) => {
      const dir = await createTempDir();
      t.after(() => removeTempDir(dir));
      await initProject(dir);
      await acceptTask(dir, 1, '1.1');
      await acceptTask(dir, 1, '1.2');
      assert.ok((await completePhase(dir, 1)).success, 'premise: phase 1 is complete');
      const statePath = join(dir, '.gsd', 'state.json');
      const raw = JSON.parse(await readFile(statePath, 'utf8'));
      raw.phases[0].todo[0].lifecycle = 'needs_revalidation';
      raw.workflow_mode = mode;
      raw.suspended_modes = ['executing_task'];
      raw.current_review = mode === 'awaiting_user' ? { scope: 'phase', scope_id: 2, stage: 'review_retry_exhausted', retry_count: 6 } : null;
      await writeFile(statePath, JSON.stringify(raw));
      const res = await resumeWorkflow({ basePath: dir });
      assert.notEqual(res.action, 'rollback_to_dirty_phase', JSON.stringify(res));
      const after = await read({ basePath: dir });
      assert.equal(after.workflow_mode, mode);
      assert.equal(after.current_phase, 2);
      assert.deepEqual(after.current_review, raw.current_review);
    });
  }
});

// The writers that set workflow_mode on the state object directly rather
// than through update() keep the stack too.
describe('the direct writers keep the stack', () => {
  it('phase-complete raising direction drift remembers what it interrupted, and resolving it returns there', async (t) => {
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    await initProject(dir);
    await acceptTask(dir, 1, '1.1');
    await acceptTask(dir, 1, '1.2');
    const drift = await completePhase(dir, 1, { direction_ok: false });
    assert.equal(drift.action, 'direction_drift', JSON.stringify(drift));
    assert.deepEqual((await read({ basePath: dir })).suspended_modes, ['executing_task']);
    const resolved = await stateApi.phaseComplete({
      phase_id: 1, basePath: dir, direction_ok: true,
      verification: { lint: { exit_code: 0 }, typecheck: { exit_code: 0 }, test: { exit_code: 0 } },
    });
    assert.ok(resolved.success, JSON.stringify(resolved));
    const after = await read({ basePath: dir });
    assert.equal(after.workflow_mode, 'executing_task');
    assert.deepEqual(after.suspended_modes, []);
  });

  it('phase-complete finishing the project leaves no stack', async (t) => {
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    await initProject(dir, { phases: [{ name: 'Only', tasks: [{ index: 1, name: 'T', level: 'L1', requires: [] }] }] });
    await acceptTask(dir, 1, '1.1');
    assert.equal((await completePhase(dir, 1)).workflow_mode, 'completed');
    assert.deepEqual((await read({ basePath: dir })).suspended_modes, []);
  });
});

// A refresh the server refuses (a blocked result over research on record)
// leaves the project in research_refresh_needed, and the refusal names the
// way out. It named executing_task, which dropped the review the refresh had
// interrupted.
describe('giving up a refused research refresh', () => {
  it('returns to the mode the refresh interrupted', async (t) => {
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    await initProject(dir);
    await checkpointTask(dir, 1, '1.1');
    const day = 86_400_000;
    const statePath = join(dir, '.gsd', 'state.json');
    const raw = JSON.parse(await readFile(statePath, 'utf8'));
    const review = { scope: 'task', scope_id: '1.1', stage: 'quality' };
    Object.assign(raw, {
      workflow_mode: 'reviewing_task',
      current_review: review,
      research: {
        volatility: 'medium',
        expires_at: new Date(Date.now() - day).toISOString(),
        sources: [],
        files: ['STACK.md', 'ARCHITECTURE.md', 'PITFALLS.md', 'SUMMARY.md'],
        updated_at: new Date(Date.now() - 30 * day).toISOString(),
        decision_index: { 'decision:a': { summary: 'Use A', source: 'docs', expires_at: new Date(Date.now() - day).toISOString() } },
      },
    });
    await writeFile(statePath, JSON.stringify(raw));
    assert.ok((await update({ updates: { workflow_mode: 'research_refresh_needed' }, basePath: dir })).success);

    const soon = new Date(Date.now() + day).toISOString();
    const refused = await stateApi.storeResearch({
      result: { decision_ids: ['decision:blocked-no-sources'], volatility: 'high', expires_at: soon, sources: [], blocked: true },
      decision_index: { 'decision:blocked-no-sources': { summary: '[BLOCKED] no sources', source: 'none', expires_at: soon } },
      artifacts: { 'STACK.md': 'x', 'ARCHITECTURE.md': 'x', 'PITFALLS.md': 'x', 'SUMMARY.md': 'x' },
      basePath: dir,
    });
    assert.equal(refused.code, 'VALIDATION_FAILED', JSON.stringify(refused));
    assert.match(refused.message, /state-update \(research: null, workflow_mode: "reviewing_task"\)/);

    const gaveUp = await update({ updates: { research: null, workflow_mode: 'reviewing_task' }, basePath: dir });
    assert.ok(gaveUp.success, JSON.stringify(gaveUp));
    const after = await read({ basePath: dir });
    assert.equal(after.workflow_mode, 'reviewing_task');
    assert.deepEqual(after.current_review, review);
    assert.deepEqual(after.suspended_modes, []);
  });
});

// Two holds are released by the server, not by a state-update of resume_to:
// a stored research refresh, and blocked tasks that unblock themselves. Both
// wrote a fixed mode (pre-tag review), which the property test above could
// not see — it releases every hold with update().
describe('the holds the server releases itself', () => {
  const research = {
    result: { decision_ids: ['decision:a'], blocked: false, volatility: 'medium', expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), sources: [{ id: 's1', type: 'docs', ref: 'https://example.com/docs' }] },
    decision_index: { 'decision:a': { summary: 'A', source: 'docs' } },
    artifacts: { 'STACK.md': '# Stack\n', 'ARCHITECTURE.md': '# Architecture\n', 'PITFALLS.md': '# Pitfalls\n', 'SUMMARY.md': '# Summary\n' },
  };

  for (const [label, path, back, stack] of [
    ['planning', ['planning'], 'planning', []],
    ['a pause over execution', ['paused_by_user'], 'paused_by_user', ['executing_task']],
    ['a /clear over execution', ['awaiting_clear'], 'awaiting_clear', ['executing_task']],
  ]) {
    it(`a stored refresh returns to ${label}`, async (t) => {
      const dir = await createTempDir();
      t.after(() => removeTempDir(dir));
      await initProject(dir);
      for (const mode of [...path, 'research_refresh_needed']) {
        const res = await update({ updates: { workflow_mode: mode }, basePath: dir });
        assert.ok(res.success, `entering ${mode}: ${JSON.stringify(res)}`);
      }
      const stored = await handleResearcherResult({ ...research, basePath: dir });
      assert.equal(stored.action, 'research_stored', JSON.stringify(stored));
      const after = await read({ basePath: dir });
      assert.equal(after.workflow_mode, back);
      assert.deepEqual(after.suspended_modes, stack);
    });
  }

  // A pause over a refresh: a blocked result refused while paused named
  // research_refresh_needed as the way out, and research given up under the
  // pause sent the researcher again once the pause released (pre-ship review).
  it('research given up during a pause over a refresh is not refreshed again', async (t) => {
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    await initProject(dir);
    assert.equal((await handleResearcherResult({ ...research, basePath: dir })).action, 'research_stored', 'premise: research on record');
    for (const mode of ['research_refresh_needed', 'paused_by_user']) await update({ updates: { workflow_mode: mode }, basePath: dir });
    const blocked = { ...research, result: { ...research.result, blocked: true } };
    const refused = await handleResearcherResult({ ...blocked, basePath: dir });
    assert.equal(refused.code, 'VALIDATION_FAILED', JSON.stringify(refused));
    const way = refused.message.match(/state-update \(research: null, workflow_mode: "(\w+)"\)/);
    assert.equal(way?.[1], 'paused_by_user', refused.message);
    assert.ok((await update({ updates: { research: null, workflow_mode: way[1] }, basePath: dir })).success);
    const paused = await resumeWorkflow({ basePath: dir });
    assert.equal(paused.resume_to, 'research_refresh_needed', JSON.stringify(paused));
    await update({ updates: { workflow_mode: paused.resume_to }, basePath: dir });
    const res = await resumeWorkflow({ basePath: dir });
    assert.notEqual(res.action, 'dispatch_researcher', JSON.stringify(res));
    assert.equal((await read({ basePath: dir })).workflow_mode, 'executing_task');
  });

  for (const [label, path, mode, stack] of [
    ['releases a blocked-task hold to the plan revision it interrupted', ['planning', 'awaiting_user'], 'planning', []],
    ['leaves a pause alone', ['paused_by_user'], 'paused_by_user', ['executing_task']],
  ]) {
    it(`unblocking a task by hand ${label}`, async (t) => {
      const dir = await createTempDir();
      t.after(() => removeTempDir(dir));
      await initProject(dir);
      for (const m of path) await update({ updates: { workflow_mode: m }, basePath: dir });
      const statePath = join(dir, '.gsd', 'state.json');
      const raw = JSON.parse(await readFile(statePath, 'utf8'));
      Object.assign(raw.phases[0].todo[0], { lifecycle: 'blocked', blocked_reason: 'needs a key' });
      await writeFile(statePath, JSON.stringify(raw));
      const res = await resumeWorkflow({ basePath: dir, unblock_tasks: [raw.phases[0].todo[0].id] });
      assert.deepEqual(res.unblocked, [raw.phases[0].todo[0].id], JSON.stringify(res));
      const after = await read({ basePath: dir });
      assert.equal(after.workflow_mode, mode);
      assert.deepEqual(after.suspended_modes, stack);
      assert.equal(after.phases[0].todo[0].lifecycle, 'pending');
    });
  }

  async function blockFirstTask(dir) {
    const statePath = join(dir, '.gsd', 'state.json');
    const raw = JSON.parse(await readFile(statePath, 'utf8'));
    Object.assign(raw.phases[0].todo[0], { lifecycle: 'blocked', blocked_reason: 'needs a key' });
    await writeFile(statePath, JSON.stringify(raw));
    return raw.phases[0].todo[0].id;
  }

  // Each hold the server releases itself takes one level of resume's
  // recursion; a stack of them ran out of levels after the write had landed
  // (delta review of the pre-ship repairs).
  // A refresh stored while a pause sat over the refresh hold left the hold
  // with nothing to refresh, and releasing the pause sent the researcher
  // again (pre-ship review, left open then).
  it('research refreshed during a pause over a refresh is not refreshed again', async (t) => {
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    await initProject(dir);
    assert.equal((await handleResearcherResult({ ...research, basePath: dir })).action, 'research_stored', 'premise: research on record');
    const statePath = join(dir, '.gsd', 'state.json');
    const raw = JSON.parse(await readFile(statePath, 'utf8'));
    raw.research.expires_at = new Date(Date.now() - 86_400_000).toISOString();
    await writeFile(statePath, JSON.stringify(raw));
    assert.equal((await resumeWorkflow({ basePath: dir })).action, 'dispatch_researcher', 'premise: the research expired');
    await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: dir });
    assert.equal((await handleResearcherResult({ ...research, basePath: dir })).action, 'research_stored', 'premise: refreshed under the pause');
    const paused = await resumeWorkflow({ basePath: dir });
    assert.equal(paused.resume_to, 'research_refresh_needed', JSON.stringify(paused));
    await update({ updates: { workflow_mode: paused.resume_to }, basePath: dir });
    const res = await resumeWorkflow({ basePath: dir });
    assert.notEqual(res.action, 'dispatch_researcher', JSON.stringify(res));
    const after = await read({ basePath: dir });
    assert.equal(after.workflow_mode, 'executing_task');
    assert.deepEqual(after.suspended_modes, []);
  });

  // A refresh that sends tasks back drops the review it interrupted, since
  // what it reviewed may have to be redone. Stored while a pause sat over the
  // refresh hold, it kept the review: released, the phase review ran over a
  // task needing revalidation, passed, and the phase completed without a
  // review of the redone work (pre-tag review; 0.17.2 did the same).
  for (const [scope, review, mode] of [
    ['phase', { scope: 'phase', scope_id: 1 }, 'reviewing_phase'],
    ['task', { scope: 'task', scope_id: '1.1', stage: 'quality' }, 'reviewing_task'],
  ]) {
    it(`a refresh stored under a pause that sends tasks back drops the interrupted ${scope} review`, async (t) => {
      const dir = await createTempDir();
      t.after(() => removeTempDir(dir));
      await stateApi.init({ project: 'p', phases: [{ name: 'A', tasks: [
        { index: 1, name: 'cites a', research_basis: ['decision:a'] },
        { index: 2, name: 'b' },
      ] }], basePath: dir });
      assert.equal((await handleResearcherResult({ ...research, basePath: dir })).action, 'research_stored', 'premise: research on record');
      if (scope === 'phase') {
        await acceptTask(dir, 1, '1.1');
        await acceptTask(dir, 1, '1.2');
        await update({ updates: { phases: [{ id: 1, lifecycle: 'reviewing' }] }, basePath: dir });
      } else {
        await checkpointTask(dir, 1, '1.1');
      }
      assert.ok((await update({ updates: { workflow_mode: mode, current_review: review }, basePath: dir })).success, 'premise: reviewing');
      const statePath = join(dir, '.gsd', 'state.json');
      const raw = JSON.parse(await readFile(statePath, 'utf8'));
      raw.research.expires_at = new Date(Date.now() - 86_400_000).toISOString();
      await writeFile(statePath, JSON.stringify(raw));
      assert.equal((await resumeWorkflow({ basePath: dir })).action, 'dispatch_researcher', 'premise: the research expired during the review');
      await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: dir });
      const revised = { ...research, decision_index: { 'decision:a': { summary: 'A, revised', source: 'docs' } } };
      const stored = await handleResearcherResult({ ...revised, basePath: dir });
      assert.deepEqual(stored.invalidated_tasks, ['1.1'], JSON.stringify(stored));
      const paused = await resumeWorkflow({ basePath: dir });
      await update({ updates: { workflow_mode: paused.resume_to }, basePath: dir });
      const res = await resumeWorkflow({ basePath: dir });
      assert.notEqual(res.action, 'dispatch_reviewer', JSON.stringify(res));
      const after = await read({ basePath: dir });
      assert.equal(after.workflow_mode, 'executing_task');
      assert.equal(after.current_review, null);
      assert.deepEqual(after.suspended_modes, []);
    });
  }

  // A refresh hold with nothing recorded under it (a state from before 0.18,
  // or one an older version has written since, left in the refresh hold and
  // then paused): what it interrupted is read from current_review (delta
  // review of the repair: nothing pinned it).
  it('a refresh stored under a pause over a refresh hold that recorded nothing drops the review', async (t) => {
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    await stateApi.init({ project: 'p', phases: [{ name: 'A', tasks: [{ index: 1, name: 'cites a', research_basis: ['decision:a'] }] }], basePath: dir });
    assert.equal((await handleResearcherResult({ ...research, basePath: dir })).action, 'research_stored', 'premise: research on record');
    await checkpointTask(dir, 1, '1.1');
    const review = { scope: 'task', scope_id: '1.1', stage: 'quality' };
    const statePath = join(dir, '.gsd', 'state.json');
    const raw = JSON.parse(await readFile(statePath, 'utf8'));
    Object.assign(raw, { workflow_mode: 'research_refresh_needed', current_review: review, suspended_modes: [] });
    raw.research.expires_at = new Date(Date.now() - 86_400_000).toISOString();
    await writeFile(statePath, JSON.stringify(raw));
    await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: dir });
    assert.deepEqual((await read({ basePath: dir })).suspended_modes, ['research_refresh_needed'], 'premise');
    const revised = { ...research, decision_index: { 'decision:a': { summary: 'A, revised', source: 'docs' } } };
    assert.deepEqual((await handleResearcherResult({ ...revised, basePath: dir })).invalidated_tasks, ['1.1']);
    assert.equal((await read({ basePath: dir })).current_review, null);
    const paused = await resumeWorkflow({ basePath: dir });
    await update({ updates: { workflow_mode: paused.resume_to }, basePath: dir });
    const res = await resumeWorkflow({ basePath: dir });
    assert.notEqual(res.action, 'dispatch_reviewer', JSON.stringify(res));
    assert.equal((await read({ basePath: dir })).workflow_mode, 'executing_task');
  });

  it('a refresh stored under a decision held over the refresh leaves the decision alone', async (t) => {
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    await stateApi.init({ project: 'p', phases: [{ name: 'A', tasks: [{ index: 1, name: 'cites a', research_basis: ['decision:a'] }] }], basePath: dir });
    assert.equal((await handleResearcherResult({ ...research, basePath: dir })).action, 'research_stored', 'premise: research on record');
    await acceptTask(dir, 1, '1.1');
    await update({ updates: { phases: [{ id: 1, lifecycle: 'reviewing' }] }, basePath: dir });
    const decision = { scope: 'phase', scope_id: 1, stage: 'review_retry_exhausted', retry_count: 6 };
    for (const updates of [
      { workflow_mode: 'reviewing_phase', current_review: { scope: 'phase', scope_id: 1 } },
      { workflow_mode: 'research_refresh_needed' },
      { workflow_mode: 'awaiting_user', current_review: decision },
      { workflow_mode: 'paused_by_user' },
    ]) assert.ok((await update({ updates, basePath: dir })).success, JSON.stringify(updates));
    assert.deepEqual((await read({ basePath: dir })).suspended_modes, ['reviewing_phase', 'research_refresh_needed', 'awaiting_user'], 'premise');
    const revised = { ...research, decision_index: { 'decision:a': { summary: 'A, revised', source: 'docs' } } };
    const stored = await handleResearcherResult({ ...revised, basePath: dir });
    assert.deepEqual(stored.invalidated_tasks, ['1.1'], JSON.stringify(stored));
    assert.deepEqual((await read({ basePath: dir })).current_review, decision);
  });

  // Each level of resume's recursion went back out through resumeWorkflow,
  // which added the research-commit warning again: nine copies on the
  // deepest chain (delta review of the pre-ship repairs).
  it('a resume that recurses reports the research-commit warning once', async (t) => {
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    await initProject(dir);
    for (const m of ['awaiting_user', 'paused_by_user', 'awaiting_clear']) await update({ updates: { workflow_mode: m }, basePath: dir });
    await writeFile(join(dir, '.gsd', '.research-commit-pending'), '{}');
    const res = await resumeWorkflow({ basePath: dir });
    assert.ok(res.success, JSON.stringify(res));
    assert.equal((await read({ basePath: dir })).workflow_mode, 'paused_by_user', 'premise: the /clear released through a level of recursion');
    assert.deepEqual((res.warnings || []).map((w) => w.code), ['RESEARCH_COMMIT_PENDING']);
  });

  it('unblocking by hand under a /clear over a blocked-task hold finishes', async (t) => {
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    await initProject(dir);
    for (const m of ['awaiting_user', 'awaiting_clear']) await update({ updates: { workflow_mode: m }, basePath: dir });
    const id = await blockFirstTask(dir);
    const res = await resumeWorkflow({ basePath: dir, unblock_tasks: [id] });
    assert.ok(res.success, JSON.stringify(res));
    assert.deepEqual(res.unblocked, [id]);
    assert.equal((await read({ basePath: dir })).workflow_mode, 'executing_task');
  });

  it('unblocking by hand returns to the review the blocked-task hold interrupted, review and all', async (t) => {
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    await initProject(dir);
    // A phase review need carry no stage, so awaiting_user over one is the
    // blocked-task hold (a stage would make it a decision held at it).
    await checkpointTask(dir, 1, '1.1');
    const review = { scope: 'phase', scope_id: 1 };
    await update({ updates: { workflow_mode: 'reviewing_phase', current_review: review }, basePath: dir });
    await update({ updates: { workflow_mode: 'awaiting_user' }, basePath: dir });
    const statePath = join(dir, '.gsd', 'state.json');
    const raw = JSON.parse(await readFile(statePath, 'utf8'));
    Object.assign(raw.phases[0].todo[1], { lifecycle: 'blocked', blocked_reason: 'needs a key' });
    await writeFile(statePath, JSON.stringify(raw));
    const res = await resumeWorkflow({ basePath: dir, unblock_tasks: [raw.phases[0].todo[1].id] });
    assert.ok(res.success, JSON.stringify(res));
    const after = await read({ basePath: dir });
    assert.equal(after.workflow_mode, 'reviewing_phase');
    assert.deepEqual(after.current_review, review);
  });

  it('unblocking by hand leaves a decision held at a stage alone', async (t) => {
    // An L3 confirmation is not the blocked-task hold: unblocking an
    // unrelated task released it, and the confirmation was never asked.
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    await initProject(dir);
    const id = await blockFirstTask(dir);
    const review = { scope: 'task', scope_id: '1.2', stage: 'human_confirmation', pending_tasks: ['1.2'] };
    await update({ updates: { workflow_mode: 'awaiting_user', current_review: review }, basePath: dir });
    const res = await resumeWorkflow({ basePath: dir, unblock_tasks: [id] });
    assert.ok(res.success, JSON.stringify(res));
    const after = await read({ basePath: dir });
    assert.equal(after.workflow_mode, 'awaiting_user');
    assert.deepEqual(after.current_review, review);
    assert.equal(after.phases[0].todo[0].lifecycle, 'pending');
  });

  it('a refresh hold whose research was given up returns to a plan revision under it', async (t) => {
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    await initProject(dir);
    for (const m of ['planning', 'research_refresh_needed']) await update({ updates: { workflow_mode: m }, basePath: dir });
    assert.equal((await read({ basePath: dir })).research, null, 'premise: no research on record');
    await resumeWorkflow({ basePath: dir });
    assert.equal((await read({ basePath: dir })).workflow_mode, 'planning');
  });

  it('blocked tasks that unblock return to the review they interrupted, review and all', async (t) => {
    // A phase review need carry no stage, so awaiting_user over one is the
    // blocked-task hold, not a decision held at a stage.
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    await initProject(dir);
    await checkpointTask(dir, 1, '1.1');
    const review = { scope: 'phase', scope_id: 1 };
    await update({ updates: { workflow_mode: 'reviewing_phase', current_review: review }, basePath: dir });
    await update({ updates: { workflow_mode: 'awaiting_user' }, basePath: dir });
    await resumeWorkflow({ basePath: dir });
    const after = await read({ basePath: dir });
    assert.equal(after.workflow_mode, 'reviewing_phase', JSON.stringify(after.current_review));
    assert.deepEqual(after.current_review, review);
  });

  it('blocked tasks that unblock return to the plan revision they interrupted', async (t) => {
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    await initProject(dir);
    await update({ updates: { workflow_mode: 'planning' }, basePath: dir });
    await update({ updates: { workflow_mode: 'awaiting_user' }, basePath: dir });
    const res = await resumeWorkflow({ basePath: dir });
    assert.equal(res.workflow_mode, 'planning', JSON.stringify(res));
    assert.deepEqual((await read({ basePath: dir })).suspended_modes, []);
  });
});

describe('what resume says to write is a write that validates', () => {
  it('a review cleared during a pause is not the way back', async (t) => {
    // current_review cleared by hand while paused over a task review: the
    // stack still says reviewing_task, which needs that review.
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    await initProject(dir);
    await checkpointTask(dir, 1, '1.1');
    await update({ updates: { workflow_mode: 'reviewing_task', current_review: { scope: 'task', scope_id: '1.1', stage: 'quality' } }, basePath: dir });
    await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: dir });
    await update({ updates: { current_review: null }, basePath: dir });
    const res = await resumeWorkflow({ basePath: dir });
    assert.equal(res.resume_to, 'executing_task', JSON.stringify(res));
    const released = await update({ updates: { workflow_mode: res.resume_to }, basePath: dir });
    assert.ok(released.success, JSON.stringify(released));
  });
});

describe('the guidance names the mode to write', () => {
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

  it('reconcile and replan holds tell the orchestrator to write resume_to, not executing_task', async (t) => {
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'fixture@example.invalid');
    git(dir, 'config', 'user.name', 'fixture');
    await writeFile(join(dir, 'a.txt'), '1');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'one');
    await initProject(dir);
    await checkpointTask(dir, 1, '1.1');
    const head = git(dir, 'rev-parse', '--short', 'HEAD');
    await update({ updates: { git_head: head, workflow_mode: 'reviewing_task', current_review: { scope: 'task', scope_id: '1.1', stage: 'quality' } }, basePath: dir });
    for (const hold of ['reconcile_workspace', 'replan_required']) {
      await update({ updates: { workflow_mode: hold }, basePath: dir });
      const res = await resumeWorkflow({ basePath: dir });
      assert.equal(res.workflow_mode, hold, JSON.stringify(res));
      assert.equal(res.resume_to, 'reviewing_task');
      assert.doesNotMatch(res.guidance, /executing_task/, res.guidance);
      assert.match(res.guidance, /reviewing_task/, res.guidance);
      await update({ updates: { workflow_mode: res.resume_to }, basePath: dir });
    }
  });

  it('planning says how to finish the revision, not to start planning over', async (t) => {
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    await initProject(dir);
    await update({ updates: { workflow_mode: 'planning' }, basePath: dir });
    const res = await resumeWorkflow({ basePath: dir });
    assert.equal(res.workflow_mode, 'planning');
    for (const text of [res.guidance, res.message]) {
      assert.doesNotMatch(text, /gsd:start|gsd:prd|state-init/, text);
      assert.match(text, /state-patch/, text);
    }
  });
});

// 0.18 wrote the state, then an older version did (a downgrade and back).
// Versions before 0.18 know neither suspended_modes nor research.blocked:
// they carry both untouched while they change modes and research, bumping
// _version as every write does. Taken at their word, a pause 0.17.2 released
// left the project in the hold on top of the stack, so every release wrote
// that same mode and popped nothing (resume hit its depth limit every time,
// or sent the researcher round forever); a stack that survived sent a hold
// back to a mode 0.17.2 had moved on from; and real research 0.17.2 stored
// over a blocked placeholder kept the blocked flag, so a blocked refresh
// replaced it (delta review of the pre-ship repairs).
describe('a state an older version wrote since', () => {
  const statePath = (dir) => join(dir, '.gsd', 'state.json');
  // What 0.17.2 does to a state 0.18 wrote: change what it changes, bump
  // _version, and carry every field it does not know.
  async function olderVersionWrites(dir, changes) {
    const raw = JSON.parse(await readFile(statePath(dir), 'utf8'));
    Object.assign(raw, typeof changes === 'function' ? changes(raw) : changes);
    raw._version = (raw._version ?? 0) + 1;
    await writeFile(statePath(dir), JSON.stringify(raw));
  }
  async function project(t, ...modes) {
    const dir = await createTempDir();
    t.after(() => removeTempDir(dir));
    await initProject(dir);
    for (const mode of modes) {
      const res = await update({ updates: { workflow_mode: mode }, basePath: dir });
      assert.ok(res.success, `entering ${mode}: ${JSON.stringify(res)}`);
    }
    return dir;
  }
  const research = (blocked, summary) => ({
    result: { decision_ids: ['decision:a'], blocked, volatility: 'medium', expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), sources: [{ id: 's1', type: 'docs', ref: 'https://example.com/docs' }] },
    decision_index: { 'decision:a': { summary, source: 'docs' } },
    artifacts: { 'STACK.md': '# Stack\n', 'ARCHITECTURE.md': '# Architecture\n', 'PITFALLS.md': '# Pitfalls\n', 'SUMMARY.md': '# Summary\n' },
  });

  it('a /clear over a pause that 0.17.2 released to the /clear resumes', async (t) => {
    const dir = await project(t, 'awaiting_clear', 'paused_by_user');
    assert.deepEqual((await read({ basePath: dir })).suspended_modes, ['executing_task', 'awaiting_clear'], 'premise');
    await olderVersionWrites(dir, { workflow_mode: 'awaiting_clear' });
    const res = await resumeWorkflow({ basePath: dir });
    assert.ok(!res.error, JSON.stringify(res));
    const after = await read({ basePath: dir });
    assert.equal(after.workflow_mode, 'executing_task');
    assert.deepEqual(after.suspended_modes, []);
  });

  it('a blocked-task hold under a /clear that 0.17.2 released unblocks by hand', async (t) => {
    const dir = await project(t);
    const raw = JSON.parse(await readFile(statePath(dir), 'utf8'));
    Object.assign(raw.phases[0].todo[0], { lifecycle: 'blocked', blocked_reason: 'needs a key' });
    await writeFile(statePath(dir), JSON.stringify(raw));
    for (const mode of ['awaiting_user', 'awaiting_clear']) await update({ updates: { workflow_mode: mode }, basePath: dir });
    assert.deepEqual((await read({ basePath: dir })).suspended_modes, ['executing_task', 'awaiting_user'], 'premise');
    await olderVersionWrites(dir, { workflow_mode: 'awaiting_user' });
    const res = await resumeWorkflow({ basePath: dir, unblock_tasks: ['1.1'] });
    assert.ok(!res.error, JSON.stringify(res));
    assert.deepEqual(res.unblocked, ['1.1']);
    const after = await read({ basePath: dir });
    assert.equal(after.workflow_mode, 'executing_task');
    assert.deepEqual(after.suspended_modes, []);
  });

  it('a pause over a refresh that 0.17.2 sent back into the refresh sends the researcher once', async (t) => {
    const dir = await project(t);
    assert.equal((await handleResearcherResult({ ...research(false, 'Use A'), basePath: dir })).action, 'research_stored', 'premise');
    const raw = JSON.parse(await readFile(statePath(dir), 'utf8'));
    raw.research.expires_at = new Date(Date.now() - 86_400_000).toISOString();
    await writeFile(statePath(dir), JSON.stringify(raw));
    for (const mode of ['research_refresh_needed', 'paused_by_user']) await update({ updates: { workflow_mode: mode }, basePath: dir });
    await olderVersionWrites(dir, { workflow_mode: 'executing_task' });
    await olderVersionWrites(dir, { workflow_mode: 'research_refresh_needed' });
    assert.equal((await resumeWorkflow({ basePath: dir })).action, 'dispatch_researcher', 'premise');
    assert.equal((await handleResearcherResult({ ...research(false, 'Use A'), basePath: dir })).action, 'research_stored');
    assert.equal((await read({ basePath: dir })).workflow_mode, 'executing_task');
    const next = await resumeWorkflow({ basePath: dir });
    assert.notEqual(next.action, 'dispatch_researcher', JSON.stringify(next));
  });

  it('and with no research on record it resumes', async (t) => {
    const dir = await project(t, 'research_refresh_needed', 'paused_by_user');
    await olderVersionWrites(dir, { workflow_mode: 'research_refresh_needed' });
    const res = await resumeWorkflow({ basePath: dir });
    assert.ok(!res.error, JSON.stringify(res));
    assert.equal((await read({ basePath: dir })).workflow_mode, 'executing_task');
  });

  it('a hold 0.17.2 entered after moving on is not sent back to what 0.18 recorded', async (t) => {
    const dir = await project(t, 'planning', 'paused_by_user');
    await olderVersionWrites(dir, { workflow_mode: 'executing_task' });
    await olderVersionWrites(dir, { workflow_mode: 'awaiting_clear' });
    await resumeWorkflow({ basePath: dir });
    const after = await read({ basePath: dir });
    assert.equal(after.workflow_mode, 'executing_task');
    assert.deepEqual(after.suspended_modes, []);
  });

  it('research 0.17.2 stored over a blocked placeholder is research, and a blocked refresh does not replace it', async (t) => {
    const dir = await project(t);
    const placeholder = research(true, '[BLOCKED] no sources');
    assert.equal((await handleResearcherResult({ ...placeholder, basePath: dir })).action, 'research_stored', 'premise');
    assert.equal((await read({ basePath: dir })).research.blocked, true, 'premise');
    // 0.17.2 stores a refresh by spreading the record it replaces.
    await olderVersionWrites(dir, (raw) => ({ research: { ...raw.research, decision_index: { 'decision:a': { summary: 'Use A', source: 'docs' } } } }));
    assert.equal((await read({ basePath: dir })).research.blocked, false);
    const refused = await handleResearcherResult({ ...placeholder, basePath: dir });
    assert.equal(refused.code, 'VALIDATION_FAILED', JSON.stringify(refused));
    assert.equal((await read({ basePath: dir })).research.decision_index['decision:a'].summary, 'Use A');
  });

  // Not an older version: a hand edit leaves _version alone, so nothing
  // tells it apart from this version's own write. A project left in the hold
  // on top of its stack still resumes.
  it('a hand edit that leaves the project in the hold on top of its stack resumes', async (t) => {
    const dir = await project(t, 'awaiting_clear', 'paused_by_user');
    const raw = JSON.parse(await readFile(statePath(dir), 'utf8'));
    raw.workflow_mode = 'awaiting_clear';
    await writeFile(statePath(dir), JSON.stringify(raw));
    const res = await resumeWorkflow({ basePath: dir });
    assert.ok(!res.error, JSON.stringify(res));
    const after = await read({ basePath: dir });
    assert.equal(after.workflow_mode, 'executing_task');
    assert.deepEqual(after.suspended_modes, []);
  });

  // The other side: what this version writes, it keeps. A blocked record
  // whose summary is not the placeholder is what reading the flag again from
  // the decisions would change, so the flag shows a write that was taken for
  // an older version's as surely as the stack does.
  for (const [writer, write] of [
    ['state-update', (dir) => update({ updates: { git_head: 'abc1234' }, basePath: dir })],
    ['state-update of phases', (dir) => update({ updates: { phases: [{ id: 2, name: 'Phase 2, renamed' }] }, basePath: dir })],
    ['evidence', (dir) => stateApi.addEvidence({ id: 'ev:1', data: { scope: 'task:1.1', type: 'test', data: { passed: true } }, basePath: dir })],
    ['evidence pruning', async (dir) => {
      await stateApi.addEvidence({ id: 'ev:1', data: { scope: 'task:1.1', type: 'test', data: { passed: true } }, basePath: dir });
      return stateApi.pruneEvidence({ currentPhase: 2, basePath: dir });
    }],
    ['state-patch', (dir) => stateApi.patchPlan({ operations: [{ op: 'update_task', task_id: '1.2', name: 'Task B, renamed' }], basePath: dir })],
    ['a stored research result', (dir) => handleResearcherResult({ ...research(true, 'Sources were unreachable'), basePath: dir })],
  ]) {
    it(`${writer} keeps the stack and the research flag it wrote`, async (t) => {
      const dir = await project(t);
      assert.equal((await handleResearcherResult({ ...research(true, 'Sources were unreachable'), basePath: dir })).action, 'research_stored', 'premise');
      await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: dir });
      const res = await write(dir);
      assert.ok(res && !res.error, JSON.stringify(res));
      const after = await read({ basePath: dir });
      assert.equal(after._version, JSON.parse(await readFile(statePath(dir), 'utf8'))._version, 'premise: the write landed');
      assert.deepEqual(after.suspended_modes, ['executing_task']);
      assert.equal(after.research.blocked, true);
    });
  }

  // Each 0.18+ write of state.json records the version that made it, which
  // is how a state an older version wrote since is told apart (migrateState),
  // so every write goes through writeState. Three gates that read the source
  // for writers going around it each missed the next shape: writeJson only,
  // then statePath as a first argument only, then statePath in listed forms
  // only (a path from getStatePath under another name, 'state' + '.json', a
  // shadowed reader name, a comment opened inside a string; pre-tag reviews).
  // So the writers refuse it at run time instead (src/utils.js), whatever the
  // path is called, and the gate is about who can write at all.
  it('the general writers refuse state.json, and writeState writes it', async (t) => {
    const utils = await import('../src/utils.js');
    const dir = await project(t);
    const path = statePath(dir);
    for (const spelled of [path, join(dir, '.gsd', 'State.json'), `${join(dir, '.gsd')}/${'state'}${'.json'}`]) {
      await assert.rejects(utils.writeJson(spelled, {}), /state\.json is written through writeState only/);
      await assert.rejects(utils.writeAtomic(spelled, '{}'), /state\.json is written through writeState only/);
      // The lock writes its token into the path it is given, and removes it.
      await assert.rejects(utils.withFileLock(spelled, async () => {}), /state\.json is written through writeState only/);
    }
    assert.ok((await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: dir })).success, 'writeState still writes it');
  });

  // Who can write at all, read deny-by-default: utils.js holds the writers,
  // and any other module may name a fs module only in a static import of
  // functions that cannot write a file's content, and may load no module at
  // run time. The gate this replaces listed the import shapes that write and
  // missed one after another (`{ promises as fsp }`, a default import beside
  // named ones, a template literal), and let two modules write unchecked; a
  // rename into state.json there passed every test (delta review). It is a
  // check against writing around writeState by accident, not a sandbox: a
  // specifier built at run time and loaded through server.js's createRequire
  // gets past it.
  const NO_WRITE = new Set(['access', 'accessSync', 'existsSync', 'lstat', 'lstatSync', 'readFile', 'readFileSync', 'readdir', 'readdirSync', 'realpathSync', 'stat', 'statSync', 'unlink', 'unlinkSync']);
  // What a module may import, past the fs modules: these builtins, the MCP
  // SDK, and modules inside src/. An import from outside src/ reached a
  // writer that does not refuse state.json (hooks/lib/atomic-write.cjs, one
  // directory over; final review). The two modules that run commands (git,
  // the project's own checks) import child_process: what a command writes no
  // gate here can see.
  const SRC = fileURLToPath(new URL('../src/', import.meta.url)).replace(/[\\/]$/, '');
  const BUILTINS = new Set(['node:crypto', 'node:fs', 'node:fs/promises', 'node:os', 'node:path', 'node:url', 'node:util']);
  const RUNS_COMMANDS = ['utils.js', 'tools/verify.js'];
  function writeReach(source, { file = 'tools/state/crud.js', mayLoad = false } = {}) {
    const why = [];
    for (const [, , spec] of source.matchAll(/^\s*(?:import|export)\s+[\w$*\s{},]*?\bfrom\s*(['"])([^'"]+)\1/gm)) {
      if (spec.startsWith('.')) {
        if (!resolve(dirname(join(SRC, file)), spec).startsWith(SRC + sep)) why.push(`imports ${spec}, outside src/`);
      } else if (spec === 'node:child_process' ? !RUNS_COMMANDS.includes(file) : spec === 'node:module' ? !mayLoad : !BUILTINS.has(spec) && !spec.startsWith('@modelcontextprotocol/sdk/')) {
        why.push(`imports ${spec}`);
      }
    }
    // An open flag makes a read a write (readFile with flag 'w' truncates);
    // process.report writes a file of its own.
    if (/\bflag\s*:\s*['"`]|\bprocess\.report\b/.test(source)) why.push('writes through an open flag or process.report');
    const specifiers = source.match(/(['"`])(?:node:)?fs(?:\/promises)?\1/g)?.length ?? 0;
    const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*(['"])(?:node:)?fs(?:\/promises)?\2/g)];
    if (specifiers !== imports.length) why.push('names a fs module outside a static named import');
    for (const [, names] of imports) {
      for (const name of names.split(',').map((entry) => entry.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
        if (!NO_WRITE.has(name)) why.push(`imports ${name}`);
      }
    }
    if (!mayLoad && /\bgetBuiltinModule\b|\bprocess\.binding\b|\bimport\s*\(|\bcreateRequire\b|\brequire\s*\(/.test(source)) why.push('loads a module at run time');
    return why;
  }

  it('the write gate sees every way a module can get a write, and passes reads', () => {
    for (const shape of [
      "import { writeFile } from 'node:fs/promises';",
      "import { rename as mv } from 'fs/promises';",
      "import {\n  readFile,\n  writeFileSync,\n} from 'node:fs';",
      "import { promises as fsp } from 'node:fs';",
      "import fsp, { stat } from 'node:fs/promises';",
      "import * as fs from 'node:fs';",
      'import fs from "fs";',
      "const fs = require('fs');",
      "const { writeFile } = await import('node:fs/promises');",
      'const fs = await import(`node:fs/promises`);',
      "const fs = process.getBuiltinModule('node:fs');",
      "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);",
      "import atomicWrite from '../../../hooks/lib/atomic-write.cjs';",
      "import { execFileSync } from 'node:child_process';",
      "import { Worker } from 'node:worker_threads';",
      "import { readFile } from 'node:fs/promises';\nawait readFile(path, { flag: 'w' });",
      'process.report.writeReport(path);',
    ]) {
      assert.notDeepEqual(writeReach(shape), [], `the gate passes: ${shape}`);
    }
    for (const shape of [
      "import { readFile, stat } from 'node:fs/promises';",
      'import { realpathSync as real, existsSync } from "node:fs";',
      "import { stat, unlink } from 'node:fs/promises';\nimport { join } from 'node:path';",
      "import { readJson } from '../../utils.js';\nexport { resumeTarget } from '../../schema.js';",
      "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
    ]) {
      assert.deepEqual(writeReach(shape), [], shape);
    }
  });

  it('only utils.js can write a file, and its writers refuse state.json', async (t) => {
    const root = new URL('../src/', import.meta.url);
    const files = (await readdir(root, { recursive: true })).filter((f) => /\.[cm]?js$/.test(f));
    assert.ok(files.length > 10, 'premise: the source tree was read');
    const reach = [];
    for (const file of files) {
      const why = writeReach(await readFile(new URL(file, root), 'utf8'), { file, mayLoad: file === 'server.js' });
      if (file === 'utils.js') assert.notDeepEqual(why, [], 'premise: the gate sees the writers');
      else if (why.length > 0) reach.push(`${file}: ${why.join(', ')}`);
    }
    assert.deepEqual(reach, []);
    const utils = await import('../src/utils.js');
    const dir = await project(t);
    await assert.rejects(utils.writeFilesTogether([{ path: join(dir, 'a.md'), content: 'a' }, { path: statePath(dir), content: '{}' }]), /state\.json is written through writeState only/);
    await assert.rejects(readFile(join(dir, 'a.md')), { code: 'ENOENT' }, 'a refused batch wrote part of itself');
    // All or none when a document fails to write, before any rename, and no
    // temp file left (final review: only a failing rename was tried).
    const docs = ['a.md', 'b.md', 'c.md'].map((name) => join(dir, name));
    for (const doc of docs) await writeFile(doc, 'old');
    const failed = await utils.writeFilesTogether([{ path: docs[0], content: 'new' }, { path: docs[1], content: 'new' }, { path: docs[2], content: 42 }]).then(() => null, (err) => err);
    assert.ok(failed, 'premise: the third document could not be written');
    assert.equal(failed.renamed, 0);
    for (const doc of docs) assert.equal(await readFile(doc, 'utf8'), 'old', `${doc} was replaced`);
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), [], 'a temp file was left');
    // writeStateFile, the guard's one way past, is writeState's alone.
    const callers = [];
    for (const file of files) {
      if ((await readFile(new URL(file, root), 'utf8')).includes('writeStateFile')) callers.push(file);
    }
    assert.deepEqual(callers.sort(), ['tools/state/constants.js', 'utils.js']);
  });
});
