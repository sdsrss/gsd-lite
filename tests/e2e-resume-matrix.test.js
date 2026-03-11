import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import {
  createTempDir,
  removeTempDir,
  initProject,
  checkpointTask,
  acceptTask,
  completePhase,
  writeContextHealth,
  read,
  update,
} from './e2e-helpers.js';
import { resumeWorkflow } from '../src/tools/orchestrator.js';

// ── TC1: executing_task — selects next runnable task ──

describe('TC1: executing_task — selects next runnable task', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('resumes by dispatching the next pending task after accepted one', async () => {
    await initProject(dir);
    // Accept task 1.1 so 1.2 becomes runnable (1.2 requires 1.1 accepted)
    await acceptTask(dir, 1, '1.1');

    const res = await resumeWorkflow({ basePath: dir });

    assert.equal(res.success, true);
    assert.equal(res.action, 'dispatch_executor');
    assert.equal(res.task_id, '1.2');
    assert.equal(res.workflow_mode, 'executing_task');
    assert.ok(res.executor_context, 'should include executor_context');
  });
});

// ── TC2: executing_task — re-dispatches interrupted running task ──

describe('TC2: executing_task — re-dispatches interrupted running task', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('resumes a task that was left in running state (interruption recovery)', async () => {
    await initProject(dir);
    // Walk task 1.1 to running and set current_task
    await update({
      updates: {
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }],
        current_task: '1.1',
      },
      basePath: dir,
    });

    const res = await resumeWorkflow({ basePath: dir });

    assert.equal(res.success, true);
    assert.equal(res.action, 'dispatch_executor');
    assert.equal(res.resumed, true);
    assert.equal(res.interruption_recovered, true);
    assert.equal(res.task_id, '1.1');
  });
});

// ── TC3: reviewing_task — dispatches reviewer ──

describe('TC3: reviewing_task — dispatches reviewer for task', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('dispatches reviewer in reviewing_task mode with L2 checkpointed task', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [
          { index: 1, name: 'Auth module', level: 'L2', requires: [] },
        ],
      }],
    });

    // Walk task to checkpointed
    await checkpointTask(dir, 1, '1.1', 'abc123');

    // Set reviewing_task mode
    await update({
      updates: {
        workflow_mode: 'reviewing_task',
        current_review: { scope: 'task', scope_id: '1.1', stage: 'spec' },
      },
      basePath: dir,
    });

    const res = await resumeWorkflow({ basePath: dir });

    assert.equal(res.success, true);
    assert.equal(res.action, 'dispatch_reviewer');
    assert.equal(res.review_scope, 'task');
    assert.equal(res.workflow_mode, 'reviewing_task');
    assert.ok(res.review_target, 'should include review_target');
    assert.equal(res.review_target.id, '1.1');
  });
});

// ── TC4: reviewing_phase — dispatches reviewer for phase ──

describe('TC4: reviewing_phase — dispatches reviewer for phase', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('dispatches reviewer for phase with 2 checkpointed L1 tasks', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [
          { index: 1, name: 'Task A', level: 'L1', requires: [] },
          { index: 2, name: 'Task B', level: 'L1', requires: [] },
        ],
      }],
    });

    // Checkpoint both tasks
    await checkpointTask(dir, 1, '1.1', 'c1');
    await checkpointTask(dir, 1, '1.2', 'c2');

    // Set reviewing_phase mode
    await update({
      updates: {
        workflow_mode: 'reviewing_phase',
        current_review: { scope: 'phase', scope_id: 1 },
      },
      basePath: dir,
    });

    const res = await resumeWorkflow({ basePath: dir });

    assert.equal(res.success, true);
    assert.equal(res.action, 'dispatch_reviewer');
    assert.equal(res.review_scope, 'phase');
    assert.equal(res.workflow_mode, 'reviewing_phase');
    assert.ok(Array.isArray(res.review_targets));
    assert.equal(res.review_targets.length, 2);
  });
});

// ── TC5: awaiting_clear + health >= 40 — resumes ──

describe('TC5: awaiting_clear + health >= 40 — resumes execution', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('transitions to executing_task when context health is above threshold', async () => {
    await initProject(dir);
    await update({ updates: { workflow_mode: 'awaiting_clear' }, basePath: dir });
    await writeContextHealth(dir, 70);

    const res = await resumeWorkflow({ basePath: dir });

    assert.equal(res.success, true);
    assert.equal(res.action, 'dispatch_executor');
    assert.equal(res.workflow_mode, 'executing_task');

    // Verify persisted state
    const state = await read({ basePath: dir });
    assert.equal(state.workflow_mode, 'executing_task');
  });
});

