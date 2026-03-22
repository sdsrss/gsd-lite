import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, read, update } from '../src/tools/state/index.js';
import { handleResearcherResult, resumeWorkflow } from '../src/tools/orchestrator/index.js';

async function withProject(name, fn, { git = false, research = false } = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), `gsd-${name}-`));
  try {
    if (git) {
      execSync('git init', { cwd: tempDir, stdio: 'ignore' });
      execSync('git config user.email test@example.com', { cwd: tempDir, stdio: 'ignore' });
      execSync('git config user.name Test User', { cwd: tempDir, stdio: 'ignore' });
      writeFileSync(join(tempDir, 'README.md'), 'init\n');
      execSync('git add README.md', { cwd: tempDir, stdio: 'ignore' });
      execSync('git commit -m init', { cwd: tempDir, stdio: 'ignore' });
    }

    await init({
      project: name,
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }, { index: 2, name: 'Task B', level: 'L0' }] }],
      research,
      basePath: tempDir,
    });
    await fn(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe('resume flow matrix', () => {
  it('covers executing_task, reviewing_task, reviewing_phase, awaiting_clear, and awaiting_user', async () => {
    await withProject('resume-executing', async (tempDir) => {
      await update({ updates: { current_task: '1.1', phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: tempDir });
      const executing = await resumeWorkflow({ basePath: tempDir });
      assert.equal(executing.action, 'dispatch_executor');
      assert.equal(executing.task_id, '1.1');
      assert.equal(executing.interruption_recovered, true);
    });

    await withProject('resume-reviewing-task', async (tempDir) => {
      await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running', level: 'L2' }] }] }, basePath: tempDir });
      await update({
        updates: {
          phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'checkpointed', level: 'L2', checkpoint_commit: 'abc123' }] }],
        },
        basePath: tempDir,
      });
      await update({
        updates: {
          workflow_mode: 'reviewing_task',
          current_review: { scope: 'task', scope_id: '1.1', stage: 'spec' },
        },
        basePath: tempDir,
      });
      const reviewingTask = await resumeWorkflow({ basePath: tempDir });
      assert.equal(reviewingTask.action, 'dispatch_reviewer');
      assert.equal(reviewingTask.review_scope, 'task');
      assert.equal(reviewingTask.review_target.id, '1.1');
    });

    await withProject('resume-reviewing-phase', async (tempDir) => {
      await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: tempDir });
      await update({
        updates: {
          phases: [{ id: 1, todo: [
            { id: '1.1', lifecycle: 'checkpointed', level: 'L1', checkpoint_commit: 'abc123' },
            { id: '1.2', lifecycle: 'running', level: 'L0' },
          ] }],
        },
        basePath: tempDir,
      });
      await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.2', lifecycle: 'checkpointed', level: 'L0', checkpoint_commit: 'l0-commit' }] }] }, basePath: tempDir });
      await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.2', lifecycle: 'accepted', level: 'L0', checkpoint_commit: 'l0-commit' }] }] }, basePath: tempDir });
      await update({ updates: { workflow_mode: 'reviewing_phase', current_review: { scope: 'phase', scope_id: 1 } }, basePath: tempDir });
      const reviewingPhase = await resumeWorkflow({ basePath: tempDir });
      assert.equal(reviewingPhase.action, 'dispatch_reviewer');
      assert.deepEqual(reviewingPhase.review_targets, [{ id: '1.1', level: 'L1', checkpoint_commit: 'abc123', files_changed: [] }]);
    });

    await withProject('resume-awaiting-clear', async (tempDir) => {
      writeFileSync(join(tempDir, '.gsd', '.context-health'), '75');
      await update({ updates: { current_task: '1.1', phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: tempDir });
      await update({ updates: { workflow_mode: 'awaiting_clear' }, basePath: tempDir });
      const awaitingClear = await resumeWorkflow({ basePath: tempDir });
      assert.equal(awaitingClear.action, 'dispatch_executor');
      assert.equal(awaitingClear.workflow_mode, 'executing_task');
    });

    await withProject('resume-awaiting-user', async (tempDir) => {
      await update({
        updates: {
          workflow_mode: 'awaiting_user',
          phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'blocked', blocked_reason: 'Need API direction', unblock_condition: 'User clarifies REST vs GraphQL' }] }],
        },
        basePath: tempDir,
      });
      const awaitingUser = await resumeWorkflow({ basePath: tempDir });
      assert.equal(awaitingUser.action, 'awaiting_user');
      assert.equal(awaitingUser.blockers[0].id, '1.1');
    });
  });

  it('covers paused_by_user, reconcile_workspace, replan_required, direction drift, completed, and failed', async () => {
    await withProject('resume-paused', async (tempDir) => {
      await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: tempDir });
      const paused = await resumeWorkflow({ basePath: tempDir });
      assert.equal(paused.action, 'await_manual_intervention');
    });

    await withProject('resume-completed', async (tempDir) => {
      // Advance all tasks through full lifecycle before accepting phase
      for (const taskId of ['1.1', '1.2']) {
        await update({ updates: { phases: [{ id: 1, todo: [{ id: taskId, lifecycle: 'running' }] }] }, basePath: tempDir });
        await update({ updates: { phases: [{ id: 1, todo: [{ id: taskId, lifecycle: 'checkpointed', checkpoint_commit: 'abc' }] }] }, basePath: tempDir });
        await update({ updates: { phases: [{ id: 1, todo: [{ id: taskId, lifecycle: 'accepted' }] }] }, basePath: tempDir });
      }
      await update({ updates: { phases: [{ id: 1, lifecycle: 'reviewing' }] }, basePath: tempDir });
      await update({ updates: { phases: [{ id: 1, lifecycle: 'accepted' }] }, basePath: tempDir });
      // Walk workflow: executing_task→reviewing_phase→completed
      await update({ updates: { workflow_mode: 'reviewing_phase', current_review: { scope: 'phase', scope_id: 1 } }, basePath: tempDir });
      await update({ updates: { workflow_mode: 'completed' }, basePath: tempDir });
      const completed = await resumeWorkflow({ basePath: tempDir });
      assert.equal(completed.action, 'noop');
      assert.equal(completed.completed_phases, 1);
    });

    await withProject('resume-failed', async (tempDir) => {
      await update({ updates: { current_task: '1.1', phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: tempDir });
      await update({ updates: { phases: [{ id: 1, lifecycle: 'failed', todo: [{ id: '1.1', lifecycle: 'failed' }] }] }, basePath: tempDir });
      await update({ updates: { workflow_mode: 'failed' }, basePath: tempDir });
      const failed = await resumeWorkflow({ basePath: tempDir });
      assert.equal(failed.action, 'await_recovery_decision');
      assert.deepEqual(failed.failed_tasks, [{ id: '1.1', name: 'Task A', phase_id: 1, retry_count: 0, last_failure_summary: null, debug_context: null }]);
      assert.deepEqual(failed.recovery_options, ['retry_failed', 'skip_failed', 'replan']);
    });

    await withProject('resume-reconcile', async (tempDir) => {
      await update({ updates: { git_head: 'deadbeef' }, basePath: tempDir });
      const reconcile = await resumeWorkflow({ basePath: tempDir });
      assert.equal(reconcile.workflow_mode, 'reconcile_workspace');
      assert.equal(reconcile.action, 'await_manual_intervention');
    }, { git: true });

    await withProject('resume-replan', async (tempDir) => {
      await update({ updates: { context: { last_session: new Date(Date.now() - 5000).toISOString(), remaining_percentage: 100 } }, basePath: tempDir });
      writeFileSync(join(tempDir, '.gsd', 'phases', 'phase-1.md'), '# modified\n');
      const replan = await resumeWorkflow({ basePath: tempDir });
      assert.equal(replan.workflow_mode, 'replan_required');
      assert.ok(replan.changed_files.includes('phases/phase-1.md'));
    });

    await withProject('resume-direction-drift', async (tempDir) => {
      await update({
        updates: {
          workflow_mode: 'executing_task',
          phases: [{ id: 1, phase_handoff: { direction_ok: false } }],
        },
        basePath: tempDir,
      });
      const drift = await resumeWorkflow({ basePath: tempDir });
      assert.equal(drift.workflow_mode, 'awaiting_user');
      assert.equal(drift.action, 'awaiting_user');
      assert.deepEqual(drift.drift_phase, { id: 1, name: 'Core' });
    });
  });

  it('preflight returns pending_issues hints when multiple issues exist', async () => {
    await withProject('resume-multi-preflight', async (tempDir) => {
      // Set up git drift + direction drift simultaneously
      await update({
        updates: {
          git_head: 'deadbeef',
          phases: [{ id: 1, phase_handoff: { direction_ok: false } }],
        },
        basePath: tempDir,
      });
      const result = await resumeWorkflow({ basePath: tempDir });
      // Primary issue should be git drift (first checked)
      assert.equal(result.workflow_mode, 'reconcile_workspace');
      // Should include hints about remaining issues
      assert.ok(Array.isArray(result.pending_issues));
      assert.ok(result.pending_issues.length >= 1);
    }, { git: true });
  });

  it('covers research_refresh_needed by refreshing research and resuming execution', async () => {
    await withProject('resume-research', async (tempDir) => {
      await update({
        updates: {
          workflow_mode: 'research_refresh_needed',
          research: {
            expires_at: '2000-01-01T00:00:00Z',
            decision_index: {
              'decision:jwt-rotation': { summary: 'Use JWT rotation', expires_at: '2000-01-01T00:00:00Z' },
            },
          },
          phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'pending', research_basis: ['decision:jwt-rotation'] }] }],
        },
        basePath: tempDir,
      });

      const preflight = await resumeWorkflow({ basePath: tempDir });
      assert.equal(preflight.action, 'dispatch_researcher');
      assert.equal(preflight.workflow_mode, 'research_refresh_needed');

      const stored = await handleResearcherResult({
        basePath: tempDir,
        result: {
          decision_ids: ['decision:jwt-rotation'],
          volatility: 'medium',
          expires_at: '2099-03-16T10:30:00Z',
          sources: [{ id: 'src1', type: 'Context7', ref: 'Next.js auth docs' }],
        },
        decision_index: {
          'decision:jwt-rotation': { summary: 'Use refresh token rotation', source: 'Context7', expires_at: '2099-03-16T10:30:00Z' },
        },
        artifacts: {
          'STACK.md': '# Stack\n',
          'ARCHITECTURE.md': '# Architecture\n',
          'PITFALLS.md': '# Pitfalls\n',
          'SUMMARY.md': '# Summary\nvolatility: medium\nexpires_at: 2099-03-16T10:30:00Z\ndecisions:\n- decision:jwt-rotation\n',
        },
      });
      assert.equal(stored.action, 'research_stored');

      // Caller now explicitly resumes (researcher no longer auto-advances)
      const resumed = await resumeWorkflow({ basePath: tempDir });
      assert.equal(resumed.action, 'dispatch_executor');

      const state = await read({ basePath: tempDir });
      assert.equal(state.workflow_mode, 'executing_task');
      assert.equal(state.research.decision_index['decision:jwt-rotation'].summary, 'Use refresh token rotation');
    }, { research: true });
  });

  it('paused_by_user with phase review returns resume_to=reviewing_phase', async () => {
    await withProject('resume-paused-review-phase', async (tempDir) => {
      await update({
        updates: {
          workflow_mode: 'paused_by_user',
          current_review: { scope: 'phase', scope_id: 1 },
        },
        basePath: tempDir,
      });
      const result = await resumeWorkflow({ basePath: tempDir });
      assert.equal(result.action, 'await_manual_intervention');
      assert.equal(result.resume_to, 'reviewing_phase');
    });
  });

  it('paused_by_user with task review returns resume_to=reviewing_task', async () => {
    await withProject('resume-paused-review-task', async (tempDir) => {
      await update({
        updates: {
          workflow_mode: 'paused_by_user',
          current_review: { scope: 'task', scope_id: '1.1', stage: 'spec' },
        },
        basePath: tempDir,
      });
      const result = await resumeWorkflow({ basePath: tempDir });
      assert.equal(result.action, 'await_manual_intervention');
      assert.equal(result.resume_to, 'reviewing_task');
    });
  });

  it('paused_by_user without review returns resume_to=executing_task', async () => {
    await withProject('resume-paused-no-review', async (tempDir) => {
      await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: tempDir });
      const result = await resumeWorkflow({ basePath: tempDir });
      assert.equal(result.action, 'await_manual_intervention');
      assert.equal(result.resume_to, 'executing_task');
    });
  });

  it('failed mode returns structured recovery info with task details', async () => {
    await withProject('resume-failed-detailed', async (tempDir) => {
      await update({ updates: { current_task: '1.1', phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: tempDir });
      await update({
        updates: {
          phases: [{
            id: 1,
            lifecycle: 'failed',
            todo: [{
              id: '1.1',
              lifecycle: 'failed',
              retry_count: 2,
              last_failure_summary: 'Test assertion failed in auth module',
              debug_context: { root_cause: 'Missing token refresh', fix_direction: 'Add refresh logic' },
            }],
          }],
        },
        basePath: tempDir,
      });
      await update({ updates: { workflow_mode: 'failed' }, basePath: tempDir });
      const result = await resumeWorkflow({ basePath: tempDir });

      // Action should indicate recovery decision needed
      assert.equal(result.success, true);
      assert.equal(result.action, 'await_recovery_decision');
      assert.equal(result.workflow_mode, 'failed');

      // Failed phases should be objects with id and name
      assert.equal(result.failed_phases.length, 1);
      assert.equal(result.failed_phases[0].id, 1);
      assert.equal(result.failed_phases[0].name, 'Core');

      // Failed tasks should include detail fields
      assert.equal(result.failed_tasks.length, 1);
      const ft = result.failed_tasks[0];
      assert.equal(ft.id, '1.1');
      assert.equal(ft.name, 'Task A');
      assert.equal(ft.phase_id, 1);
      assert.equal(ft.retry_count, 2);
      assert.equal(ft.last_failure_summary, 'Test assertion failed in auth module');
      assert.deepEqual(ft.debug_context, { root_cause: 'Missing token refresh', fix_direction: 'Add refresh logic' });

      // Recovery options per resume.md spec
      assert.deepEqual(result.recovery_options, ['retry_failed', 'skip_failed', 'replan']);

      // Message should mention recovery
      assert.match(result.message, /[Rr]ecovery/);
    });
  });

  it('returns await_manual_intervention for planning workflow mode', async () => {
    await withProject('resume-planning', async (tempDir) => {
      await update({ updates: { workflow_mode: 'planning' }, basePath: tempDir });
      const result = await resumeWorkflow({ basePath: tempDir });
      assert.equal(result.success, true);
      assert.equal(result.action, 'await_manual_intervention');
      assert.equal(result.workflow_mode, 'planning');
      assert.match(result.message, /planning mode/);
      assert.ok(result.guidance);
    });
  });
});