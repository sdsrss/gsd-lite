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
} from './e2e-helpers.js';
import {
  handleExecutorResult,
  handleReviewerResult,
  resumeWorkflow,
} from '../src/tools/orchestrator/index.js';
import {
  selectRunnableTask,
} from '../src/tools/state/index.js';

// ── Test Case 1: executing_task → reviewing_task (L2 checkpoint) ──

describe('TC1: executing_task → reviewing_task (L2 checkpoint)', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('L2 task checkpoint triggers immediate review', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [
          { index: 1, name: 'Auth module', level: 'L2', requires: [] },
        ],
      }],
    });

    // Walk task to running
    await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: dir });

    const res = await handleExecutorResult({
      result: {
        task_id: '1.1',
        outcome: 'checkpointed',
        checkpoint_commit: 'abc123',
        summary: 'Auth module done',
        files_changed: ['src/auth.js'],
        decisions: [],
        blockers: [],
        contract_changed: false,
        evidence: [],
      },
      basePath: dir,
    });

    assert.equal(res.success, true);
    assert.equal(res.workflow_mode, 'reviewing_task');
    assert.equal(res.action, 'dispatch_reviewer');
    assert.equal(res.review_level, 'L2');
    assert.deepEqual(res.current_review, { scope: 'task', scope_id: '1.1', stage: 'spec' });

    // Verify persisted state
    const state = await read({ basePath: dir });
    assert.equal(state.workflow_mode, 'reviewing_task');
    const task = state.phases[0].todo.find(t => t.id === '1.1');
    assert.equal(task.lifecycle, 'checkpointed');
    assert.equal(task.checkpoint_commit, 'abc123');
  });
});

// ── Test Case 2: executing_task → trigger_review (all L1 checkpointed) ──

describe('TC2: executing_task → trigger_review (all L1 checkpointed)', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('all L1 tasks checkpointed triggers batch review via selectRunnableTask', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [
          { index: 1, name: 'Init', level: 'L0', requires: [] },
          { index: 2, name: 'Core logic', level: 'L1', requires: [] },
          { index: 3, name: 'Tests', level: 'L1', requires: [{ kind: 'task', id: '1.2', gate: 'checkpoint' }] },
        ],
      }],
    });

    // Accept L0 task
    await acceptTask(dir, 1, '1.1');

    // Checkpoint both L1 tasks
    await checkpointTask(dir, 1, '1.2', 'aaa111');
    await checkpointTask(dir, 1, '1.3', 'bbb222');

    const state = await read({ basePath: dir });
    const phase = state.phases[0];
    const selection = selectRunnableTask(phase, state);

    // No pending/needs_revalidation tasks remain → trigger_review
    assert.equal(selection.mode, 'trigger_review');
    assert.equal(selection.task, undefined);
  });
});

// ── Test Case 3: reviewing_task → executing_task (L2 review passed) ──

describe('TC3: reviewing_task → review_accepted (L2 review passed)', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('L2 review pass accepts task and clears current_review', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [
          { index: 1, name: 'Auth module', level: 'L2', requires: [] },
          { index: 2, name: 'Dashboard', level: 'L1', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }] },
        ],
      }],
    });

    // Walk task 1.1 to checkpointed
    await checkpointTask(dir, 1, '1.1', 'abc123');

    // Set up reviewing_task mode
    await update({
      updates: {
        workflow_mode: 'reviewing_task',
        current_review: { scope: 'task', scope_id: '1.1', stage: 'spec' },
      },
      basePath: dir,
    });

    const res = await handleReviewerResult({
      result: {
        scope: 'task',
        scope_id: '1.1',
        review_level: 'L2',
        spec_passed: true,
        quality_passed: true,
        critical_issues: [],
        important_issues: [],
        minor_issues: [],
        accepted_tasks: ['1.1'],
        rework_tasks: [],
        evidence: [],
      },
      basePath: dir,
    });

    assert.equal(res.success, true);
    assert.equal(res.action, 'review_accepted');
    assert.equal(res.accepted_count, 1);
    assert.equal(res.rework_count, 0);

    // Verify persisted state
    const state = await read({ basePath: dir });
    assert.equal(state.current_review, null);
    const task = state.phases[0].todo.find(t => t.id === '1.1');
    assert.equal(task.lifecycle, 'accepted');

    // Downstream task 1.2 is now unblocked (its dep 1.1 is accepted)
    const phase = state.phases[0];
    const selection = selectRunnableTask(phase, state);
    assert.ok(selection.task);
    assert.equal(selection.task.id, '1.2');
  });
});

