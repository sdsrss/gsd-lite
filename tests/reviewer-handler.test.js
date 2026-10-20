import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, patchPlan, read, update } from '../src/tools/state/index.js';
import { handleReviewerResult, resumeWorkflow } from '../src/tools/orchestrator/index.js';
import { MAX_PHASE_REVIEW_RETRY } from '../src/tools/orchestrator/helpers.js';

function makeValidReviewerResult(overrides = {}) {
  return {
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
    ...overrides,
  };
}

async function setupCheckpointedTask(basePath, taskOverrides = {}) {
  await init({
    project: 'reviewer-test',
    phases: [{
      name: 'Core',
      tasks: [
        { index: 1, name: 'Task A' },
        { index: 2, name: 'Task B', requires: [{ kind: 'task', id: '1.1' }] },
        { index: 3, name: 'Task C', requires: [{ kind: 'task', id: '1.2' }] },
      ],
    }],
    basePath,
  });

  // Transition task 1.1 to running
  await update({
    updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] },
    basePath,
  });

  // Transition task 1.1 to checkpointed
  await update({
    updates: {
      phases: [{
        id: 1,
        todo: [{
          id: '1.1',
          lifecycle: 'checkpointed',
          checkpoint_commit: 'abc123',
          ...taskOverrides,
        }],
      }],
    },
    basePath,
  });
}

