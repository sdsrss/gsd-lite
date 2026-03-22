import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTransition,
  CANONICAL_FIELDS,
  WORKFLOW_MODES,
  TASK_LEVELS,
  validateState,
  createInitialState,
  validateExecutorResult,
  validateReviewerResult,
  validateResearcherResult,
  validateDebuggerResult,
  validateResearchDecisionIndex,
  validateResearchArtifacts,
} from '../src/schema.js';

describe('schema', () => {
  describe('TASK_LIFECYCLE transitions', () => {
    it('allows pending → running', () => {
      assert.equal(validateTransition('task', 'pending', 'running').valid, true);
    });

    it('allows running → checkpointed', () => {
      assert.equal(validateTransition('task', 'running', 'checkpointed').valid, true);
    });

    it('allows checkpointed → accepted', () => {
      assert.equal(validateTransition('task', 'checkpointed', 'accepted').valid, true);
    });

    it('allows pending → blocked', () => {
      assert.equal(validateTransition('task', 'pending', 'blocked').valid, true);
    });

    it('allows running → blocked', () => {
      assert.equal(validateTransition('task', 'running', 'blocked').valid, true);
    });

    it('allows running → failed', () => {
      assert.equal(validateTransition('task', 'running', 'failed').valid, true);
    });

    it('allows accepted → needs_revalidation', () => {
      assert.equal(validateTransition('task', 'accepted', 'needs_revalidation').valid, true);
    });

    it('allows checkpointed → needs_revalidation (C-2 fix)', () => {
      assert.equal(validateTransition('task', 'checkpointed', 'needs_revalidation').valid, true);
    });

    it('allows needs_revalidation → pending', () => {
      assert.equal(validateTransition('task', 'needs_revalidation', 'pending').valid, true);
    });

    it('rejects pending → accepted (skip running)', () => {
      assert.equal(validateTransition('task', 'pending', 'accepted').valid, false);
    });

    it('rejects accepted → running (no direct)', () => {
      assert.equal(validateTransition('task', 'accepted', 'running').valid, false);
    });

    it('rejects blocked → running (M-3: must go through pending)', () => {
      assert.equal(validateTransition('task', 'blocked', 'running').valid, false);
    });
  });

  describe('PHASE_LIFECYCLE transitions', () => {
    it('allows pending → active', () => {
      assert.equal(validateTransition('phase', 'pending', 'active').valid, true);
    });

    it('allows active → reviewing', () => {
      assert.equal(validateTransition('phase', 'active', 'reviewing').valid, true);
    });

    it('allows reviewing → accepted', () => {
      assert.equal(validateTransition('phase', 'reviewing', 'accepted').valid, true);
    });

    it('allows active → blocked', () => {
      assert.equal(validateTransition('phase', 'active', 'blocked').valid, true);
    });

    it('allows active → failed', () => {
      assert.equal(validateTransition('phase', 'active', 'failed').valid, true);
    });

    it('rejects pending → reviewing', () => {
      assert.equal(validateTransition('phase', 'pending', 'reviewing').valid, false);
    });
  });

  describe('CANONICAL_FIELDS', () => {
    it('includes workflow_mode', () => {
      assert.ok(CANONICAL_FIELDS.includes('workflow_mode'));
    });

    it('includes schema_version', () => {
      assert.ok(CANONICAL_FIELDS.includes('schema_version'));
    });

    it('does not include derived fields', () => {
      assert.ok(!CANONICAL_FIELDS.includes('stopped_at'));
      assert.ok(!CANONICAL_FIELDS.includes('next_action'));
    });
  });

  describe('WORKFLOW_MODES', () => {
    it('contains all 12 modes', () => {
      assert.equal(WORKFLOW_MODES.length, 12);
      assert.ok(WORKFLOW_MODES.includes('planning'));
      assert.ok(WORKFLOW_MODES.includes('executing_task'));
      assert.ok(WORKFLOW_MODES.includes('completed'));
      assert.ok(WORKFLOW_MODES.includes('failed'));
    });
  });

  describe('validateState', () => {
    it('accepts valid minimal state', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      const result = validateState(state);
      assert.equal(result.valid, true);
    });

    it('rejects state with invalid workflow_mode', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.workflow_mode = 'invalid_mode';
      const result = validateState(state);
      assert.equal(result.valid, false);
    });

    it('rejects state where total_phases mismatches phases.length (M-1)', () => {
      const state = createInitialState({ project: 'test', phases: [{ name: 'p1', tasks: [] }] });
      state.total_phases = 5;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('total_phases')));
    });

    it('rejects state with non-string git_head (M-1)', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.git_head = 123;
      const result = validateState(state);
      assert.equal(result.valid, false);
    });

    it('rejects phase with malformed todo structure', () => {
      const state = createInitialState({ project: 'test', phases: [{ name: 'p1', tasks: [] }] });
      state.phases.push({ id: 2, name: 'broken', lifecycle: 'pending' });
      state.total_phases = 2;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('todo must be an array')));
    });
  });

  describe('validateTransition edge cases', () => {
    it('rejects unknown source state for task entity', () => {
      const result = validateTransition('task', 'nonexistent_state', 'running');
      assert.equal(result.valid, false);
      assert.match(result.error, /Unknown task state/);
    });

    it('rejects unknown source state for phase entity', () => {
      const result = validateTransition('phase', 'nonexistent_state', 'active');
      assert.equal(result.valid, false);
      assert.match(result.error, /Unknown phase state/);
    });

    it('rejects invalid target state for valid source state (task)', () => {
      const result = validateTransition('task', 'pending', 'accepted');
      assert.equal(result.valid, false);
      assert.match(result.error, /Invalid task transition/);
    });

    it('rejects invalid target state for valid source state (phase)', () => {
      const result = validateTransition('phase', 'accepted', 'active');
      assert.equal(result.valid, false);
      assert.match(result.error, /Invalid phase transition/);
    });

    it('uses PHASE_LIFECYCLE when entity is not task', () => {
      const result = validateTransition('phase', 'blocked', 'active');
      assert.equal(result.valid, true);
    });
  });

  describe('validateState detailed branch coverage', () => {
    it('rejects missing project (falsy)', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.project = '';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('project must be a non-empty string')));
    });

    it('rejects project of non-string type', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.project = 42;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('project must be a non-empty string')));
    });

    it('rejects non-number plan_version', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.plan_version = 'v1';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('plan_version must be a finite number')));
    });

    it('rejects non-number current_phase', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.current_phase = 'phase1';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('current_phase must be a finite number')));
    });

    it('rejects non-number total_phases', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.total_phases = '0';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('total_phases must be a finite number')));
    });

    it('rejects non-array phases', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.phases = 'not-array';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('phases must be an array')));
    });

    it('rejects non-array decisions', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.decisions = 'not-array';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('decisions must be an array')));
    });

    it('rejects non-object context', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.context = 'not-object';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('context must be an object')));
    });

    it('rejects context with non-string last_session', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.context.last_session = 42;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('context.last_session must be a string')));
    });

    it('rejects context with non-number remaining_percentage', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.context.remaining_percentage = '100';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('context.remaining_percentage must be a finite number')));
    });

    it('rejects non-null non-object research', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.research = 'bad-research';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('research must be null or an object')));
    });

    it('rejects research with non-object decision_index', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.research = { decision_index: 'not-object' };
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('research.decision_index must be an object')));
    });

    it('rejects research with invalid volatility', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.research = { volatility: 'extreme' };
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('research.volatility must be low|medium|high')));
    });

    it('rejects research with empty expires_at', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.research = { expires_at: '' };
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('research.expires_at must be a non-empty string')));
    });

    it('rejects research with non-string expires_at', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.research = { expires_at: 12345 };
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('research.expires_at must be a non-empty string')));
    });

    it('rejects research with invalid ISO 8601 expires_at', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.research = { expires_at: '2026-99-99' };
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('valid ISO 8601 date')));
    });

    it('rejects research with non-array files', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.research = { files: 'not-array' };
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('research.files must be an array')));
    });

    it('rejects research.files with non-string entries', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.research = { files: [42] };
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('research.files entries must be non-empty strings')));
    });

    it('rejects research.files with empty string entries', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.research = { files: [''] };
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('research.files entries must be non-empty strings')));
    });

    it('validates research.sources entries inline', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.research = { sources: [{ id: '', type: 'foo', ref: 'bar' }] };
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('research.sources[].id must be non-empty string')));
    });

    it('validates research.decision_index entries inline', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.research = { decision_index: { 'd1': { summary: '' } } };
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('summary must be a non-empty string')));
    });

    it('rejects non-number schema_version', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.schema_version = 'v1';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('schema_version must be a finite number')));
    });

    it('rejects non-object evidence', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.evidence = 'not-object';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('evidence must be an object')));
    });

    it('rejects non-object phase entry in phases array', () => {
      const state = createInitialState({ project: 'test', phases: [{ name: 'p1', tasks: [] }] });
      state.phases.push('not-an-object');
      state.total_phases = 2;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('phase must be an object')));
    });

    it('rejects phase with non-number id', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.phases = [{ id: 'abc', name: 'p1', lifecycle: 'active', phase_review: { status: 'pending', retry_count: 0 }, tasks: 0, done: 0, todo: [], phase_handoff: { required_reviews_passed: false, tests_passed: false, critical_issues_open: 0 } }];
      state.total_phases = 1;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('phase.id must be a finite number')));
    });

    it('rejects phase with missing name', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.phases = [{ id: 1, name: '', lifecycle: 'active', phase_review: { status: 'pending', retry_count: 0 }, tasks: 0, done: 0, todo: [], phase_handoff: { required_reviews_passed: false, tests_passed: false, critical_issues_open: 0 } }];
      state.total_phases = 1;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('name must be a non-empty string')));
    });

    it('rejects phase with invalid lifecycle', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.phases = [{ id: 1, name: 'p1', lifecycle: 'invalid_lifecycle', phase_review: { status: 'pending', retry_count: 0 }, tasks: 0, done: 0, todo: [], phase_handoff: { required_reviews_passed: false, tests_passed: false, critical_issues_open: 0 } }];
      state.total_phases = 1;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('invalid lifecycle')));
    });

    it('rejects phase with invalid phase_review.status', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.phases = [{ id: 1, name: 'p1', lifecycle: 'active', phase_review: { status: 'bad', retry_count: 0 }, tasks: 0, done: 0, todo: [], phase_handoff: { required_reviews_passed: false, tests_passed: false, critical_issues_open: 0 } }];
      state.total_phases = 1;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('invalid phase_review.status')));
    });

    it('rejects phase with non-number phase_review.retry_count', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.phases = [{ id: 1, name: 'p1', lifecycle: 'active', phase_review: { status: 'pending', retry_count: 'x' }, tasks: 0, done: 0, todo: [], phase_handoff: { required_reviews_passed: false, tests_passed: false, critical_issues_open: 0 } }];
      state.total_phases = 1;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('phase_review.retry_count must be a finite number')));
    });

    it('rejects phase with non-object phase_review', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.phases = [{ id: 1, name: 'p1', lifecycle: 'active', phase_review: 'bad', tasks: 0, done: 0, todo: [], phase_handoff: { required_reviews_passed: false, tests_passed: false, critical_issues_open: 0 } }];
      state.total_phases = 1;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('phase_review must be an object')));
    });

    it('rejects phase with non-number tasks', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.phases = [{ id: 1, name: 'p1', lifecycle: 'active', phase_review: { status: 'pending', retry_count: 0 }, tasks: 'two', done: 0, todo: [], phase_handoff: { required_reviews_passed: false, tests_passed: false, critical_issues_open: 0 } }];
      state.total_phases = 1;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('tasks must be a finite number')));
    });

    it('rejects phase with non-number done', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.phases = [{ id: 1, name: 'p1', lifecycle: 'active', phase_review: { status: 'pending', retry_count: 0 }, tasks: 0, done: 'none', todo: [], phase_handoff: { required_reviews_passed: false, tests_passed: false, critical_issues_open: 0 } }];
      state.total_phases = 1;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('done must be a finite number')));
    });

    it('rejects phase with non-object phase_handoff', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.phases = [{ id: 1, name: 'p1', lifecycle: 'active', phase_review: { status: 'pending', retry_count: 0 }, tasks: 0, done: 0, todo: [], phase_handoff: 'bad' }];
      state.total_phases = 1;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('phase_handoff must be an object')));
    });

    it('rejects phase_handoff with non-boolean required_reviews_passed', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.phases = [{ id: 1, name: 'p1', lifecycle: 'active', phase_review: { status: 'pending', retry_count: 0 }, tasks: 0, done: 0, todo: [], phase_handoff: { required_reviews_passed: 'yes', tests_passed: false, critical_issues_open: 0 } }];
      state.total_phases = 1;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('required_reviews_passed must be boolean')));
    });

    it('rejects phase_handoff with non-boolean tests_passed', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.phases = [{ id: 1, name: 'p1', lifecycle: 'active', phase_review: { status: 'pending', retry_count: 0 }, tasks: 0, done: 0, todo: [], phase_handoff: { required_reviews_passed: false, tests_passed: 'no', critical_issues_open: 0 } }];
      state.total_phases = 1;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('tests_passed must be boolean')));
    });

    it('rejects phase_handoff with non-number critical_issues_open', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.phases = [{ id: 1, name: 'p1', lifecycle: 'active', phase_review: { status: 'pending', retry_count: 0 }, tasks: 0, done: 0, todo: [], phase_handoff: { required_reviews_passed: false, tests_passed: false, critical_issues_open: 'none' } }];
      state.total_phases = 1;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('critical_issues_open must be a finite number')));
    });

    it('rejects phase_handoff with non-boolean direction_ok when present', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.phases = [{ id: 1, name: 'p1', lifecycle: 'active', phase_review: { status: 'pending', retry_count: 0 }, tasks: 0, done: 0, todo: [], phase_handoff: { required_reviews_passed: false, tests_passed: false, critical_issues_open: 0, direction_ok: 'yes' } }];
      state.total_phases = 1;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('direction_ok must be boolean when present')));
    });

    it('rejects non-object task entry in todo', () => {
      const state = createInitialState({ project: 'test', phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }] });
      state.phases[0].todo.push('not-an-object');
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('task must be an object')));
    });

    it('rejects task with empty id', () => {
      const state = createInitialState({ project: 'test', phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }] });
      state.phases[0].todo[0].id = '';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('task.id must be a non-empty string')));
    });

    it('rejects task with empty name', () => {
      const state = createInitialState({ project: 'test', phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }] });
      state.phases[0].todo[0].name = '';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('name must be a non-empty string')));
    });

    it('rejects task with invalid lifecycle', () => {
      const state = createInitialState({ project: 'test', phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }] });
      state.phases[0].todo[0].lifecycle = 'broken';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('invalid lifecycle')));
    });

    it('exports TASK_LEVELS constant with L0-L3', () => {
      assert.deepEqual(TASK_LEVELS, ['L0', 'L1', 'L2', 'L3']);
    });

    it('accepts tasks with valid levels L0-L3', () => {
      for (const level of ['L0', 'L1', 'L2', 'L3']) {
        const state = createInitialState({ project: 'test', phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1', level }] }] });
        const result = validateState(state);
        assert.equal(result.valid, true, `level ${level} should be valid`);
      }
    });

    it('rejects task with invalid level string', () => {
      const state = createInitialState({ project: 'test', phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }] });
      state.phases[0].todo[0].level = 'L5';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('level must be one of')));
    });

    it('rejects task with arbitrary string level', () => {
      const state = createInitialState({ project: 'test', phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }] });
      state.phases[0].todo[0].level = 'foo';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('level must be one of')));
    });

    it('rejects task with non-string level', () => {
      const state = createInitialState({ project: 'test', phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }] });
      state.phases[0].todo[0].level = 42;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('level must be one of')));
    });

    it('rejects task with non-array requires', () => {
      const state = createInitialState({ project: 'test', phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }] });
      state.phases[0].todo[0].requires = 'bad';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('requires must be an array')));
    });

    it('rejects task with non-number retry_count', () => {
      const state = createInitialState({ project: 'test', phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }] });
      state.phases[0].todo[0].retry_count = 'x';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('retry_count must be a finite number')));
    });

    it('rejects task with non-boolean review_required', () => {
      const state = createInitialState({ project: 'test', phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }] });
      state.phases[0].todo[0].review_required = 'yes';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('review_required must be a boolean')));
    });

    it('rejects task with non-boolean verification_required', () => {
      const state = createInitialState({ project: 'test', phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }] });
      state.phases[0].todo[0].verification_required = 'yes';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('verification_required must be a boolean')));
    });

    it('rejects task with non-null non-string checkpoint_commit', () => {
      const state = createInitialState({ project: 'test', phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }] });
      state.phases[0].todo[0].checkpoint_commit = 42;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('checkpoint_commit must be a string or null')));
    });

    it('rejects task with non-array research_basis', () => {
      const state = createInitialState({ project: 'test', phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }] });
      state.phases[0].todo[0].research_basis = 'bad';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('research_basis must be an array')));
    });

    it('rejects task with non-array evidence_refs', () => {
      const state = createInitialState({ project: 'test', phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }] });
      state.phases[0].todo[0].evidence_refs = 'bad';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('evidence_refs must be an array')));
    });

    it('accepts valid research with valid volatility and expires_at', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.research = { volatility: 'low', expires_at: '2026-01-01T00:00:00Z', files: ['STACK.md'] };
      const result = validateState(state);
      assert.equal(result.valid, true);
    });

    it('accepts string git_head', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.git_head = 'abc123';
      const result = validateState(state);
      assert.equal(result.valid, true);
    });

    it('accepts null git_head', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.git_head = null;
      const result = validateState(state);
      assert.equal(result.valid, true);
    });

    // M-4: Cross-field validation
    it('rejects current_phase > total_phases (M-4)', () => {
      const state = createInitialState({ project: 'test', phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }] });
      state.current_phase = 5;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('must not exceed total_phases')));
    });

    it('accepts current_phase equal to total_phases (M-4)', () => {
      const state = createInitialState({ project: 'test', phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }] });
      state.current_phase = 1;
      const result = validateState(state);
      assert.equal(result.valid, true);
    });

    // M-5: Evidence entry structure validation
    it('rejects evidence entry without scope (M-5)', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.evidence = { 'ev:1': { command: 'test' } };
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('evidence["ev:1"].scope')));
    });

    it('rejects non-object evidence entry (M-5)', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.evidence = { 'ev:1': 'bad' };
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('evidence["ev:1"] must be an object')));
    });

    it('accepts valid evidence entries with scope (M-5)', () => {
      const state = createInitialState({ project: 'test', phases: [] });
      state.evidence = { 'ev:1': { scope: 'task:1.1' }, 'ev:2': { scope: 'global' } };
      const result = validateState(state);
      assert.equal(result.valid, true);
    });

    // P2-9: Cross-field consistency checks
    it('rejects current_task not belonging to current_phase (P2-9)', () => {
      const state = createInitialState({
        project: 'test',
        phases: [
          { name: 'p1', tasks: [{ index: 1, name: 't1' }] },
          { name: 'p2', tasks: [{ index: 1, name: 't2' }] },
        ],
      });
      state.current_phase = 1;
      state.current_task = '2.1'; // task from phase 2, not phase 1
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('current_task "2.1" not found in current_phase 1')));
    });

    it('accepts current_task belonging to current_phase (P2-9)', () => {
      const state = createInitialState({
        project: 'test',
        phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }],
      });
      state.current_phase = 1;
      state.current_task = '1.1';
      const result = validateState(state);
      assert.equal(result.valid, true);
    });

    it('allows null current_task regardless of phase (P2-9)', () => {
      const state = createInitialState({
        project: 'test',
        phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }],
      });
      state.current_phase = 1;
      state.current_task = null;
      const result = validateState(state);
      assert.equal(result.valid, true);
    });

    it('rejects completed project with running tasks (P2-9)', () => {
      const state = createInitialState({
        project: 'test',
        phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }],
      });
      state.workflow_mode = 'completed';
      state.phases[0].todo[0].lifecycle = 'running';
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('Completed project has running task')));
    });

    it('accepts completed project with all accepted tasks (P2-9)', () => {
      const state = createInitialState({
        project: 'test',
        phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }],
      });
      state.workflow_mode = 'completed';
      state.phases[0].todo[0].lifecycle = 'accepted';
      state.phases[0].lifecycle = 'accepted';
      state.phases[0].done = 1;
      const result = validateState(state);
      assert.equal(result.valid, true);
    });

    // P2-9: reviewing mode requires matching current_review
    it('rejects reviewing_phase without phase-scoped current_review (P2-9)', () => {
      const state = createInitialState({
        project: 'test',
        phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }],
      });
      state.workflow_mode = 'reviewing_phase';
      state.current_review = null;
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('requires current_review with scope="phase"')));
    });

    it('rejects reviewing_task with phase-scoped current_review (P2-9)', () => {
      const state = createInitialState({
        project: 'test',
        phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }],
      });
      state.workflow_mode = 'reviewing_task';
      state.current_review = { scope: 'phase', scope_id: 1 };
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('requires current_review with scope="task"')));
    });

    // P2-9: current_review.scope_id references existing entity
    it('rejects current_review.scope_id referencing non-existent phase (P2-9)', () => {
      const state = createInitialState({
        project: 'test',
        phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }],
      });
      state.workflow_mode = 'reviewing_phase';
      state.current_review = { scope: 'phase', scope_id: 99 };
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('non-existent phase')));
    });

    it('rejects current_review.scope_id referencing non-existent task (P2-9)', () => {
      const state = createInitialState({
        project: 'test',
        phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }],
      });
      state.workflow_mode = 'reviewing_task';
      state.current_review = { scope: 'task', scope_id: '9.9' };
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('non-existent task')));
    });

    it('rejects current_review with invalid scope value', () => {
      const state = createInitialState({
        project: 'test',
        phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }],
      });
      state.current_review = { scope: 'tsk', scope_id: '1.1' };
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('current_review.scope must be one of: task, phase')));
    });

    it('accepts current_review with valid scope "task"', () => {
      const state = createInitialState({
        project: 'test',
        phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }],
      });
      state.workflow_mode = 'reviewing_task';
      state.current_task = '1.1';
      state.current_review = { scope: 'task', scope_id: '1.1' };
      const result = validateState(state);
      assert.equal(result.valid, true);
    });

    it('accepts valid current_review.scope_id referencing existing phase (P2-9)', () => {
      const state = createInitialState({
        project: 'test',
        phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }],
      });
      state.workflow_mode = 'reviewing_phase';
      state.current_review = { scope: 'phase', scope_id: 1 };
      const result = validateState(state);
      assert.equal(result.valid, true);
    });

    // P2-9: accepted phase must not contain non-accepted tasks
    it('rejects accepted phase with pending task (P2-9)', () => {
      const state = createInitialState({
        project: 'test',
        phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }, { index: 2, name: 't2' }] }],
      });
      state.phases[0].lifecycle = 'accepted';
      state.phases[0].todo[0].lifecycle = 'accepted';
      // todo[1] is still 'pending'
      const result = validateState(state);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('Accepted phase 1 contains non-accepted tasks')));
    });

    it('accepts accepted phase with all accepted tasks (P2-9)', () => {
      const state = createInitialState({
        project: 'test',
        phases: [{ name: 'p1', tasks: [{ index: 1, name: 't1' }] }],
      });
      state.phases[0].lifecycle = 'accepted';
      state.phases[0].todo[0].lifecycle = 'accepted';
      state.phases[0].done = 1;
      const result = validateState(state);
      assert.equal(result.valid, true);
    });
  });

  describe('createInitialState', () => {
    it('creates state with correct structure', () => {
      const state = createInitialState({
        project: 'my-app',
        phases: [
          { name: 'setup', tasks: [{ index: 1, name: 'init repo' }, { index: 2, name: 'add deps' }] },
          { name: 'features', tasks: [{ index: 1, name: 'user api', level: 'L2' }] },
        ],
      });
      assert.equal(state.project, 'my-app');
      assert.equal(state.schema_version, 1);
      assert.equal(state.workflow_mode, 'executing_task');
      assert.equal(state.plan_version, 1);
      assert.equal(state.total_phases, 2);
      assert.equal(state.phases.length, 2);
      assert.equal(state.phases[0].lifecycle, 'active');
      assert.equal(state.phases[1].lifecycle, 'pending');
      assert.equal(state.phases[0].tasks, 2);
      assert.equal(state.phases[0].todo.length, 2);
      assert.equal(state.phases[0].todo[0].id, '1.1');
      assert.equal(state.phases[0].todo[0].lifecycle, 'pending');
      assert.equal(state.phases[1].todo[0].level, 'L2');
    });

    it('creates tasks with defaults when optional fields omitted', () => {
      const state = createInitialState({
        project: 'defaults-test',
        phases: [{ name: 'p1', tasks: [{ name: 'minimal task' }] }],
      });
      const task = state.phases[0].todo[0];
      assert.equal(task.level, 'L1');
      assert.deepEqual(task.requires, []);
      assert.equal(task.review_required, true);
      assert.equal(task.verification_required, true);
      assert.deepEqual(task.research_basis, []);
    });

    it('handles phase with no tasks array', () => {
      const state = createInitialState({
        project: 'no-tasks-test',
        phases: [{ name: 'empty-phase' }],
      });
      assert.equal(state.phases[0].tasks, 0);
      assert.deepEqual(state.phases[0].todo, []);
    });

    it('includes blocked_reason and invalidate_downstream_on_change when provided', () => {
      const state = createInitialState({
        project: 'extras-test',
        phases: [{ name: 'p1', tasks: [{
          name: 'blocked-task',
          blocked_reason: 'needs decision',
          invalidate_downstream_on_change: true,
        }] }],
      });
      const task = state.phases[0].todo[0];
      assert.equal(task.blocked_reason, 'needs decision');
      assert.equal(task.invalidate_downstream_on_change, true);
    });
  });
});