// ── Test Case 4: reviewing_task → rework (L2 review failed) ──

describe('TC4: reviewing_task → rework (L2 review failed)', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('L2 review with critical issues triggers rework', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [
          { index: 1, name: 'Auth module', level: 'L2', requires: [] },
          { index: 2, name: 'Dashboard', level: 'L1', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }] },
        ],
      }],
    });

    // Walk task 1.1 to checkpointed
    await checkpointTask(dir, 1, '1.1', 'abc123');

    // Set up reviewing_task mode
    await update({
      updates: {
        workflow_mode: 'reviewing_task',
        current_review: { scope: 'task', scope_id: '1.1', stage: 'spec' },
      },
      basePath: dir,
    });

    const res = await handleReviewerResult({
      result: {
        scope: 'task',
        scope_id: '1.1',
        review_level: 'L2',
        spec_passed: true,
        quality_passed: false,
        critical_issues: [
          { task_id: '1.1', reason: 'SQL injection vulnerability', invalidates_downstream: true },
        ],
        important_issues: [],
        minor_issues: [],
        accepted_tasks: [],
        rework_tasks: ['1.1'],
        evidence: [],
      },
      basePath: dir,
    });

    assert.equal(res.success, true);
    assert.equal(res.action, 'rework_required');
    assert.equal(res.workflow_mode, 'executing_task');
    assert.equal(res.critical_count, 1);

    // Verify persisted state
    const state = await read({ basePath: dir });
    assert.equal(state.workflow_mode, 'executing_task');
    assert.equal(state.current_review, null);

    const task11 = state.phases[0].todo.find(t => t.id === '1.1');
    assert.equal(task11.lifecycle, 'needs_revalidation');

    // Task 1.2 should still be pending (1.1 not accepted)
    const task12 = state.phases[0].todo.find(t => t.id === '1.2');
    assert.equal(task12.lifecycle, 'pending');
  });
});

// ── Test Case 5: reviewing_phase → review_accepted (batch passed) ──

describe('TC5: reviewing_phase → review_accepted (batch passed)', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('batch review pass accepts all L1 tasks', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [
          { index: 1, name: 'Task A', level: 'L1', requires: [] },
          { index: 2, name: 'Task B', level: 'L1', requires: [] },
          { index: 3, name: 'Task C', level: 'L1', requires: [] },
        ],
      }],
    });

    // Checkpoint all tasks
    await checkpointTask(dir, 1, '1.1', 'c1');
    await checkpointTask(dir, 1, '1.2', 'c2');
    await checkpointTask(dir, 1, '1.3', 'c3');

    // Set up reviewing_phase mode
    await update({
      updates: {
        workflow_mode: 'reviewing_phase',
        current_review: { scope: 'phase', scope_id: 1 },
      },
      basePath: dir,
    });

    const res = await handleReviewerResult({
      result: {
        scope: 'phase',
        scope_id: 1,
        review_level: 'L1-batch',
        spec_passed: true,
        quality_passed: true,
        critical_issues: [],
        important_issues: [],
        minor_issues: ['Could use better variable names in src/utils.js:10'],
        accepted_tasks: ['1.1', '1.2', '1.3'],
        rework_tasks: [],
        evidence: [],
      },
      basePath: dir,
    });

    assert.equal(res.success, true);
    assert.equal(res.action, 'review_accepted');
    assert.equal(res.accepted_count, 3);
    assert.equal(res.rework_count, 0);

    // Verify persisted state: all tasks accepted
    const state = await read({ basePath: dir });
    for (const task of state.phases[0].todo) {
      assert.equal(task.lifecycle, 'accepted', `task ${task.id} should be accepted`);
    }
    assert.equal(state.current_review, null);

    // phase_handoff.required_reviews_passed should be set
    assert.equal(state.phases[0].phase_handoff.required_reviews_passed, true);
  });
});

