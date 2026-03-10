import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, update, read, phaseComplete } from '../src/tools/state.js';

async function prepareReviewingAcceptedPhase(basePath) {
  await init({
    project: 'handoff-test',
    phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
    basePath,
  });

  let result = await update({
    updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] },
    basePath,
  });
  assert.equal(result.success, true);

  result = await update({
    updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'checkpointed', checkpoint_commit: 'abc123' }] }] },
    basePath,
  });
  assert.equal(result.success, true);

  result = await update({
    updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'accepted' }] }] },
    basePath,
  });
  assert.equal(result.success, true);

  result = await update({
    updates: { phases: [{ id: 1, lifecycle: 'reviewing' }] },
    basePath,
  });
  assert.equal(result.success, true);
}

describe('phase handoff gate', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-handoff-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('rejects completion when phase review has not passed', async () => {
    await prepareReviewingAcceptedPhase(tempDir);

    const result = await phaseComplete({
      phase_id: 1,
      basePath: tempDir,
      verification: { lint: { exit_code: 0 }, typecheck: { exit_code: 0 }, test: { exit_code: 0 } },
      direction_ok: true,
    });

    assert.equal(result.error, true);
    assert.match(result.message, /required reviews not passed/i);
  });

  it('rejects completion when verification fails', async () => {
    await prepareReviewingAcceptedPhase(tempDir);
    const reviewAccepted = await update({
      updates: { phases: [{ id: 1, phase_review: { status: 'accepted' } }] },
      basePath: tempDir,
    });
    assert.equal(reviewAccepted.success, true);

    const result = await phaseComplete({
      phase_id: 1,
      basePath: tempDir,
      verification: { lint: { exit_code: 0 }, typecheck: { exit_code: 1 }, test: { exit_code: 0 } },
      direction_ok: true,
    });

    assert.equal(result.error, true);
    assert.match(result.message, /verification checks failed/i);
  });

  it('blocks handoff and switches to awaiting_user on direction drift', async () => {
    await prepareReviewingAcceptedPhase(tempDir);
    const reviewAccepted = await update({
      updates: { phases: [{ id: 1, phase_review: { status: 'accepted' } }] },
      basePath: tempDir,
    });
    assert.equal(reviewAccepted.success, true);

    const result = await phaseComplete({
      phase_id: 1,
      basePath: tempDir,
      verification: { lint: { exit_code: 0 }, typecheck: { exit_code: 0 }, test: { exit_code: 0 } },
      direction_ok: false,
    });

    assert.equal(result.error, true);
    assert.equal(result.workflow_mode, 'awaiting_user');

    const state = await read({ basePath: tempDir });
    assert.equal(state.workflow_mode, 'awaiting_user');
    assert.equal(state.current_review.stage, 'direction_drift');
    assert.equal(state.current_review.scope_id, 1);
    assert.equal(state.phases[0].lifecycle, 'reviewing');
    assert.equal(state.phases[0].phase_handoff.direction_ok, false);
  });

  it('completes phase only when review, verification, and direction gates all pass', async () => {
    await prepareReviewingAcceptedPhase(tempDir);
    const reviewAccepted = await update({
      updates: { phases: [{ id: 1, phase_review: { status: 'accepted' } }] },
      basePath: tempDir,
    });
    assert.equal(reviewAccepted.success, true);

    const result = await phaseComplete({
      phase_id: 1,
      basePath: tempDir,
      verification: { lint: { exit_code: 0 }, typecheck: { exit_code: 0 }, test: { exit_code: 0 } },
      direction_ok: true,
    });

    assert.equal(result.success, true);

    const state = await read({ basePath: tempDir });
    assert.equal(state.phases[0].lifecycle, 'accepted');
    assert.equal(state.phases[0].phase_handoff.required_reviews_passed, true);
    assert.equal(state.phases[0].phase_handoff.tests_passed, true);
    assert.equal(state.phases[0].phase_handoff.direction_ok, true);
  });

  it('activates the next phase lifecycle when current phase completes', async () => {
    await init({
      project: 'handoff-next-phase',
      phases: [
        { name: 'Phase 1', tasks: [{ index: 1, name: 'Task A' }] },
        { name: 'Phase 2', tasks: [{ index: 1, name: 'Task B' }] },
      ],
      basePath: tempDir,
    });

    // Verify initial state: phase 1 active, phase 2 pending
    let state = await read({ basePath: tempDir });
    assert.equal(state.phases[0].lifecycle, 'active');
    assert.equal(state.phases[1].lifecycle, 'pending');

    // Transition task through lifecycle: pending → running → checkpointed → accepted
    await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] },
      basePath: tempDir,
    });
    await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'checkpointed', checkpoint_commit: 'abc' }] }] },
      basePath: tempDir,
    });
    await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'accepted' }] }] },
      basePath: tempDir,
    });

    // Transition phase to reviewing
    await update({
      updates: { phases: [{ id: 1, lifecycle: 'reviewing', phase_review: { status: 'accepted' } }] },
      basePath: tempDir,
    });

    const result = await phaseComplete({
      phase_id: 1,
      basePath: tempDir,
      verification: { lint: { exit_code: 0 }, typecheck: { exit_code: 0 }, test: { exit_code: 0 } },
      direction_ok: true,
    });

    assert.equal(result.success, true);

    state = await read({ basePath: tempDir });
    assert.equal(state.phases[0].lifecycle, 'accepted');
    assert.equal(state.phases[1].lifecycle, 'active');
    assert.equal(state.current_phase, 2);
  });
});