describe('validateExecutorResult edge cases', () => {
  const base = {
    task_id: '1.1',
    outcome: 'checkpointed',
    summary: 'Done',
    checkpoint_commit: 'abc',
    files_changed: [],
    decisions: [],
    blockers: [],
    contract_changed: false,
    evidence: [],
  };

  it('rejects empty summary', () => {
    const r = { ...base, summary: '' };
    const result = validateExecutorResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('summary must be non-empty string')));
  });

  it('rejects non-string summary', () => {
    const r = { ...base, summary: 42 };
    const result = validateExecutorResult(r);
    assert.equal(result.valid, false);
  });

  it('rejects non-array files_changed', () => {
    const r = { ...base, files_changed: 'file.js' };
    const result = validateExecutorResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('files_changed must be array')));
  });

  it('rejects non-array decisions', () => {
    const r = { ...base, decisions: 'a decision' };
    const result = validateExecutorResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('decisions must be array')));
  });

  it('rejects non-array blockers', () => {
    const r = { ...base, blockers: 'a blocker' };
    const result = validateExecutorResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('blockers must be array')));
  });

  it('rejects non-boolean contract_changed', () => {
    const r = { ...base, contract_changed: 'yes' };
    const result = validateExecutorResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('contract_changed must be boolean')));
  });

  it('allows checkpoint_commit as null for non-checkpointed outcome', () => {
    const r = { ...base, outcome: 'failed', checkpoint_commit: null };
    const result = validateExecutorResult(r);
    assert.equal(result.valid, true);
  });

  it('rejects checkpoint_commit as number', () => {
    const r = { ...base, checkpoint_commit: 123 };
    const result = validateExecutorResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('checkpoint_commit must be string or null')));
  });

  it('accepts blocked outcome without checkpoint_commit key', () => {
    const { checkpoint_commit: _, ...rest } = base;
    const r = { ...rest, outcome: 'blocked' };
    const result = validateExecutorResult(r);
    assert.equal(result.valid, true);
  });
});

