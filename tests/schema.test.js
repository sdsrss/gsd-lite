import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('schema', () => {
  describe('TASK_LIFECYCLE transitions', () => {
    it('allows pending → running', async () => {
      const { validateTransition } = await import('../src/schema.js');
      assert.equal(validateTransition('task', 'pending', 'running').valid, true);
    });

    it('allows running → checkpointed', async () => {
      const { validateTransition } = await import('../src/schema.js');
      assert.equal(validateTransition('task', 'running', 'checkpointed').valid, true);
    });

    it('allows checkpointed → accepted', async () => {
      const { validateTransition } = await import('../src/schema.js');
      assert.equal(validateTransition('task', 'checkpointed', 'accepted').valid, true);
    });

    it('allows pending → blocked', async () => {
      const { validateTransition } = await import('../src/schema.js');
      assert.equal(validateTransition('task', 'pending', 'blocked').valid, true);
    });

    it('allows running → blocked', async () => {
      const { validateTransition } = await import('../src/schema.js');
      assert.equal(validateTransition('task', 'running', 'blocked').valid, true);
    });

    it('allows running → failed', async () => {
      const { validateTransition } = await import('../src/schema.js');
      assert.equal(validateTransition('task', 'running', 'failed').valid, true);
    });

    it('allows accepted → needs_revalidation', async () => {
      const { validateTransition } = await import('../src/schema.js');
      assert.equal(validateTransition('task', 'accepted', 'needs_revalidation').valid, true);
    });

    it('allows needs_revalidation → pending', async () => {
      const { validateTransition } = await import('../src/schema.js');
      assert.equal(validateTransition('task', 'needs_revalidation', 'pending').valid, true);
    });

    it('rejects pending → accepted (skip running)', async () => {
      const { validateTransition } = await import('../src/schema.js');
      assert.equal(validateTransition('task', 'pending', 'accepted').valid, false);
    });

    it('rejects accepted → running (no direct)', async () => {
      const { validateTransition } = await import('../src/schema.js');
      assert.equal(validateTransition('task', 'accepted', 'running').valid, false);
    });
  });

  describe('PHASE_LIFECYCLE transitions', () => {
    it('allows pending → active', async () => {
      const { validateTransition } = await import('../src/schema.js');
      assert.equal(validateTransition('phase', 'pending', 'active').valid, true);
    });

    it('allows active → reviewing', async () => {
      const { validateTransition } = await import('../src/schema.js');
      assert.equal(validateTransition('phase', 'active', 'reviewing').valid, true);
    });

    it('allows reviewing → accepted', async () => {
      const { validateTransition } = await import('../src/schema.js');
      assert.equal(validateTransition('phase', 'reviewing', 'accepted').valid, true);
    });

    it('allows active → blocked', async () => {
      const { validateTransition } = await import('../src/schema.js');
      assert.equal(validateTransition('phase', 'active', 'blocked').valid, true);
    });

    it('allows active → failed', async () => {
      const { validateTransition } = await import('../src/schema.js');
      assert.equal(validateTransition('phase', 'active', 'failed').valid, true);
    });

    it('rejects pending → reviewing', async () => {
      const { validateTransition } = await import('../src/schema.js');
      assert.equal(validateTransition('phase', 'pending', 'reviewing').valid, false);
    });
  });

  describe('CANONICAL_FIELDS', () => {
    it('includes workflow_mode', async () => {
      const { CANONICAL_FIELDS } = await import('../src/schema.js');
      assert.ok(CANONICAL_FIELDS.includes('workflow_mode'));
    });

    it('does not include derived fields', async () => {
      const { CANONICAL_FIELDS } = await import('../src/schema.js');
      assert.ok(!CANONICAL_FIELDS.includes('stopped_at'));
      assert.ok(!CANONICAL_FIELDS.includes('next_action'));
    });
  });

  describe('WORKFLOW_MODES', () => {
    it('contains all 12 modes', async () => {
      const { WORKFLOW_MODES } = await import('../src/schema.js');
      assert.equal(WORKFLOW_MODES.length, 12);
      assert.ok(WORKFLOW_MODES.includes('planning'));
      assert.ok(WORKFLOW_MODES.includes('executing_task'));
      assert.ok(WORKFLOW_MODES.includes('completed'));
      assert.ok(WORKFLOW_MODES.includes('failed'));
    });
  });

  describe('validateState', () => {
    it('accepts valid minimal state', async () => {
      const { validateState, createInitialState } = await import('../src/schema.js');
      const state = createInitialState({ project: 'test', phases: [] });
      const result = validateState(state);
      assert.equal(result.valid, true);
    });

    it('rejects state with invalid workflow_mode', async () => {
      const { validateState, createInitialState } = await import('../src/schema.js');
      const state = createInitialState({ project: 'test', phases: [] });
      state.workflow_mode = 'invalid_mode';
      const result = validateState(state);
      assert.equal(result.valid, false);
    });
  });

  describe('createInitialState', () => {
    it('creates state with correct structure', async () => {
      const { createInitialState } = await import('../src/schema.js');
      const state = createInitialState({
        project: 'my-app',
        phases: [
          { name: 'setup', tasks: [{ index: 1, name: 'init repo' }, { index: 2, name: 'add deps' }] },
          { name: 'features', tasks: [{ index: 1, name: 'user api', level: 'L2' }] },
        ],
      });
      assert.equal(state.project, 'my-app');
      assert.equal(state.workflow_mode, 'planning');
      assert.equal(state.plan_version, 1);
      assert.equal(state.total_phases, 2);
      assert.equal(state.phases.length, 2);
      assert.equal(state.phases[0].tasks, 2);
      assert.equal(state.phases[0].todo.length, 2);
      assert.equal(state.phases[0].todo[0].id, '1.1');
      assert.equal(state.phases[0].todo[0].lifecycle, 'pending');
      assert.equal(state.phases[1].todo[0].level, 'L2');
    });
  });
});