describe('handleReviewerResult', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-reviewer-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('rejects non-object input', async () => {
    const result = await handleReviewerResult({ result: 'not-an-object', basePath: tempDir });
    assert.equal(result.error, true);
    assert.match(result.message, /result must be an object/);
  });

  it('rejects null input', async () => {
    const result = await handleReviewerResult({ result: null, basePath: tempDir });
    assert.equal(result.error, true);
    assert.match(result.message, /result must be an object/);
  });

  it('rejects array input', async () => {
    const result = await handleReviewerResult({ result: [], basePath: tempDir });
    assert.equal(result.error, true);
    assert.match(result.message, /result must be an object/);
  });

  it('rejects invalid reviewer result with missing required fields', async () => {
    await setupCheckpointedTask(tempDir);
    const result = await handleReviewerResult({
      result: { scope: 'invalid_scope' },
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /Invalid reviewer result/);
  });

  it('accepts tasks on valid review pass', async () => {
    await setupCheckpointedTask(tempDir);
    const result = await handleReviewerResult({
      result: makeValidReviewerResult(),
      basePath: tempDir,
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'review_accepted');
    assert.equal(result.accepted_count, 1);
    assert.equal(result.review_status, 'accepted');

    const state = await read({ basePath: tempDir });
    const task = state.phases[0].todo.find((t) => t.id === '1.1');
    assert.equal(task.lifecycle, 'accepted');
    assert.equal(state.phases[0].done, 1);
    assert.equal(state.phases[0].phase_review.status, 'accepted');
  });

  it('rework tasks on critical issues', async () => {
    await setupCheckpointedTask(tempDir);
    const result = await handleReviewerResult({
      result: makeValidReviewerResult({
        spec_passed: false,
        quality_passed: false,
        critical_issues: [{ reason: 'API contract violation', task_id: '1.1' }],
        accepted_tasks: [],
        rework_tasks: ['1.1'],
      }),
      basePath: tempDir,
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'rework_required');
    assert.equal(result.rework_count, 1);
    assert.equal(result.critical_count, 1);

    const state = await read({ basePath: tempDir });
    const task = state.phases[0].todo.find((t) => t.id === '1.1');
    assert.equal(task.lifecycle, 'needs_revalidation');
    assert.deepEqual(task.evidence_refs, []);
  });

  it('rework accepted tasks back to needs_revalidation', async () => {
    await setupCheckpointedTask(tempDir);

    // First accept the task
    await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'accepted' }] }] },
      basePath: tempDir,
    });

    const result = await handleReviewerResult({
      result: makeValidReviewerResult({
        spec_passed: false,
        critical_issues: [{ reason: 'Regression found' }],
        accepted_tasks: [],
        rework_tasks: ['1.1'],
      }),
      basePath: tempDir,
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'rework_required');

    const state = await read({ basePath: tempDir });
    const task = state.phases[0].todo.find((t) => t.id === '1.1');
    assert.equal(task.lifecycle, 'needs_revalidation');
  });

  it('sets phase_review.status to accepted on pass', async () => {
    await setupCheckpointedTask(tempDir);
    await handleReviewerResult({
      result: makeValidReviewerResult(),
      basePath: tempDir,
    });

    const state = await read({ basePath: tempDir });
    assert.equal(state.phases[0].phase_review.status, 'accepted');
  });

  it('sets phase_review.status to rework_required on critical issues', async () => {
    await setupCheckpointedTask(tempDir);
    await handleReviewerResult({
      result: makeValidReviewerResult({
        critical_issues: [{ reason: 'Missing error handling' }],
        accepted_tasks: [],
        rework_tasks: ['1.1'],
      }),
      basePath: tempDir,
    });

    const state = await read({ basePath: tempDir });
    assert.equal(state.phases[0].phase_review.status, 'rework_required');
  });

  it('propagates invalidation to downstream tasks on invalidates_downstream', async () => {
    await setupCheckpointedTask(tempDir);

    // Also checkpoint task 1.2 (depends on 1.1)
    await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.2', lifecycle: 'running' }] }] },
      basePath: tempDir,
    });
    await update({
      updates: {
        phases: [{
          id: 1,
          todo: [{ id: '1.2', lifecycle: 'checkpointed', checkpoint_commit: 'def456' }],
        }],
      },
      basePath: tempDir,
    });

    const result = await handleReviewerResult({
      result: makeValidReviewerResult({
        critical_issues: [{
          reason: 'Contract changed',
          task_id: '1.1',
          invalidates_downstream: true,
        }],
        accepted_tasks: [],
        rework_tasks: ['1.1'],
      }),
      basePath: tempDir,
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'rework_required');

    const state = await read({ basePath: tempDir });
    const task11 = state.phases[0].todo.find((t) => t.id === '1.1');
    const task12 = state.phases[0].todo.find((t) => t.id === '1.2');
    assert.equal(task11.lifecycle, 'needs_revalidation');
    assert.equal(task12.lifecycle, 'needs_revalidation');
    assert.deepEqual(task12.evidence_refs, []);
  });

  it('sets phase_handoff.required_reviews_passed on phase scope pass', async () => {
    await setupCheckpointedTask(tempDir);

    // Set workflow to reviewing_phase
    await update({
      updates: {
        workflow_mode: 'reviewing_phase',
        current_review: { scope: 'phase', scope_id: 1 },
      },
      basePath: tempDir,
    });

    const result = await handleReviewerResult({
      result: makeValidReviewerResult({
        scope: 'phase',
        scope_id: 1,
        review_level: 'L1-batch',
        accepted_tasks: ['1.1'],
      }),
      basePath: tempDir,
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'review_accepted');

    const state = await read({ basePath: tempDir });
    assert.equal(state.phases[0].phase_handoff.required_reviews_passed, true);
  });

  it('does not set required_reviews_passed on phase scope with critical issues', async () => {
    await setupCheckpointedTask(tempDir);

    await update({
      updates: {
        workflow_mode: 'reviewing_phase',
        current_review: { scope: 'phase', scope_id: 1 },
      },
      basePath: tempDir,
    });

    await handleReviewerResult({
      result: makeValidReviewerResult({
        scope: 'phase',
        scope_id: 1,
        review_level: 'L1-batch',
        critical_issues: [{ reason: 'Missing tests' }],
        accepted_tasks: [],
        rework_tasks: ['1.1'],
      }),
      basePath: tempDir,
    });

    const state = await read({ basePath: tempDir });
    assert.equal(state.phases[0].phase_handoff.required_reviews_passed, false);
  });

  it('does not set required_reviews_passed on task scope pass', async () => {
    await setupCheckpointedTask(tempDir);

    const result = await handleReviewerResult({
      result: makeValidReviewerResult({
        scope: 'task',
        scope_id: '1.1',
        accepted_tasks: ['1.1'],
      }),
      basePath: tempDir,
    });

    assert.equal(result.success, true);

    const state = await read({ basePath: tempDir });
    assert.equal(state.phases[0].phase_handoff.required_reviews_passed, false);
  });

  it('clears current_review after handling', async () => {
    await setupCheckpointedTask(tempDir);

    await update({
      updates: {
        current_review: { scope: 'task', scope_id: '1.1', stage: 'spec' },
      },
      basePath: tempDir,
    });

    await handleReviewerResult({
      result: makeValidReviewerResult(),
      basePath: tempDir,
    });

    const state = await read({ basePath: tempDir });
    assert.equal(state.current_review, null);
  });

  it('transitions workflow_mode from reviewing_task to executing_task on acceptance', async () => {
    await setupCheckpointedTask(tempDir);

    await update({
      updates: {
        workflow_mode: 'reviewing_task',
        current_review: { scope: 'task', scope_id: '1.1', stage: 'spec' },
      },
      basePath: tempDir,
    });

    const result = await handleReviewerResult({
      result: makeValidReviewerResult(),
      basePath: tempDir,
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'review_accepted');
    assert.equal(result.workflow_mode, 'executing_task');

    const state = await read({ basePath: tempDir });
    assert.equal(state.workflow_mode, 'executing_task');
  });

  it('transitions workflow_mode from reviewing_phase to executing_task on acceptance', async () => {
    await setupCheckpointedTask(tempDir);

    await update({
      updates: {
        workflow_mode: 'reviewing_phase',
        current_review: { scope: 'phase', scope_id: 1 },
      },
      basePath: tempDir,
    });

    const result = await handleReviewerResult({
      result: makeValidReviewerResult({
        scope: 'phase',
        scope_id: 1,
        review_level: 'L1-batch',
        accepted_tasks: ['1.1'],
      }),
      basePath: tempDir,
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'review_accepted');
    assert.equal(result.workflow_mode, 'executing_task');

    const state = await read({ basePath: tempDir });
    assert.equal(state.workflow_mode, 'executing_task');
  });

  it('increments done count for each accepted task', async () => {
    await setupCheckpointedTask(tempDir);

    const stateBefore = await read({ basePath: tempDir });
    const doneBefore = stateBefore.phases[0].done;

    await handleReviewerResult({
      result: makeValidReviewerResult(),
      basePath: tempDir,
    });

    const stateAfter = await read({ basePath: tempDir });
    assert.equal(stateAfter.phases[0].done, doneBefore + 1);
  });

  it('triggers rework when spec_passed is false even without critical_issues', async () => {
    await setupCheckpointedTask(tempDir);

    const result = await handleReviewerResult({
      result: makeValidReviewerResult({
        spec_passed: false,
        quality_passed: true,
        critical_issues: [],
        accepted_tasks: [],
        rework_tasks: ['1.1'],
      }),
      basePath: tempDir,
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'rework_required');
    assert.equal(result.review_status, 'rework_required');

    const state = await read({ basePath: tempDir });
    assert.equal(state.phases[0].phase_review.status, 'rework_required');
  });

  it('clears current_task after handling reviewer result', async () => {
    await setupCheckpointedTask(tempDir);
    await update({
      updates: {
        workflow_mode: 'reviewing_task',
        current_task: '1.1',
        current_review: { scope: 'task', scope_id: '1.1', stage: 'spec' },
      },
      basePath: tempDir,
    });

    await handleReviewerResult({
      result: makeValidReviewerResult(),
      basePath: tempDir,
    });

    const state = await read({ basePath: tempDir });
    assert.equal(state.current_task, null, 'current_task should be null after reviewer result');
    assert.equal(state.current_review, null, 'current_review should be null after reviewer result');
  });

  it('triggers rework when quality_passed is false even without critical_issues', async () => {
    await setupCheckpointedTask(tempDir);

    const result = await handleReviewerResult({
      result: makeValidReviewerResult({
        spec_passed: true,
        quality_passed: false,
        critical_issues: [],
        accepted_tasks: [],
        rework_tasks: ['1.1'],
      }),
      basePath: tempDir,
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'rework_required');
    assert.equal(result.review_status, 'rework_required');
  });

  it('fallback targets accepted tasks when rework needed but no checkpointed tasks remain', async () => {
    await setupCheckpointedTask(tempDir);

    // Advance task 1.1 to accepted (no checkpointed tasks left)
    await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'accepted' }] }] },
      basePath: tempDir,
    });

    // Reviewer says spec_passed:false with empty rework_tasks — fallback should kick in
    const result = await handleReviewerResult({
      result: makeValidReviewerResult({
        spec_passed: false,
        quality_passed: true,
        critical_issues: [],
        accepted_tasks: [],
        rework_tasks: [],
      }),
      basePath: tempDir,
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'rework_required');
    assert.ok(result.rework_count > 0, 'fallback should produce rework patches for accepted tasks');

    const state = await read({ basePath: tempDir });
    const task = state.phases[0].todo.find(t => t.id === '1.1');
    assert.equal(task.lifecycle, 'needs_revalidation', 'accepted task should be marked for revalidation');
  });

  it('returns review_retry_exhausted when phase review retry limit exceeded', async () => {
    await setupCheckpointedTask(tempDir);
    // Set phase_review.retry_count to the limit (5)
    await update({
      updates: {
        workflow_mode: 'reviewing_phase',
        current_review: { scope: 'phase', scope_id: 1 },
        phases: [{
          id: 1,
          lifecycle: 'reviewing',
          phase_review: { status: 'rework_required', retry_count: 5 },
        }],
      },
      basePath: tempDir,
    });

    const result = await handleReviewerResult({
      result: makeValidReviewerResult({
        scope: 'phase',
        scope_id: 1,
        spec_passed: false,
        quality_passed: false,
        accepted_tasks: [],
        rework_tasks: ['1.1'],
      }),
      basePath: tempDir,
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'review_retry_exhausted');
    assert.equal(result.workflow_mode, 'awaiting_user');
    assert.ok(result.retry_count > 5, 'retry_count exceeds limit');

    const state = await read({ basePath: tempDir });
    assert.equal(state.workflow_mode, 'awaiting_user');
    assert.equal(state.current_review.stage, 'review_retry_exhausted');
  });
});