describe('validateReviewerResult edge cases', () => {
  const base = {
    scope: 'task',
    scope_id: '1.1',
    review_level: 'L2',
    spec_passed: true,
    quality_passed: true,
    critical_issues: [],
    important_issues: [],
    minor_issues: [],
    accepted_tasks: [],
    rework_tasks: [],
    evidence: [],
  };

  it('rejects empty scope_id', () => {
    const r = { ...base, scope_id: '' };
    const result = validateReviewerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('scope_id')));
  });

  it('rejects scope_id of 0', () => {
    const r = { ...base, scope_id: 0 };
    const result = validateReviewerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('scope_id')));
  });

  it('accepts numeric scope_id', () => {
    const r = { ...base, scope_id: 1 };
    const result = validateReviewerResult(r);
    assert.equal(result.valid, true);
  });

  it('rejects invalid review_level', () => {
    const r = { ...base, review_level: 'L3' };
    const result = validateReviewerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('invalid review_level')));
  });

  it('rejects non-boolean quality_passed', () => {
    const r = { ...base, quality_passed: 'true' };
    const result = validateReviewerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('quality_passed must be boolean')));
  });

  it('rejects non-array important_issues', () => {
    const r = { ...base, important_issues: 'issue' };
    const result = validateReviewerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('important_issues must be array')));
  });

  it('rejects non-array minor_issues', () => {
    const r = { ...base, minor_issues: 'issue' };
    const result = validateReviewerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('minor_issues must be array')));
  });

  it('rejects non-array accepted_tasks', () => {
    const r = { ...base, accepted_tasks: 'task' };
    const result = validateReviewerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('accepted_tasks must be array')));
  });

  it('rejects non-array rework_tasks', () => {
    const r = { ...base, rework_tasks: 'task' };
    const result = validateReviewerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('rework_tasks must be array')));
  });

  it('validates critical_issues entry with non-object', () => {
    const r = { ...base, critical_issues: ['not-an-object'] };
    const result = validateReviewerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('critical_issues entries must be objects')));
  });

  it('validates critical_issues entry with empty reason', () => {
    const r = { ...base, critical_issues: [{ reason: '' }] };
    const result = validateReviewerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('must be non-empty string')));
  });

  it('validates critical_issues entry with non-string task_id', () => {
    const r = { ...base, critical_issues: [{ reason: 'bad', task_id: 123 }] };
    const result = validateReviewerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('task_id must be string')));
  });

  it('validates critical_issues entry with non-boolean invalidates_downstream', () => {
    const r = { ...base, critical_issues: [{ reason: 'bad', invalidates_downstream: 'yes' }] };
    const result = validateReviewerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('invalidates_downstream must be boolean')));
  });

  it('accepts valid critical_issues entry with task_id and invalidates_downstream', () => {
    const r = { ...base, critical_issues: [{ reason: 'bad', task_id: '1.1', invalidates_downstream: true }] };
    const result = validateReviewerResult(r);
    assert.equal(result.valid, true);
  });
});

