import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, update, read, phaseComplete } from '../src/tools/state/index.js';

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

    assert.equal(result.success, true);
    assert.equal(result.action, 'direction_drift');
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

  it('rejects completion with a verification-required hint when verification is entirely absent', async () => {
    await prepareReviewingAcceptedPhase(tempDir);
    const reviewAccepted = await update({
      updates: { phases: [{ id: 1, phase_review: { status: 'accepted' } }] },
      basePath: tempDir,
    });
    assert.equal(reviewAccepted.success, true);

    const result = await phaseComplete({
      phase_id: 1,
      basePath: tempDir,
      direction_ok: true,
    });

    assert.equal(result.error, true);
    assert.equal(result.code, 'HANDOFF_GATE');
    assert.match(result.message, /verification required/i);
    assert.doesNotMatch(result.message, /verification checks failed/i);
  });

  it('fails handoff with run_verify: true when verification not provided', async () => {
    await prepareReviewingAcceptedPhase(tempDir);
    const reviewAccepted = await update({
      updates: { phases: [{ id: 1, phase_review: { status: 'accepted' } }] },
      basePath: tempDir,
    });
    assert.equal(reviewAccepted.success, true);

    // run_verify: true without verification parameter returns an error
    // (state layer no longer executes external tools directly)
    const result = await phaseComplete({
      phase_id: 1,
      basePath: tempDir,
      run_verify: true,
      direction_ok: true,
    });

    assert.equal(result.error, true);
    assert.equal(result.code, 'INVALID_INPUT');
    assert.match(result.message, /run_verify requires verification results/i);
  });

  it('reports run_verify without verification as INVALID_INPUT even when a state gate is also unmet', async () => {
    // `run_verify: true` with no `verification` is a contradiction in the
    // ARGUMENTS: no state makes that call valid, so it cannot be diagnosed by
    // looking at the phase. The tool description promises INVALID_INPUT for it
    // (src/server.js, phase-complete → run_verify).
    //
    // The test above reaches that check only because it first satisfies every
    // handoff gate. With a gate unmet the caller used to get HANDOFF_GATE
    // instead — sent off to accept tasks, and told the call was malformed all
    // along only on the next attempt.
    //
    // Enumerate the gates rather than sampling one: each is its own early
    // return, so a fix that only reorders past the first leaves the others.
    const gates = [
      {
        name: 'tasks not accepted',
        arrange: async (basePath) => {
          await init({
            project: 'handoff-test',
            phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
            basePath,
          });
        },
      },
      {
        name: 'phase review not passed',
        arrange: prepareReviewingAcceptedPhase,
      },
      {
        name: 'critical issues open',
        arrange: async (basePath) => {
          await prepareReviewingAcceptedPhase(basePath);
          const patched = await update({
            updates: {
              phases: [{
                id: 1,
                phase_review: { status: 'accepted' },
                phase_handoff: { critical_issues_open: 2 },
              }],
            },
            basePath,
          });
          assert.equal(patched.success, true, 'arrange: expected critical_issues_open to be set');
        },
      },
    ];

    for (const gate of gates) {
      const gateDir = await mkdtemp(join(tmpdir(), 'gsd-handoff-gate-'));
      try {
        await gate.arrange(gateDir);

        const result = await phaseComplete({
          phase_id: 1,
          basePath: gateDir,
          run_verify: true,
          direction_ok: true,
        });

        assert.equal(result.error, true, `${gate.name}: expected an error`);
        assert.equal(
          result.code,
          'INVALID_INPUT',
          `${gate.name}: a malformed call must be reported as malformed, not as the state gate it also happens to trip`,
        );
        assert.match(result.message, /run_verify requires verification results/i, gate.name);
      } finally {
        await rm(gateDir, { recursive: true, force: true });
      }
    }
  });

  it('reports run_verify without verification as INVALID_INPUT even with no project at all', async () => {
    // The fourth case, and the one the gate enumeration above cannot reach:
    // there is no `.gsd/` to have gates. Argument validation runs before
    // getStatePath, so NO_PROJECT_DIR no longer preempts this — which is the
    // consistent behaviour, since phase_id's and direction_ok's type checks
    // already ran before the project lookup and always have.
    //
    // Called out because it is a real precedence change for a caller who was
    // getting NO_PROJECT_DIR from this exact call before, not because it is
    // in doubt.
    const emptyDir = await mkdtemp(join(tmpdir(), 'gsd-handoff-noproject-'));
    try {
      const result = await phaseComplete({
        phase_id: 1,
        basePath: emptyDir,
        run_verify: true,
        direction_ok: true,
      });

      assert.equal(result.error, true);
      assert.equal(result.code, 'INVALID_INPUT');
      assert.match(result.message, /run_verify requires verification results/i);

      // Guard the guard: the same directory must still produce NO_PROJECT_DIR
      // for a well-formed call. Without this, the assertion above would keep
      // passing if argument validation ever swallowed the project check
      // outright.
      const wellFormed = await phaseComplete({
        phase_id: 1,
        basePath: emptyDir,
        verification: { lint: { exit_code: 0 }, typecheck: { exit_code: 0 }, test: { exit_code: 0 } },
        direction_ok: true,
      });
      assert.equal(wellFormed.error, true);
      assert.equal(wellFormed.code, 'NO_PROJECT_DIR');
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('completes phase when verification object is provided directly with all passing exit codes', async () => {
    await prepareReviewingAcceptedPhase(tempDir);
    const reviewAccepted = await update({
      updates: { phases: [{ id: 1, phase_review: { status: 'accepted' } }] },
      basePath: tempDir,
    });
    assert.equal(reviewAccepted.success, true);

    // Provide verification directly (not run_verify), all exit codes 0
    const result = await phaseComplete({
      phase_id: 1,
      basePath: tempDir,
      verification: {
        lint: { exit_code: 0 },
        typecheck: { exit_code: 0 },
        test: { exit_code: 0 },
      },
      direction_ok: true,
    });

    assert.equal(result.success, true);

    const state = await read({ basePath: tempDir });
    assert.equal(state.phases[0].lifecycle, 'accepted');
    assert.equal(state.phases[0].phase_handoff.tests_passed, true);
  });

  it('sets workflow_mode to completed when the final phase completes', async () => {
    // Single-phase project: phase 1 is both first and last
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
    assert.equal(state.workflow_mode, 'completed', 'workflow_mode should be completed after final phase');
  });

  it('does not set workflow_mode to completed when a non-final phase completes', async () => {
    await init({
      project: 'handoff-non-final',
      phases: [
        { name: 'Phase 1', tasks: [{ index: 1, name: 'Task A' }] },
        { name: 'Phase 2', tasks: [{ index: 1, name: 'Task B' }] },
      ],
      basePath: tempDir,
    });

    // Transition task through lifecycle
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

    const state = await read({ basePath: tempDir });
    assert.notEqual(state.workflow_mode, 'completed', 'workflow_mode should NOT be completed for non-final phase');
    assert.equal(state.current_phase, 2);
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