// ── Test Case 6: reviewing_phase → rework (batch failed with propagation) ──

describe('TC6: reviewing_phase → rework (batch failed with propagation)', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('batch review failure propagates invalidation downstream', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [
          { index: 1, name: 'Task A', level: 'L1', requires: [] },
          { index: 2, name: 'Task B', level: 'L1', requires: [{ kind: 'task', id: '1.1', gate: 'checkpoint' }] },
          { index: 3, name: 'Task C', level: 'L1', requires: [{ kind: 'task', id: '1.2', gate: 'checkpoint' }] },
        ],
      }],
    });

    // Checkpoint all tasks in chain A→B→C
    await checkpointTask(dir, 1, '1.1', 'c1');
    await checkpointTask(dir, 1, '1.2', 'c2');
    await checkpointTask(dir, 1, '1.3', 'c3');

    // Set up reviewing_phase mode
    await update({
      updates: {
        workflow_mode: 'reviewing_phase',
        current_review: { scope: 'phase', scope_id: 1 },
      },
      basePath: dir,
    });

    const res = await handleReviewerResult({
      result: {
        scope: 'phase',
        scope_id: 1,
        review_level: 'L1-batch',
        spec_passed: true,
        quality_passed: false,
        critical_issues: [
          { task_id: '1.1', reason: 'API contract violation', invalidates_downstream: true },
        ],
        important_issues: [],
        minor_issues: [],
        accepted_tasks: [],
        rework_tasks: ['1.1'],
        evidence: [],
      },
      basePath: dir,
    });

    assert.equal(res.success, true);
    assert.equal(res.action, 'rework_required');
    assert.equal(res.workflow_mode, 'executing_task');

    // Verify persisted state
    const state = await read({ basePath: dir });
    assert.equal(state.workflow_mode, 'executing_task');
    assert.equal(state.current_review, null);

    // Task A: explicitly reworked
    const taskA = state.phases[0].todo.find(t => t.id === '1.1');
    assert.equal(taskA.lifecycle, 'needs_revalidation');
    assert.deepEqual(taskA.evidence_refs, []);

    // Task B: propagated invalidation (depends on A)
    const taskB = state.phases[0].todo.find(t => t.id === '1.2');
    assert.equal(taskB.lifecycle, 'needs_revalidation');
    assert.deepEqual(taskB.evidence_refs, []);

    // Task C: transitive propagation (depends on B which depends on A)
    const taskC = state.phases[0].todo.find(t => t.id === '1.3');
    assert.equal(taskC.lifecycle, 'needs_revalidation');
    assert.deepEqual(taskC.evidence_refs, []);
  });
});

// ── Test Case 7: executing_task → awaiting_user (all blocked) ──

describe('TC7: executing_task → awaiting_user (all blocked)', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('all tasks blocked causes awaiting_user mode', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [
          { index: 1, name: 'Blocked task', level: 'L1', requires: [], blocked_reason: 'Needs API key from client' },
        ],
      }],
    });

    // Transition the task to blocked (pending→blocked is valid)
    await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'blocked' }] }] },
      basePath: dir,
    });

    const state = await read({ basePath: dir });
    const phase = state.phases[0];
    const selection = selectRunnableTask(phase, state);

    assert.equal(selection.mode, 'awaiting_user');
    assert.equal(selection.task, undefined);
    assert.ok(Array.isArray(selection.blockers));
    assert.ok(selection.blockers.length > 0);
  });
});

// ── Test Case 8: executing_task → completed ──