describe('validateResearcherResult edge cases', () => {
  it('rejects non-array decision_ids', () => {
    const r = { decision_ids: 'not-array', volatility: 'low', expires_at: '2026-01-01', sources: [] };
    const result = validateResearcherResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('decision_ids must be array')));
  });

  it('rejects empty expires_at', () => {
    const r = { decision_ids: [], volatility: 'low', expires_at: '', sources: [] };
    const result = validateResearcherResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('missing expires_at')));
  });

  it('rejects non-string expires_at', () => {
    const r = { decision_ids: [], volatility: 'low', expires_at: 42, sources: [] };
    const result = validateResearcherResult(r);
    assert.equal(result.valid, false);
  });

  it('rejects non-array sources', () => {
    const r = { decision_ids: [], volatility: 'low', expires_at: '2026-01-01', sources: 'not-array' };
    const result = validateResearcherResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('sources must be array')));
  });

  it('rejects sources with non-object entries', () => {
    const r = { decision_ids: [], volatility: 'low', expires_at: '2026-01-01', sources: ['not-object'] };
    const result = validateResearcherResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('sources entries must be objects')));
  });

  it('rejects source with empty type', () => {
    const r = { decision_ids: [], volatility: 'low', expires_at: '2026-01-01', sources: [{ id: 'src1', type: '', ref: 'docs' }] };
    const result = validateResearcherResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('type must be non-empty string')));
  });

  it('rejects source with empty ref', () => {
    const r = { decision_ids: [], volatility: 'low', expires_at: '2026-01-01', sources: [{ id: 'src1', type: 'web', ref: '' }] };
    const result = validateResearcherResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('ref must be non-empty string')));
  });
});

