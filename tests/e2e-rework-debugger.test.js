import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTempDir,
  removeTempDir,
  initProject,
  checkpointTask,
  read,
  update,
} from './e2e-helpers.js';
import {
  handleExecutorResult,
  handleReviewerResult,
  handleDebuggerResult,
} from '../src/tools/orchestrator/index.js';
import {
  reclassifyReviewLevel,
} from '../src/tools/state/index.js';

// ── Helper: walk a task to running ──

async function walkToRunning(dir, phaseId, taskId) {
  await update({
    updates: { phases: [{ id: phaseId, todo: [{ id: taskId, lifecycle: 'running' }] }] },
    basePath: dir,
  });
}

// ── Helper: submit N failed executor results ──

async function failExecutorNTimes(dir, taskId, count) {
  let res;
  for (let i = 1; i <= count; i++) {
    res = await handleExecutorResult({
      result: {
        task_id: taskId,
        outcome: 'failed',
        summary: `Attempt ${i}: connection error`,
        checkpoint_commit: null,
        files_changed: [],
        decisions: [],
        blockers: [],
        contract_changed: false,
        evidence: [],
      },
      basePath: dir,
    });
  }
  return res;
}

// ── TC1: Rework propagation — critical on A, B gets needs_revalidation ──

describe('TC1: Rework propagation — critical on A, B gets needs_revalidation', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('critical issue with invalidates_downstream propagates to B but not C', async () => {
    await initProject(dir, {
      phases: [{
        name: 'P1',
        tasks: [
          { index: 1, name: 'Task A', level: 'L1', requires: [] },
          { index: 2, name: 'Task B', level: 'L1', requires: [{ kind: 'task', id: '1.1', gate: 'checkpoint' }] },
          { index: 3, name: 'Task C', level: 'L1', requires: [{ kind: 'task', id: '1.2', gate: 'accepted' }] },
        ],
      }],
    });

    // Checkpoint A and B
    await checkpointTask(dir, 1, '1.1', 'commit-a');
    await checkpointTask(dir, 1, '1.2', 'commit-b');

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

    const state = await read({ basePath: dir });
    const taskA = state.phases[0].todo.find(t => t.id === '1.1');
    const taskB = state.phases[0].todo.find(t => t.id === '1.2');
    const taskC = state.phases[0].todo.find(t => t.id === '1.3');

    assert.equal(taskA.lifecycle, 'needs_revalidation');
    assert.equal(taskB.lifecycle, 'needs_revalidation'); // propagated
    assert.equal(taskC.lifecycle, 'pending'); // never started, stays pending
  });
});

// ── TC2: Non-contract rework — no propagation ──

describe('TC2: Non-contract rework — no propagation', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('critical issue without invalidates_downstream does not propagate', async () => {
    await initProject(dir, {
      phases: [{
        name: 'P1',
        tasks: [
          { index: 1, name: 'Task A', level: 'L1', requires: [] },
          { index: 2, name: 'Task B', level: 'L1', requires: [{ kind: 'task', id: '1.1', gate: 'checkpoint' }] },
          { index: 3, name: 'Task C', level: 'L1', requires: [{ kind: 'task', id: '1.2', gate: 'accepted' }] },
        ],
      }],
    });

    // Checkpoint A and B
    await checkpointTask(dir, 1, '1.1', 'commit-a');
    await checkpointTask(dir, 1, '1.2', 'commit-b');

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
          { task_id: '1.1', reason: 'Style issue', invalidates_downstream: false },
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

    const state = await read({ basePath: dir });
    const taskA = state.phases[0].todo.find(t => t.id === '1.1');
    const taskB = state.phases[0].todo.find(t => t.id === '1.2');

    assert.equal(taskA.lifecycle, 'needs_revalidation'); // explicit rework
    assert.equal(taskB.lifecycle, 'checkpointed'); // no propagation
  });
});

// ── TC3: Review reclassification — L1 + auth + contract_changed → L2 ──