describe('TC8: executing_task → completed (all phases accepted)', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('project completed when all phases accepted and workflow_mode set', async () => {
    await initProject(dir, {
      phases: [
        { name: 'Phase 1', tasks: [{ index: 1, name: 'Task A', level: 'L0', requires: [] }] },
        { name: 'Phase 2', tasks: [{ index: 1, name: 'Task B', level: 'L0', requires: [{ kind: 'phase', id: 1, gate: 'accepted' }] }] },
      ],
    });

    // Accept task in phase 1
    await acceptTask(dir, 1, '1.1');
    await update({ updates: { phases: [{ id: 1, done: 1 }] }, basePath: dir });

    // Complete phase 1
    await update({ updates: { phases: [{ id: 1, lifecycle: 'reviewing' }] }, basePath: dir });
    await update({ updates: { phases: [{ id: 1, phase_review: { status: 'accepted' } }] }, basePath: dir });
    await update({ updates: { phases: [{ id: 1, phase_handoff: { required_reviews_passed: true, tests_passed: true } }] }, basePath: dir });

    // Accept phase 1 (reviewing → accepted)
    const { phaseComplete } = await import('../src/tools/state/index.js');
    let res = await phaseComplete({
      phase_id: 1,
      basePath: dir,
      verification: { lint: { exit_code: 0 }, typecheck: { exit_code: 0 }, test: { exit_code: 0 } },
      direction_ok: true,
    });
    assert.equal(res.success, true);

    let state = await read({ basePath: dir });
    assert.equal(state.current_phase, 2);
    assert.equal(state.phases[1].lifecycle, 'active');

    // Accept task in phase 2
    await acceptTask(dir, 2, '2.1');
    await update({ updates: { phases: [{ id: 2, done: 1 }] }, basePath: dir });

    // Complete phase 2
    await update({ updates: { phases: [{ id: 2, lifecycle: 'reviewing' }] }, basePath: dir });
    await update({ updates: { phases: [{ id: 2, phase_review: { status: 'accepted' } }] }, basePath: dir });
    await update({ updates: { phases: [{ id: 2, phase_handoff: { required_reviews_passed: true, tests_passed: true } }] }, basePath: dir });

    res = await phaseComplete({
      phase_id: 2,
      basePath: dir,
      verification: { lint: { exit_code: 0 }, typecheck: { exit_code: 0 }, test: { exit_code: 0 } },
      direction_ok: true,
    });
    assert.equal(res.success, true);

    // Set workflow to completed
    await update({ updates: { workflow_mode: 'completed' }, basePath: dir });

    state = await read({ basePath: dir });
    assert.equal(state.workflow_mode, 'completed');
    assert.equal(state.phases[0].lifecycle, 'accepted');
    assert.equal(state.phases[1].lifecycle, 'accepted');

    // resumeWorkflow should return noop
    const resumed = await resumeWorkflow({ basePath: dir });
    assert.equal(resumed.success, true);
    assert.equal(resumed.action, 'noop');
    assert.equal(resumed.workflow_mode, 'completed');
  });
});

// ── Test Case 9: L1→L2 reclassification triggers immediate review ──

describe('TC9: L1→L2 reclassification triggers immediate review', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('contract_changed + sensitive keyword upgrades L1 to L2', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [
          { index: 1, name: 'Init', level: 'L0', requires: [] },
          { index: 2, name: 'Implement auth token validation', level: 'L1', requires: [] },
        ],
      }],
    });

    // Walk task 1.2 to running
    await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.2', lifecycle: 'running' }] }] }, basePath: dir });

    const res = await handleExecutorResult({
      result: {
        task_id: '1.2',
        outcome: 'checkpointed',
        checkpoint_commit: 'xyz789',
        summary: 'Auth token validation implemented',
        files_changed: ['src/auth-tokens.js'],
        decisions: [],
        blockers: [],
        contract_changed: true,
        evidence: [],
      },
      basePath: dir,
    });

    assert.equal(res.success, true);
    assert.equal(res.review_level, 'L2');
    assert.equal(res.workflow_mode, 'reviewing_task');
    assert.equal(res.action, 'dispatch_reviewer');
    assert.deepEqual(res.current_review, { scope: 'task', scope_id: '1.2', stage: 'spec' });

    // Verify reclassifyReviewLevel directly
    const state = await read({ basePath: dir });
    const task = state.phases[0].todo.find(t => t.id === '1.2');
    assert.equal(task.level, 'L2');
    assert.equal(task.lifecycle, 'checkpointed');
  });
});

