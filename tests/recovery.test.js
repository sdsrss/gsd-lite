import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, read, update, patchPlan } from '../src/tools/state/index.js';
import { resumeWorkflow } from '../src/tools/orchestrator/index.js';

async function withProject(name, fn, phases) {
  const tempDir = await mkdtemp(join(tmpdir(), `gsd-${name}-`));
  try {
    await init({
      project: name,
      phases: phases || [{
        name: 'Core',
        tasks: [{ index: 1, name: 'Task A' }, { index: 2, name: 'Task B', level: 'L0' }],
      }],
      basePath: tempDir,
    });
    await fn(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Walk a legal transition path and fail loudly if any step is rejected.
 *
 * Setting the mode directly does not work from every starting point — init
 * leaves the project in `planning`, which only reaches executing_task or
 * paused_by_user. A setup that silently no-ops leaves the test asserting
 * against the wrong state and passing for the wrong reason.
 */
async function walkModes(basePath, modes) {
  for (const mode of modes) {
    const result = await update({ updates: { workflow_mode: mode }, basePath });
    assert.ok(!result.error, `setup: could not reach ${mode} — ${result.code}: ${result.message}`);
  }
  const state = await read({ basePath });
  assert.equal(state.workflow_mode, modes[modes.length - 1], 'setup: workflow_mode did not stick');
}

async function step(basePath, updates, label) {
  const result = await update({ updates, basePath });
  assert.ok(!result.error, `setup: ${label} — ${result.code}: ${result.message}`);
  return result;
}

/** Drive the project into the state a debugger `architecture_concern: true` leaves behind. */
async function enterFailed(basePath, { taskId = '1.1' } = {}) {
  await walkModes(basePath, ['executing_task']);
  // A task only reaches `failed` by way of `running` — pending → failed is not
  // a legal lifecycle edge.
  await step(basePath, { current_task: taskId, phases: [{ id: 1, todo: [{ id: taskId, lifecycle: 'running' }] }] }, 'could not start the task');
  await step(basePath, {
    current_task: null,
    phases: [{ id: 1, lifecycle: 'failed', todo: [{ id: taskId, lifecycle: 'failed', retry_count: 3 }] }],
  }, 'could not mark the phase failed');
  await walkModes(basePath, ['failed']);
}

async function enterCompleted(basePath) {
  await walkModes(basePath, ['executing_task']);
  const todo = ['1.1', '1.2'];
  await step(basePath, { phases: [{ id: 1, todo: todo.map(id => ({ id, lifecycle: 'running' })) }] }, 'could not start the tasks');
  await step(basePath, { phases: [{ id: 1, todo: todo.map(id => ({ id, lifecycle: 'accepted' })) }] }, 'could not accept the tasks');
  // reviewing_phase is only valid alongside a phase-scoped current_review.
  await step(basePath, {
    workflow_mode: 'reviewing_phase',
    current_review: { scope: 'phase', scope_id: 1, stage: 'spec' },
    phases: [{ id: 1, lifecycle: 'reviewing' }],
  }, 'could not reach reviewing_phase');
  await step(basePath, { phases: [{ id: 1, lifecycle: 'accepted' }] }, 'could not accept the phase');
  await step(basePath, { workflow_mode: 'completed', current_review: null }, 'could not reach completed');
}

describe('failed workflow is recoverable', () => {
  // A single `architecture_concern: true` from the debugger used to be a one-way
  // door: WORKFLOW_TRANSITIONS.failed was [], the FROM-terminal guard rejected
  // every mode change, state-patch refused too, and resume advertised
  // recovery_options that no handler implemented. The only ways out were
  // state-init force:true (which destroys the plan) or hand-editing state.json.
  it('accepts a direct mode change out of failed', async () => {
    await withProject('recover-update', async (basePath) => {
      await enterFailed(basePath);
      const result = await update({ updates: { workflow_mode: 'executing_task' }, basePath });
      assert.ok(!result.error, `expected the transition to be allowed, got ${result.code}: ${result.message}`);
      assert.equal((await read({ basePath })).workflow_mode, 'executing_task');
    });
  });

  it('allows replanning out of failed', async () => {
    await withProject('recover-replan-update', async (basePath) => {
      await enterFailed(basePath);
      const result = await update({ updates: { workflow_mode: 'planning' }, basePath });
      assert.ok(!result.error, `expected planning to be reachable, got ${result.code}`);
    });
  });

  it('still refuses to leave completed', async () => {
    // The guard is not being removed, only narrowed. completed stays terminal.
    await withProject('recover-completed', async (basePath) => {
      await enterCompleted(basePath);
      const result = await update({ updates: { workflow_mode: 'executing_task' }, basePath });
      assert.equal(result.error, true);
      assert.equal(result.code, 'TERMINAL_STATE');
    });
  });

  it('accepts a plan patch in failed so replanning can edit the plan', async () => {
    await withProject('recover-patch', async (basePath) => {
      await enterFailed(basePath);
      const result = await patchPlan({
        operations: [{ op: 'update_task', phase_id: 1, task_id: '1.2', name: 'Task B revised' }],
        basePath,
      });
      assert.ok(!result.error, `expected the patch to apply, got ${result.code}: ${result.message}`);
    });
  });

  it('still refuses a plan patch in completed', async () => {
    await withProject('recover-patch-completed', async (basePath) => {
      await enterCompleted(basePath);
      const result = await patchPlan({
        operations: [{ op: 'update_task', phase_id: 1, task_id: '1.2', name: 'nope' }],
        basePath,
      });
      assert.equal(result.error, true);
      assert.equal(result.code, 'TERMINAL_STATE');
    });
  });
});

describe('resume recovery parameter', () => {
  // resume advertises recovery_options in two places. Until now nothing read
  // them back, so the advertisement was the whole feature.
  it('reports the failed state with the options it actually accepts', async () => {
    await withProject('recover-advertise', async (basePath) => {
      await enterFailed(basePath);
      const result = await resumeWorkflow({ basePath });
      assert.equal(result.action, 'await_recovery_decision');
      assert.deepEqual(result.recovery_options, ['retry_failed', 'skip_failed', 'replan']);
    });
  });

  it('retry_failed puts failed tasks back in the queue with a fresh budget', async () => {
    await withProject('recover-retry', async (basePath) => {
      await enterFailed(basePath);
      const result = await resumeWorkflow({ basePath, recovery: 'retry_failed' });
      assert.ok(!result.error, `expected recovery to succeed, got ${result.code}: ${result.message}`);
      assert.equal(result.recovery_applied, 'retry_failed');

      const state = await read({ basePath });
      assert.equal(state.workflow_mode, 'executing_task');
      const phase = state.phases.find(p => p.id === 1);
      assert.equal(phase.lifecycle, 'active');
      const task = phase.todo.find(t => t.id === '1.1');
      // Requeued, then picked straight back up by the resume that follows the
      // recovery — `running` is the loop working, not the recovery failing.
      assert.ok(['pending', 'running'].includes(task.lifecycle),
        `expected 1.1 back in the queue, got ${task.lifecycle}`);
      assert.equal(task.retry_count, 0, 'retry budget must reset, or the task fails again immediately');
      assert.equal(result.task_id, '1.1', 'the requeued task should be the one dispatched next');
    });
  });

  it('skip_failed leaves the failures on the record and runs what still can run', async () => {
    await withProject('recover-skip', async (basePath) => {
      await enterFailed(basePath);
      const result = await resumeWorkflow({ basePath, recovery: 'skip_failed' });
      assert.ok(!result.error, `expected recovery to succeed, got ${result.code}`);

      const state = await read({ basePath });
      assert.equal(state.workflow_mode, 'executing_task');
      const phase = state.phases.find(p => p.id === 1);
      assert.equal(phase.lifecycle, 'active');
      // Not rewritten as accepted — skipping is not the same as succeeding.
      assert.equal(phase.todo.find(t => t.id === '1.1').lifecycle, 'failed');
      // ...and the point of skipping: the remaining work actually gets dispatched.
      assert.equal(result.task_id, '1.2');
      assert.equal(phase.todo.find(t => t.id === '1.2').lifecycle, 'running');
    });
  });

  it('replan hands the plan back to the planner', async () => {
    await withProject('recover-replan', async (basePath) => {
      await enterFailed(basePath);
      const result = await resumeWorkflow({ basePath, recovery: 'replan' });
      assert.ok(!result.error, `expected recovery to succeed, got ${result.code}`);
      assert.equal((await read({ basePath })).workflow_mode, 'planning');
    });
  });

  // The debugger escalates to workflow_mode `failed` only on
  // `architecture_concern: true`. The ordinary "this task cannot be fixed" path
  // leaves the mode at executing_task, and resume then reports
  // await_recovery_decision from a different site — with the same three options.
  // Gating recovery on workflow_mode missed that site entirely, which is the
  // more common of the two.
  async function enterStuckWhileExecuting(basePath) {
    await walkModes(basePath, ['executing_task']);
    await step(basePath, { current_task: '1.1', phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }, { id: '1.2', lifecycle: 'running' }] }] }, 'start both');
    await step(basePath, { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'failed' }, { id: '1.2', lifecycle: 'accepted' }] }] }, 'fail 1.1, accept 1.2');
    await step(basePath, { current_task: null }, 'clear current task');
    const probe = await resumeWorkflow({ basePath });
    assert.equal(probe.action, 'await_recovery_decision', 'setup: expected the executing_task recovery site');
    assert.equal(probe.workflow_mode, 'executing_task', 'setup: this site fires without entering failed');
  }

  for (const option of ['retry_failed', 'skip_failed', 'replan']) {
    it(`accepts ${option} at the executing_task recovery site`, async () => {
      await withProject(`stuck-exec-${option}`, async (basePath) => {
        await enterStuckWhileExecuting(basePath);
        const result = await resumeWorkflow({ basePath, recovery: option });
        assert.ok(!result.error,
          `resume offered ${option} here and then refused it: ${result.code}: ${result.message}`);
        assert.equal(result.recovery_applied, option);
      });
    });
  }

  it('leaves a way out after skip_failed', async () => {
    // skip_failed used to move the workflow from `failed` into executing_task —
    // out of the only mode where recovery was accepted — so the project was
    // stranded with resume repeating the same unanswerable prompt forever, after
    // reporting success.
    // The trap needs no runnable work left: with something still to run,
    // skip_failed does what it says and resume dispatches it. It is the
    // nothing-left case that used to strand the project.
    await withProject('skip-not-a-trap', async (basePath) => {
      await walkModes(basePath, ['executing_task']);
      await step(basePath, { current_task: '1.1', phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }, { id: '1.2', lifecycle: 'running' }] }] }, 'start both');
      await step(basePath, { current_task: null, phases: [{ id: 1, lifecycle: 'failed', todo: [{ id: '1.1', lifecycle: 'failed' }, { id: '1.2', lifecycle: 'accepted' }] }] }, 'fail 1.1, accept 1.2');
      await walkModes(basePath, ['failed']);

      const skipped = await resumeWorkflow({ basePath, recovery: 'skip_failed' });
      assert.ok(!skipped.error, `${skipped.code}: ${skipped.message}`);

      const retry = await resumeWorkflow({ basePath, recovery: 'retry_failed' });
      assert.ok(!retry.error,
        `after skip_failed the workflow could not be recovered at all: ${retry.code}: ${retry.message}`);
      assert.equal(retry.recovery_applied, 'retry_failed');
    });
  });

  it('refuses recovery while a task is actually being dispatched', async () => {
    // selectRunnableTask also returns nothing while a task is running, so a
    // predicate built on "failed task and nothing runnable" would fire here and
    // applyRecovery would null current_task and current_review over a live
    // executor. Keying on the response instead means this returns
    // dispatch_executor and carries no recovery_options.
    await withProject('live-dispatch', async (basePath) => {
      await walkModes(basePath, ['executing_task']);
      await step(basePath, { current_task: '1.1', phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, 'start 1.1');

      const result = await resumeWorkflow({ basePath, recovery: 'retry_failed' });
      assert.equal(result.error, true, 'recovery fired over a live dispatch');
      assert.equal(result.code, 'TRANSITION_ERROR');
      assert.equal((await read({ basePath })).current_task, '1.1', 'the in-flight task was cleared');
    });
  });

  it('does not rewrite the review record of an already-accepted phase', async () => {
    await withProject('accepted-untouched', async (basePath) => {
      await walkModes(basePath, ['executing_task']);
      await step(basePath, { current_task: '1.1', phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }, { id: '1.2', lifecycle: 'running' }] }] }, 'start');
      await step(basePath, { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'accepted' }, { id: '1.2', lifecycle: 'accepted' }] }] }, 'accept tasks');
      await step(basePath, {
        workflow_mode: 'reviewing_phase',
        current_review: { scope: 'phase', scope_id: 1, stage: 'spec' },
        phases: [{ id: 1, lifecycle: 'reviewing', phase_review: { status: 'accepted', retry_count: 3 } }],
      }, 'review phase');
      await step(basePath, { phases: [{ id: 1, lifecycle: 'accepted' }] }, 'accept phase');
      await step(basePath, { workflow_mode: 'executing_task', current_review: null, current_task: null }, 'back to executing');

      const before = (await read({ basePath })).phases.find(p => p.id === 1).phase_review;
      // Park the workflow in a recoverable state without touching phase 1.
      await walkModes(basePath, ['failed']);
      await resumeWorkflow({ basePath, recovery: 'retry_failed' });

      const after = (await read({ basePath })).phases.find(p => p.id === 1).phase_review;
      assert.deepEqual(after, before,
        'an accepted phase had its review record reset — that is finished history');
    });
  });

  it('rejects an unknown recovery option instead of ignoring it', async () => {
    await withProject('recover-bogus', async (basePath) => {
      await enterFailed(basePath);
      const result = await resumeWorkflow({ basePath, recovery: 'make_it_work' });
      assert.equal(result.error, true);
      assert.equal(result.code, 'INVALID_INPUT');
      assert.equal((await read({ basePath })).workflow_mode, 'failed');
    });
  });

  it('validates recovery even when unblock_tasks handles the call first', async () => {
    // The unblock_tasks branch returns before the recovery block did, so a
    // garbage recovery value rode along unvalidated and was silently dropped —
    // the same silent no-op this release fixes for unblock_tasks itself.
    await withProject('recover-with-unblock', async (basePath) => {
      await walkModes(basePath, ['executing_task']);
      await step(basePath, { current_task: '1.1', phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, 'start 1.1');
      await step(basePath, { current_task: null, phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'blocked', blocked_reason: 'waiting' }] }] }, 'block 1.1');

      const result = await resumeWorkflow({ basePath, unblock_tasks: ['1.1'], recovery: 'nonsense' });
      assert.equal(result.error, true, 'a bad recovery value was accepted and ignored');
      assert.equal(result.code, 'INVALID_INPUT');
      assert.equal((await read({ basePath })).phases[0].todo[0].lifecycle, 'blocked',
        'the call should have been rejected whole, not half-applied');
    });
  });
});