describe('TC3: Review reclassification — L1 + auth + contract_changed → L2', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('contract_changed + sensitive keyword upgrades L1 to L2 with review dispatch', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [
          { index: 1, name: 'Implement auth token validation', level: 'L1', requires: [] },
        ],
      }],
    });

    await walkToRunning(dir, 1, '1.1');

    const res = await handleExecutorResult({
      result: {
        task_id: '1.1',
        outcome: 'checkpointed',
        checkpoint_commit: 'auth-commit',
        summary: 'Auth token validation implemented',
        files_changed: ['src/auth.js'],
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
  });
});

// ── TC4: No reclassification — contract_changed but no sensitive keyword ──

describe('TC4: No reclassification — contract_changed but no sensitive keyword', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('contract_changed without sensitive keyword stays L1, no immediate review', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [
          { index: 1, name: 'Update button styles', level: 'L1', requires: [] },
        ],
      }],
    });

    await walkToRunning(dir, 1, '1.1');

    const res = await handleExecutorResult({
      result: {
        task_id: '1.1',
        outcome: 'checkpointed',
        checkpoint_commit: 'btn-commit',
        summary: 'Button styles updated',
        files_changed: ['src/styles.css'],
        decisions: [],
        blockers: [],
        contract_changed: true,
        evidence: [],
      },
      basePath: dir,
    });

    assert.equal(res.success, true);
    assert.equal(res.review_level, 'L1');
    assert.equal(res.workflow_mode, 'executing_task');
  });
});

// ── TC5: LEVEL-UP decision upgrades to L2 ──

describe('TC5: LEVEL-UP decision upgrades to L2', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('[LEVEL-UP] decision in executor result upgrades L1 to L2', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [
          { index: 1, name: 'Basic utils', level: 'L1', requires: [] },
        ],
      }],
    });

    await walkToRunning(dir, 1, '1.1');

    const res = await handleExecutorResult({
      result: {
        task_id: '1.1',
        outcome: 'checkpointed',
        checkpoint_commit: 'utils-commit',
        summary: 'Utils with complex changes',
        files_changed: ['src/utils.js'],
        decisions: ['[LEVEL-UP] complex changes required broader refactor'],
        blockers: [],
        contract_changed: false,
        evidence: [],
      },
      basePath: dir,
    });

    assert.equal(res.success, true);
    assert.equal(res.review_level, 'L2');
    assert.equal(res.workflow_mode, 'reviewing_task');
  });
});

// ── TC6: Never downgrade — L2 stays L2 ──

describe('TC6: Never downgrade — L2 stays L2', () => {
  it('L2 task stays L2 even with no contract_changed and no LEVEL-UP', () => {
    const task = { name: 'Some task', level: 'L2' };
    const executorResult = {
      contract_changed: false,
      decisions: [],
    };

    const result = reclassifyReviewLevel(task, executorResult);
    assert.equal(result, 'L2');
  });
});

// ── TC7: 3 failures → debugger dispatch ──

describe('TC7: 3 failures → debugger dispatch', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('tracks retry_count and dispatches debugger on 3rd failure', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [
          { index: 1, name: 'Flaky task', level: 'L1', requires: [] },
        ],
      }],
    });

    await walkToRunning(dir, 1, '1.1');

    const makeFailedResult = (attempt) => ({
      task_id: '1.1',
      outcome: 'failed',
      summary: `connection error attempt ${attempt}`,
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
    let state = await read({ basePath: dir });
    assert.equal(state.phases[0].todo[0].retry_count, 1);

    // Failure 2
    res = await handleExecutorResult({ result: makeFailedResult(2), basePath: dir });
    assert.equal(res.success, true);
    assert.equal(res.action, 'retry_executor');
    assert.equal(res.retry_count, 2);
    state = await read({ basePath: dir });
    assert.equal(state.phases[0].todo[0].retry_count, 2);

    // Failure 3 → debugger
    res = await handleExecutorResult({ result: makeFailedResult(3), basePath: dir });
    assert.equal(res.success, true);
    assert.equal(res.action, 'dispatch_debugger');
    assert.equal(res.retry_count, 3);
    assert.ok(res.current_review);
    assert.equal(res.current_review.stage, 'debugging');

    state = await read({ basePath: dir });
    assert.equal(state.phases[0].todo[0].retry_count, 3);
    assert.equal(state.current_review.stage, 'debugging');
  });
});

