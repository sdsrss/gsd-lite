// tests/incremental-validation.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStateUpdate,
  validateState,
  createInitialState,
} from '../src/schema.js';

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
      const result = validateStateUpdate(state, { total_phases: 3 });
      assert.equal(result.valid, true);
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

    it('accepts valid evidence entries with scope', () => {
      const state = baseState();
      const result = validateStateUpdate(state, { evidence: { 'ev:1': { scope: 'task:1.1' }, 'ev:2': { scope: 'global' } } });
      assert.equal(result.valid, true);
    });
  });
});
