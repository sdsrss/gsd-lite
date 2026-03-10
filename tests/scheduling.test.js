// tests/scheduling.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('selectRunnableTask', () => {
  it('returns first pending task with no dependencies', async () => {
    const { selectRunnableTask } = await import('../src/tools/state.js');
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'pending', requires: [], retry_count: 0 },
        { id: '1.2', lifecycle: 'pending', requires: [], retry_count: 0 },
      ],
    };
    const result = selectRunnableTask(phase, {});
    assert.equal(result.task.id, '1.1');
  });

  it('skips tasks with unmet accepted gate', async () => {
    const { selectRunnableTask } = await import('../src/tools/state.js');
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'accepted', requires: [], retry_count: 0 },
        { id: '1.2', lifecycle: 'pending', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }], retry_count: 0 },
        { id: '1.3', lifecycle: 'pending', requires: [{ kind: 'task', id: '1.2', gate: 'accepted' }], retry_count: 0 },
      ],
    };
    const result = selectRunnableTask(phase, {});
    assert.equal(result.task.id, '1.2');
  });

  it('allows checkpoint gate for checkpointed dependency', async () => {
    const { selectRunnableTask } = await import('../src/tools/state.js');
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'checkpointed', requires: [], retry_count: 0 },
        { id: '1.2', lifecycle: 'pending', requires: [{ kind: 'task', id: '1.1', gate: 'checkpoint' }], retry_count: 0 },
      ],
    };
    const result = selectRunnableTask(phase, {});
    assert.equal(result.task.id, '1.2');
  });

  it('blocks checkpoint gate for pending dependency', async () => {
    const { selectRunnableTask } = await import('../src/tools/state.js');
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'pending', requires: [], retry_count: 0 },
        { id: '1.2', lifecycle: 'pending', requires: [{ kind: 'task', id: '1.1', gate: 'checkpoint' }], retry_count: 0 },
      ],
    };
    const result = selectRunnableTask(phase, {});
    assert.equal(result.task.id, '1.1');
  });

  it('detects deadlock (all blocked)', async () => {
    const { selectRunnableTask } = await import('../src/tools/state.js');
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'blocked', requires: [], retry_count: 0, blocked_reason: 'need info' },
      ],
    };
    const result = selectRunnableTask(phase, {});
    assert.equal(result.mode, 'awaiting_user');
    assert.ok(result.blockers.length > 0);
  });

  it('detects all-awaiting-review', async () => {
    const { selectRunnableTask } = await import('../src/tools/state.js');
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'checkpointed', requires: [], retry_count: 0 },
        { id: '1.2', lifecycle: 'checkpointed', requires: [], retry_count: 0 },
      ],
    };
    const result = selectRunnableTask(phase, {});
    assert.equal(result.mode, 'trigger_review');
  });

  it('skips tasks that exceeded retry limit', async () => {
    const { selectRunnableTask } = await import('../src/tools/state.js');
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'pending', requires: [], retry_count: 5 },
        { id: '1.2', lifecycle: 'pending', requires: [], retry_count: 0 },
      ],
    };
    const result = selectRunnableTask(phase, {});
    assert.equal(result.task.id, '1.2');
  });

  it('handles phase_complete gate', async () => {
    const { selectRunnableTask } = await import('../src/tools/state.js');
    const phase = {
      todo: [
        { id: '2.1', lifecycle: 'pending', requires: [{ kind: 'phase', id: 1, gate: 'phase_complete' }], retry_count: 0 },
      ],
    };
    const result = selectRunnableTask(phase, { phases: [{ id: 1, lifecycle: 'active' }] });
    assert.equal(result.task, undefined);
  });

  it('handles empty todo list', async () => {
    const { selectRunnableTask } = await import('../src/tools/state.js');
    const phase = { todo: [] };
    const result = selectRunnableTask(phase, {});
    assert.equal(result.task, undefined);
  });

  it('handles all tasks accepted (phase complete)', async () => {
    const { selectRunnableTask } = await import('../src/tools/state.js');
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'accepted', requires: [], retry_count: 0 },
        { id: '1.2', lifecycle: 'accepted', requires: [], retry_count: 0 },
      ],
    };
    const result = selectRunnableTask(phase, {});
    assert.equal(result.task, undefined);
  });

  it('handles mixed blocked and pending with unmet deps', async () => {
    const { selectRunnableTask } = await import('../src/tools/state.js');
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'blocked', requires: [], retry_count: 0, blocked_reason: 'needs API key' },
        { id: '1.2', lifecycle: 'pending', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }], retry_count: 0 },
      ],
    };
    const result = selectRunnableTask(phase, {});
    assert.equal(result.mode, 'awaiting_user');
    assert.ok(result.blockers.length > 0);
  });

  it('selects needs_revalidation tasks', async () => {
    const { selectRunnableTask } = await import('../src/tools/state.js');
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'accepted', requires: [], retry_count: 0 },
        { id: '1.2', lifecycle: 'needs_revalidation', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }], retry_count: 0 },
      ],
    };
    const result = selectRunnableTask(phase, {});
    assert.equal(result.task.id, '1.2');
  });

  it('skips tasks with missing dependency reference', async () => {
    const { selectRunnableTask } = await import('../src/tools/state.js');
    const phase = {
      todo: [
        { id: '1.2', lifecycle: 'pending', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }], retry_count: 0 },
      ],
    };
    const result = selectRunnableTask(phase, {});
    assert.equal(result.task, undefined);
  });

  it('throws a clear error when phase.todo is missing', async () => {
    const { selectRunnableTask } = await import('../src/tools/state.js');
    assert.throws(
      () => selectRunnableTask({}, {}),
      /Phase todo must be an array/
    );
  });

  it('returns diagnostics when no task is runnable due to unmet deps', async () => {
    const { selectRunnableTask } = await import('../src/tools/state.js');
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'accepted', requires: [], retry_count: 0 },
        { id: '1.2', lifecycle: 'pending', requires: [{ kind: 'task', id: '1.3', gate: 'accepted' }], retry_count: 0 },
        { id: '1.3', lifecycle: 'running', requires: [], retry_count: 0 },
      ],
    };
    const result = selectRunnableTask(phase, {});
    assert.equal(result.task, undefined);
    assert.ok(Array.isArray(result.diagnostics));
    const diag12 = result.diagnostics.find(d => d.id === '1.2');
    assert.ok(diag12, 'diagnostics should include task 1.2');
    assert.ok(diag12.reasons.some(r => r.includes('dep 1.3 needs accepted')));
    const diag13 = result.diagnostics.find(d => d.id === '1.3');
    assert.ok(diag13, 'diagnostics should include task 1.3');
    assert.ok(diag13.reasons.some(r => r.includes('lifecycle=running')));
  });

  it('returns diagnostics for retry-exhausted tasks', async () => {
    const { selectRunnableTask } = await import('../src/tools/state.js');
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'pending', requires: [], retry_count: 5 },
      ],
    };
    const result = selectRunnableTask(phase, {});
    assert.equal(result.task, undefined);
    assert.ok(Array.isArray(result.diagnostics));
    assert.ok(result.diagnostics[0].reasons.some(r => r.includes('retry_count=5')));
  });

  it('returns empty diagnostics when all tasks are terminal', async () => {
    const { selectRunnableTask } = await import('../src/tools/state.js');
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'accepted', requires: [], retry_count: 0 },
        { id: '1.2', lifecycle: 'failed', requires: [], retry_count: 0 },
      ],
    };
    const result = selectRunnableTask(phase, {});
    assert.equal(result.task, undefined);
    assert.ok(Array.isArray(result.diagnostics));
    assert.equal(result.diagnostics.length, 0);
  });
});