describe('awaiting_user holds are not auto-cleared', () => {
  async function enterReviewHold(basePath, stage) {
    await walkModes(basePath, ['executing_task', 'awaiting_user']);
    const result = await update({
      updates: {
        current_task: null,
        current_review: { scope: 'phase', scope_id: 1, stage, retry_count: 6 },
        phases: [{ id: 1, phase_review: { status: 'rework_required', retry_count: 6 } }],
      },
      basePath,
    });
    assert.ok(!result.error, `setup: could not install the review hold — ${result.code}: ${result.message}`);
  }

  // reviewer.js parks the workflow here once phase review has failed
  // MAX_PHASE_REVIEW_RETRY times. resume only recognised 'human_confirmation'
  // and 'direction_drift', so this stage fell through to tryAutoUnblock, which
  // found no blocked task, wrote workflow_mode back to executing_task and
  // recursed — straight back into another review with retry_count still
  // climbing. "User intervention required" never actually required anything.
  it('holds on review_retry_exhausted rather than auto-unblocking', async () => {
    await withProject('hold-exhausted', async (basePath) => {
      await enterReviewHold(basePath, 'review_retry_exhausted');
      const result = await resumeWorkflow({ basePath });

      assert.equal(result.workflow_mode, 'awaiting_user');
      assert.equal(result.action, 'await_manual_intervention');
      assert.equal(result.current_review.stage, 'review_retry_exhausted');
      assert.equal((await read({ basePath })).workflow_mode, 'awaiting_user');
    });
  });

  it('holds on any other named review stage too', async () => {
    // The fix is the class, not the one stage: an unrecognised stage is a hold
    // someone added without teaching resume about it, which is exactly the case
    // that must not be silently cleared.
    await withProject('hold-unknown', async (basePath) => {
      await enterReviewHold(basePath, 'some_future_stage');
      const result = await resumeWorkflow({ basePath });
      assert.equal(result.workflow_mode, 'awaiting_user');
      assert.equal((await read({ basePath })).workflow_mode, 'awaiting_user');
    });
  });

  it('still auto-unblocks when there is no review hold at all', async () => {
    // The auto-unblock path is not being removed — it just no longer applies
    // to a state that says a human is needed.
    await withProject('hold-none', async (basePath) => {
      await walkModes(basePath, ['executing_task', 'awaiting_user']);
      await update({ updates: { current_task: null, current_review: null }, basePath });
      const result = await resumeWorkflow({ basePath });
      assert.notEqual(result.workflow_mode, 'awaiting_user');
      assert.equal((await read({ basePath })).workflow_mode, 'executing_task');
    });
  });

  it('retry_failed clears the hold and resets the phase review budget', async () => {
    await withProject('hold-recover', async (basePath) => {
      await enterReviewHold(basePath, 'review_retry_exhausted');
      const result = await resumeWorkflow({ basePath, recovery: 'retry_failed' });
      assert.ok(!result.error, `expected recovery to succeed, got ${result.code}: ${result.message}`);

      const state = await read({ basePath });
      assert.equal(state.workflow_mode, 'executing_task');
      assert.equal(state.current_review, null);
      const phase = state.phases.find(p => p.id === 1);
      assert.equal(phase.phase_review.retry_count, 0,
        'without a reset the next review starts already over the limit');
    });
  });

  it('does not let recovery clear an L3 human-confirmation hold', async () => {
    // human_confirmation is the one awaiting_user stage with its own resolution
    // channel (confirm_review: confirm|reject) precisely because clearing it
    // silently accepts an L3 task with no human sign-off — audit R-03/H3. It
    // must not become reachable through the generic recovery door.
    await withProject('hold-l3', async (basePath) => {
      await enterReviewHold(basePath, 'human_confirmation');
      const result = await resumeWorkflow({ basePath, recovery: 'retry_failed' });
      assert.equal(result.error, true);
      assert.equal(result.code, 'TRANSITION_ERROR');

      const state = await read({ basePath });
      assert.equal(state.workflow_mode, 'awaiting_user');
      assert.equal(state.current_review.stage, 'human_confirmation', 'the L3 gate must survive');
    });
  });

  it('replan is reachable from a review hold, not just from failed', async () => {
    // Every option resume offers has to work from every state resume offers it
    // in, or the menu is lying again in a smaller way.
    await withProject('hold-replan', async (basePath) => {
      await enterReviewHold(basePath, 'review_retry_exhausted');
      const result = await resumeWorkflow({ basePath, recovery: 'replan' });
      assert.ok(!result.error, `expected replan to be reachable, got ${result.code}: ${result.message}`);
      assert.equal((await read({ basePath })).workflow_mode, 'planning');
    });
  });
});
