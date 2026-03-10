// tests/context-build.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('buildExecutorContext', () => {
  it('constructs context with all 6 fields', async () => {
    const { buildExecutorContext } = await import('../src/tools/state.js');
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

  it('throws a clear error when phase is missing', async () => {
    const { buildExecutorContext } = await import('../src/tools/state.js');
    assert.throws(
      () => buildExecutorContext({ phases: [] }, '1.1', 1),
      /Phase 1 not found/
    );
  });
});