describe('validateDebuggerResult edge cases', () => {
  const base = {
    task_id: '1.1',
    outcome: 'fix_suggested',
    root_cause: 'pool exhaustion',
    evidence: [],
    hypothesis_tested: [],
    fix_direction: 'fix the pool',
    fix_attempts: 1,
    blockers: [],
    architecture_concern: false,
  };

  it('rejects empty root_cause', () => {
    const r = { ...base, root_cause: '' };
    const result = validateDebuggerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('root_cause must be non-empty string')));
  });

  it('rejects non-array evidence', () => {
    const r = { ...base, evidence: 'bad' };
    const result = validateDebuggerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('evidence must be array')));
  });

  it('rejects non-array hypothesis_tested', () => {
    const r = { ...base, hypothesis_tested: 'bad' };
    const result = validateDebuggerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('hypothesis_tested must be array')));
  });

  it('rejects empty fix_direction', () => {
    const r = { ...base, fix_direction: '' };
    const result = validateDebuggerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('fix_direction must be non-empty string')));
  });

  it('rejects negative fix_attempts', () => {
    const r = { ...base, fix_attempts: -1 };
    const result = validateDebuggerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('fix_attempts must be non-negative integer')));
  });

  it('rejects non-integer fix_attempts', () => {
    const r = { ...base, fix_attempts: 1.5 };
    const result = validateDebuggerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('fix_attempts must be non-negative integer')));
  });

  it('rejects non-array blockers', () => {
    const r = { ...base, blockers: 'bad' };
    const result = validateDebuggerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('blockers must be array')));
  });

  it('rejects non-boolean architecture_concern', () => {
    const r = { ...base, architecture_concern: 'yes' };
    const result = validateDebuggerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('architecture_concern must be boolean')));
  });

  it('validates hypothesis_tested entries — non-object', () => {
    const r = { ...base, hypothesis_tested: ['not-object'] };
    const result = validateDebuggerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('hypothesis_tested entries must be objects')));
  });

  it('validates hypothesis_tested entries — empty hypothesis', () => {
    const r = { ...base, hypothesis_tested: [{ hypothesis: '', result: 'confirmed', evidence: 'ev1' }] };
    const result = validateDebuggerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('hypothesis must be non-empty string')));
  });

  it('validates hypothesis_tested entries — invalid result', () => {
    const r = { ...base, hypothesis_tested: [{ hypothesis: 'test', result: 'maybe', evidence: 'ev1' }] };
    const result = validateDebuggerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('result must be confirmed or rejected')));
  });

  it('validates hypothesis_tested entries — empty evidence', () => {
    const r = { ...base, hypothesis_tested: [{ hypothesis: 'test', result: 'confirmed', evidence: '' }] };
    const result = validateDebuggerResult(r);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('evidence must be non-empty string')));
  });

  it('accepts valid failed outcome with 3+ fix_attempts', () => {
    const r = { ...base, outcome: 'failed', fix_attempts: 3 };
    const result = validateDebuggerResult(r);
    assert.equal(result.valid, true);
  });

  it('accepts root_cause_found outcome', () => {
    const r = { ...base, outcome: 'root_cause_found' };
    const result = validateDebuggerResult(r);
    assert.equal(result.valid, true);
  });
});

