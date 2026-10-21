// tests/incremental-validation.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateStateUpdate,
  validateState,
  createInitialState,
  CANONICAL_FIELDS,
  WORKFLOW_MODES,
} from '../src/schema.js';
import { init, patchPlan, phaseComplete, read, storeResearch, update } from '../src/tools/state/index.js';
import { resumeWorkflow } from '../src/tools/orchestrator/index.js';
import { acceptTask, createTempDir, initProject, removeTempDir } from './e2e-helpers.js';

const PASSED = { lint: { exit_code: 0 }, typecheck: { exit_code: 0 }, test: { exit_code: 0 } };

describe('validateStateUpdate', () => {
  const baseState = () => createInitialState({ project: 'test', phases: [{ name: 'P1', tasks: [{ index: 1, name: 'T1' }] }] });

  describe('fallback to full validation for phases updates', () => {
    it('falls back to validateState when updates contain phases', () => {
      const state = baseState();
      const updates = { phases: state.phases };
      const result = validateStateUpdate(state, updates);
      assert.equal(result.valid, true);
    });

    it('catches errors via full validation when phases update is invalid', () => {
      const state = baseState();
      const updates = { phases: 'not-an-array' };
      const merged = { ...state, ...updates };
      const fullResult = validateState(merged);
      const incrResult = validateStateUpdate(state, updates);
      assert.equal(incrResult.valid, false);
      assert.equal(fullResult.valid, false);
    });
  });

  describe('workflow_mode validation', () => {
    it('accepts valid workflow_mode', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { workflow_mode: 'paused_by_user' });
      assert.equal(result.valid, true);
    });

    it('accepts completed from reviewing_phase when all phases accepted', () => {
      const state = baseState();
      state.workflow_mode = 'reviewing_phase';
      state.phases[0].lifecycle = 'accepted';
      const result = validateStateUpdate(state, { workflow_mode: 'completed' });
      assert.equal(result.valid, true);
    });

    it('rejects completed when phases not accepted', () => {
      const state = baseState();
      state.workflow_mode = 'reviewing_phase';
      const result = validateStateUpdate(state, { workflow_mode: 'completed' });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('not accepted')));
    });

    it('rejects completed with a running task, matching full validation (R-02 parity)', () => {
      const state = baseState();
      state.workflow_mode = 'reviewing_phase';
      state.phases[0].lifecycle = 'accepted';
      state.phases[0].todo[0].lifecycle = 'running'; // contradictory shape the full validator also rejects
      const incr = validateStateUpdate(state, { workflow_mode: 'completed' });
      const full = validateState({ ...state, workflow_mode: 'completed' });
      assert.equal(incr.valid, false);
      assert.equal(full.valid, false, 'full validator must also reject');
      assert.ok(incr.errors.some(e => /running task/.test(e)), 'fast path must catch the running-task invariant');
    });

    it('rejects completed from executing_task (invalid transition)', () => {
      const state = baseState();
      state.phases[0].lifecycle = 'accepted';
      const result = validateStateUpdate(state, { workflow_mode: 'completed' });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('Invalid workflow_mode transition')));
    });

    it('rejects invalid workflow_mode', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { workflow_mode: 'invalid_mode' });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('Invalid workflow_mode')));
    });
  });

  describe('current_phase validation', () => {
    it('accepts valid current_phase', () => {
      const state = baseState();
      // current_phase must not exceed total_phases (which is 1 for baseState)
      const result = validateStateUpdate(state, { current_phase: 1 });
      assert.equal(result.valid, true);
    });

    it('rejects non-finite current_phase', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { current_phase: 'phase1' });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('current_phase must be a finite number')));
    });

    it('rejects current_phase below 1 (R-19)', () => {
      const state = baseState();
      for (const bad of [0, -1]) {
        const result = validateStateUpdate(state, { current_phase: bad });
        assert.equal(result.valid, false, `current_phase ${bad} should be rejected`);
        assert.ok(result.errors.some(e => e.includes('current_phase must be >= 1')));
      }
    });
  });

  describe('current_task validation', () => {
    it('accepts string current_task', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { current_task: '1.1' });
      assert.equal(result.valid, true);
    });

    it('accepts null current_task', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { current_task: null });
      assert.equal(result.valid, true);
    });

    it('rejects non-string non-null current_task', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { current_task: 42 });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('current_task must be a string or null')));
    });
  });

  describe('current_review validation', () => {
    it('accepts object current_review', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { current_review: { scope: 'task', scope_id: '1.1' } });
      assert.equal(result.valid, true);
    });

    it('accepts null current_review', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { current_review: null });
      assert.equal(result.valid, true);
    });

    it('rejects non-object non-null current_review', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { current_review: 'bad' });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('current_review must be an object or null')));
    });

    it('rejects current_review with invalid scope via incremental path', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { current_review: { scope: 'tsk', scope_id: '1.1' } });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('current_review.scope must be one of: task, phase')));
    });

    it('accepts current_review with valid scope "phase" via incremental path', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { current_review: { scope: 'phase', scope_id: 1 } });
      assert.equal(result.valid, true);
    });
  });

  describe('git_head validation', () => {
    it('accepts string git_head', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { git_head: 'abc123' });
      assert.equal(result.valid, true);
    });

    it('accepts null git_head', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { git_head: null });
      assert.equal(result.valid, true);
    });

    it('rejects non-string non-null git_head', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { git_head: 123 });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('git_head must be a string or null')));
    });
  });

  describe('plan_version validation', () => {
    it('accepts valid plan_version', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { plan_version: 2 });
      assert.equal(result.valid, true);
    });

    it('rejects non-finite plan_version', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { plan_version: 'v2' });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('plan_version must be a finite number')));
    });
  });

  describe('schema_version validation', () => {
    it('accepts valid schema_version', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { schema_version: 2 });
      assert.equal(result.valid, true);
    });

    it('rejects non-finite schema_version', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { schema_version: 'v1' });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('schema_version must be a finite number')));
    });
  });

  describe('total_phases validation', () => {
    it('accepts valid total_phases', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { total_phases: state.phases.length });
      assert.equal(result.valid, true);
    });

    it('rejects a total_phases that does not match the phases, as full validation does', () => {
      // This case used to assert that 3 was accepted for a one-phase plan.
      // validateState refuses that state, so every later full validation of
      // it (a research store, a phase completion) failed.
      const state = baseState();
      const result = validateStateUpdate(state, { total_phases: 3 });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('does not match phases.length')), result.errors.join('; '));
      assert.equal(validateState({ ...state, total_phases: 3 }).valid, false, 'premise: the full validator refuses it');
    });

    it('rejects non-finite total_phases', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { total_phases: 'many' });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('total_phases must be a finite number')));
    });
  });

  describe('project validation', () => {
    it('accepts valid project', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { project: 'new-name' });
      assert.equal(result.valid, true);
    });

    it('rejects empty project', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { project: '' });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('project must be a non-empty string')));
    });

    it('rejects non-string project', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { project: 42 });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('project must be a non-empty string')));
    });
  });

  describe('decisions validation', () => {
    it('accepts valid decisions array', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { decisions: ['d1'] });
      assert.equal(result.valid, true);
    });

    it('rejects non-array decisions', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { decisions: 'bad' });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('decisions must be an array')));
    });
  });

  describe('context validation', () => {
    it('accepts valid context', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { context: { last_session: '2026-01-01', remaining_percentage: 50 } });
      assert.equal(result.valid, true);
    });

    it('rejects non-object context', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { context: 'bad' });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('context must be an object')));
    });

    it('validates merged context fields', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { context: { last_session: 42 } });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('context.last_session must be a string')));
    });

    it('validates remaining_percentage from merged context', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { context: { remaining_percentage: 'high' } });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('context.remaining_percentage must be a finite number')));
    });
  });

  describe('evidence validation', () => {
    it('accepts valid evidence object', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { evidence: { 'ev:1': { scope: 'task:1.1' } } });
      assert.equal(result.valid, true);
    });

    it('rejects non-object evidence', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { evidence: 'bad' });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('evidence must be an object')));
    });
  });

  describe('research validation', () => {
    it('accepts null research', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { research: null });
      assert.equal(result.valid, true);
    });

    it('accepts valid object research', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { research: { decision_index: {} } });
      assert.equal(result.valid, true);
    });

    it('rejects non-null non-object research', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { research: 'bad' });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('research must be null or an object')));
    });
  });

  describe('unknown field rejection', () => {
    it('rejects unknown canonical field', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { unknown_field: 'value' });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('Unknown canonical field: unknown_field')));
    });

    it('rejects another unknown field key with descriptive error', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { foo_bar_baz: 123 });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('Unknown canonical field')));
      assert.ok(result.errors.some(e => e.includes('foo_bar_baz')));
    });
  });

  describe('multiple updates at once', () => {
    it('validates multiple valid updates', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { workflow_mode: 'paused_by_user', current_task: null });
      assert.equal(result.valid, true);
    });

    it('collects errors from multiple invalid updates', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { workflow_mode: 'bad', current_phase: 'x' });
      assert.equal(result.valid, false);
      assert.ok(result.errors.length >= 2);
    });
  });

  describe('M-4: cross-field current_phase ≤ total_phases', () => {
    it('rejects current_phase exceeding total_phases', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { current_phase: 5 });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('must not exceed total_phases')));
    });

    it('rejects when updating total_phases below current_phase', () => {
      const state = baseState();
      state.current_phase = 3;
      state.total_phases = 5;
      const result = validateStateUpdate(state, { total_phases: 2 });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('must not exceed total_phases')));
    });

    it('accepts current_phase equal to total_phases', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { current_phase: 1, total_phases: 1 });
      assert.equal(result.valid, true);
    });

    it('skips check when total_phases is 0 (degenerate case)', () => {
      const state = baseState();
      state.total_phases = 0;
      const result = validateStateUpdate(state, { current_phase: 1 });
      assert.equal(result.valid, true);
    });
  });

  describe('R-02: reviewing-mode / scope_id cross-invariants (fast path parity)', () => {
    it('rejects workflow_mode reviewing_task when current_review is null', () => {
      const state = baseState();
      state.workflow_mode = 'executing_task';
      const result = validateStateUpdate(state, { workflow_mode: 'reviewing_task' });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('requires current_review with scope="task"')));
    });

    it('rejects clearing current_review to null while in reviewing mode', () => {
      const state = baseState();
      state.workflow_mode = 'reviewing_task';
      state.current_review = { scope: 'task', scope_id: '1.1' };
      const result = validateStateUpdate(state, { current_review: null });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('requires current_review with scope="task"')));
    });

    it('rejects current_review.scope_id referencing a non-existent phase', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { current_review: { scope: 'phase', scope_id: 99 } });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('references non-existent phase')));
    });

    it('rejects current_review.scope_id referencing a non-existent task', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { current_review: { scope: 'task', scope_id: '1.9' } });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('references non-existent task')));
    });

    it('accepts a consistent reviewing_task + current_review update together', () => {
      const state = baseState();
      state.workflow_mode = 'executing_task';
      const result = validateStateUpdate(state, {
        workflow_mode: 'reviewing_task',
        current_review: { scope: 'task', scope_id: '1.1' },
      });
      assert.equal(result.valid, true);
    });

    it('fast path and full path agree on the reviewing_task/null-review case', () => {
      const state = baseState();
      state.workflow_mode = 'executing_task';
      const updates = { workflow_mode: 'reviewing_task' };
      const fast = validateStateUpdate(state, updates);
      const full = validateState({ ...state, ...updates });
      assert.equal(fast.valid, false);
      assert.equal(full.valid, false);
    });

    it('fast path and full path agree on the bad scope_id case', () => {
      const state = baseState();
      const updates = { current_review: { scope: 'phase', scope_id: 99 } };
      const fast = validateStateUpdate(state, updates);
      const full = validateState({ ...state, ...updates });
      assert.equal(fast.valid, false);
      assert.equal(full.valid, false);
    });
  });

  describe('M-5: evidence entry structure validation', () => {
    it('rejects evidence entry without scope', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { evidence: { 'ev:1': { command: 'test' } } });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('evidence["ev:1"].scope must be a non-empty string')));
    });

    it('rejects evidence entry with empty scope', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { evidence: { 'ev:1': { scope: '' } } });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('scope must be a non-empty string')));
    });

    it('rejects non-object evidence entry', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { evidence: { 'ev:1': 'bad' } });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('evidence["ev:1"] must be an object')));
    });

    it('rejects what validateState rejects in research and in evidence fields', () => {
      // update() also checks the result against validateState; this is the
      // fast path's own answer, which used to accept both.
      const state = baseState();
      const research = validateStateUpdate(state, { research: { decision_index: { 'decision:a': null } } });
      assert.equal(research.valid, false);
      assert.ok(research.errors.some(e => e.includes('decision_index.decision:a must be an object')), research.errors.join('; '));
      const evidence = validateStateUpdate(state, { evidence: { 'ev:1': { scope: 'task:1.1', passed: 'false' } } });
      assert.equal(evidence.valid, false);
      assert.ok(evidence.errors.some(e => e.includes('passed must be a boolean')), evidence.errors.join('; '));
    });

    it('accepts valid evidence entries with scope', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { evidence: { 'ev:1': { scope: 'task:1.1' }, 'ev:2': { scope: 'global' } } });
      assert.equal(result.valid, true);
    });
  });
});