describe('a phase review that leaves a target unreviewed', () => {
  // selectRunnableTask returns trigger_review while any task in the phase is
  // checkpointed. A reviewer that passed the phase without naming one of its
  // targets was recorded as accepted with retry_count reset to 0, so the next
  // resume triggered the same review, every round, with nothing to end it.
  // Found for an L3 task; the level plays no part, so every reviewable level
  // is driven through the same loop.
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-reviewer-omit-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function setupPhase(omittedLevel) {
    await init({
      project: 'reviewer-omit',
      phases: [{ name: 'Core', tasks: [
        { index: 1, name: 'Task A', level: 'L1' },
        { index: 2, name: 'Task B', level: omittedLevel },
      ] }],
      basePath: tempDir,
    });
    for (const id of ['1.1', '1.2']) {
      await update({ updates: { phases: [{ id: 1, todo: [{ id, lifecycle: 'running' }] }] }, basePath: tempDir });
      await update({ updates: { phases: [{ id: 1, todo: [{ id, lifecycle: 'checkpointed', checkpoint_commit: `c${id}` }] }] }, basePath: tempDir });
    }
  }

  // One orchestrator round: resume until the reviewer is dispatched, then
  // answer with a phase review that passes and names only `named`.
  async function reviewRound(named) {
    let dispatch = await resumeWorkflow({ basePath: tempDir });
    if (dispatch.action === 'trigger_review') dispatch = await resumeWorkflow({ basePath: tempDir });
    assert.equal(dispatch.action, 'dispatch_reviewer', `expected a reviewer dispatch, got ${JSON.stringify(dispatch)}`);
    return handleReviewerResult({
      result: makeValidReviewerResult({ scope: 'phase', scope_id: 1, review_level: 'L1-batch', accepted_tasks: named }),
      basePath: tempDir,
    });
  }

  for (const level of ['L1', 'L2', 'L3']) {
    it(`ends at the retry limit when an ${level} target keeps being left out`, async () => {
      await setupPhase(level);
      const outcomes = [];
      for (let round = 1; round <= MAX_PHASE_REVIEW_RETRY + 2; round++) {
        const res = await reviewRound(round === 1 ? ['1.1'] : []);
        outcomes.push(res.action);
        const phase = (await read({ basePath: tempDir })).phases[0];
        assert.notEqual(phase.phase_review.status, 'accepted', `round ${round}: a review that never named 1.2 was recorded as passed`);
        assert.notEqual(phase.phase_handoff?.required_reviews_passed, true, `round ${round}: the handoff says reviews passed with 1.2 unreviewed`);
        if (res.action === 'review_retry_exhausted') break;
        assert.equal(res.action, 'review_incomplete', `round ${round}: ${JSON.stringify(res)}`);
        assert.deepEqual(res.unreviewed_tasks, ['1.2']);
      }
      assert.equal(outcomes.at(-1), 'review_retry_exhausted', `the review loop did not end: ${outcomes.join(' → ')}`);
      assert.equal(outcomes.length, MAX_PHASE_REVIEW_RETRY + 1, outcomes.join(' → '));

      const state = await read({ basePath: tempDir });
      assert.equal(state.workflow_mode, 'awaiting_user');
      assert.equal(state.current_review.stage, 'review_retry_exhausted');
      const lifecycle = Object.fromEntries(state.phases[0].todo.map((t) => [t.id, t.lifecycle]));
      assert.deepEqual(lifecycle, { 1.1: 'accepted', 1.2: 'checkpointed' }, 'the task the review named was not accepted');
    });
  }

  it('a later round that names the target completes the review and resets the count', async () => {
    await setupPhase('L1');
    const first = await reviewRound(['1.1']);
    assert.equal(first.action, 'review_incomplete', JSON.stringify(first));
    const second = await reviewRound(['1.2']);
    assert.equal(second.action, 'review_accepted', JSON.stringify(second));
    const phase = (await read({ basePath: tempDir })).phases[0];
    assert.equal(phase.phase_review.status, 'accepted');
    assert.equal(phase.phase_review.retry_count, 0);
    assert.equal(phase.phase_handoff.required_reviews_passed, true);
  });
});