describe('validateResearchDecisionIndex edge cases', () => {
  it('rejects non-object decision_index', () => {
    const result = validateResearchDecisionIndex('not-object');
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('decision_index must be an object')));
  });

  it('validates required ids not present', () => {
    const result = validateResearchDecisionIndex({}, ['d1']);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('decision_index.d1 must be an object')));
  });

  it('rejects non-object entry value', () => {
    const result = validateResearchDecisionIndex({ d1: 'not-object' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('decision_index.d1 must be an object')));
  });

  it('rejects entry with empty summary', () => {
    const result = validateResearchDecisionIndex({ d1: { summary: '' } });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('summary must be a non-empty string')));
  });

  it('rejects entry with empty source', () => {
    const result = validateResearchDecisionIndex({ d1: { summary: 'ok', source: '' } });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('source must be a non-empty string')));
  });

  it('rejects entry with empty expires_at', () => {
    const result = validateResearchDecisionIndex({ d1: { summary: 'ok', expires_at: '' } });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('expires_at must be a non-empty string')));
  });

  it('accepts valid decision_index with source and expires_at', () => {
    const result = validateResearchDecisionIndex({ d1: { summary: 'ok', source: 'web', expires_at: '2026-01-01' } });
    assert.equal(result.valid, true);
  });

  it('rejects entry with invalid ISO 8601 expires_at', () => {
    const result = validateResearchDecisionIndex({ d1: { summary: 'ok', expires_at: '2026-99-99' } });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('valid ISO 8601 date')));
  });

  it('accepts entry with valid ISO 8601 expires_at', () => {
    const result = validateResearchDecisionIndex({ d1: { summary: 'ok', expires_at: '2026-03-17T12:00:00Z' } });
    assert.equal(result.valid, true);
  });
});

