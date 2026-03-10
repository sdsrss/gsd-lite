import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTempDir,
  removeTempDir,
  initProject,
  checkpointTask,
  acceptTask,
  read,
  update,
  addEvidence,
} from './e2e-helpers.js';

describe('E2E stop/resume: state save completeness and roundtrip data integrity', () => {

  describe('TC1: Executing → paused: workflow_mode changes, position preserved', () => {
    let basePath;

    before(async () => {
      basePath = await createTempDir();
      await initProject(basePath);
      // Accept task 1.1, walk 1.2 to running
      await acceptTask(basePath, 1, '1.1');
      await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.2', lifecycle: 'running' }] }] }, basePath });
    });

    after(async () => { await removeTempDir(basePath); });

    it('pausing preserves workflow_mode, current_phase, and all task lifecycles', async () => {
      // Update: workflow_mode='paused_by_user'
      const result = await update({ updates: { workflow_mode: 'paused_by_user' }, basePath });
      assert.equal(result.success, true);

      // Read back
      const state = await read({ basePath });
      assert.equal(state.workflow_mode, 'paused_by_user');
      assert.equal(state.current_phase, 1);
      assert.equal(state.phases.length, 2);

      // Task 1.1 should be accepted
      const task11 = state.phases[0].todo.find(t => t.id === '1.1');
      assert.equal(task11.lifecycle, 'accepted');

      // Task 1.2 should still be running
      const task12 = state.phases[0].todo.find(t => t.id === '1.2');
      assert.equal(task12.lifecycle, 'running');

      // Phase 2 task should still be pending
      const task21 = state.phases[1].todo.find(t => t.id === '2.1');
      assert.equal(task21.lifecycle, 'pending');
    });
  });

  describe('TC2: Task lifecycles preserved across pause', () => {
    let basePath;

    before(async () => {
      basePath = await createTempDir();
      // Init 1-phase project with 4 tasks: A(L0), B(L1), C(L1), D(L1)
      await initProject(basePath, {
        phases: [
          { name: 'Phase 1', tasks: [
            { index: 1, name: 'Task A', level: 'L0', requires: [] },
            { index: 2, name: 'Task B', level: 'L1', requires: [] },
            { index: 3, name: 'Task C', level: 'L1', requires: [] },
            { index: 4, name: 'Task D', level: 'L1', requires: [] },
          ]},
        ],
      });

      // Walk: A=accepted
      await acceptTask(basePath, 1, '1.1');
      // Walk: B=running
      await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.2', lifecycle: 'running' }] }] }, basePath });
      // C stays pending
      // Walk D: pending→running first, then running→blocked (running→blocked is valid)
      await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.4', lifecycle: 'running' }] }] }, basePath });
      await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.4', lifecycle: 'blocked', blocked_reason: 'Waiting for API key' }] }] }, basePath });
    });

    after(async () => { await removeTempDir(basePath); });

    it('each task lifecycle is exactly as set after pause', async () => {
      // Pause
      await update({ updates: { workflow_mode: 'paused_by_user' }, basePath });

      const state = await read({ basePath });
      assert.equal(state.workflow_mode, 'paused_by_user');

      const tasks = state.phases[0].todo;
      assert.equal(tasks.find(t => t.id === '1.1').lifecycle, 'accepted');
      assert.equal(tasks.find(t => t.id === '1.2').lifecycle, 'running');
      assert.equal(tasks.find(t => t.id === '1.3').lifecycle, 'pending');
      assert.equal(tasks.find(t => t.id === '1.4').lifecycle, 'blocked');
    });
  });

  describe('TC3: Decisions array preserved across pause', () => {
    let basePath;
    const decisions = [
      { id: 'd1', summary: 'Use PostgreSQL', phase: 1 },
      { id: 'd2', summary: 'REST API', phase: 1 },
    ];

    before(async () => {
      basePath = await createTempDir();
      await initProject(basePath);
      // Add 2 decisions via update
      await update({ updates: { decisions }, basePath });
    });

    after(async () => { await removeTempDir(basePath); });

    it('decisions length=2 and content matches after pause', async () => {
      // Pause
      await update({ updates: { workflow_mode: 'paused_by_user' }, basePath });

      const state = await read({ basePath });
      assert.equal(state.workflow_mode, 'paused_by_user');
      assert.equal(state.decisions.length, 2);
      assert.deepEqual(state.decisions, decisions);
    });
  });

  describe('TC4: Evidence preserved across pause', () => {
    let basePath;

    before(async () => {
      basePath = await createTempDir();
      await initProject(basePath);
      // Add 3 evidence entries via addEvidence()
      await addEvidence({ id: 'ev:1.1', data: { scope: 'task:1.1', type: 'test', data: { passed: true } }, basePath });
      await addEvidence({ id: 'ev:1.2', data: { scope: 'task:1.2', type: 'lint', data: { exit_code: 0 } }, basePath });
      await addEvidence({ id: 'ev:review', data: { scope: 'task:1.1', type: 'review', data: { approved: true } }, basePath });
    });

    after(async () => { await removeTempDir(basePath); });

    it('all 3 evidence entries present with correct data after pause', async () => {
      // Pause
      await update({ updates: { workflow_mode: 'paused_by_user' }, basePath });

      const state = await read({ basePath });
      assert.equal(state.workflow_mode, 'paused_by_user');
      assert.equal(Object.keys(state.evidence).length, 3);
      assert.ok(state.evidence['ev:1.1']);
      assert.ok(state.evidence['ev:1.2']);
      assert.ok(state.evidence['ev:review']);
      assert.equal(state.evidence['ev:1.1'].scope, 'task:1.1');
      assert.equal(state.evidence['ev:1.1'].type, 'test');
      assert.deepEqual(state.evidence['ev:1.2'].data, { exit_code: 0 });
      assert.deepEqual(state.evidence['ev:review'].data, { approved: true });
    });
  });

  describe('TC5: Research data preserved across pause', () => {
    let basePath;
    const researchData = {
      decision_index: {
        d1: { summary: 'Use React', volatility: 'medium', expires_at: '2026-06-01T00:00:00Z' },
      },
      volatility: 'medium',
      expires_at: '2026-06-01T00:00:00Z',
      sources: [{ id: 's1', type: 'docs', ref: 'React docs' }],
      files: ['STACK.md', 'ARCHITECTURE.md', 'PITFALLS.md', 'SUMMARY.md'],
      updated_at: '2026-03-01T00:00:00Z',
    };

    before(async () => {
      basePath = await createTempDir();
      await initProject(basePath, { research: true });
      // After init, update research field
      await update({ updates: { research: researchData }, basePath });
    });

    after(async () => { await removeTempDir(basePath); });

    it('research.decision_index matches after pause', async () => {
      // Pause
      await update({ updates: { workflow_mode: 'paused_by_user' }, basePath });

      const state = await read({ basePath });
      assert.equal(state.workflow_mode, 'paused_by_user');
      assert.ok(state.research);
      assert.ok(state.research.decision_index);
      assert.deepEqual(state.research.decision_index.d1, researchData.decision_index.d1);
      assert.equal(state.research.volatility, 'medium');
      assert.equal(state.research.expires_at, '2026-06-01T00:00:00Z');
      assert.deepEqual(state.research.sources, researchData.sources);
      assert.deepEqual(state.research.files, researchData.files);
    });
  });

  describe('TC6: Blocked task with reason preserved', () => {
    let basePath;

    before(async () => {
      basePath = await createTempDir();
      await initProject(basePath);
      // Walk 1.1 to running first
      await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath });
      // Then update to blocked with reason (running→blocked is valid)
      await update({
        updates: {
          phases: [{
            id: 1,
            todo: [{
              id: '1.1',
              lifecycle: 'blocked',
              blocked_reason: 'Need API key',
              unblock_condition: 'User provides key',
            }],
          }],
        },
        basePath,
      });
    });

    after(async () => { await removeTempDir(basePath); });

    it('blocked_reason and unblock_condition preserved after pause', async () => {
      // Pause
      await update({ updates: { workflow_mode: 'paused_by_user' }, basePath });

      const state = await read({ basePath });
      assert.equal(state.workflow_mode, 'paused_by_user');

      const task = state.phases[0].todo.find(t => t.id === '1.1');
      assert.equal(task.lifecycle, 'blocked');
      assert.equal(task.blocked_reason, 'Need API key');
      assert.equal(task.unblock_condition, 'User provides key');
    });
  });

  describe('TC7: Multiple stop/resume cycles — cumulative data integrity', () => {
    let basePath;

    before(async () => {
      basePath = await createTempDir();
      await initProject(basePath);
    });

    after(async () => { await removeTempDir(basePath); });

    it('cumulative data preserved across two stop/resume cycles', async () => {
      // --- Cycle 1: accept task 1.1, add decision d1, add evidence ev1, pause ---
      await acceptTask(basePath, 1, '1.1');
      await update({ updates: { decisions: [{ id: 'd1', summary: 'Use PostgreSQL', phase: 1 }] }, basePath });
      await addEvidence({ id: 'ev1', data: { scope: 'task:1.1', type: 'test', data: { cycle: 1 } }, basePath });

      // Pause
      let result = await update({ updates: { workflow_mode: 'paused_by_user' }, basePath });
      assert.equal(result.success, true);

      // Read back and verify cycle 1 data
      let state = await read({ basePath });
      assert.equal(state.workflow_mode, 'paused_by_user');
      assert.equal(state.phases[0].todo.find(t => t.id === '1.1').lifecycle, 'accepted');
      assert.equal(state.decisions.length, 1);
      assert.equal(state.decisions[0].id, 'd1');
      assert.ok(state.evidence['ev1']);

      // --- Cycle 2: resume, checkpoint 1.2, add decision d2, pause ---
      // Resume (simulating resume by updating workflow_mode back to executing_task)
      result = await update({ updates: { workflow_mode: 'executing_task' }, basePath });
      assert.equal(result.success, true);

      // Checkpoint task 1.2
      await checkpointTask(basePath, 1, '1.2', 'commit-1.2');

      // Add decision d2
      await update({
        updates: {
          decisions: [
            { id: 'd1', summary: 'Use PostgreSQL', phase: 1 },
            { id: 'd2', summary: 'REST API', phase: 1 },
          ],
        },
        basePath,
      });

      // Add another evidence entry
      await addEvidence({ id: 'ev2', data: { scope: 'task:1.2', type: 'lint', data: { cycle: 2 } }, basePath });

      // Pause again
      result = await update({ updates: { workflow_mode: 'paused_by_user' }, basePath });
      assert.equal(result.success, true);

      // --- Verify cumulative data ---
      state = await read({ basePath });
      assert.equal(state.workflow_mode, 'paused_by_user');

      // Both decisions present
      assert.equal(state.decisions.length, 2);
      assert.equal(state.decisions[0].id, 'd1');
      assert.equal(state.decisions[1].id, 'd2');

      // Both evidences present
      assert.ok(state.evidence['ev1'], 'evidence from cycle 1 preserved');
      assert.ok(state.evidence['ev2'], 'evidence from cycle 2 preserved');
      assert.deepEqual(state.evidence['ev1'].data, { cycle: 1 });
      assert.deepEqual(state.evidence['ev2'].data, { cycle: 2 });

      // Task states correct
      const task11 = state.phases[0].todo.find(t => t.id === '1.1');
      assert.equal(task11.lifecycle, 'accepted');
      const task12 = state.phases[0].todo.find(t => t.id === '1.2');
      assert.equal(task12.lifecycle, 'checkpointed');
      assert.equal(task12.checkpoint_commit, 'commit-1.2');
    });
  });

  describe('TC8: Reviewing → paused: current_review preserved', () => {
    let basePath;

    before(async () => {
      basePath = await createTempDir();
      await initProject(basePath);
      // Checkpoint L1 task
      await checkpointTask(basePath, 1, '1.1', 'chk-abc');
      // Set workflow_mode to reviewing_phase with current_review
      await update({
        updates: {
          workflow_mode: 'reviewing_phase',
          current_review: { scope: 'phase', scope_id: 1, stage: 'spec' },
        },
        basePath,
      });
    });

    after(async () => { await removeTempDir(basePath); });

    it('current_review is fully preserved after pause', async () => {
      // Verify the reviewing state is set
      let state = await read({ basePath });
      assert.equal(state.workflow_mode, 'reviewing_phase');
      assert.deepEqual(state.current_review, { scope: 'phase', scope_id: 1, stage: 'spec' });

      // Pause (update workflow_mode to paused_by_user, keep current_review)
      const result = await update({ updates: { workflow_mode: 'paused_by_user' }, basePath });
      assert.equal(result.success, true);

      // Read back and verify current_review preserved
      state = await read({ basePath });
      assert.equal(state.workflow_mode, 'paused_by_user');
      assert.ok(state.current_review, 'current_review should not be null');
      assert.equal(state.current_review.scope, 'phase');
      assert.equal(state.current_review.scope_id, 1);
      assert.equal(state.current_review.stage, 'spec');
      assert.deepEqual(state.current_review, { scope: 'phase', scope_id: 1, stage: 'spec' });
    });
  });

});