// ── TC6: awaiting_clear + health < 40 — stays awaiting_clear ──

describe('TC6: awaiting_clear + health < 40 — stays awaiting_clear', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('remains in awaiting_clear when context health is below threshold', async () => {
    await initProject(dir);
    await update({ updates: { workflow_mode: 'awaiting_clear' }, basePath: dir });
    await writeContextHealth(dir, 30);

    const res = await resumeWorkflow({ basePath: dir });

    assert.equal(res.success, true);
    assert.equal(res.workflow_mode, 'awaiting_clear');
    assert.equal(res.action, 'await_manual_intervention');
    assert.equal(res.remaining_percentage, 30);
  });
});

// ── TC7: awaiting_user + auto-unblock match ──

describe('TC7: awaiting_user + auto-unblock via decision match', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('auto-unblocks task when a decision matches the blocked reason', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [
          { index: 1, name: 'DB Setup', level: 'L1', requires: [] },
        ],
      }],
    });

    // Walk task to blocked: pending → blocked
    await update({
      updates: {
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'blocked', blocked_reason: 'Need database connection config' }] }],
      },
      basePath: dir,
    });

    // Set awaiting_user with a matching decision
    await update({
      updates: {
        workflow_mode: 'awaiting_user',
        decisions: [{ id: 'd1', summary: 'Use PostgreSQL database with connection pooling', phase: 1 }],
      },
      basePath: dir,
    });

    const res = await resumeWorkflow({ basePath: dir });

    assert.equal(res.success, true);
    // Task was auto-unblocked and workflow resumed to executing
    assert.ok(res.auto_unblocked, 'should have auto_unblocked entries');
    assert.ok(res.auto_unblocked.length > 0, 'at least one task auto-unblocked');
    assert.equal(res.auto_unblocked[0].task_id, '1.1');
    assert.equal(res.auto_unblocked[0].decision_id, 'd1');
  });
});

// ── TC8: awaiting_user + no match ──

describe('TC8: awaiting_user + no decision match — returns blockers', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('stays awaiting_user when blocked reason has no matching decision', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [
          { index: 1, name: 'Task A', level: 'L1', requires: [] },
        ],
      }],
    });

    // Block the task
    await update({
      updates: {
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'blocked', blocked_reason: 'Need custom hardware token' }] }],
      },
      basePath: dir,
    });

    // Set awaiting_user with a decision that does not match
    await update({
      updates: {
        workflow_mode: 'awaiting_user',
        decisions: [{ id: 'd1', summary: 'Use PostgreSQL database with connection pooling', phase: 1 }],
      },
      basePath: dir,
    });

    const res = await resumeWorkflow({ basePath: dir });

    assert.equal(res.success, true);
    assert.equal(res.action, 'awaiting_user');
    assert.equal(res.workflow_mode, 'awaiting_user');
    assert.ok(Array.isArray(res.blockers));
    assert.ok(res.blockers.length > 0, 'should have unresolved blockers');
    assert.equal(res.blockers[0].id, '1.1');
  });
});

// ── TC9: paused_by_user ──

describe('TC9: paused_by_user — await manual intervention', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('returns await_manual_intervention for paused_by_user mode', async () => {
    await initProject(dir);
    await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: dir });

    const res = await resumeWorkflow({ basePath: dir });

    assert.equal(res.success, true);
    assert.equal(res.action, 'await_manual_intervention');
    assert.equal(res.workflow_mode, 'paused_by_user');
  });
});

// ── TC10: completed ──

describe('TC10: completed — noop', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('returns noop when workflow is completed', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [{ index: 1, name: 'Task A', level: 'L0', requires: [] }],
      }],
    });

    // Accept the task, complete the phase, set workflow to completed
    await acceptTask(dir, 1, '1.1');
    await update({ updates: { phases: [{ id: 1, done: 1 }] }, basePath: dir });
    await completePhase(dir, 1);
    await update({ updates: { workflow_mode: 'completed' }, basePath: dir });

    const res = await resumeWorkflow({ basePath: dir });

    assert.equal(res.success, true);
    assert.equal(res.action, 'noop');
    assert.equal(res.workflow_mode, 'completed');
  });
});

// ── TC11: failed — noop ──