describe('validateResearchArtifacts edge cases', () => {
  it('rejects non-object artifacts', () => {
    const result = validateResearchArtifacts('not-object');
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('artifacts must be an object')));
  });

  it('rejects missing required files', () => {
    const result = validateResearchArtifacts({});
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('STACK.md must be a non-empty string')));
    assert.ok(result.errors.some(e => e.includes('ARCHITECTURE.md must be a non-empty string')));
    assert.ok(result.errors.some(e => e.includes('PITFALLS.md must be a non-empty string')));
    assert.ok(result.errors.some(e => e.includes('SUMMARY.md must be a non-empty string')));
  });

  it('rejects empty string for required file', () => {
    const result = validateResearchArtifacts({ 'STACK.md': '', 'ARCHITECTURE.md': 'x', 'PITFALLS.md': 'x', 'SUMMARY.md': 'x' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('STACK.md must be a non-empty string')));
  });

  it('accepts SUMMARY.md without content-level checks (structure only)', () => {
    const artifacts = {
      'STACK.md': 'stack',
      'ARCHITECTURE.md': 'arch',
      'PITFALLS.md': 'pit',
      'SUMMARY.md': 'no specific mentions needed',
    };
    // Content-level substring checks removed: correctness ensured by structured JSON result
    const result = validateResearchArtifacts(artifacts);
    assert.equal(result.valid, true);
  });

  it('accepts valid artifacts with non-empty files', () => {
    const artifacts = {
      'STACK.md': 'stack info',
      'ARCHITECTURE.md': 'arch info',
      'PITFALLS.md': 'pit info',
      'SUMMARY.md': 'summary info',
    };
    const result = validateResearchArtifacts(artifacts);
    assert.equal(result.valid, true);
  });
});

describe('createInitialState — duplicate task ID', () => {
  it('rejects duplicate task index within a phase', () => {
    const result = createInitialState({
      project: 'dup-test',
      phases: [{ name: 'P1', tasks: [{ name: 'A', index: 1 }, { name: 'B', index: 1 }] }],
    });
    assert.equal(result.error, true);
    assert.match(result.message, /Duplicate task ID/);
  });

  it('detects circular dependencies within a phase (M-7)', () => {
    const result = createInitialState({
      project: 'cycle-test',
      phases: [{
        name: 'P1',
        tasks: [
          { name: 'A', requires: [{ kind: 'task', id: '1.2', gate: 'accepted' }] },
          { name: 'B', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }] },
        ],
      }],
    });
    assert.equal(result.error, true);
    assert.match(result.message, /Circular dependency/);
  });

  it('allows valid DAG dependencies (no cycle)', () => {
    const result = createInitialState({
      project: 'dag-test',
      phases: [{
        name: 'P1',
        tasks: [
          { name: 'A' },
          { name: 'B', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }] },
          { name: 'C', requires: [{ kind: 'task', id: '1.2', gate: 'accepted' }] },
        ],
      }],
    });
    assert.equal(result.error, undefined);
    assert.equal(result.project, 'dag-test');
  });
});

