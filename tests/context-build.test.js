// tests/context-build.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutorContext } from '../src/tools/state/index.js';

describe('buildExecutorContext', () => {
  it('constructs context with all 6 fields', () => {
    const state = {
      phases: [{
        id: 1,
        todo: [
          { id: '1.1', lifecycle: 'accepted', files_changed: ['a.js'], checkpoint_commit: 'abc', requires: [], research_basis: [] },
          { id: '1.2', lifecycle: 'pending', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }], research_basis: ['decision:jwt'], level: 'L1', review_required: true, retry_count: 0 },
        ],
      }],
      research: { decision_index: { 'decision:jwt': { summary: 'Use JWT', source: 'Context7' } } },
    };
    const ctx = buildExecutorContext(state, '1.2', 1);
    assert.ok(ctx.task_spec !== undefined);
    assert.ok(ctx.research_decisions !== undefined);
    assert.ok(ctx.predecessor_outputs !== undefined);
    assert.ok(ctx.project_conventions !== undefined);
    assert.ok(ctx.workflows !== undefined);
    assert.ok(ctx.constraints !== undefined);
    assert.equal(ctx.constraints.level, 'L1');
    assert.deepEqual(ctx.predecessor_outputs, [{ files_changed: ['a.js'], checkpoint_commit: 'abc' }]);
    assert.equal(ctx.research_decisions[0].summary, 'Use JWT');
  });

  it('returns a structured error when phase is missing', () => {
    const result = buildExecutorContext({ phases: [] }, '1.1', 1);
    assert.equal(result.error, true);
    assert.match(result.message, /Phase 1 not found/);
  });

  it('includes debugging workflow when retry_count > 0', () => {
    const state = {
      phases: [{
        id: 1,
        todo: [
          { id: '1.1', lifecycle: 'pending', requires: [], research_basis: [], retry_count: 2, level: 'L1' },
        ],
      }],
    };
    const ctx = buildExecutorContext(state, '1.1', 1);
    assert.ok(!ctx.error, 'should not return error');
    assert.ok(ctx.workflows.includes('workflows/debugging.md'), 'should include debugging workflow');
  });

  it('handles research_basis referencing non-existent decision_index entry gracefully', () => {
    const state = {
      phases: [{
        id: 1,
        todo: [
          { id: '1.1', lifecycle: 'pending', requires: [], research_basis: ['decision:nonexistent'], level: 'L1' },
        ],
      }],
      research: { decision_index: {} },
    };
    const ctx = buildExecutorContext(state, '1.1', 1);
    assert.ok(!ctx.error, 'should not throw or return error');
    assert.equal(ctx.research_decisions.length, 1);
    assert.equal(ctx.research_decisions[0].summary, 'not found');
  });

  it('references correct phase file for task in phase 2', () => {
    const state = {
      phases: [
        { id: 1, todo: [] },
        {
          id: 2,
          todo: [
            { id: '2.1', lifecycle: 'pending', requires: [], research_basis: [], level: 'L2' },
          ],
        },
      ],
    };
    const ctx = buildExecutorContext(state, '2.1', 2);
    assert.ok(!ctx.error, 'should not return error');
    assert.equal(ctx.task_spec, 'phases/phase-2.md');
  });

  it('reflects review_required: false in constraints', () => {
    const state = {
      phases: [{
        id: 1,
        todo: [
          { id: '1.1', lifecycle: 'pending', requires: [], research_basis: [], level: 'L0', review_required: false },
        ],
      }],
    };
    const ctx = buildExecutorContext(state, '1.1', 1);
    assert.ok(!ctx.error, 'should not return error');
    assert.equal(ctx.constraints.review_required, false);
  });

  it('does not throw when state.research is null', () => {
    const state = {
      phases: [{
        id: 1,
        todo: [
          { id: '1.1', lifecycle: 'pending', requires: [], research_basis: ['decision:x'], level: 'L1' },
        ],
      }],
      research: null,
    };
    const ctx = buildExecutorContext(state, '1.1', 1);
    assert.ok(!ctx.error, 'should not return error');
    assert.equal(ctx.research_decisions.length, 1);
    assert.equal(ctx.research_decisions[0].summary, 'not found');
  });

  it('returns empty predecessor_outputs when requires is empty', () => {
    const state = {
      phases: [{
        id: 1,
        todo: [
          { id: '1.1', lifecycle: 'pending', requires: [], research_basis: [], level: 'L1' },
        ],
      }],
    };
    const ctx = buildExecutorContext(state, '1.1', 1);
    assert.ok(!ctx.error, 'should not return error');
    assert.deepEqual(ctx.predecessor_outputs, []);
  });
});
