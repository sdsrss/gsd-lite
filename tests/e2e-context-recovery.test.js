import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTempDir,
  removeTempDir,
  initProject,
  checkpointTask,
  acceptTask,
  writeContextHealth,
  read,
  update,
  addEvidence,
} from './e2e-helpers.js';
import { resumeWorkflow } from '../src/tools/orchestrator.js';

/**
 * Helper: read state and build a context update that preserves last_session
 * from init (which was carefully set to be >= all plan file mtimes).
 * Using new Date().toISOString() can race with sub-ms file mtime precision.
 */
async function awaitingClearContext(basePath, remainingPercentage) {
  const state = await read({ basePath });
  return {
    remaining_percentage: remainingPercentage,
    last_session: state.context.last_session,
  };
}

describe('E2E context recovery: awaiting_clear state save, resume after clear, and multi-cycle integrity', () => {

  describe('TC1: awaiting_clear state save — all canonical fields preserved', () => {
    let basePath;

    before(async () => {
      basePath = await createTempDir();
      await initProject(basePath);
      // Accept task 1.1
      await acceptTask(basePath, 1, '1.1');
      // Walk task 1.2 to running
      await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.2', lifecycle: 'running' }] }] }, basePath });
      // Add decisions
      await update({ updates: { decisions: [{ id: 'd1', summary: 'Use PostgreSQL', phase: 1 }] }, basePath });
      // Add evidence
      await addEvidence({ id: 'ev:1.1', data: { scope: 'task:1.1', type: 'test', data: { passed: true } }, basePath });
      // Save context state as awaiting_clear
      await update({ updates: { workflow_mode: 'awaiting_clear', context: await awaitingClearContext(basePath, 35) }, basePath });
    });

    after(async () => { await removeTempDir(basePath); });

    it('all canonical fields present and correct after awaiting_clear save', async () => {
      const state = await read({ basePath });

      // Top-level canonical fields
      assert.equal(state.project, 'e2e-test');
      assert.equal(state.workflow_mode, 'awaiting_clear');
      assert.equal(typeof state.plan_version, 'number');
      assert.equal(state.current_phase, 1);
      assert.equal(state.total_phases, 2);
      assert.ok(Array.isArray(state.phases));
      assert.ok(Array.isArray(state.decisions));
      assert.ok(typeof state.evidence === 'object');
      assert.ok(typeof state.context === 'object');

      // Task lifecycles
      const phase1 = state.phases[0];
      const task11 = phase1.todo.find(t => t.id === '1.1');
      const task12 = phase1.todo.find(t => t.id === '1.2');
      assert.equal(task11.lifecycle, 'accepted');
      assert.equal(task12.lifecycle, 'running');

      // Decisions
      assert.equal(state.decisions.length, 1);
      assert.equal(state.decisions[0].id, 'd1');
      assert.equal(state.decisions[0].summary, 'Use PostgreSQL');

      // Evidence
      assert.ok(state.evidence['ev:1.1']);
      assert.equal(state.evidence['ev:1.1'].scope, 'task:1.1');
      assert.equal(state.evidence['ev:1.1'].type, 'test');

      // Context
      assert.equal(state.context.remaining_percentage, 35);
      assert.ok(typeof state.context.last_session === 'string');
    });
  });

  describe('TC2: Resume from awaiting_clear — workflow_mode restored to executing_task', () => {
    let basePath;

    before(async () => {
      basePath = await createTempDir();
      await initProject(basePath);
      // Accept task 1.1
      await acceptTask(basePath, 1, '1.1');
      // Walk task 1.2 to running
      await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.2', lifecycle: 'running' }] }] }, basePath });
      // Add decisions and evidence
      await update({ updates: { decisions: [{ id: 'd1', summary: 'Use PostgreSQL', phase: 1 }] }, basePath });
      await addEvidence({ id: 'ev:1.1', data: { scope: 'task:1.1', type: 'test', data: { passed: true } }, basePath });
      // Save as awaiting_clear
      await update({ updates: { workflow_mode: 'awaiting_clear', context: await awaitingClearContext(basePath, 35) }, basePath });
      // Write good context health
      await writeContextHealth(basePath, 70);
    });

    after(async () => { await removeTempDir(basePath); });

    it('resumeWorkflow transitions from awaiting_clear to executing_task', async () => {
      const result = await resumeWorkflow({ basePath });

      assert.equal(result.success, true);
      // After resume from awaiting_clear with health >= 40, it transitions to executing_task
      // and then dispatches the next action (executor for running task 1.2)
      assert.equal(result.workflow_mode, 'executing_task');

      // Verify state was persisted
      const state = await read({ basePath });
      assert.equal(state.workflow_mode, 'executing_task');
    });
  });

  describe('TC3: Resume from awaiting_clear with low health — stays awaiting_clear', () => {
    let basePath;

    before(async () => {
      basePath = await createTempDir();
      await initProject(basePath);
      // Save as awaiting_clear (preserve last_session from init to avoid plan drift detection)
      await update({ updates: { workflow_mode: 'awaiting_clear', context: await awaitingClearContext(basePath, 30) }, basePath });
      // Write low context health
      await writeContextHealth(basePath, 30);
    });

    after(async () => { await removeTempDir(basePath); });

    it('resumeWorkflow stays awaiting_clear when health below threshold', async () => {
      const result = await resumeWorkflow({ basePath });

      assert.equal(result.success, true);
      assert.equal(result.workflow_mode, 'awaiting_clear');
      assert.equal(result.action, 'await_manual_intervention');
      assert.equal(result.remaining_percentage, 30);

      // State should still be awaiting_clear
      const state = await read({ basePath });
      assert.equal(state.workflow_mode, 'awaiting_clear');
    });
  });

  describe('TC4: Multiple clear/resume cycles — cumulative data integrity', () => {
    let basePath;

    before(async () => {
      basePath = await createTempDir();
    });

    after(async () => { await removeTempDir(basePath); });

    it('data accumulates correctly across two clear/resume cycles', async () => {
      // --- Cycle 1: init, progress, save ---
      await initProject(basePath);
      await acceptTask(basePath, 1, '1.1');
      await update({ updates: { decisions: [{ id: 'd1', summary: 'Use PostgreSQL', phase: 1 }] }, basePath });
      await addEvidence({ id: 'ev:c1', data: { scope: 'task:1.1', type: 'test', data: { cycle: 1 } }, basePath });

      // Save as awaiting_clear
      await update({ updates: { workflow_mode: 'awaiting_clear', context: await awaitingClearContext(basePath, 35) }, basePath });

      // Verify cycle 1 state
      let state = await read({ basePath });
      assert.equal(state.workflow_mode, 'awaiting_clear');
      assert.equal(state.decisions.length, 1);
      assert.ok(state.evidence['ev:c1']);
      assert.equal(state.phases[0].todo.find(t => t.id === '1.1').lifecycle, 'accepted');

      // --- Cycle 2: resume, progress more, save again ---
      await writeContextHealth(basePath, 80);
      const resumeResult = await resumeWorkflow({ basePath });
      assert.equal(resumeResult.success, true);
      assert.equal(resumeResult.workflow_mode, 'executing_task');

      // Checkpoint task 1.2 (it should have been set to running by resumeWorkflow dispatching it)
      state = await read({ basePath });
      const task12 = state.phases[0].todo.find(t => t.id === '1.2');
      // resumeWorkflow may have set 1.2 to running, or it may still be pending
      // We need to walk it through the lifecycle
      if (task12.lifecycle === 'pending') {
        await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.2', lifecycle: 'running' }] }] }, basePath });
      }
      await checkpointTask(basePath, 1, '1.2');

      // Add more decisions and evidence in cycle 2
      state = await read({ basePath });
      const existingDecisions = state.decisions;
      await update({ updates: { decisions: [...existingDecisions, { id: 'd2', summary: 'Use Redis for caching', phase: 1 }] }, basePath });
      await addEvidence({ id: 'ev:c2', data: { scope: 'task:1.2', type: 'test', data: { cycle: 2 } }, basePath });

      // Save as awaiting_clear again
      await update({ updates: { workflow_mode: 'awaiting_clear', context: await awaitingClearContext(basePath, 25) }, basePath });

      // --- Final verification ---
      state = await read({ basePath });
      assert.equal(state.workflow_mode, 'awaiting_clear');

      // Both decisions present
      assert.equal(state.decisions.length, 2);
      assert.equal(state.decisions[0].id, 'd1');
      assert.equal(state.decisions[1].id, 'd2');

      // Both evidence entries present
      assert.ok(state.evidence['ev:c1'], 'evidence from cycle 1 preserved');
      assert.ok(state.evidence['ev:c2'], 'evidence from cycle 2 preserved');

      // Task states correct
      assert.equal(state.phases[0].todo.find(t => t.id === '1.1').lifecycle, 'accepted');
      assert.equal(state.phases[0].todo.find(t => t.id === '1.2').lifecycle, 'checkpointed');
    });
  });

  describe('TC5: Context save during review — current_review preserved', () => {
    let basePath;

    before(async () => {
      basePath = await createTempDir();
      await initProject(basePath);
      // Checkpoint task 1.1
      await checkpointTask(basePath, 1, '1.1');
      // Set review state
      await update({
        updates: {
          workflow_mode: 'reviewing_phase',
          current_review: { scope: 'phase', scope_id: 1, stage: 'spec' },
        },
        basePath,
      });
    });

    after(async () => { await removeTempDir(basePath); });

    it('current_review preserved when saving as awaiting_clear', async () => {
      // Save as awaiting_clear (only workflow_mode changes, current_review stays)
      const result = await update({ updates: { workflow_mode: 'awaiting_clear' }, basePath });
      assert.equal(result.success, true);

      // Read and verify current_review is intact
      const state = await read({ basePath });
      assert.equal(state.workflow_mode, 'awaiting_clear');
      assert.ok(state.current_review, 'current_review should not be null');
      assert.equal(state.current_review.scope, 'phase');
      assert.equal(state.current_review.scope_id, 1);
      assert.equal(state.current_review.stage, 'spec');
      assert.deepEqual(state.current_review, { scope: 'phase', scope_id: 1, stage: 'spec' });
    });
  });

  describe('TC6: Decisions and evidence accumulate across cycles', () => {
    let basePath;

    before(async () => {
      basePath = await createTempDir();
    });

    after(async () => { await removeTempDir(basePath); });

    it('4 decisions and 3 evidence entries after 3 cycles', async () => {
      await initProject(basePath);

      // --- Cycle 1: add 2 decisions, 1 evidence ---
      await update({ updates: { decisions: [
        { id: 'd1', summary: 'Use PostgreSQL', phase: 1 },
        { id: 'd2', summary: 'REST API design', phase: 1 },
      ] }, basePath });
      await addEvidence({ id: 'ev:1', data: { scope: 'task:1.1', type: 'test', data: { passed: true } }, basePath });
      await update({ updates: { workflow_mode: 'awaiting_clear', context: await awaitingClearContext(basePath, 30) }, basePath });

      // Resume cycle 1
      await writeContextHealth(basePath, 80);
      await resumeWorkflow({ basePath });

      // --- Cycle 2: add 1 decision, 2 evidence entries ---
      let state = await read({ basePath });
      const decisionsAfterC1 = state.decisions;
      await update({ updates: { decisions: [...decisionsAfterC1, { id: 'd3', summary: 'Use JWT auth', phase: 1 }] }, basePath });
      await addEvidence({ id: 'ev:2', data: { scope: 'task:1.1', type: 'lint', data: { exit_code: 0 } }, basePath });
      await addEvidence({ id: 'ev:3', data: { scope: 'task:1.2', type: 'test', data: { passed: true } }, basePath });
      await update({ updates: { workflow_mode: 'awaiting_clear', context: await awaitingClearContext(basePath, 25) }, basePath });

      // Resume cycle 2
      await writeContextHealth(basePath, 75);
      await resumeWorkflow({ basePath });

      // --- Cycle 3: add 1 decision ---
      state = await read({ basePath });
      const decisionsAfterC2 = state.decisions;
      await update({ updates: { decisions: [...decisionsAfterC2, { id: 'd4', summary: 'Use Docker for deployment', phase: 1 }] }, basePath });
      await update({ updates: { workflow_mode: 'awaiting_clear', context: await awaitingClearContext(basePath, 20) }, basePath });

      // --- Final verification ---
      state = await read({ basePath });
      assert.equal(state.decisions.length, 4, 'should have 4 decisions total');
      assert.equal(state.decisions[0].id, 'd1');
      assert.equal(state.decisions[1].id, 'd2');
      assert.equal(state.decisions[2].id, 'd3');
      assert.equal(state.decisions[3].id, 'd4');

      assert.equal(Object.keys(state.evidence).length, 3, 'should have 3 evidence entries total');
      assert.ok(state.evidence['ev:1']);
      assert.ok(state.evidence['ev:2']);
      assert.ok(state.evidence['ev:3']);
    });
  });

  describe('TC7: Task lifecycle states preserved exactly', () => {
    let basePath;

    before(async () => {
      basePath = await createTempDir();
      // Init with 1-phase project with 4 tasks
      await initProject(basePath, {
        phases: [{
          name: 'P1',
          tasks: [
            { index: 1, name: 'A', level: 'L0', requires: [] },
            { index: 2, name: 'B', level: 'L1', requires: [] },
            { index: 3, name: 'C', level: 'L1', requires: [] },
            { index: 4, name: 'D', level: 'L1', requires: [] },
          ],
        }],
      });

      // Walk: accept A, walk B to running, checkpoint C, leave D pending
      await acceptTask(basePath, 1, '1.1');
      await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.2', lifecycle: 'running' }] }] }, basePath });
      await checkpointTask(basePath, 1, '1.3');
      // D stays pending

      // Save as awaiting_clear
      await update({ updates: { workflow_mode: 'awaiting_clear', context: await awaitingClearContext(basePath, 30) }, basePath });
    });

    after(async () => { await removeTempDir(basePath); });

    it('each task lifecycle state is exactly as set after awaiting_clear save', async () => {
      const state = await read({ basePath });
      assert.equal(state.workflow_mode, 'awaiting_clear');

      const tasks = state.phases[0].todo;
      assert.equal(tasks.find(t => t.id === '1.1').lifecycle, 'accepted', 'A should be accepted');
      assert.equal(tasks.find(t => t.id === '1.2').lifecycle, 'running', 'B should be running');
      assert.equal(tasks.find(t => t.id === '1.3').lifecycle, 'checkpointed', 'C should be checkpointed');
      assert.equal(tasks.find(t => t.id === '1.4').lifecycle, 'pending', 'D should be pending');
    });

    it('task lifecycle states correct after resume', async () => {
      // Set current_task to B (1.2) so resumeWorkflow re-dispatches it
      // rather than picking a new runnable task
      await update({ updates: { current_task: '1.2' }, basePath });

      await writeContextHealth(basePath, 75);
      const result = await resumeWorkflow({ basePath });
      assert.equal(result.success, true);

      const state = await read({ basePath });
      assert.equal(state.workflow_mode, 'executing_task');

      const tasks = state.phases[0].todo;
      // A stays accepted
      assert.equal(tasks.find(t => t.id === '1.1').lifecycle, 'accepted', 'A should still be accepted');
      // B was running with current_task set — resumeWorkflow re-dispatches it, keeping it running
      assert.equal(tasks.find(t => t.id === '1.2').lifecycle, 'running', 'B should still be running');
      // C stays checkpointed
      assert.equal(tasks.find(t => t.id === '1.3').lifecycle, 'checkpointed', 'C should still be checkpointed');
      // D stays pending (B is re-dispatched, not D)
      assert.equal(tasks.find(t => t.id === '1.4').lifecycle, 'pending', 'D should still be pending');
    });
  });

});
