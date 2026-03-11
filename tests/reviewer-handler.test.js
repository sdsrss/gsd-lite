import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, read, update } from '../src/tools/state.js';
import { handleReviewerResult } from '../src/tools/orchestrator.js';

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
});
