import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, read, update } from '../src/tools/state.js';
import {
  handleDebuggerResult,
  handleExecutorResult,
  handleReviewerResult,
  handleResearcherResult,
  resumeWorkflow,
} from '../src/tools/orchestrator.js';

describe('orchestrator skeleton', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-orchestrator-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('dispatches executor for the next runnable task in executing_task mode', async () => {
    await init({
      project: 'orchestrator-test',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }, { index: 2, name: 'Task B' }] }],
      basePath: tempDir,
    });

    const result = await resumeWorkflow({ basePath: tempDir });
    assert.equal(result.success, true);
    assert.equal(result.action, 'dispatch_executor');
    assert.equal(result.phase_id, 1);
    assert.equal(result.task_id, '1.1');
    assert.equal(result.executor_context.task_spec, 'phases/phase-1.md');

    const state = await read({ basePath: tempDir });
    assert.equal(state.current_task, '1.1');
    assert.equal(state.workflow_mode, 'executing_task');
  });

  it('re-dispatches interrupted running current_task in executing_task mode', async () => {
    await init({
      project: 'orchestrator-interrupted',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });

    await update({
      updates: {
        current_task: '1.1',
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }],
      },
      basePath: tempDir,
    });

    const result = await resumeWorkflow({ basePath: tempDir });
    assert.equal(result.success, true);
    assert.equal(result.action, 'dispatch_executor');
    assert.equal(result.task_id, '1.1');
    assert.equal(result.resumed, true);
    assert.equal(result.interruption_recovered, true);
  });

  it('switches to reviewing_phase when current phase only has checkpointed tasks', async () => {
    await init({
      project: 'orchestrator-review',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });

    await update({
      updates: {
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }],
      },
      basePath: tempDir,
    });
    await update({
      updates: {
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'checkpointed', checkpoint_commit: 'abc123' }] }],
      },
      basePath: tempDir,
    });

    const result = await resumeWorkflow({ basePath: tempDir });
    assert.equal(result.success, true);
    assert.equal(result.action, 'trigger_review');
    assert.equal(result.workflow_mode, 'reviewing_phase');
    assert.deepEqual(result.current_review, { scope: 'phase', scope_id: 1 });

    const state = await read({ basePath: tempDir });
    assert.equal(state.workflow_mode, 'reviewing_phase');
    assert.deepEqual(state.current_review, { scope: 'phase', scope_id: 1 });
    assert.equal(state.current_task, null);
  });

  it('switches to awaiting_user when all tasks are blocked', async () => {
    await init({
      project: 'orchestrator-blocked',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });

    await update({
      updates: {
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'blocked', blocked_reason: 'Need API key' }] }],
      },
      basePath: tempDir,
    });

    const result = await resumeWorkflow({ basePath: tempDir });
    assert.equal(result.success, true);
    assert.equal(result.action, 'awaiting_user');
    assert.equal(result.workflow_mode, 'awaiting_user');
    assert.deepEqual(result.blockers, [{ id: '1.1', reason: 'Need API key', unblock_condition: null }]);

    const state = await read({ basePath: tempDir });
    assert.equal(state.workflow_mode, 'awaiting_user');
    assert.equal(state.current_task, null);
  });

  it('auto-unblocks blocked tasks from decisions and resumes execution when all blockers are resolved', async () => {
    await init({
      project: 'orchestrator-auto-unblock',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });

    await update({
      updates: {
        workflow_mode: 'awaiting_user',
        decisions: [{ id: 'd1', summary: 'Use PostgreSQL database connection strategy', phase: 1 }],
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'blocked', blocked_reason: 'Need database connection strategy' }] }],
      },
      basePath: tempDir,
    });

    const result = await resumeWorkflow({ basePath: tempDir });
    assert.equal(result.success, true);
    assert.equal(result.action, 'dispatch_executor');
    assert.equal(result.task_id, '1.1');
    assert.deepEqual(result.auto_unblocked, [{
      task_id: '1.1',
      decision_id: 'd1',
      decision_summary: 'Use PostgreSQL database connection strategy',
    }]);

    const state = await read({ basePath: tempDir });
    assert.equal(state.workflow_mode, 'executing_task');
    assert.equal(state.current_task, '1.1');
    assert.equal(state.phases[0].todo[0].lifecycle, 'running');
    assert.equal(state.phases[0].todo[0].blocked_reason, null);
  });

  it('keeps awaiting_user when only some blockers can be auto-unblocked', async () => {
    await init({
      project: 'orchestrator-partial-unblock',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }, { index: 2, name: 'Task B' }] }],
      basePath: tempDir,
    });

    await update({
      updates: {
        workflow_mode: 'awaiting_user',
        decisions: [{ id: 'd1', summary: 'Use PostgreSQL database connection strategy', phase: 1 }],
        phases: [{
          id: 1,
          todo: [
            { id: '1.1', lifecycle: 'blocked', blocked_reason: 'Need database connection strategy' },
            { id: '1.2', lifecycle: 'blocked', blocked_reason: 'Need deployment platform decision', unblock_condition: 'User picks cloud provider' },
          ],
        }],
      },
      basePath: tempDir,
    });

    const result = await resumeWorkflow({ basePath: tempDir });
    assert.equal(result.success, true);
    assert.equal(result.action, 'awaiting_user');
    assert.equal(result.workflow_mode, 'awaiting_user');
    assert.equal(result.auto_unblocked.length, 1);
    assert.deepEqual(result.blockers, [{
      id: '1.2',
      reason: 'Need deployment platform decision',
      unblock_condition: 'User picks cloud provider',
    }]);

    const state = await read({ basePath: tempDir });
    assert.equal(state.workflow_mode, 'awaiting_user');
    assert.equal(state.phases[0].todo[0].lifecycle, 'pending');
    assert.equal(state.phases[0].todo[1].lifecycle, 'blocked');
  });

  it('resumes from awaiting_clear by flipping back to executing_task', async () => {
    await init({
      project: 'orchestrator-clear',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({ updates: { workflow_mode: 'awaiting_clear' }, basePath: tempDir });

    const result = await resumeWorkflow({ basePath: tempDir });
    assert.equal(result.success, true);
    assert.equal(result.action, 'dispatch_executor');
    assert.equal(result.task_id, '1.1');

    const state = await read({ basePath: tempDir });
    assert.equal(state.workflow_mode, 'executing_task');
    assert.equal(state.current_task, '1.1');
  });

  it('keeps awaiting_clear when context health is still below threshold', async () => {
    await init({
      project: 'orchestrator-clear-low-health',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    writeFileSync(join(tempDir, '.gsd', '.context-health'), '15');
    await update({ updates: { workflow_mode: 'awaiting_clear' }, basePath: tempDir });

    const result = await resumeWorkflow({ basePath: tempDir });
    assert.equal(result.success, true);
    assert.equal(result.action, 'await_manual_intervention');
    assert.equal(result.workflow_mode, 'awaiting_clear');
    assert.equal(result.remaining_percentage, 15);

    const state = await read({ basePath: tempDir });
    assert.equal(state.workflow_mode, 'awaiting_clear');
    assert.equal(state.context.remaining_percentage, 15);
  });

  it('overrides resume to reconcile_workspace when git head mismatches', async () => {
    execSync('git init', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.email test@example.com', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.name Test User', { cwd: tempDir, stdio: 'ignore' });
    writeFileSync(join(tempDir, 'README.md'), 'init\n');
    execSync('git add README.md', { cwd: tempDir, stdio: 'ignore' });
    execSync('git commit -m init', { cwd: tempDir, stdio: 'ignore' });

    await init({
      project: 'orchestrator-reconcile',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({ updates: { git_head: 'deadbeef' }, basePath: tempDir });

    const result = await resumeWorkflow({ basePath: tempDir });
    assert.equal(result.success, true);
    assert.equal(result.action, 'await_manual_intervention');
    assert.equal(result.workflow_mode, 'reconcile_workspace');
    assert.equal(result.saved_git_head, 'deadbeef');
    assert.ok(typeof result.current_git_head === 'string' && result.current_git_head.length > 0);

    const state = await read({ basePath: tempDir });
    assert.equal(state.workflow_mode, 'reconcile_workspace');
  });

  it('overrides resume to replan_required when plan artifacts changed after last session', async () => {
    await init({
      project: 'orchestrator-replan',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({
      updates: {
        context: {
          last_session: new Date(Date.now() - 5000).toISOString(),
          remaining_percentage: 100,
        },
      },
      basePath: tempDir,
    });

    writeFileSync(join(tempDir, '.gsd', 'phases', 'phase-1.md'), '# changed\n');

    const result = await resumeWorkflow({ basePath: tempDir });
    assert.equal(result.success, true);
    assert.equal(result.action, 'await_manual_intervention');
    assert.equal(result.workflow_mode, 'replan_required');
    assert.ok(result.changed_files.includes('phases/phase-1.md'));

    const state = await read({ basePath: tempDir });
    assert.equal(state.workflow_mode, 'replan_required');
  });

  it('overrides resume to research_refresh_needed when research is expired', async () => {
    await init({
      project: 'orchestrator-research-refresh',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({
      updates: {
        research: {
          expires_at: '2000-01-01T00:00:00Z',
          decision_index: {
            'decision:db': {
              summary: 'Use PostgreSQL',
              expires_at: '2000-01-01T00:00:00Z',
            },
          },
        },
      },
      basePath: tempDir,
    });

    const result = await resumeWorkflow({ basePath: tempDir });
    assert.equal(result.success, true);
    assert.equal(result.action, 'dispatch_researcher');
    assert.equal(result.workflow_mode, 'research_refresh_needed');
    assert.deepEqual(result.expired_research.map((entry) => entry.id), ['research', 'decision:db']);

    const state = await read({ basePath: tempDir });
    assert.equal(state.workflow_mode, 'research_refresh_needed');
  });

  it('overrides resume to awaiting_user when direction drift is recorded on the phase', async () => {
    await init({
      project: 'orchestrator-direction-drift',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({
      updates: {
        workflow_mode: 'executing_task',
        phases: [{ id: 1, phase_handoff: { direction_ok: false } }],
      },
      basePath: tempDir,
    });

    const result = await resumeWorkflow({ basePath: tempDir });
    assert.equal(result.success, true);
    assert.equal(result.action, 'awaiting_user');
    assert.equal(result.workflow_mode, 'awaiting_user');
    assert.deepEqual(result.drift_phase, { id: 1, name: 'Core' });

    const state = await read({ basePath: tempDir });
    assert.equal(state.workflow_mode, 'awaiting_user');
    assert.equal(state.current_review.stage, 'direction_drift');
    assert.equal(state.current_review.scope_id, 1);
  });

  it('keeps direction drift resumes in awaiting_user instead of entering auto-unblock flow', async () => {
    await init({
      project: 'orchestrator-direction-drift-awaiting-user',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({
      updates: {
        workflow_mode: 'awaiting_user',
        current_review: { scope: 'phase', scope_id: 1, stage: 'direction_drift', summary: 'Direction drift detected for phase 1' },
        phases: [{ id: 1, phase_handoff: { direction_ok: false } }],
      },
      basePath: tempDir,
    });

    const result = await resumeWorkflow({ basePath: tempDir });
    assert.equal(result.success, true);
    assert.equal(result.action, 'awaiting_user');
    assert.deepEqual(result.drift_phase, { id: 1, name: 'Core' });
    assert.deepEqual(result.blockers, []);
    assert.match(result.message, /direction drift/i);
  });

  it('returns dispatch_reviewer for reviewing_task mode', async () => {
    await init({
      project: 'orchestrator-review-task',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] },
      basePath: tempDir,
    });
    await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'checkpointed', checkpoint_commit: 'abc123' }] }] },
      basePath: tempDir,
    });
    await update({
      updates: {
        workflow_mode: 'reviewing_task',
        current_review: { scope: 'task', scope_id: '1.1', stage: 'spec' },
      },
      basePath: tempDir,
    });

    const result = await resumeWorkflow({ basePath: tempDir });
    assert.equal(result.success, true);
    assert.equal(result.action, 'dispatch_reviewer');
    assert.equal(result.review_scope, 'task');
    assert.deepEqual(result.current_review, { scope: 'task', scope_id: '1.1', stage: 'spec' });
    assert.deepEqual(result.review_target, {
      id: '1.1',
      level: 'L1',
      checkpoint_commit: 'abc123',
      files_changed: [],
    });
  });

  it('returns batch review targets for reviewing_phase mode', async () => {
    await init({
      project: 'orchestrator-phase-review',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }, { index: 2, name: 'Task B', level: 'L0' }] }],
      basePath: tempDir,
    });
    await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] },
      basePath: tempDir,
    });
    await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'checkpointed', checkpoint_commit: 'abc123' }] }] },
      basePath: tempDir,
    });
    await update({
      updates: {
        workflow_mode: 'reviewing_phase',
      },
      basePath: tempDir,
    });

    const result = await resumeWorkflow({ basePath: tempDir });
    assert.equal(result.success, true);
    assert.equal(result.action, 'dispatch_reviewer');
    assert.equal(result.review_scope, 'phase');
    assert.deepEqual(result.review_targets, [{ id: '1.1', level: 'L1', checkpoint_commit: 'abc123', files_changed: [] }]);
  });

  it('returns structured info for completed and not-yet-automated modes', async () => {
    await init({
      project: 'orchestrator-completed',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({ updates: { phases: [{ id: 1, lifecycle: 'reviewing' }] }, basePath: tempDir });
    await update({ updates: { phases: [{ id: 1, lifecycle: 'accepted' }] }, basePath: tempDir });

    await update({
      updates: {
        workflow_mode: 'completed',
      },
      basePath: tempDir,
    });
    const completed = await resumeWorkflow({ basePath: tempDir });
    assert.equal(completed.success, true);
    assert.equal(completed.action, 'noop');
    assert.equal(completed.completed_phases, 1);

    // Use a fresh project for paused_by_user (can't transition from completed)
    const pausedDir = await mkdtemp(join(tmpdir(), 'gsd-paused-'));
    try {
      await init({
        project: 'orchestrator-paused',
        phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
        basePath: pausedDir,
      });
      await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: pausedDir });
      const paused = await resumeWorkflow({ basePath: pausedDir });
      assert.equal(paused.success, true);
      assert.equal(paused.action, 'await_manual_intervention');
      assert.match(paused.message, /paused/i);
    } finally {
      await rm(pausedDir, { recursive: true, force: true });
    }
  });

  it('retries executor failures before debugger threshold', async () => {
    await init({
      project: 'orchestrator-retry',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({
      updates: {
        current_task: '1.1',
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }],
      },
      basePath: tempDir,
    });

    const result = await handleExecutorResult({
      basePath: tempDir,
      result: {
        task_id: '1.1',
        outcome: 'failed',
        summary: 'Temporary DB timeout',
        files_changed: [],
        decisions: [],
        blockers: [],
        contract_changed: false,
        evidence: [],
        error_fingerprint: 'db-timeout',
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'retry_executor');
    assert.equal(result.retry_count, 1);

    const state = await read({ basePath: tempDir });
    assert.equal(state.current_task, '1.1');
    assert.equal(state.current_review, null);
    assert.equal(state.phases[0].todo[0].retry_count, 1);
    assert.equal(state.phases[0].todo[0].last_error_fingerprint, 'db-timeout');
  });

  it('routes to debugger after repeated executor failures', async () => {
    await init({
      project: 'orchestrator-debug-route',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({
      updates: {
        current_task: '1.1',
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running', retry_count: 2 }] }],
      },
      basePath: tempDir,
    });

    const result = await handleExecutorResult({
      basePath: tempDir,
      result: {
        task_id: '1.1',
        outcome: 'failed',
        summary: 'Same failure fingerprint',
        files_changed: [],
        decisions: [],
        blockers: [],
        contract_changed: false,
        evidence: [],
        error_fingerprint: 'repeat-fp',
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'dispatch_debugger');
    assert.equal(result.retry_count, 3);
    assert.equal(result.current_review.stage, 'debugging');

    const resumed = await resumeWorkflow({ basePath: tempDir });
    assert.equal(resumed.success, true);
    assert.equal(resumed.action, 'dispatch_debugger');
    assert.equal(resumed.debug_target.id, '1.1');
    assert.equal(resumed.debug_target.error_fingerprint, 'repeat-fp');
  });

  it('re-dispatches executor after debugger suggests a fix', async () => {
    await init({
      project: 'orchestrator-debug-fix',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({
      updates: {
        current_task: '1.1',
        current_review: { scope: 'task', scope_id: '1.1', stage: 'debugging' },
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running', retry_count: 3 }] }],
      },
      basePath: tempDir,
    });

    const result = await handleDebuggerResult({
      basePath: tempDir,
      result: {
        task_id: '1.1',
        outcome: 'fix_suggested',
        root_cause: 'Connection pool exhaustion',
        evidence: ['ev:trace:1'],
        hypothesis_tested: [
          { hypothesis: 'Pool leak', result: 'confirmed', evidence: 'ev:trace:1' },
        ],
        fix_direction: 'Reuse shared client and tighten cleanup',
        fix_attempts: 1,
        blockers: [],
        architecture_concern: false,
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'dispatch_executor');
    assert.equal(result.resumed_from_debugger, true);
    assert.equal(result.debugger_guidance.fix_direction, 'Reuse shared client and tighten cleanup');
    assert.equal(result.executor_context.debugger_guidance.fix_direction, 'Reuse shared client and tighten cleanup');

    const state = await read({ basePath: tempDir });
    assert.equal(state.current_review, null);
    assert.equal(state.current_task, '1.1');
    assert.equal(state.phases[0].todo[0].debug_context.fix_direction, 'Reuse shared client and tighten cleanup');
  });

  it('fails the phase when debugger reports architecture concern', async () => {
    await init({
      project: 'orchestrator-debug-phase-fail',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({
      updates: {
        current_task: '1.1',
        current_review: { scope: 'task', scope_id: '1.1', stage: 'debugging' },
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running', retry_count: 3 }] }],
      },
      basePath: tempDir,
    });

    const result = await handleDebuggerResult({
      basePath: tempDir,
      result: {
        task_id: '1.1',
        outcome: 'failed',
        root_cause: 'Architecture mismatch between queue and DB consistency model',
        evidence: ['ev:arch:1'],
        hypothesis_tested: [
          { hypothesis: 'Current architecture cannot guarantee ordering', result: 'confirmed', evidence: 'ev:arch:1' },
        ],
        fix_direction: 'Re-plan event processing architecture',
        fix_attempts: 3,
        blockers: ['Need architecture decision'],
        architecture_concern: true,
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'phase_failed');
    assert.equal(result.workflow_mode, 'failed');

    const state = await read({ basePath: tempDir });
    assert.equal(state.workflow_mode, 'failed');
    assert.equal(state.phases[0].lifecycle, 'failed');
    assert.equal(state.phases[0].todo[0].lifecycle, 'failed');
  });

  it('sets task lifecycle to running when dispatching a pending task', async () => {
    await init({
      project: 'orchestrator-running-lifecycle',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }, { index: 2, name: 'Task B' }] }],
      basePath: tempDir,
    });

    const result = await resumeWorkflow({ basePath: tempDir });
    assert.equal(result.success, true);
    assert.equal(result.action, 'dispatch_executor');
    assert.equal(result.task_id, '1.1');

    const state = await read({ basePath: tempDir });
    assert.equal(state.phases[0].todo[0].lifecycle, 'running');
    assert.equal(state.phases[0].todo[1].lifecycle, 'pending');
  });

  it('auto-accepts L0 tasks on checkpoint and increments phase.done', async () => {
    await init({
      project: 'orchestrator-l0-auto-accept',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A', level: 'L0' }] }],
      basePath: tempDir,
    });
    await update({
      updates: {
        current_task: '1.1',
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }],
      },
      basePath: tempDir,
    });

    const result = await handleExecutorResult({
      basePath: tempDir,
      result: {
        task_id: '1.1',
        outcome: 'checkpointed',
        summary: 'Implemented config loader',
        checkpoint_commit: 'abc123',
        files_changed: ['src/config.js'],
        decisions: [],
        blockers: [],
        contract_changed: false,
        evidence: [],
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'continue_execution');
    assert.equal(result.review_level, 'L0');
    assert.equal(result.auto_accepted, true);

    const state = await read({ basePath: tempDir });
    assert.equal(state.phases[0].todo[0].lifecycle, 'accepted');
    assert.equal(state.phases[0].done, 1);
  });

  it('keeps L1 tasks as checkpointed and does not auto-accept', async () => {
    await init({
      project: 'orchestrator-l1-no-auto-accept',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A', level: 'L1' }] }],
      basePath: tempDir,
    });
    await update({
      updates: {
        current_task: '1.1',
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }],
      },
      basePath: tempDir,
    });

    const result = await handleExecutorResult({
      basePath: tempDir,
      result: {
        task_id: '1.1',
        outcome: 'checkpointed',
        summary: 'Built main module',
        checkpoint_commit: 'def456',
        files_changed: ['src/main.js'],
        decisions: [],
        blockers: [],
        contract_changed: false,
        evidence: [],
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'continue_execution');
    assert.equal(result.review_level, 'L1');
    assert.ok(!result.auto_accepted);

    const state = await read({ basePath: tempDir });
    assert.equal(state.phases[0].todo[0].lifecycle, 'checkpointed');
    assert.equal(state.phases[0].done, 0);
  });

  it('stores structured evidence entries from executor result into state.evidence', async () => {
    await init({
      project: 'orchestrator-evidence-store',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({
      updates: {
        current_task: '1.1',
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }],
      },
      basePath: tempDir,
    });

    const result = await handleExecutorResult({
      basePath: tempDir,
      result: {
        task_id: '1.1',
        outcome: 'checkpointed',
        summary: 'Built task A',
        checkpoint_commit: 'ev123',
        files_changed: ['src/a.js'],
        decisions: [],
        blockers: [],
        contract_changed: false,
        evidence: [
          { id: 'ev:test:task-a', scope: 'task:1.1', command: 'npm test', exit_code: 0, timestamp: '2026-03-10T00:00:00Z', summary: 'tests passed' },
          { id: 'ev:lint:task-a', scope: 'task:1.1', command: 'npm run lint', exit_code: 0, timestamp: '2026-03-10T00:00:00Z', summary: 'lint passed' },
          'ev:string-only-ref',
        ],
      },
    });

    assert.equal(result.success, true);

    const state = await read({ basePath: tempDir });
    // Structured evidence entries should be in state.evidence
    assert.ok(state.evidence['ev:test:task-a'], 'structured evidence entry should be stored');
    assert.equal(state.evidence['ev:test:task-a'].command, 'npm test');
    assert.equal(state.evidence['ev:test:task-a'].scope, 'task:1.1');
    assert.ok(state.evidence['ev:lint:task-a'], 'second evidence entry should be stored');
    // String-only refs should NOT be stored as evidence data
    assert.equal(state.evidence['ev:string-only-ref'], undefined);
    // evidence_refs on the task should contain all entries
    assert.equal(state.phases[0].todo[0].evidence_refs.length, 3);
  });

  it('handles executor blocked outcome with string blocker', async () => {
    await init({
      project: 'orchestrator-blocked-string',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({
      updates: {
        current_task: '1.1',
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }],
      },
      basePath: tempDir,
    });

    const result = await handleExecutorResult({
      basePath: tempDir,
      result: {
        task_id: '1.1',
        outcome: 'blocked',
        summary: 'Blocked by external dependency',
        files_changed: [],
        decisions: [],
        blockers: ['Need API key from vendor'],
        contract_changed: false,
        evidence: [],
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'awaiting_user');
    assert.equal(result.blockers[0].reason, 'Need API key from vendor');

    const state = await read({ basePath: tempDir });
    assert.equal(state.phases[0].todo[0].lifecycle, 'blocked');
    assert.equal(state.phases[0].todo[0].blocked_reason, 'Need API key from vendor');
  });

  it('handles executor blocked outcome with object blocker', async () => {
    await init({
      project: 'orchestrator-blocked-object',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({
      updates: {
        current_task: '1.1',
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }],
      },
      basePath: tempDir,
    });

    const result = await handleExecutorResult({
      basePath: tempDir,
      result: {
        task_id: '1.1',
        outcome: 'blocked',
        summary: 'Blocked',
        files_changed: [],
        decisions: [],
        blockers: [{ reason: 'Need DB schema', unblock_condition: 'DBA approves migration' }],
        contract_changed: false,
        evidence: [],
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'awaiting_user');
    assert.equal(result.blockers[0].reason, 'Need DB schema');
    assert.equal(result.blockers[0].unblock_condition, 'DBA approves migration');
  });

  it('handles executor blocked outcome with empty blockers array', async () => {
    await init({
      project: 'orchestrator-blocked-empty',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({
      updates: {
        current_task: '1.1',
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }],
      },
      basePath: tempDir,
    });

    const result = await handleExecutorResult({
      basePath: tempDir,
      result: {
        task_id: '1.1',
        outcome: 'blocked',
        summary: 'Something blocked this',
        files_changed: [],
        decisions: [],
        blockers: [],
        contract_changed: false,
        evidence: [],
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'awaiting_user');
    // When no blockers, blocked_reason falls back to summary
    assert.equal(result.blockers[0].reason, 'Something blocked this');
  });

  it('handles executor failure with no error_fingerprint — uses summary truncation', async () => {
    await init({
      project: 'orchestrator-no-fingerprint',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({
      updates: {
        current_task: '1.1',
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }],
      },
      basePath: tempDir,
    });

    const result = await handleExecutorResult({
      basePath: tempDir,
      result: {
        task_id: '1.1',
        outcome: 'failed',
        summary: 'A very long error message that should be truncated to 80 characters for the error fingerprint value',
        files_changed: [],
        decisions: [],
        blockers: [],
        contract_changed: false,
        evidence: [],
      },
    });

    assert.equal(result.success, true);
    const state = await read({ basePath: tempDir });
    assert.ok(state.phases[0].todo[0].last_error_fingerprint.length <= 80);
  });

  it('rejects executor result with invalid input types', async () => {
    const resultNull = await handleExecutorResult({ result: null, basePath: tempDir });
    assert.equal(resultNull.error, true);
    assert.match(resultNull.message, /result must be an object/);

    const resultArray = await handleExecutorResult({ result: [], basePath: tempDir });
    assert.equal(resultArray.error, true);
    assert.match(resultArray.message, /result must be an object/);
  });

  it('rejects executor result for non-existent task', async () => {
    await init({
      project: 'orchestrator-no-task',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });

    const result = await handleExecutorResult({
      basePath: tempDir,
      result: {
        task_id: '99.99',
        outcome: 'checkpointed',
        summary: 'done',
        checkpoint_commit: 'abc',
        files_changed: [],
        decisions: [],
        blockers: [],
        contract_changed: false,
        evidence: [],
      },
    });

    assert.equal(result.error, true);
    assert.match(result.message, /not found/);
  });

  it('accumulates decisions from executor results', async () => {
    await init({
      project: 'orchestrator-decisions',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({
      updates: {
        current_task: '1.1',
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }],
      },
      basePath: tempDir,
    });

    const result = await handleExecutorResult({
      basePath: tempDir,
      result: {
        task_id: '1.1',
        outcome: 'checkpointed',
        summary: 'done',
        checkpoint_commit: 'abc',
        files_changed: ['src/a.js'],
        decisions: [
          'Use PostgreSQL',
          { id: 'custom-id', summary: 'Custom decision' },
          null,
        ],
        blockers: [],
        contract_changed: false,
        evidence: [],
      },
    });

    assert.equal(result.success, true);
    const state = await read({ basePath: tempDir });
    // String decision should be converted
    assert.ok(state.decisions.some(d => d.summary === 'Use PostgreSQL'));
    // Object decision with custom id should be kept
    assert.ok(state.decisions.some(d => d.id === 'custom-id'));
    // Null entries should be filtered out
    assert.equal(state.decisions.length, 2);
  });

  it('triggers L2 review for checkpointed task with contract_changed + sensitive keyword', async () => {
    await init({
      project: 'orchestrator-l2-review',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Implement auth endpoint', level: 'L1' }] }],
      basePath: tempDir,
    });
    await update({
      updates: {
        current_task: '1.1',
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }],
      },
      basePath: tempDir,
    });

    const result = await handleExecutorResult({
      basePath: tempDir,
      result: {
        task_id: '1.1',
        outcome: 'checkpointed',
        summary: 'Changed API contract',
        checkpoint_commit: 'xyz',
        files_changed: ['src/api.js'],
        decisions: [],
        blockers: [],
        contract_changed: true,
        evidence: [],
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.review_level, 'L2');
    assert.equal(result.action, 'dispatch_reviewer');
    assert.equal(result.workflow_mode, 'reviewing_task');
    assert.deepEqual(result.current_review, { scope: 'task', scope_id: '1.1', stage: 'spec' });
  });

  it('resumes reviewing_task without current_review by deriving from current_task', async () => {
    await init({
      project: 'orchestrator-review-task-derive',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] },
      basePath: tempDir,
    });
    await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'checkpointed', checkpoint_commit: 'abc' }] }] },
      basePath: tempDir,
    });
    await update({
      updates: {
        workflow_mode: 'reviewing_task',
        current_task: '1.1',
        current_review: null,
      },
      basePath: tempDir,
    });

    const result = await resumeWorkflow({ basePath: tempDir });
    assert.equal(result.success, true);
    assert.equal(result.action, 'dispatch_reviewer');
    assert.equal(result.review_scope, 'task');
  });

  it('returns error for reviewing_task without current_review or current_task', async () => {
    await init({
      project: 'orchestrator-review-task-no-id',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({
      updates: {
        workflow_mode: 'reviewing_task',
        current_task: null,
        current_review: null,
      },
      basePath: tempDir,
    });

    const result = await resumeWorkflow({ basePath: tempDir });
    assert.equal(result.error, true);
    assert.match(result.message, /requires current_review/);
  });

  it('resumes reviewing_phase without current_review and persists derived review', async () => {
    await init({
      project: 'orchestrator-review-phase-derive',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({
      updates: {
        workflow_mode: 'reviewing_phase',
        current_review: null,
      },
      basePath: tempDir,
    });

    const result = await resumeWorkflow({ basePath: tempDir });
    assert.equal(result.success, true);
    assert.equal(result.action, 'dispatch_reviewer');
    assert.equal(result.review_scope, 'phase');

    const state = await read({ basePath: tempDir });
    assert.deepEqual(state.current_review, { scope: 'phase', scope_id: 1 });
  });

  it('returns failed workflow info including failed_phases and failed_tasks', async () => {
    await init({
      project: 'orchestrator-failed-info',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }, { index: 2, name: 'Task B' }] }],
      basePath: tempDir,
    });
    // Transition task to running first, then to failed
    await update({
      updates: {
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }],
      },
      basePath: tempDir,
    });
    await update({
      updates: {
        phases: [{ id: 1, lifecycle: 'failed', todo: [
          { id: '1.1', lifecycle: 'failed' },
        ] }],
      },
      basePath: tempDir,
    });
    await update({
      updates: { workflow_mode: 'failed' },
      basePath: tempDir,
    });

    const result = await resumeWorkflow({ basePath: tempDir });
    assert.equal(result.success, true);
    assert.equal(result.action, 'await_recovery_decision');
    assert.equal(result.workflow_mode, 'failed');
    assert.deepEqual(result.failed_phases, [{ id: 1, name: 'Core' }]);
    assert.equal(result.failed_tasks.length, 1);
    assert.equal(result.failed_tasks[0].id, '1.1');
    assert.equal(result.failed_tasks[0].name, 'Task A');
    assert.equal(result.failed_tasks[0].phase_id, 1);
    assert.deepEqual(result.recovery_options, ['retry_failed', 'skip_failed', 'replan']);
  });

  it('handles debugger result with task_failed (non-architecture)', async () => {
    await init({
      project: 'orchestrator-debugger-task-fail',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    await update({
      updates: {
        current_task: '1.1',
        current_review: { scope: 'task', scope_id: '1.1', stage: 'debugging' },
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running', retry_count: 3 }] }],
      },
      basePath: tempDir,
    });

    const result = await handleDebuggerResult({
      basePath: tempDir,
      result: {
        task_id: '1.1',
        outcome: 'failed',
        root_cause: 'Logic error unfixable within scope',
        evidence: ['ev1'],
        hypothesis_tested: [],
        fix_direction: 'None viable',
        fix_attempts: 3,
        blockers: [],
        architecture_concern: false,
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'task_failed');
    // No progressable tasks remain → escalates to awaiting_user
    assert.equal(result.workflow_mode, 'awaiting_user');

    const state = await read({ basePath: tempDir });
    assert.equal(state.phases[0].todo[0].lifecycle, 'failed');
    assert.equal(state.phases[0].lifecycle, 'active'); // Phase not failed when no architecture_concern
  });

  it('debugger task_failed stays executing_task when other tasks remain', async () => {
    await init({
      project: 'debugger-partial-fail',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'A' }, { index: 2, name: 'B' }] }],
      basePath: tempDir,
    });
    await update({
      updates: {
        current_task: '1.1',
        current_review: { scope: 'task', scope_id: '1.1', stage: 'debugging' },
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running', retry_count: 3 }] }],
      },
      basePath: tempDir,
    });
    const result = await handleDebuggerResult({
      basePath: tempDir,
      result: {
        task_id: '1.1', outcome: 'failed', root_cause: 'unfixable',
        evidence: [], hypothesis_tested: [], fix_direction: 'none',
        fix_attempts: 3, blockers: [], architecture_concern: false,
      },
    });
    assert.equal(result.workflow_mode, 'executing_task');
  });

  it('reviewer propagation decrements done for accepted downstream tasks', async () => {
    // Setup: A (checkpointed) → B depends on A (accepted, done=1), critical issue invalidates A downstream
    await init({
      project: 'done-counter-propagation',
      phases: [{ name: 'Core', tasks: [
        { index: 1, name: 'A', review_required: false },
        { index: 2, name: 'B', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }], review_required: false },
      ] }],
      basePath: tempDir,
    });
    // Transition tasks through valid lifecycle: pending→running→checkpointed→accepted
    await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }, { id: '1.2', lifecycle: 'running' }] }] }, basePath: tempDir });
    await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'checkpointed' }, { id: '1.2', lifecycle: 'checkpointed' }] }] }, basePath: tempDir });
    await update({ updates: { phases: [{ id: 1, done: 1, todo: [{ id: '1.2', lifecycle: 'accepted' }] }] }, basePath: tempDir });
    const result = await handleReviewerResult({
      basePath: tempDir,
      result: {
        scope: 'phase', scope_id: 1, review_level: 'L1-batch',
        spec_passed: false, quality_passed: false,
        critical_issues: [{ task_id: '1.1', reason: 'contract broken', invalidates_downstream: true }],
        important_issues: [], minor_issues: [],
        accepted_tasks: [], rework_tasks: ['1.1'], evidence: [],
      },
    });
    assert.equal(result.success, true);
    const state = await read({ basePath: tempDir });
    // B was accepted (done=1), propagated to needs_revalidation → doneDecrement should include B
    assert.equal(state.phases[0].done, 0);
    assert.equal(state.phases[0].todo[1].lifecycle, 'needs_revalidation');
  });

  it('rejects debugger result with non-object input', async () => {
    const resultNull = await handleDebuggerResult({ result: null, basePath: tempDir });
    assert.equal(resultNull.error, true);
    assert.match(resultNull.message, /result must be an object/);

    const resultArray = await handleDebuggerResult({ result: [], basePath: tempDir });
    assert.equal(resultArray.error, true);
  });

  it('rejects debugger result for non-existent task', async () => {
    await init({
      project: 'orchestrator-debugger-no-task',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });

    const result = await handleDebuggerResult({
      basePath: tempDir,
      result: {
        task_id: '99.99',
        outcome: 'fix_suggested',
        root_cause: 'unknown',
        evidence: [],
        hypothesis_tested: [],
        fix_direction: 'try again',
        fix_attempts: 0,
        blockers: [],
        architecture_concern: false,
      },
    });

    assert.equal(result.error, true);
    assert.match(result.message, /not found/);
  });

  it('rejects researcher result with non-object input', async () => {
    const resultNull = await handleResearcherResult({ result: null, basePath: tempDir });
    assert.equal(resultNull.error, true);
    assert.match(resultNull.message, /result must be an object/);

    const resultArray = await handleResearcherResult({ result: [], basePath: tempDir });
    assert.equal(resultArray.error, true);
  });

  it('rejects invalid researcher result', async () => {
    const result = await handleResearcherResult({
      result: { decision_ids: 'not-array' },
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /Invalid researcher result/);
  });

  it('handles reviewer result for phase scope with scope_id lookup', async () => {
    await init({
      project: 'orchestrator-reviewer-phase-scope',
      phases: [
        { name: 'Phase 1', tasks: [{ index: 1, name: 'Task A' }] },
        { name: 'Phase 2', tasks: [{ index: 1, name: 'Task B' }] },
      ],
      basePath: tempDir,
    });
    // checkpoint task in phase 1
    await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] },
      basePath: tempDir,
    });
    await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'checkpointed', checkpoint_commit: 'abc' }] }] },
      basePath: tempDir,
    });

    const result = await handleReviewerResult({
      basePath: tempDir,
      result: {
        scope: 'phase',
        scope_id: 1,
        review_level: 'L1-batch',
        spec_passed: true,
        quality_passed: true,
        critical_issues: [],
        important_issues: [],
        minor_issues: [],
        accepted_tasks: ['1.1'],
        rework_tasks: [],
        evidence: [{ id: 'ev:review:1', scope: 'phase:1', summary: 'review evidence' }],
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'review_accepted');

    const state = await read({ basePath: tempDir });
    assert.ok(state.evidence['ev:review:1']);
  });

  it('returns idle when no runnable task found (all accepted)', async () => {
    await init({
      project: 'orchestrator-idle',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    // Move through full lifecycle manually without using orchestrator
    await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] },
      basePath: tempDir,
    });
    await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'checkpointed', checkpoint_commit: 'abc' }] }] },
      basePath: tempDir,
    });
    await update({
      updates: { phases: [{ id: 1, done: 1, todo: [{ id: '1.1', lifecycle: 'accepted' }] }] },
      basePath: tempDir,
    });

    const result = await resumeWorkflow({ basePath: tempDir });
    // Should trigger review or idle, depending on selectRunnableTask logic
    assert.equal(result.success, true);
  });

  it('multi-round rework propagation: rework A invalidates B and C, then rework B invalidates C again', async () => {
    // Setup: Phase with 3 tasks A -> B -> C (chain dependency), all accepted
    await init({
      project: 'multi-round-rework',
      phases: [{ name: 'Core', tasks: [
        { index: 1, name: 'Task A' },
        { index: 2, name: 'Task B', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }] },
        { index: 3, name: 'Task C', requires: [{ kind: 'task', id: '1.2', gate: 'accepted' }] },
      ] }],
      basePath: tempDir,
    });

    // Move all tasks through lifecycle: pending -> running -> checkpointed -> accepted
    for (const taskId of ['1.1', '1.2', '1.3']) {
      await update({ updates: { phases: [{ id: 1, todo: [{ id: taskId, lifecycle: 'running' }] }] }, basePath: tempDir });
      await update({ updates: { phases: [{ id: 1, todo: [{ id: taskId, lifecycle: 'checkpointed', checkpoint_commit: `commit-${taskId}` }] }] }, basePath: tempDir });
      await update({ updates: { phases: [{ id: 1, todo: [{ id: taskId, lifecycle: 'accepted' }] }] }, basePath: tempDir });
    }
    await update({ updates: { phases: [{ id: 1, done: 3 }] }, basePath: tempDir });

    // Round 1: Reviewer reworks A with invalidates_downstream: true
    const round1 = await handleReviewerResult({
      basePath: tempDir,
      result: {
        scope: 'phase', scope_id: 1, review_level: 'L1-batch',
        spec_passed: false, quality_passed: false,
        critical_issues: [{ task_id: '1.1', reason: 'broken contract', invalidates_downstream: true }],
        important_issues: [], minor_issues: [],
        accepted_tasks: [], rework_tasks: ['1.1'], evidence: [],
      },
    });

    assert.equal(round1.success, true);
    assert.equal(round1.action, 'rework_required');

    let state = await read({ basePath: tempDir });
    // A should be needs_revalidation (rework_tasks)
    assert.equal(state.phases[0].todo[0].lifecycle, 'needs_revalidation');
    // B and C should also be needs_revalidation (propagated from A)
    assert.equal(state.phases[0].todo[1].lifecycle, 'needs_revalidation');
    assert.equal(state.phases[0].todo[2].lifecycle, 'needs_revalidation');
    // done counter should be decremented: 3 tasks were accepted, all 3 now need revalidation
    assert.equal(state.phases[0].done, 0);

    // Fix A and B: move them back through lifecycle
    for (const taskId of ['1.1', '1.2']) {
      await update({ updates: { phases: [{ id: 1, todo: [{ id: taskId, lifecycle: 'pending' }] }] }, basePath: tempDir });
      await update({ updates: { phases: [{ id: 1, todo: [{ id: taskId, lifecycle: 'running' }] }] }, basePath: tempDir });
      await update({ updates: { phases: [{ id: 1, todo: [{ id: taskId, lifecycle: 'checkpointed', checkpoint_commit: `fix-${taskId}` }] }] }, basePath: tempDir });
      await update({ updates: { phases: [{ id: 1, todo: [{ id: taskId, lifecycle: 'accepted' }] }] }, basePath: tempDir });
    }
    await update({ updates: { phases: [{ id: 1, done: 2 }] }, basePath: tempDir });
    // Fix C too
    await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.3', lifecycle: 'pending' }] }] }, basePath: tempDir });
    await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.3', lifecycle: 'running' }] }] }, basePath: tempDir });
    await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.3', lifecycle: 'checkpointed', checkpoint_commit: 'fix-1.3' }] }] }, basePath: tempDir });
    await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.3', lifecycle: 'accepted' }] }] }, basePath: tempDir });
    await update({ updates: { phases: [{ id: 1, done: 3 }] }, basePath: tempDir });

    // Round 2: Reviewer reworks B with invalidates_downstream: true
    const round2 = await handleReviewerResult({
      basePath: tempDir,
      result: {
        scope: 'phase', scope_id: 1, review_level: 'L1-batch',
        spec_passed: false, quality_passed: false,
        critical_issues: [{ task_id: '1.2', reason: 'API change', invalidates_downstream: true }],
        important_issues: [], minor_issues: [],
        accepted_tasks: [], rework_tasks: ['1.2'], evidence: [],
      },
    });

    assert.equal(round2.success, true);
    assert.equal(round2.action, 'rework_required');

    state = await read({ basePath: tempDir });
    // A should still be accepted (not downstream of B)
    assert.equal(state.phases[0].todo[0].lifecycle, 'accepted');
    // B should be needs_revalidation (rework_tasks)
    assert.equal(state.phases[0].todo[1].lifecycle, 'needs_revalidation');
    // C should be needs_revalidation again (propagated from B)
    assert.equal(state.phases[0].todo[2].lifecycle, 'needs_revalidation');
    // done counter: was 3, B and C invalidated = -2 = 1
    assert.equal(state.phases[0].done, 1);
  });

  it('returns error when resumeWorkflow recursive depth exceeds MAX_RESUME_DEPTH', async () => {
    await init({
      project: 'orchestrator-depth-limit',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });

    // Call with _depth at the limit (3) — should be rejected immediately
    const result = await resumeWorkflow({ basePath: tempDir, _depth: 3 });
    assert.equal(result.error, true);
    assert.ok(result.message.includes('depth'), `Expected depth-related error, got: ${result.message}`);
  });

  it('allows resumeWorkflow recursive calls below MAX_RESUME_DEPTH', async () => {
    await init({
      project: 'orchestrator-depth-ok',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });

    // Call with _depth=2 (below limit of 3) — should succeed normally
    const result = await resumeWorkflow({ basePath: tempDir, _depth: 2 });
    assert.equal(result.success, true);
    assert.equal(result.action, 'dispatch_executor');
  });
});