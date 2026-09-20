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

  // skip_failed is excluded here on purpose: enterStuckWhileExecuting leaves
  // nothing else runnable, which is exactly the state where skipping achieves
  // nothing — covered by its own test below.
  for (const option of ['retry_failed', 'replan']) {
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

  it('accepts skip_failed when other work can still run', async () => {
    await withProject('skip-with-work-left', async (basePath) => {
      await walkModes(basePath, ['executing_task']);
      await step(basePath, { current_task: '1.1', phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, 'start 1.1');
      await step(basePath, { current_task: null, phases: [{ id: 1, lifecycle: 'failed', todo: [{ id: '1.1', lifecycle: 'failed' }] }] }, 'fail 1.1');
      await walkModes(basePath, ['failed']);

      const result = await resumeWorkflow({ basePath, recovery: 'skip_failed' });
      assert.ok(!result.error, `${result.code}: ${result.message}`);
      assert.equal(result.recovery_applied, 'skip_failed');

      const state = await read({ basePath });
      // The failure stays on the record; 1.2 is what gets picked up.
      assert.equal(state.phases[0].todo.find(t => t.id === '1.1').lifecycle, 'failed');
      assert.equal(result.task_id, '1.2');
    });
  });

  it('stays recoverable after a skip_failed that did continue', async () => {
    // skip_failed used to move the workflow out of the only mode where recovery
    // was accepted, stranding the project. Recovery is keyed on the response
    // now, so a state that still needs a decision still offers one.
    await withProject('skip-then-recover', async (basePath) => {
      await walkModes(basePath, ['executing_task']);
      await step(basePath, { current_task: '1.1', phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, 'start 1.1');
      await step(basePath, { current_task: null, phases: [{ id: 1, lifecycle: 'failed', todo: [{ id: '1.1', lifecycle: 'failed' }] }] }, 'fail 1.1');
      await walkModes(basePath, ['failed']);

      const skipped = await resumeWorkflow({ basePath, recovery: 'skip_failed' });
      assert.ok(!skipped.error, `${skipped.code}: ${skipped.message}`);

      // 1.2 is running now; finish it so the phase runs out of work again.
      await step(basePath, { current_task: null, phases: [{ id: 1, todo: [{ id: '1.2', lifecycle: 'accepted' }] }] }, 'accept 1.2');

      const retry = await resumeWorkflow({ basePath, recovery: 'retry_failed' });
      assert.ok(!retry.error,
        `the workflow became unrecoverable after skip_failed: ${retry.code}: ${retry.message}`);
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

  it('applies recovery from the awaiting_user auto-unblock path', async () => {
    // awaiting_user with no review stage and no blocked tasks falls through to
    // tryAutoUnblock, which persists executing_task and RECURSES — and that
    // branch returned early, skipping the gate. The response said
    // await_recovery_decision and carried recovery_options, the user answered,
    // and the answer was dropped under a success. Third site of the same bug,
    // introduced by the fix for the first two; the gate now wraps every return.
    await withProject('recover-autounblock', async (basePath) => {
      await walkModes(basePath, ['executing_task']);
      await step(basePath, { current_task: '1.1', phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }, { id: '1.2', lifecycle: 'running' }] }] }, 'start both');
      await step(basePath, { current_task: null, phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'failed' }, { id: '1.2', lifecycle: 'accepted' }] }] }, 'fail 1.1');
      await step(basePath, { workflow_mode: 'awaiting_user', current_review: null }, 'to awaiting_user');

      const result = await resumeWorkflow({ basePath, recovery: 'retry_failed' });
      assert.ok(!result.error, `${result.code}: ${result.message}`);
      assert.equal(result.recovery_applied, 'retry_failed', 'the answer was dropped under a success');

      const task = (await read({ basePath })).phases[0].todo.find(t => t.id === '1.1');
      assert.notEqual(task.lifecycle, 'failed', 'nothing was actually requeued');
    });
  });

  it('refuses skip_failed when there is nothing left to skip to', async () => {
    // Reported success and changed nothing: five consecutive calls each returned
    // recovery_applied:'skip_failed' with the task still failed and resume still
    // asking. A phase holding a failed task can never be accepted, so the loop
    // had no exit.
    await withProject('skip-nothing-left', async (basePath) => {
      await walkModes(basePath, ['executing_task']);
      await step(basePath, { current_task: '1.1', phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }, { id: '1.2', lifecycle: 'running' }] }] }, 'start both');
      await step(basePath, { current_task: null, phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'failed' }, { id: '1.2', lifecycle: 'accepted' }] }] }, 'fail 1.1, accept 1.2');

      const result = await resumeWorkflow({ basePath, recovery: 'skip_failed' });
      assert.equal(result.error, true, 'skip_failed reported success while doing nothing');
      assert.equal(result.code, 'TRANSITION_ERROR');
      assert.deepEqual(result.recovery_options, ['retry_failed', 'replan'],
        'the refusal should name the options that do work');

      // ...and the ones it names must actually work from here.
      const retry = await resumeWorkflow({ basePath, recovery: 'retry_failed' });
      assert.ok(!retry.error, `${retry.code}: ${retry.message}`);
    });
  });

  it('accepts skip_failed when the work left is blocked rather than runnable', async () => {
    // Third try. Tightening the guard to "is a task runnable right now" was too
    // strict: a blocked sibling makes selectRunnableTask return awaiting_user
    // with blockers, which is somewhere to go — a loud state whose remedy is
    // unblock_tasks. Refusing it was wrong three ways at once: it blocked a path
    // that worked, it said "no other work remains" with a blocked task sitting
    // there, and it named retry_failed when unblock_tasks is the fix. The guard
    // exists to stop resume re-offering skip_failed forever, and it does not
    // re-offer it here.
    await withProject('skip-blocked-sibling', async (basePath) => {
      await walkModes(basePath, ['executing_task']);
      await step(basePath, { current_task: '1.1', phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, 'start 1.1');
      await step(basePath, {
        current_task: null,
        phases: [{ id: 1, lifecycle: 'failed', todo: [
          { id: '1.1', lifecycle: 'failed' },
          { id: '1.2', lifecycle: 'blocked', blocked_reason: 'waiting on an API key' },
        ] }],
      }, 'fail 1.1, block 1.2');
      await walkModes(basePath, ['failed']);

      const result = await resumeWorkflow({ basePath, recovery: 'skip_failed' });
      assert.ok(!result.error,
        `skip_failed refused while a blocked task was waiting: ${result.code}: ${result.message}`);
      assert.equal(result.recovery_applied, 'skip_failed');
      assert.equal(result.workflow_mode, 'awaiting_user',
        'the blocked task should now be the thing the workflow is waiting on');
      assert.ok((result.blockers || []).some(b => b.id === '1.2'),
        'the response must name the blocked task, since unblock_tasks is the remedy');

      // And the failure still stands on the record — skipping is not accepting.
      const state = await read({ basePath });
      assert.equal(state.phases[0].todo.find(t => t.id === '1.1').lifecycle, 'failed');
    });
  });

  it('refuses skip_failed when the tasks left in the phase are not actually runnable', async () => {
    // Second try at the same bug. Scoping the guard to the current phase was
    // necessary and not sufficient: it still asked "is there a task here that is
    // neither accepted nor failed", which is looser than selectRunnableTask, the
    // predicate resumeExecutingTask actually consumes. A pending task that
    // depends on the failed one satisfied the loose check and nothing else, so
    // resume fell straight back to offering skip_failed and the self-sustaining
    // no-op returned at full strength. A dependent of the failed task is the
    // ordinary shape of this, not an edge case — which is the point: the guard
    // has to ask the consumer's question, not a proxy for it.
    await withProject('skip-dependent-not-runnable', async (basePath) => {
      await walkModes(basePath, ['executing_task']);
      await step(basePath, { current_task: '1.1', phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, 'start 1.1');
      await step(basePath, { current_task: null, phases: [{ id: 1, lifecycle: 'failed', todo: [{ id: '1.1', lifecycle: 'failed' }] }] }, 'fail 1.1');
      await walkModes(basePath, ['failed']);

      const before = await read({ basePath });
      assert.equal(before.phases[0].todo.find(t => t.id === '1.2').lifecycle, 'pending',
        'setup: 1.2 must be pending, and unrunnable only because its dependency failed');

      const result = await resumeWorkflow({ basePath, recovery: 'skip_failed' });
      assert.equal(result.error, true,
        'skip_failed reported success with nothing it could actually run');
      assert.equal(result.code, 'TRANSITION_ERROR');

      // The tell for the original bug was that the same call kept working.
      const again = await resumeWorkflow({ basePath, recovery: 'skip_failed' });
      assert.equal(again.error, true, 'the no-op loop is still reachable on the second call');
      assert.equal((await read({ basePath })).phases[0].todo.find(t => t.id === '1.2').lifecycle, 'pending');
    }, [
      {
        name: 'Core',
        tasks: [
          { index: 1, name: 'Task A' },
          { index: 2, name: 'Task B', level: 'L0', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }] },
        ],
      },
    ]);
  });

  it('refuses skip_failed when the only work left is in a phase that cannot be reached', async () => {
    // The guard above shipped scoped to the whole plan, which made it inert for
    // every project with more than one phase: a pending task in phase 2 satisfied
    // it while changing nothing about phase 1. But the stranding is per-current-
    // phase — resumeExecutingTask only ever looks at getCurrentPhase(state), and
    // the handoff gate in crud.js counts a `failed` task as not-accepted, so a
    // phase holding one can never complete and current_phase can never advance
    // past it. Phase 2 is unreachable work, not a reason to proceed.
    await withProject('skip-unreachable-next-phase', async (basePath) => {
      await walkModes(basePath, ['executing_task']);
      await step(basePath, { current_task: '1.1', phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }, { id: '1.2', lifecycle: 'running' }] }] }, 'start both');
      await step(basePath, { current_task: null, phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'failed' }, { id: '1.2', lifecycle: 'accepted' }] }] }, 'fail 1.1, accept 1.2');

      const before = await read({ basePath });
      assert.equal(before.current_phase, 1, 'setup: should still be on phase 1');
      assert.equal(before.phases[1].todo[0].lifecycle, 'pending', 'setup: phase 2 must hold runnable work');

      const result = await resumeWorkflow({ basePath, recovery: 'skip_failed' });
      assert.equal(result.error, true, 'skip_failed reported success while phase 1 stayed stuck');
      assert.equal(result.code, 'TRANSITION_ERROR');
      assert.deepEqual(result.recovery_options, ['retry_failed', 'replan']);
      assert.match(result.message, /unreachable/,
        'the refusal must say the later work is unreachable, not that no work remains');

      // The no-op was self-sustaining: nothing changed, so the same call kept
      // returning the same success. Assert the state is untouched and the named
      // options really do work from here.
      const after = await read({ basePath });
      assert.equal(after.current_phase, 1);
      assert.equal(after.phases[0].todo.find(t => t.id === '1.1').lifecycle, 'failed');

      const retry = await resumeWorkflow({ basePath, recovery: 'retry_failed' });
      assert.ok(!retry.error, `${retry.code}: ${retry.message}`);
    }, [
      { name: 'Core', tasks: [{ index: 1, name: 'Task A' }, { index: 2, name: 'Task B', level: 'L0' }] },
      { name: 'Followup', tasks: [{ index: 1, name: 'Task C', level: 'L0' }] },
    ]);
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

  it('rejects recovery riding along with confirm_review before anything is committed', async () => {
    // The wrapper checked `recovery_options` only AFTER _resumeWorkflow returned,
    // and confirm_review persists and returns early — so the pair committed the
    // L3 sign-off (1.1 → accepted) and then handed the caller a TRANSITION_ERROR.
    // A caller that reads the error as "nothing happened" is wrong about an
    // acceptance that already landed. These are three mutually exclusive ways to
    // resolve a hold; the contradiction has to be refused before the first write.
    await withProject('confirm-plus-recovery', async (basePath) => {
      await walkModes(basePath, ['executing_task']);
      await step(basePath, { current_task: '1.1', phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, 'start 1.1');
      await step(basePath, { current_task: null, phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'checkpointed' }] }] }, 'checkpoint 1.1');
      await walkModes(basePath, ['awaiting_user']);
      await step(basePath, {
        current_review: { scope: 'task', scope_id: '1.1', stage: 'human_confirmation', pending_tasks: ['1.1'] },
      }, 'install the L3 hold');

      const result = await resumeWorkflow({ basePath, confirm_review: 'confirm', recovery: 'retry_failed' });
      assert.equal(result.error, true);
      assert.equal(result.code, 'INVALID_INPUT',
        'the contradiction must be refused as bad input, not reported after a partial commit');

      const state = await read({ basePath });
      assert.equal(state.phases[0].todo.find(t => t.id === '1.1').lifecycle, 'checkpointed',
        'the L3 sign-off was committed by a call that reported failure');
      assert.equal(state.workflow_mode, 'awaiting_user', 'the hold must survive a refused call');
      assert.equal(state.current_review?.stage, 'human_confirmation');
    });
  });

  it('rejects recovery riding along with unblock_tasks before anything is committed', async () => {
    await withProject('unblock-plus-recovery', async (basePath) => {
      await walkModes(basePath, ['executing_task']);
      await step(basePath, {
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'blocked', blocked_reason: 'waiting on input' }] }],
      }, 'block 1.1');

      const result = await resumeWorkflow({ basePath, unblock_tasks: ['1.1'], recovery: 'retry_failed' });
      assert.equal(result.error, true);
      assert.equal(result.code, 'INVALID_INPUT');

      const state = await read({ basePath });
      assert.equal(state.phases[0].todo.find(t => t.id === '1.1').lifecycle, 'blocked',
        'the unblock was committed by a call that reported failure');
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