describe('a checkpointed L0 task is a phase-review target', () => {
  // selectRunnableTask triggers a phase review for any checkpointed task, but
  // getReviewTargets left L0 out: an L0 task sitting at checkpointed (a level
  // lowered by state-patch after checkpoint) was never handed to a reviewer,
  // never accepted, and the review came back every resume (pre-tag review).
  let tempDir;
  beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), 'gsd-reviewer-l0-')); });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('is sent to the reviewer, and accepting every target completes the review', async () => {
    await init({ project: 'reviewer-l0', phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }, { index: 2, name: 'Task B' }] }], basePath: tempDir });
    for (const id of ['1.1', '1.2']) {
      await update({ updates: { phases: [{ id: 1, todo: [{ id, lifecycle: 'running' }] }] }, basePath: tempDir });
      await update({ updates: { phases: [{ id: 1, todo: [{ id, lifecycle: 'checkpointed', checkpoint_commit: `c${id}` }] }] }, basePath: tempDir });
    }
    const patched = await patchPlan({ operations: [{ op: 'update_task', task_id: '1.1', level: 'L0' }], basePath: tempDir });
    assert.ok(patched.success, `premise: ${JSON.stringify(patched)}`);

    let dispatch = await resumeWorkflow({ basePath: tempDir });
    if (dispatch.action === 'trigger_review') dispatch = await resumeWorkflow({ basePath: tempDir });
    assert.equal(dispatch.action, 'dispatch_reviewer', JSON.stringify(dispatch));
    const targets = dispatch.review_targets.map((t) => t.id);
    assert.deepEqual(targets.sort(), ['1.1', '1.2'], 'the L0 task is not a review target');
    const res = await handleReviewerResult({
      result: makeValidReviewerResult({ scope: 'phase', scope_id: 1, review_level: 'L1-batch', accepted_tasks: targets }),
      basePath: tempDir,
    });
    assert.equal(res.action, 'review_accepted', JSON.stringify(res));
    const lifecycles = (await read({ basePath: tempDir })).phases[0].todo.map((t) => t.lifecycle);
    assert.deepEqual(lifecycles, ['accepted', 'accepted']);
    assert.equal((await resumeWorkflow({ basePath: tempDir })).action, 'complete_phase');
  });
});