describe('createInitialState — requires validation', () => {
  it('rejects string-format requires entries', () => {
    const result = createInitialState({
      project: 'test',
      phases: [{ name: 'P1', tasks: [{ name: 'A' }, { name: 'B', requires: ['1.1'] }] }],
    });
    assert.equal(result.error, true);
    assert.match(result.message, /must be an object.*not a string/);
  });

  it('rejects requires with missing kind/id', () => {
    const result = createInitialState({
      project: 'test',
      phases: [{ name: 'P1', tasks: [{ name: 'A' }, { name: 'B', requires: [{ id: '1.1' }] }] }],
    });
    assert.equal(result.error, true);
    assert.match(result.message, /kind.*and id/);
  });

  it('rejects reference to non-existent task ID', () => {
    const result = createInitialState({
      project: 'test',
      phases: [{ name: 'P1', tasks: [{ name: 'A' }, { name: 'B', requires: [{ kind: 'task', id: '9.9' }] }] }],
    });
    assert.equal(result.error, true);
    assert.match(result.message, /non-existent task/);
  });

  it('rejects reference to non-existent phase', () => {
    const result = createInitialState({
      project: 'test',
      phases: [{ name: 'P1', tasks: [{ name: 'A', requires: [{ kind: 'phase', id: 5 }] }] }],
    });
    assert.equal(result.error, true);
    assert.match(result.message, /non-existent phase/);
  });

  it('rejects invalid requires kind', () => {
    const result = createInitialState({
      project: 'test',
      phases: [{ name: 'P1', tasks: [{ name: 'A', requires: [{ kind: 'milestone', id: '1' }] }] }],
    });
    assert.equal(result.error, true);
    assert.match(result.message, /kind must be "task" or "phase"/);
  });

  it('accepts valid cross-phase dependency', () => {
    const result = createInitialState({
      project: 'test',
      phases: [
        { name: 'P1', tasks: [{ name: 'A' }] },
        { name: 'P2', tasks: [{ name: 'B', requires: [{ kind: 'phase', id: 1 }] }] },
      ],
    });
    assert.equal(result.error, undefined);
    assert.equal(result.project, 'test');
  });

  it('rejects invalid gate value', () => {
    const result = createInitialState({
      project: 'test',
      phases: [{ name: 'P1', tasks: [
        { name: 'A' },
        { name: 'B', requires: [{ kind: 'task', id: '1.1', gate: 'checkpint' }] },
      ] }],
    });
    assert.equal(result.error, true);
    assert.match(result.message, /gate must be one of/);
  });

  it('accepts valid gate values', () => {
    for (const gate of ['checkpoint', 'accepted', 'phase_complete']) {
      const result = createInitialState({
        project: 'test',
        phases: [{ name: 'P1', tasks: [
          { name: 'A' },
          { name: 'B', requires: [{ kind: 'task', id: '1.1', gate }] },
        ] }],
      });
      assert.equal(result.error, undefined, `gate "${gate}" should be accepted`);
    }
  });
});

describe('validateState — current_task and current_review types', () => {
  it('rejects numeric current_task', () => {
    const state = createInitialState({ project: 'test', phases: [{ name: 'P1', tasks: [{ name: 'T' }] }] });
    state.current_task = 42;
    const result = validateState(state);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('current_task')));
  });

  it('rejects string current_review', () => {
    const state = createInitialState({ project: 'test', phases: [{ name: 'P1', tasks: [{ name: 'T' }] }] });
    state.current_review = 'bad';
    const result = validateState(state);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('current_review')));
  });
});

describe('validateReviewerResult — disjoint check', () => {
  it('rejects overlapping accepted_tasks and rework_tasks', () => {
    const result = validateReviewerResult({
      scope: 'phase', scope_id: 1, review_level: 'L1-batch',
      spec_passed: true, quality_passed: true,
      critical_issues: [], important_issues: [], minor_issues: [],
      accepted_tasks: ['1.1', '1.2'], rework_tasks: ['1.2'], evidence: [],
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('disjoint')));
  });
});

describe('validateReviewerResult — critical_issues accepts description field', () => {
  it('accepts critical_issues entry with description instead of reason', () => {
    const result = validateReviewerResult({
      scope: 'task', scope_id: '1.1', review_level: 'L2',
      spec_passed: false, quality_passed: true,
      critical_issues: [{ description: 'Missing input validation on user endpoint' }],
      important_issues: [], minor_issues: [],
      accepted_tasks: [], rework_tasks: ['1.1'], evidence: [],
    });
    assert.equal(result.valid, true, `Expected valid but got errors: ${result.errors.join('; ')}`);
  });

  it('still accepts critical_issues entry with reason field', () => {
    const result = validateReviewerResult({
      scope: 'task', scope_id: '1.1', review_level: 'L2',
      spec_passed: false, quality_passed: true,
      critical_issues: [{ reason: 'Missing error handling' }],
      important_issues: [], minor_issues: [],
      accepted_tasks: [], rework_tasks: ['1.1'], evidence: [],
    });
    assert.equal(result.valid, true, `Expected valid but got errors: ${result.errors.join('; ')}`);
  });

  it('rejects critical_issues entry with neither reason nor description', () => {
    const result = validateReviewerResult({
      scope: 'task', scope_id: '1.1', review_level: 'L2',
      spec_passed: false, quality_passed: true,
      critical_issues: [{ task_id: '1.1' }],
      important_issues: [], minor_issues: [],
      accepted_tasks: [], rework_tasks: ['1.1'], evidence: [],
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('reason') || e.includes('description')));
  });
});