// ── TC8: Debugger fix_suggested → executor re-dispatched with debug_context ──

describe('TC8: Debugger fix_suggested → executor re-dispatched', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('fix_suggested outcome re-dispatches executor with debugger_guidance', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [
          { index: 1, name: 'Failing task', level: 'L1', requires: [] },
        ],
      }],
    });

    await walkToRunning(dir, 1, '1.1');

    // Fail 3 times to reach debugger stage
    await failExecutorNTimes(dir, '1.1', 3);

    // Now call handleDebuggerResult with fix_suggested
    const res = await handleDebuggerResult({
      result: {
        task_id: '1.1',
        outcome: 'fix_suggested',
        root_cause: 'Connection pool exhaustion',
        fix_direction: 'Increase pool size',
        evidence: [],
        hypothesis_tested: [
          { hypothesis: 'Pool too small', result: 'confirmed', evidence: 'ev:trace:1' },
        ],
        fix_attempts: 1,
        blockers: [],
        architecture_concern: false,
      },
      basePath: dir,
    });

    assert.equal(res.success, true);
    assert.equal(res.action, 'dispatch_executor');
    assert.equal(res.resumed_from_debugger, true);
    assert.ok(res.debugger_guidance);
    assert.equal(res.debugger_guidance.root_cause, 'Connection pool exhaustion');
    assert.equal(res.debugger_guidance.fix_direction, 'Increase pool size');
  });
});

// ── TC9: Debugger failed → task lifecycle=failed ──

describe('TC9: Debugger failed → task lifecycle=failed', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('debugger failed outcome marks task as failed', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [
          { index: 1, name: 'Unfixable task', level: 'L1', requires: [] },
        ],
      }],
    });

    await walkToRunning(dir, 1, '1.1');
    await failExecutorNTimes(dir, '1.1', 3);

    const res = await handleDebuggerResult({
      result: {
        task_id: '1.1',
        outcome: 'failed',
        root_cause: 'Cannot reproduce in isolation',
        fix_direction: 'No viable path identified',
        evidence: [],
        hypothesis_tested: [],
        fix_attempts: 0,
        blockers: [],
        architecture_concern: false,
      },
      basePath: dir,
    });

    assert.equal(res.success, true);
    assert.equal(res.action, 'task_failed');

    const state = await read({ basePath: dir });
    const task = state.phases[0].todo.find(t => t.id === '1.1');
    assert.equal(task.lifecycle, 'failed');
  });
});

// ── TC10: Debugger architecture_concern → phase failed ──

describe('TC10: Debugger architecture_concern → phase failed', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('architecture_concern=true marks both task and phase as failed', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [
          { index: 1, name: 'Arch-concern task', level: 'L1', requires: [] },
        ],
      }],
    });

    await walkToRunning(dir, 1, '1.1');
    await failExecutorNTimes(dir, '1.1', 3);

    const res = await handleDebuggerResult({
      result: {
        task_id: '1.1',
        outcome: 'fix_suggested',
        root_cause: 'Fundamental design flaw in data model',
        fix_direction: 'Requires complete redesign',
        evidence: [],
        hypothesis_tested: [],
        fix_attempts: 0,
        blockers: [],
        architecture_concern: true,
      },
      basePath: dir,
    });

    assert.equal(res.success, true);
    assert.equal(res.action, 'phase_failed');
    assert.equal(res.workflow_mode, 'failed');

    const state = await read({ basePath: dir });
    assert.equal(state.phases[0].lifecycle, 'failed');
    const task = state.phases[0].todo.find(t => t.id === '1.1');
    assert.equal(task.lifecycle, 'failed');
  });
});
