import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  init,
  read,
  update,
  phaseComplete,
  addEvidence,
  pruneEvidence,
  selectRunnableTask,
  buildExecutorContext,
  reclassifyReviewLevel,
} from '../src/tools/state.js';
import { readJson } from '../src/utils.js';

describe('E2E smoke: full project lifecycle', () => {
  let tempDir;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-e2e-smoke-'));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // Step 1
  it('init creates project with 2 phases', async () => {
    const result = await init({
      project: 'smoke-project',
      phases: [
        { name: 'Setup', tasks: [
          { index: 1, name: 'Init project', level: 'L0', requires: [] },
          { index: 2, name: 'Auth module', level: 'L2', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }] },
        ]},
        { name: 'Features', tasks: [
          { index: 1, name: 'API endpoints', level: 'L1', requires: [{ kind: 'phase', id: 1, gate: 'accepted' }] },
          { index: 2, name: 'Tests', level: 'L1', requires: [{ kind: 'task', id: '2.1', gate: 'checkpoint' }] },
        ]},
      ],
      research: true,
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    const stateResult = await readJson(join(tempDir, '.gsd', 'state.json'));
    assert.equal(stateResult.ok, true);

    const state = stateResult.data;
    assert.equal(state.phases.length, 2);
    assert.equal(state.total_phases, 2);
    assert.equal(state.phases[0].lifecycle, 'active');
    assert.equal(state.phases[1].lifecycle, 'pending');
    assert.equal(state.phases[0].todo.length, 2);
    assert.equal(state.phases[1].todo.length, 2);
    assert.equal(state.current_phase, 1);
  });

  // Step 2
  it('selectRunnableTask finds task 1.1', async () => {
    const state = await read({ basePath: tempDir });
    const phase1 = state.phases[0];
    const result = selectRunnableTask(phase1, state);

    assert.ok(result.task, 'should find a runnable task');
    assert.equal(result.task.id, '1.1');
    assert.equal(result.task.name, 'Init project');
  });

  // Step 3
  it('buildExecutorContext for task 1.1', async () => {
    const state = await read({ basePath: tempDir });
    const ctx = buildExecutorContext(state, '1.1', 1);

    assert.equal(ctx.task_spec, 'phases/phase-1.md');
    assert.deepEqual(ctx.research_decisions, []);
    assert.deepEqual(ctx.predecessor_outputs, []);
    assert.equal(ctx.project_conventions, 'CLAUDE.md');
    assert.ok(ctx.workflows.includes('workflows/tdd-cycle.md'));
    assert.equal(ctx.constraints.level, 'L0');
  });

  // Step 4
  it('walk task 1.1: pending -> running -> checkpointed -> accepted (L0 auto-accept)', async () => {
    // pending -> running
    let result = await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    // running -> checkpointed
    result = await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'checkpointed', checkpoint_commit: 'abc1234' }] }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    // checkpointed -> accepted (L0 = auto-accept, no review needed)
    result = await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'accepted' }] }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    const state = await read({ basePath: tempDir });
    const task11 = state.phases[0].todo.find(t => t.id === '1.1');
    assert.equal(task11.lifecycle, 'accepted');
    assert.equal(task11.checkpoint_commit, 'abc1234');
  });

  // Step 5
  it('addEvidence for task 1.1', async () => {
    const result = await addEvidence({
      id: 'ev:1.1',
      data: { scope: 'task:1.1', type: 'test', data: { passed: true } },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    const state = await read({ basePath: tempDir });
    assert.ok(state.evidence['ev:1.1']);
    assert.equal(state.evidence['ev:1.1'].scope, 'task:1.1');
  });

  // Step 6
  it('selectRunnableTask now finds task 1.2 (gate met)', async () => {
    const state = await read({ basePath: tempDir });
    const phase1 = state.phases[0];
    const result = selectRunnableTask(phase1, state);

    assert.ok(result.task, 'should find task 1.2 now that 1.1 is accepted');
    assert.equal(result.task.id, '1.2');
    assert.equal(result.task.name, 'Auth module');
  });

  // Step 7
  it('walk task 1.2: pending -> running -> checkpointed', async () => {
    let result = await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.2', lifecycle: 'running' }] }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    result = await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.2', lifecycle: 'checkpointed', checkpoint_commit: 'def5678' }] }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    const state = await read({ basePath: tempDir });
    const task12 = state.phases[0].todo.find(t => t.id === '1.2');
    assert.equal(task12.lifecycle, 'checkpointed');
  });

  // Step 8
  it('reclassifyReviewLevel for L2 task', async () => {
    const state = await read({ basePath: tempDir });
    const task12 = state.phases[0].todo.find(t => t.id === '1.2');

    const level = reclassifyReviewLevel(task12, {
      contract_changed: true,
      decisions: [],
    });

    // "Auth module" contains "auth" (sensitive keyword) + contract_changed => L2
    assert.equal(level, 'L2');
  });

  // Step 9
  it('simulate L2 review pass -> accepted', async () => {
    const result = await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.2', lifecycle: 'accepted' }] }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    const state = await read({ basePath: tempDir });
    const task12 = state.phases[0].todo.find(t => t.id === '1.2');
    assert.equal(task12.lifecycle, 'accepted');
  });

  // Step 10
  it('addEvidence and phaseComplete for phase 1', async () => {
    // Add evidence for task 1.2
    let result = await addEvidence({
      id: 'ev:1.2',
      data: { scope: 'task:1.2', type: 'test', data: { passed: true } },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    // Update phase done count to match accepted tasks
    result = await update({
      updates: { phases: [{ id: 1, done: 2 }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    // Transition phase 1: active -> reviewing (required before phaseComplete)
    result = await update({
      updates: { phases: [{ id: 1, lifecycle: 'reviewing' }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    result = await update({
      updates: { phases: [{ id: 1, phase_review: { status: 'accepted' } }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    // phaseComplete transitions reviewing -> accepted
    result = await phaseComplete({
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
    assert.equal(state.current_phase, 2);
  });

  // Step 11
  it('evidence pruning archived phase 1 evidence', async () => {
    // After phaseComplete with current_phase=2, evidence from phase 1
    // gets archived when threshold = current_phase - 1 = 1, so phase < 1 is archived.
    // Phase 1 evidence (scope "task:1.x") has phase=1, threshold=1, so 1 < 1 is false.
    // We need to call pruneEvidence explicitly with a higher phase to archive phase 1.
    const result = await pruneEvidence({ currentPhase: 3, basePath: tempDir });
    assert.equal(result.success, true);
    assert.ok(result.archived > 0, 'should have archived phase 1 evidence');

    const archiveResult = await readJson(join(tempDir, '.gsd', 'evidence-archive.json'));
    assert.equal(archiveResult.ok, true);
    assert.ok(archiveResult.data['ev:1.1'], 'ev:1.1 should be in archive');
  });

  // Step 12
  it('selectRunnableTask in phase 2', async () => {
    // Phase 2 needs to be active before tasks can run
    let result = await update({
      updates: { phases: [{ id: 2, lifecycle: 'active' }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    const state = await read({ basePath: tempDir });
    const phase2 = state.phases[1];

    // Task 2.1 requires phase 1 accepted (met), task 2.2 requires 2.1 checkpoint (not met)
    const runnable = selectRunnableTask(phase2, state);
    assert.ok(runnable.task, 'should find a runnable task in phase 2');
    assert.equal(runnable.task.id, '2.1');
    assert.equal(runnable.task.name, 'API endpoints');
  });

  // Step 13
  it('walk phase 2 tasks through lifecycle', async () => {
    // Task 2.1: pending -> running -> checkpointed -> accepted
    let result = await update({
      updates: { phases: [{ id: 2, todo: [{ id: '2.1', lifecycle: 'running' }] }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    result = await update({
      updates: { phases: [{ id: 2, todo: [{ id: '2.1', lifecycle: 'checkpointed', checkpoint_commit: 'ghi9012' }] }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    // After 2.1 checkpointed, task 2.2 dep (checkpoint gate) is met
    let state = await read({ basePath: tempDir });
    const phase2 = state.phases[1];
    const runnable = selectRunnableTask(phase2, state);
    assert.ok(runnable.task, 'task 2.2 should be runnable after 2.1 checkpoint');
    assert.equal(runnable.task.id, '2.2');

    // Accept task 2.1
    result = await update({
      updates: { phases: [{ id: 2, todo: [{ id: '2.1', lifecycle: 'accepted' }] }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    // Task 2.2: pending -> running -> checkpointed -> accepted
    result = await update({
      updates: { phases: [{ id: 2, todo: [{ id: '2.2', lifecycle: 'running' }] }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    result = await update({
      updates: { phases: [{ id: 2, todo: [{ id: '2.2', lifecycle: 'checkpointed', checkpoint_commit: 'jkl3456' }] }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    result = await update({
      updates: { phases: [{ id: 2, todo: [{ id: '2.2', lifecycle: 'accepted' }] }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    // Add evidence for both tasks
    result = await addEvidence({
      id: 'ev:2.1',
      data: { scope: 'task:2.1', type: 'test', data: { passed: true } },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    result = await addEvidence({
      id: 'ev:2.2',
      data: { scope: 'task:2.2', type: 'test', data: { passed: true } },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    state = await read({ basePath: tempDir });
    assert.equal(state.phases[1].todo[0].lifecycle, 'accepted');
    assert.equal(state.phases[1].todo[1].lifecycle, 'accepted');
  });

  // Step 14
  it('phaseComplete for phase 2 -> project complete', async () => {
    // Update done count for phase 2
    let result = await update({
      updates: { phases: [{ id: 2, done: 2 }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    // Transition phase 2: active -> reviewing
    result = await update({
      updates: { phases: [{ id: 2, lifecycle: 'reviewing' }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    result = await update({
      updates: { phases: [{ id: 2, phase_review: { status: 'accepted' } }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    // phaseComplete transitions reviewing -> accepted
    result = await phaseComplete({
      phase_id: 2,
      basePath: tempDir,
      verification: {
        lint: { exit_code: 0 },
        typecheck: { exit_code: 0 },
        test: { exit_code: 0 },
      },
      direction_ok: true,
    });
    assert.equal(result.success, true);

    // Mark project as completed
    result = await update({
      updates: { workflow_mode: 'completed' },
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    const state = await read({ basePath: tempDir });
    assert.equal(state.phases[0].lifecycle, 'accepted');
    assert.equal(state.phases[1].lifecycle, 'accepted');
    assert.equal(state.workflow_mode, 'completed');
  });

  // Step 15
  it('final state verification', async () => {
    const state = await read({ basePath: tempDir });

    // workflow_mode = completed
    assert.equal(state.workflow_mode, 'completed');

    // All 4 tasks accepted
    const allTasks = state.phases.flatMap(p => p.todo);
    assert.equal(allTasks.length, 4);
    for (const task of allTasks) {
      assert.equal(task.lifecycle, 'accepted', `task ${task.id} should be accepted`);
    }

    // Evidence exists for current phase tasks (phase 1 was archived)
    assert.ok(state.evidence['ev:2.1'], 'evidence for task 2.1 should exist');
    assert.ok(state.evidence['ev:2.2'], 'evidence for task 2.2 should exist');

    // Archived evidence for phase 1 tasks
    const archiveResult = await readJson(join(tempDir, '.gsd', 'evidence-archive.json'));
    assert.equal(archiveResult.ok, true);
    assert.ok(archiveResult.data['ev:1.1'], 'archived evidence for task 1.1 should exist');

    // Decisions array exists
    assert.ok(Array.isArray(state.decisions));

    // No orphaned blocked/failed tasks
    const badTasks = allTasks.filter(t => t.lifecycle === 'blocked' || t.lifecycle === 'failed');
    assert.equal(badTasks.length, 0, 'should have no blocked or failed tasks');
  });
});