// The fast path checked research as "null or an object" and evidence entries
// for a scope only, so state-update wrote a decision_index entry of null and
// an evidence `passed: "false"` that the full validator refuses. The next
// research refresh read `.summary` of that null and threw a TypeError. Asked
// of every canonical field rather than of the two that were reported.
describe('update() never writes a state that validateState refuses', () => {
  const GENERIC = [null, 0, -1, 1.5, '', 'x', true, [], {}, [null], { a: null }, { a: {} }, { a: 'x' }];
  const NESTED = {
    research: [
      { decision_index: [] },
      { decision_index: { 'decision:a': null } },
      { decision_index: { 'decision:a': {} } },
      { decision_index: { 'decision:a': { summary: '' } } },
      { decision_index: { 'decision:a': { source: 'docs' } } },
      { decision_index: { 'decision:a': { summary: 'A', source: '' } } },
      { decision_index: { 'decision:a': { summary: 'A', expires_at: 'soon' } } },
      { volatility: 'extreme' },
      { expires_at: '' },
      { expires_at: 'never' },
      { files: 'STACK.md' },
      { files: [''] },
      { sources: 'docs' },
      { sources: [{}] },
    ],
    evidence: [
      { 'ev:1': null },
      { 'ev:1': {} },
      { 'ev:1': { scope: 'task:1.1', passed: 'false' } },
      { 'ev:1': { scope: 'task:1.1', type: '' } },
    ],
    context: [{ remaining_percentage: 'x' }, { last_session: 1 }],
    current_review: [{ scope: 'x' }, { scope: 'task', scope_id: '9.9' }, { scope: 'phase', scope_id: 9 }],
    // With a review of task 1.1 in progress, moving current_phase to 2 left a
    // scope_id the full validator refuses (pre-tag review).
    current_phase: [1, 2, 3],
    current_task: ['1.1', '2.1', '9.9'],
    workflow_mode: WORKFLOW_MODES,
  };

  // Two states to write into: a fresh plan, and a task review in progress in
  // a two-phase plan. Fields checked against each other only fail where the
  // other one is set.
  const BASES = {
    'a fresh one-phase plan': async (dir) => {
      await init({ project: 'test', phases: [{ name: 'P1', tasks: [{ index: 1, name: 'T1' }] }], basePath: dir });
    },
    'a task review in progress in a two-phase plan': async (dir) => {
      await init({ project: 'test', phases: [{ name: 'P1', tasks: [{ index: 1, name: 'T1' }] }, { name: 'P2', tasks: [{ index: 1, name: 'T2' }] }], basePath: dir });
      for (const lifecycle of ['running', 'checkpointed']) {
        await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle, ...(lifecycle === 'checkpointed' ? { checkpoint_commit: 'c1' } : {}) }] }] }, basePath: dir });
      }
      await update({ updates: { workflow_mode: 'reviewing_task', current_review: { scope: 'task', scope_id: '1.1', stage: 'spec' } }, basePath: dir });
    },
  };

  let dir;
  let original;
  const originals = {};
  before(async () => {
    for (const [label, build] of Object.entries(BASES)) {
      const d = await mkdtemp(join(tmpdir(), 'gsd-incremental-'));
      await build(d);
      originals[label] = { dir: d, json: await readFile(join(d, '.gsd', 'state.json'), 'utf8') };
    }
    ({ dir, json: original } = originals['a fresh one-phase plan']);
  });
  after(async () => {
    for (const { dir: d } of Object.values(originals)) await rm(d, { recursive: true, force: true });
  });

  for (const label of Object.keys(BASES)) {
    it(`holds for every canonical field, writing into ${label}`, async () => {
      const { dir: base, json } = originals[label];
      assert.ok(validateState(JSON.parse(json)).valid, 'premise: the base state is valid');
      const statePath = join(base, '.gsd', 'state.json');
      const written = [];
      let tried = 0;
      for (const field of CANONICAL_FIELDS) {
        for (const value of [...GENERIC, ...(NESTED[field] ?? [])]) {
          await writeFile(statePath, json);
          tried += 1;
          // A throw writes nothing either; this asks only about what is written.
          const res = await update({ updates: { [field]: value }, basePath: base }).catch((err) => ({ thrown: err }));
          if (!res.success) continue;
          const check = validateState(JSON.parse(await readFile(statePath, 'utf8')));
          if (!check.valid) written.push(`${field} = ${JSON.stringify(value)}: ${check.errors.join('; ')}`);
        }
      }
      assert.ok(tried > CANONICAL_FIELDS.length * GENERIC.length, 'premise: the values were tried');
      assert.deepEqual(written, []);
    });
  }

  // The property above holds as well when both validators are equally lax, so
  // the two reported writes are asserted on their own.
  it('refuses a decision_index entry of null, and the next refresh stores normally', async () => {
    const statePath = join(dir, '.gsd', 'state.json');
    await writeFile(statePath, original);
    const index = { 'decision:a': { summary: 'A', source: 'docs' } };
    const result = { decision_ids: ['decision:a'], volatility: 'medium', expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), sources: [] };
    const artifacts = { 'STACK.md': 's', 'ARCHITECTURE.md': 'a', 'PITFALLS.md': 'p', 'SUMMARY.md': 'm' };
    assert.ok((await storeResearch({ result, decision_index: index, artifacts, basePath: dir })).success, 'premise: research is on record');
    const { research } = JSON.parse(await readFile(statePath, 'utf8'));
    const res = await update({ updates: { research: { ...research, decision_index: { 'decision:a': null } } }, basePath: dir });
    assert.equal(res.error, true, JSON.stringify(res));
    assert.match(res.message, /decision_index\.decision:a must be an object/);
    const refresh = await storeResearch({ result, decision_index: { 'decision:a': { summary: 'A2', source: 'docs' } }, artifacts, basePath: dir });
    assert.ok(refresh.success, JSON.stringify(refresh));
  });

  it('still writes to a state that was already invalid, when the update adds nothing invalid', async () => {
    // update() checks the fast path's answer against validateState, counting
    // only errors the update introduces. A state 0.17.0 left with a null
    // decision must still be pausable, and recoverable with research: null.
    const statePath = join(dir, '.gsd', 'state.json');
    const raw = JSON.parse(original);
    raw.research = { decision_index: { 'decision:a': null } };
    await writeFile(statePath, JSON.stringify(raw));
    assert.equal(validateState(raw).valid, false, 'premise: the planted state is invalid');
    const paused = await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: dir });
    assert.ok(paused.success, JSON.stringify(paused));
    const recovered = await update({ updates: { research: null }, basePath: dir });
    assert.ok(recovered.success, JSON.stringify(recovered));
    assert.ok(validateState(JSON.parse(await readFile(statePath, 'utf8'))).valid);
  });

  it('refuses an evidence entry whose passed is not a boolean', async () => {
    await writeFile(join(dir, '.gsd', 'state.json'), original);
    const res = await update({ updates: { evidence: { 'ev:1': { scope: 'task:1.1', passed: 'false' } } }, basePath: dir });
    assert.equal(res.error, true, JSON.stringify(res));
    assert.match(res.message, /passed must be a boolean/);
  });

  // The property above skips a throw, since a throw writes nothing. Over MCP
  // a throw still reaches the caller, as "Tool execution failed: Cannot read
  // properties of null (reading 'id')", which names neither the field nor
  // the entry. Asked of every canonical field.
  it('answers every malformed update with an error instead of throwing', async () => {
    const statePath = join(dir, '.gsd', 'state.json');
    const entries = [null, 0, 'x', [], true];
    const PATCHES = {
      phases: [...entries.map((entry) => [entry]), ...entries.map((entry) => [{ id: 1, todo: [entry] }]), [{ id: 2, todo: [null] }]],
    };
    const thrown = [];
    for (const field of CANONICAL_FIELDS) {
      for (const value of [...GENERIC, ...(PATCHES[field] ?? [])]) {
        await writeFile(statePath, original);
        try {
          await update({ updates: { [field]: value }, basePath: dir });
        } catch (err) {
          thrown.push(`${field} = ${JSON.stringify(value)}: ${err.message}`);
        }
      }
    }
    assert.deepEqual(thrown, []);
  });

  for (const [label, phases, where] of [
    ['a phase', [null], 'phases[0]'],
    ['a task', [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }, null] }], 'phases[0].todo[1]'],
    ['a task in a new phase', [{ id: 2, todo: ['x'] }], 'phases[0].todo[0]'],
  ]) {
    it(`refuses ${label} patch that is not an object, naming the entry and writing nothing`, async () => {
      const statePath = join(dir, '.gsd', 'state.json');
      await writeFile(statePath, original);
      const res = await update({ updates: { phases }, basePath: dir });
      assert.equal(res.code, 'INVALID_INPUT', JSON.stringify(res));
      assert.ok(res.message.includes(`${where} must be an object`), res.message);
      assert.equal(await readFile(statePath, 'utf8'), original);
    });
  }

  // A research record already invalid on file fails every write that is
  // validated in full, whatever it writes, and resume reported only the
  // error, every time.
  describe('a research record that is already invalid on file', () => {
    const plant = async () => {
      const raw = JSON.parse(original);
      raw.research = { decision_index: { 'decision:a': null } };
      await writeFile(join(dir, '.gsd', 'state.json'), JSON.stringify(raw));
    };

    it('says how to get out of it when a write fails on it', async () => {
      await plant();
      const res = await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: dir });
      assert.equal(res.code, 'VALIDATION_FAILED', JSON.stringify(res));
      assert.match(res.message, /research\.decision_index\.decision:a must be an object/);
      assert.ok(res.message.includes('state-update (research: null)'), res.message);
      const escaped = await update({ updates: { research: null }, basePath: dir });
      assert.ok(escaped.success, JSON.stringify(escaped));
      const retried = await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: dir });
      assert.ok(retried.success, JSON.stringify(retried));
    });

    it('does not offer it to an update that writes research itself', async () => {
      // There the update is what is wrong, and dropping the record is not the fix.
      await writeFile(join(dir, '.gsd', 'state.json'), original);
      const res = await update({ updates: { research: { decision_index: { 'decision:a': null } } }, basePath: dir });
      assert.equal(res.code, 'VALIDATION_FAILED', JSON.stringify(res));
      assert.ok(!res.message.includes('research: null'), res.message);
    });

    it('resume reports the way out too', async () => {
      await plant();
      const res = await resumeWorkflow({ basePath: dir });
      assert.equal(res.code, 'VALIDATION_FAILED', JSON.stringify(res));
      assert.ok(res.message.includes('state-update (research: null)'), res.message);
    });

    // Every other path that answers with validateState's errors.
    for (const [label, call] of [
      ['a validating read', (base) => read({ basePath: base, validate: true })],
      ['a plan patch', (base) => patchPlan({ operations: [{ op: 'add_task', phase_id: 1, task: { name: 'X' } }], basePath: base })],
      ['phase-complete', (base) => phaseComplete({ phase_id: 1, basePath: base, direction_ok: true, verification: PASSED })],
      ['phase-complete finding drift', (base) => phaseComplete({ phase_id: 1, basePath: base, direction_ok: false, verification: PASSED })],
    ]) {
      it(`${label} says it as well`, async () => {
        const base = await createTempDir();
        try {
          await initProject(base);
          for (const id of ['1.1', '1.2']) await acceptTask(base, 1, id);
          await update({ updates: { phases: [{ id: 1, lifecycle: 'reviewing' }] }, basePath: base });
          await update({ updates: { phases: [{ id: 1, phase_review: { status: 'accepted' } }] }, basePath: base });
          const statePath = join(base, '.gsd', 'state.json');
          const raw = JSON.parse(await readFile(statePath, 'utf8'));
          assert.ok(validateState(raw).valid, 'premise: the phase is ready before the research is broken');
          raw.research = { decision_index: { 'decision:a': null } };
          await writeFile(statePath, JSON.stringify(raw));
          const res = await call(base);
          assert.equal(res.code, 'VALIDATION_FAILED', JSON.stringify(res));
          assert.ok(res.message.includes('state-update (research: null)'), res.message);
        } finally {
          await removeTempDir(base);
        }
      });
    }
  });
});