describe('TC11: failed — noop', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('returns noop with failed tasks info when workflow is failed', async () => {
    await initProject(dir, {
      phases: [{
        name: 'Phase 1',
        tasks: [{ index: 1, name: 'Task A', level: 'L1', requires: [] }],
      }],
    });

    // Walk task: pending → running → failed
    await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] },
      basePath: dir,
    });
    await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'failed' }] }] },
      basePath: dir,
    });

    // Walk phase: active → failed
    await update({
      updates: {
        phases: [{ id: 1, lifecycle: 'failed' }],
        workflow_mode: 'failed',
      },
      basePath: dir,
    });

    const res = await resumeWorkflow({ basePath: dir });

    assert.equal(res.success, true);
    assert.equal(res.action, 'await_recovery_decision');
    assert.equal(res.workflow_mode, 'failed');
    assert.ok(Array.isArray(res.failed_tasks));
    assert.ok(res.failed_tasks.some((t) => t.id === '1.1'));
    assert.deepEqual(res.recovery_options, ['retry_failed', 'skip_failed', 'replan']);
  });
});

// ── TC12: Pre-flight — git HEAD mismatch → reconcile_workspace ──

describe('TC12: Pre-flight — git HEAD mismatch → reconcile_workspace', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('overrides to reconcile_workspace when git HEAD differs from stored value', async () => {
    // Create a git repo in tempDir so getGitHead returns a real commit
    execSync('git init && git -c user.name="test" -c user.email="test@test" commit --allow-empty -m "init"', { cwd: dir, stdio: 'ignore' });

    await initProject(dir);

    // Set git_head to a value that won't match the real HEAD
    await update({ updates: { git_head: 'deadbeef' }, basePath: dir });

    const res = await resumeWorkflow({ basePath: dir });

    assert.equal(res.success, true);
    assert.equal(res.workflow_mode, 'reconcile_workspace');
    assert.ok(res.saved_git_head, 'should report saved_git_head');
    assert.equal(res.saved_git_head, 'deadbeef');
    assert.ok(res.current_git_head, 'should report current_git_head');

    // Verify persisted state
    const state = await read({ basePath: dir });
    assert.equal(state.workflow_mode, 'reconcile_workspace');
  });
});

// ── TC13: Pre-flight — expired research → research_refresh_needed ──

describe('TC13: Pre-flight — expired research → research_refresh_needed', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('overrides to research_refresh_needed when research cache is expired', async () => {
    await initProject(dir, { research: true });

    // Set up research with expired data
    await update({
      updates: {
        research: {
          decision_index: {
            d1: { summary: 'Use React', volatility: 'medium', expires_at: '2020-01-01T00:00:00Z' },
          },
          volatility: 'medium',
          expires_at: '2020-01-01T00:00:00Z',
          sources: [{ id: 's1', type: 'docs', ref: 'ref' }],
          files: ['STACK.md', 'ARCHITECTURE.md', 'PITFALLS.md', 'SUMMARY.md'],
          updated_at: '2020-01-01T00:00:00Z',
        },
      },
      basePath: dir,
    });

    const res = await resumeWorkflow({ basePath: dir });

    assert.equal(res.success, true);
    assert.equal(res.workflow_mode, 'research_refresh_needed');
    assert.equal(res.action, 'dispatch_researcher');
    assert.ok(Array.isArray(res.expired_research));
    assert.ok(res.expired_research.length > 0, 'should report expired research entries');

    // Verify persisted state
    const state = await read({ basePath: dir });
    assert.equal(state.workflow_mode, 'research_refresh_needed');
  });
});

// ── TC14: Pre-flight — direction drift → awaiting_user ──

describe('TC14: Pre-flight — direction drift → awaiting_user', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('overrides to awaiting_user when direction drift is detected on current phase', async () => {
    await initProject(dir);

    // Set direction_ok=false on current phase (phase 1)
    await update({
      updates: {
        phases: [{ id: 1, phase_handoff: { direction_ok: false } }],
      },
      basePath: dir,
    });

    const res = await resumeWorkflow({ basePath: dir });

    assert.equal(res.success, true);
    assert.equal(res.workflow_mode, 'awaiting_user');
    assert.ok(res.drift_phase, 'should report drift_phase');
    assert.equal(res.drift_phase.id, 1);

    // Verify persisted state
    const state = await read({ basePath: dir });
    assert.equal(state.workflow_mode, 'awaiting_user');
    assert.equal(state.current_review.stage, 'direction_drift');
  });
});