// ── Test Case 10: selectRunnableTask → trigger_review ──

describe('TC10: selectRunnableTask → trigger_review', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('all tasks checkpointed returns trigger_review', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [
          { index: 1, name: 'Task A', level: 'L1', requires: [] },
          { index: 2, name: 'Task B', level: 'L1', requires: [] },
        ],
      }],
    });

    // Checkpoint all tasks (no accepted, no pending)
    await checkpointTask(dir, 1, '1.1', 'c1');
    await checkpointTask(dir, 1, '1.2', 'c2');

    const state = await read({ basePath: dir });
    const phase = state.phases[0];
    const selection = selectRunnableTask(phase, state);

    assert.equal(selection.mode, 'trigger_review');
    assert.equal(selection.task, undefined);
  });

  it('resumeWorkflow transitions to reviewing_phase on trigger_review', async () => {
    // Reset: re-init project and checkpoint tasks again
    const dir2 = await createTempDir();
    try {
      await initProject(dir2, {
        phases: [{
          name: 'Phase 1',
          tasks: [
            { index: 1, name: 'Task A', level: 'L1', requires: [] },
            { index: 2, name: 'Task B', level: 'L1', requires: [] },
          ],
        }],
      });

      await checkpointTask(dir2, 1, '1.1', 'c1');
      await checkpointTask(dir2, 1, '1.2', 'c2');

      const res = await resumeWorkflow({ basePath: dir2 });
      assert.equal(res.success, true);
      assert.equal(res.action, 'trigger_review');
      assert.equal(res.workflow_mode, 'reviewing_phase');

      // Verify persisted state
      const state = await read({ basePath: dir2 });
      assert.equal(state.workflow_mode, 'reviewing_phase');
      assert.deepEqual(state.current_review, { scope: 'phase', scope_id: 1 });
    } finally {
      await removeTempDir(dir2);
    }
  });
});

// ── Test Case 11: 3 failures → debugger ──

describe('TC11: 3 failures → dispatch_debugger', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('3rd executor failure dispatches debugger', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [
          { index: 1, name: 'Tricky task', level: 'L1', requires: [] },
        ],
      }],
    });

    // Walk task to running
    await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: dir });

    const makeFailedResult = (attempt) => ({
      task_id: '1.1',
      outcome: 'failed',
      summary: `Attempt ${attempt} failed: compilation error`,
      checkpoint_commit: null,
      files_changed: [],
      decisions: [],
      blockers: [],
      contract_changed: false,
      evidence: [],
    });

    // Failure 1
    let res = await handleExecutorResult({ result: makeFailedResult(1), basePath: dir });
    assert.equal(res.success, true);
    assert.equal(res.action, 'retry_executor');
    assert.equal(res.retry_count, 1);

    // Failure 2
    res = await handleExecutorResult({ result: makeFailedResult(2), basePath: dir });
    assert.equal(res.success, true);
    assert.equal(res.action, 'retry_executor');
    assert.equal(res.retry_count, 2);

    // Failure 3 → dispatch debugger
    res = await handleExecutorResult({ result: makeFailedResult(3), basePath: dir });
    assert.equal(res.success, true);
    assert.equal(res.action, 'dispatch_debugger');
    assert.equal(res.retry_count, 3);
    assert.equal(res.workflow_mode, 'executing_task');
    assert.ok(res.current_review);
    assert.equal(res.current_review.stage, 'debugging');
    assert.equal(res.current_review.scope_id, '1.1');

    // Verify persisted state
    const state = await read({ basePath: dir });
    assert.equal(state.current_review.stage, 'debugging');
    assert.equal(state.current_review.retry_count, 3);
    const task = state.phases[0].todo.find(t => t.id === '1.1');
    assert.equal(task.retry_count, 3);
  });
});
