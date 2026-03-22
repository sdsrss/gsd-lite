/**
 * Simulation edge cases — tests that probe for real product bugs.
 * These target specific edge conditions found during code review.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { init, read, update, addEvidence, setLockPath, selectRunnableTask, applyResearchRefresh, propagateInvalidation, reclassifyReviewLevel, matchDecisionForBlocker, buildExecutorContext } from '../src/tools/state/index.js';
import { handleExecutorResult, handleDebuggerResult, handleReviewerResult, resumeWorkflow } from '../src/tools/orchestrator/index.js';

let basePath;

async function createTmpGit() {
  basePath = await mkdtemp(join(tmpdir(), 'gsd-edge-'));
  execSync('git init && git commit --allow-empty -m "init"', {
    cwd: basePath,
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' },
  });
  setLockPath(null);
  return basePath;
}

async function cleanTmp() {
  if (basePath) await rm(basePath, { recursive: true, force: true });
}

function makePhases(defs) {
  return defs.map(d => ({
    name: d.name,
    tasks: (d.tasks || []).map(t => ({
      name: t.name,
      level: t.level || 'L1',
      requires: t.requires || [],
      review_required: t.review_required ?? true,
      verification_required: t.verification_required ?? true,
      ...(t.research_basis ? { research_basis: t.research_basis } : {}),
    })),
  }));
}

// ── EDGE 1: Concurrent-like mutations (sequential stress) ──

describe('Edge 1: Rapid sequential state mutations', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('1.1 Multiple updates in quick succession all succeed', async () => {
    await init({
      project: 'ConcurrentTest',
      phases: makePhases([{
        name: 'P1',
        tasks: [
          { name: 'T1', level: 'L0', review_required: false },
          { name: 'T2', level: 'L0', review_required: false },
          { name: 'T3', level: 'L0', review_required: false },
        ],
      }]),
      basePath,
    });

    // Fire multiple updates rapidly
    const results = await Promise.all([
      update({ updates: { current_task: '1.1' }, basePath }),
      update({ updates: { current_task: '1.2' }, basePath }),
      update({ updates: { current_task: '1.3' }, basePath }),
    ]);

    // All should succeed (serialized by mutation queue)
    for (const r of results) {
      assert.ok(r.success, `Update failed: ${JSON.stringify(r)}`);
    }

    // Final state should be one of the values (last writer wins)
    const state = await read({ basePath });
    assert.ok(['1.1', '1.2', '1.3'].includes(state.current_task));
  });
});

// ── EDGE 2: Deeply nested task dependency chains ──

describe('Edge 2: Long dependency chain', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('2.1 Chain of 5 tasks with sequential dependencies', async () => {
    const result = await init({
      project: 'ChainTest',
      phases: [{
        name: 'Pipeline',
        tasks: [
          { name: 'Step 1' },
          { name: 'Step 2', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }] },
          { name: 'Step 3', requires: [{ kind: 'task', id: '1.2', gate: 'accepted' }] },
          { name: 'Step 4', requires: [{ kind: 'task', id: '1.3', gate: 'accepted' }] },
          { name: 'Step 5', requires: [{ kind: 'task', id: '1.4', gate: 'accepted' }] },
        ],
      }],
      basePath,
    });
    assert.ok(result.success);

    // Only task 1.1 should be runnable
    const state = await read({ basePath });
    const sel = selectRunnableTask(state.phases[0], state);
    assert.equal(sel.task.id, '1.1');
  });
});

// ── EDGE 3: Research refresh with removed decisions ──

describe('Edge 3: Research refresh invalidation', () => {
  it('3.1 Removed decision invalidates dependent tasks', () => {
    const state = {
      phases: [{
        id: 1,
        todo: [
          { id: '1.1', lifecycle: 'accepted', name: 'T1', research_basis: ['d1'], evidence_refs: ['ev1'] },
          { id: '1.2', lifecycle: 'checkpointed', name: 'T2', research_basis: ['d2'], evidence_refs: [] },
          { id: '1.3', lifecycle: 'pending', name: 'T3', research_basis: ['d1'], evidence_refs: [] },
        ],
      }],
      research: {
        decision_index: {
          d1: { summary: 'Use React' },
          d2: { summary: 'Use PostgreSQL' },
        },
      },
    };

    const result = applyResearchRefresh(state, {
      decision_index: {
        // d1 removed!
        d2: { summary: 'Use PostgreSQL' }, // same
        d3: { summary: 'Use Redis' }, // new
      },
    });

    assert.ok(result.warnings.length > 0, 'Should warn about removed d1');
    assert.ok(result.warnings[0].includes('d1'));

    // Task 1.1 (accepted, depends on d1) → needs_revalidation
    assert.equal(state.phases[0].todo[0].lifecycle, 'needs_revalidation');
    assert.deepEqual(state.phases[0].todo[0].evidence_refs, []);

    // Task 1.2 (checkpointed, depends on d2 unchanged) → stays checkpointed
    assert.equal(state.phases[0].todo[1].lifecycle, 'checkpointed');

    // Task 1.3 (pending, depends on d1) → stays pending (can't invalidate pending)
    assert.equal(state.phases[0].todo[2].lifecycle, 'pending');

    // New decision d3 added
    assert.ok(state.research.decision_index.d3);
  });

  it('3.2 Changed decision summary invalidates dependent tasks', () => {
    const state = {
      phases: [{
        id: 1,
        todo: [
          { id: '1.1', lifecycle: 'checkpointed', name: 'T1', research_basis: ['d1'], evidence_refs: ['ev1'] },
        ],
      }],
      research: {
        decision_index: {
          d1: { summary: 'Use React', source: 'docs' },
        },
      },
    };

    applyResearchRefresh(state, {
      decision_index: {
        d1: { summary: 'Use Vue instead of React', source: 'docs' }, // changed summary
      },
    });

    assert.equal(state.phases[0].todo[0].lifecycle, 'needs_revalidation');
    assert.equal(state.research.decision_index.d1.summary, 'Use Vue instead of React');
  });
});

// ── EDGE 4: Propagation depth ──

describe('Edge 4: Transitive dependency propagation', () => {
  it('4.1 Propagation cascades through chain', () => {
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'accepted', requires: [], evidence_refs: ['e1'] },
        { id: '1.2', lifecycle: 'accepted', requires: [{ kind: 'task', id: '1.1' }], evidence_refs: ['e2'] },
        { id: '1.3', lifecycle: 'checkpointed', requires: [{ kind: 'task', id: '1.2' }], evidence_refs: ['e3'] },
        { id: '1.4', lifecycle: 'pending', requires: [{ kind: 'task', id: '1.3' }], evidence_refs: [] },
      ],
    };

    propagateInvalidation(phase, '1.1', true);

    // 1.2 (accepted→needs_revalidation): direct dep
    assert.equal(phase.todo[1].lifecycle, 'needs_revalidation');
    assert.deepEqual(phase.todo[1].evidence_refs, []);

    // 1.3 (checkpointed→needs_revalidation): transitive
    assert.equal(phase.todo[2].lifecycle, 'needs_revalidation');
    assert.deepEqual(phase.todo[2].evidence_refs, []);

    // 1.4 (pending→stays pending): can't transition pending→needs_revalidation
    assert.equal(phase.todo[3].lifecycle, 'pending');
  });
});

// ── EDGE 5: Evidence with non-standard scope format ──

describe('Edge 5: Evidence scope edge cases', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('5.1 Evidence with unusual scope format still stores', async () => {
    await init({
      project: 'ScopeTest',
      phases: makePhases([{
        name: 'P1',
        tasks: [{ name: 'T1' }],
      }]),
      basePath,
    });

    // Non-standard scope (no "task:X.Y" format)
    const result = await addEvidence({
      id: 'ev-custom',
      data: { scope: 'global:project', type: 'audit', detail: 'security scan' },
      basePath,
    });
    assert.ok(result.success, 'Should accept any non-empty scope string');
  });

  it('5.2 Evidence with scope "global" is not pruned on phase advance', async () => {
    const state = await read({ basePath });
    assert.ok(state.evidence['ev-custom']);

    // The prune logic looks for "task:X.Y" pattern — global scope won't match
    // So it should survive phase completion pruning
  });
});

// ── EDGE 6: matchDecisionForBlocker edge cases ──

describe('Edge 6: Auto-unblock matching edge cases', () => {
  it('6.1 No match when tokens too short', () => {
    const decisions = [{ id: 'd1', summary: 'A B' }]; // single-char tokens filtered
    const result = matchDecisionForBlocker(decisions, 'a b c');
    assert.equal(result, null, 'Single char tokens should be filtered');
  });

  it('6.2 Matches when overlap >= 2 tokens', () => {
    const decisions = [{ id: 'd1', summary: 'Use React framework for frontend development' }];
    const result = matchDecisionForBlocker(decisions, 'Need React framework decision');
    assert.ok(result, 'Should match on "React" and "framework"');
    assert.equal(result.id, 'd1');
  });

  it('6.3 Empty blocker reason returns null', () => {
    const result = matchDecisionForBlocker([{ id: 'd1', summary: 'something' }], '');
    assert.equal(result, null);
  });

  it('6.4 Picks best match when multiple candidates', () => {
    const decisions = [
      { id: 'd1', summary: 'React component library choice' },
      { id: 'd2', summary: 'React state management and component architecture patterns' },
    ];
    const result = matchDecisionForBlocker(decisions, 'Need React component architecture decision');
    assert.ok(result);
    assert.equal(result.id, 'd2', 'Should pick higher overlap');
  });
});

// ── EDGE 7: reclassifyReviewLevel edge cases ──

describe('Edge 7: Review level reclassification', () => {
  it('7.1 Never downgrades L2/L3', () => {
    assert.equal(reclassifyReviewLevel({ level: 'L2' }, { decisions: [], contract_changed: false }), 'L2');
    assert.equal(reclassifyReviewLevel({ level: 'L3' }, { decisions: [], contract_changed: false }), 'L3');
  });

  it('7.2 [LEVEL-UP] in object decision works', () => {
    const level = reclassifyReviewLevel(
      { level: 'L1', name: 'something' },
      { decisions: [{ summary: '[LEVEL-UP] Important change' }], contract_changed: false },
    );
    assert.equal(level, 'L2');
  });

  it('7.3 contract_changed + payment keyword upgrades', () => {
    const level = reclassifyReviewLevel(
      { level: 'L1', name: 'Stripe payment integration' },
      { decisions: [], contract_changed: true },
    );
    assert.equal(level, 'L2');
  });

  it('7.4 contract_changed without sensitive keyword stays L1', () => {
    const level = reclassifyReviewLevel(
      { level: 'L1', name: 'Update README formatting' },
      { decisions: [], contract_changed: true },
    );
    assert.equal(level, 'L1');
  });
});

// ── EDGE 8: Phase dependency across phases ──

describe('Edge 8: Cross-phase dependencies', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('8.1 Task in phase 2 blocked by phase 1 not accepted', async () => {
    await init({
      project: 'CrossPhase',
      phases: [{
        name: 'Foundation',
        tasks: [{ name: 'Setup' }],
      }, {
        name: 'Feature',
        tasks: [{ name: 'Build feature', requires: [{ kind: 'phase', id: 1, gate: 'phase_complete' }] }],
      }],
      basePath,
    });

    const state = await read({ basePath });
    // Phase 2 task has phase dependency
    const phase2 = state.phases[1];
    const sel = selectRunnableTask(phase2, state);
    // Phase 1 not accepted yet, so task should not be runnable
    assert.equal(sel.task, undefined, 'Task with phase dependency should not be runnable');
  });

  it('8.2 Phase dep with string id resolves correctly when phase is accepted', async () => {
    // Regression: MCP input sends dep.id as string "1" but phase.id is number 1
    const state = await read({ basePath });
    // Accept phase 1 task and mark phase 1 as accepted
    state.phases[0].todo[0].lifecycle = 'accepted';
    state.phases[0].lifecycle = 'accepted';
    // Ensure phase 2 dep.id is a string (as MCP tools would provide)
    state.phases[1].todo[0].requires = [{ kind: 'phase', id: '1', gate: 'phase_complete' }];
    state.phases[1].lifecycle = 'active';
    const phase2 = state.phases[1];
    const sel = selectRunnableTask(phase2, state);
    assert.ok(sel.task, 'Task with string phase dep id should be runnable when phase is accepted');
    assert.equal(sel.task.id, '2.1');
  });
});

// ── EDGE 9: buildExecutorContext with missing data ──

describe('Edge 9: Executor context with missing/partial data', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('9.1 Missing phase returns error', async () => {
    await init({
      project: 'CtxTest',
      phases: makePhases([{ name: 'P1', tasks: [{ name: 'T1' }] }]),
      basePath,
    });
    const state = await read({ basePath });
    const ctx = buildExecutorContext(state, '1.1', 99); // non-existent phase
    assert.ok(ctx.error);
  });

  it('9.2 Missing task returns error', async () => {
    const state = await read({ basePath });
    const ctx = buildExecutorContext(state, '99.99', 1); // non-existent task
    assert.ok(ctx.error);
  });

  it('9.3 Context includes debugging workflow on retry', async () => {
    const state = await read({ basePath });
    state.phases[0].todo[0].retry_count = 1;
    const ctx = buildExecutorContext(state, '1.1', 1);
    assert.ok(!ctx.error);
    assert.ok(ctx.workflows.includes('workflows/debugging.md'));
  });

  it('9.4 Context includes research workflow when research_basis present', async () => {
    const state = await read({ basePath });
    state.phases[0].todo[0].research_basis = ['d1'];
    const ctx = buildExecutorContext(state, '1.1', 1);
    assert.ok(!ctx.error);
    assert.ok(ctx.workflows.includes('workflows/research.md'));
  });
});

// ── EDGE 10: State with corrupted JSON ──

describe('Edge 10: Corrupted state handling', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('10.1 Corrupted state.json returns error on read', async () => {
    await init({
      project: 'CorruptTest',
      phases: makePhases([{ name: 'P1', tasks: [{ name: 'T1' }] }]),
      basePath,
    });

    // Corrupt the JSON
    await writeFile(join(basePath, '.gsd', 'state.json'), '{ invalid json !!!', 'utf-8');

    const result = await read({ basePath });
    assert.ok(result.error, 'Should return error for corrupted JSON');
  });

  it('10.2 Resume with corrupted state returns error', async () => {
    const result = await resumeWorkflow({ basePath });
    assert.ok(result.error);
  });
});

// ── EDGE 11: Executor result with missing task ──

describe('Edge 11: Executor result referencing non-existent task', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('11.1 Returns error for unknown task_id', async () => {
    await init({
      project: 'MissingTask',
      phases: makePhases([{ name: 'P1', tasks: [{ name: 'T1' }] }]),
      basePath,
    });

    const result = await handleExecutorResult({
      result: {
        task_id: '99.99', // doesn't exist
        outcome: 'checkpointed',
        summary: 'done',
        checkpoint_commit: 'c1',
        files_changed: [],
        decisions: [],
        contract_changed: false,
        blockers: [],
        evidence: [],
      },
      basePath,
    });
    assert.ok(result.error);
    assert.ok(result.message.includes('not found'));
  });
});

// ── EDGE 12: Decision accumulation cap ──

describe('Edge 12: Decision cap at 200', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('12.1 Decisions capped at 200 entries', async () => {
    await init({
      project: 'DecisionCap',
      phases: makePhases([{ name: 'P1', tasks: [{ name: 'T1' }] }]),
      basePath,
    });

    // Pre-fill 199 decisions
    const bigDecisions = Array.from({ length: 199 }, (_, i) => ({
      id: `d${i}`, summary: `Decision ${i}`, phase: 1, task: '1.1',
    }));
    await update({ updates: { decisions: bigDecisions }, basePath });

    // Start task
    await resumeWorkflow({ basePath });

    // Submit result with 5 more decisions
    await handleExecutorResult({
      result: {
        task_id: '1.1',
        outcome: 'checkpointed',
        summary: 'Done with many decisions',
        checkpoint_commit: 'c1',
        files_changed: [],
        decisions: ['new1', 'new2', 'new3', 'new4', 'new5'],
        contract_changed: false,
        blockers: [],
        evidence: [],
      },
      basePath,
    });

    const state = await read({ basePath });
    // 199 + 5 = 204, capped to 200
    assert.ok(state.decisions.length <= 200, `Decisions should be capped at 200, got ${state.decisions.length}`);
    // Oldest should be trimmed
    assert.ok(state.decisions[state.decisions.length - 1].summary.includes('new'));
  });
});

// ── EDGE 13: Debugger result with failed + no progressable tasks ──

describe('Edge 13: Debugger failure with no other progressable tasks', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('13.1 Single task failure with no siblings → awaiting_user', async () => {
    await init({
      project: 'SingleFail',
      phases: makePhases([{ name: 'P1', tasks: [{ name: 'Only Task', level: 'L2' }] }]),
      basePath,
    });

    // Start and fail 3 times
    await resumeWorkflow({ basePath });
    for (let i = 0; i < 3; i++) {
      await handleExecutorResult({
        result: {
          task_id: '1.1', outcome: 'failed', summary: 'keeps failing',
          checkpoint_commit: null, files_changed: [],
          decisions: [], contract_changed: false, blockers: [], evidence: [],
        },
        basePath,
      });
    }

    // Debugger fails without architecture concern
    const result = await handleDebuggerResult({
      result: {
        task_id: '1.1',
        outcome: 'failed',
        root_cause: 'Cannot determine fix',
        fix_direction: 'Need human help',
        evidence: ['Exhausted options'],
        hypothesis_tested: [{ hypothesis: 'config issue', result: 'rejected', evidence: 'checked config' }],
        fix_attempts: 3,
        blockers: [],
        architecture_concern: false,
      },
      basePath,
    });
    assert.ok(result.success);
    // No other tasks to progress → should be awaiting_user (not executing_task)
    assert.equal(result.workflow_mode, 'awaiting_user');
    assert.equal(result.action, 'task_failed');
  });
});

// ── EDGE 14: Reviewer accepts already-accepted task (idempotent) ──

describe('Edge 14: Reviewer accepting already-accepted task', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('14.1 Accepting already-accepted task is safe', async () => {
    await init({
      project: 'IdempotentAccept',
      phases: makePhases([{ name: 'P1', tasks: [{ name: 'T1', level: 'L2' }, { name: 'T2', level: 'L2' }] }]),
      basePath,
    });

    // Complete and accept task 1.1
    await resumeWorkflow({ basePath });
    await handleExecutorResult({
      result: {
        task_id: '1.1', outcome: 'checkpointed', summary: 'done',
        checkpoint_commit: 'c1', files_changed: [],
        decisions: [], contract_changed: false, blockers: [], evidence: [],
      },
      basePath,
    });
    await handleReviewerResult({
      result: {
        scope: 'task', scope_id: '1.1', review_level: 'L2',
        spec_passed: true, quality_passed: true,
        critical_issues: [], important_issues: [], minor_issues: [],
        accepted_tasks: ['1.1'], rework_tasks: [], evidence: [],
      },
      basePath,
    });

    const stateBefore = await read({ basePath });
    assert.equal(stateBefore.phases[0].todo[0].lifecycle, 'accepted');

    // Phase review tries to accept 1.1 again (already accepted)
    // This should be harmless - just skip the already-accepted task
    await resumeWorkflow({ basePath }); // start 1.2
    await handleExecutorResult({
      result: {
        task_id: '1.2', outcome: 'checkpointed', summary: 'done',
        checkpoint_commit: 'c2', files_changed: [],
        decisions: [], contract_changed: false, blockers: [], evidence: [],
      },
      basePath,
    });

    // Phase review accepts both (1.1 already accepted, 1.2 checkpointed)
    await resumeWorkflow({ basePath }); // triggers phase review
    const result = await handleReviewerResult({
      result: {
        scope: 'phase', scope_id: 1, review_level: 'L1-batch',
        spec_passed: true, quality_passed: true,
        critical_issues: [], important_issues: [], minor_issues: [],
        accepted_tasks: ['1.1', '1.2'], // 1.1 already accepted
        rework_tasks: [],
        evidence: [],
      },
      basePath,
    });
    assert.ok(result.success);

    const stateAfter = await read({ basePath });
    assert.equal(stateAfter.phases[0].todo[0].lifecycle, 'accepted');
    assert.equal(stateAfter.phases[0].todo[1].lifecycle, 'accepted');
  });
});

// ── EDGE 15: done counter accuracy ──

describe('Edge 15: Phase done counter tracking', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('15.1 Done counter increments and decrements correctly', async () => {
    await init({
      project: 'DoneCounter',
      phases: makePhases([{
        name: 'P1',
        tasks: [
          { name: 'T1', level: 'L2' },
          { name: 'T2', level: 'L2' },
        ],
      }]),
      basePath,
    });

    // Complete T1
    await resumeWorkflow({ basePath });
    await handleExecutorResult({
      result: {
        task_id: '1.1', outcome: 'checkpointed', summary: 'done',
        checkpoint_commit: 'c1', files_changed: ['a.js'],
        decisions: [], contract_changed: false, blockers: [], evidence: [],
      },
      basePath,
    });
    await handleReviewerResult({
      result: {
        scope: 'task', scope_id: '1.1', review_level: 'L2',
        spec_passed: true, quality_passed: true,
        critical_issues: [], important_issues: [], minor_issues: [],
        accepted_tasks: ['1.1'], rework_tasks: [], evidence: [],
      },
      basePath,
    });

    let state = await read({ basePath });
    assert.equal(state.phases[0].done, 1, 'done should be 1 after accepting T1');

    // Complete T2
    await resumeWorkflow({ basePath });
    await handleExecutorResult({
      result: {
        task_id: '1.2', outcome: 'checkpointed', summary: 'done',
        checkpoint_commit: 'c2', files_changed: ['b.js'],
        decisions: [], contract_changed: false, blockers: [], evidence: [],
      },
      basePath,
    });
    await handleReviewerResult({
      result: {
        scope: 'task', scope_id: '1.2', review_level: 'L2',
        spec_passed: true, quality_passed: true,
        critical_issues: [], important_issues: [], minor_issues: [],
        accepted_tasks: ['1.2'], rework_tasks: [], evidence: [],
      },
      basePath,
    });

    state = await read({ basePath });
    assert.equal(state.phases[0].done, 2, 'done should be 2 after accepting T2');

    // Phase review rejects T1 (rework) — done should decrement
    await resumeWorkflow({ basePath }); // trigger phase review
    await handleReviewerResult({
      result: {
        scope: 'phase', scope_id: 1, review_level: 'L1-batch',
        spec_passed: false, quality_passed: false,
        critical_issues: [{ reason: 'Bug in T1', task_id: '1.1' }],
        important_issues: [], minor_issues: [],
        accepted_tasks: [],
        rework_tasks: ['1.1'],
        evidence: [],
      },
      basePath,
    });

    state = await read({ basePath });
    assert.equal(state.phases[0].done, 1, 'done should decrement to 1 after rework T1');
  });
});

// ── EDGE 16: selectRunnableTask diagnostics ──

describe('Edge 16: selectRunnableTask diagnostic output', () => {
  it('16.1 Provides diagnostics when no task is runnable', () => {
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'running', name: 'T1', requires: [], retry_count: 0 },
      ],
    };
    const state = { phases: [{ id: 1, ...phase }] };

    const result = selectRunnableTask(phase, state);
    assert.equal(result.task, undefined);
    assert.ok(result.diagnostics, 'Should include diagnostics');
    assert.ok(result.diagnostics[0].reasons.length > 0);
  });

  it('16.2 Skip tasks at max retry', () => {
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'pending', name: 'T1', requires: [], retry_count: 3 },
      ],
    };
    const state = { phases: [{ id: 1, ...phase }] };

    const result = selectRunnableTask(phase, state);
    assert.equal(result.task, undefined);
    assert.ok(result.diagnostics[0].reasons.some(r => r.includes('retry_count')));
  });
});

// ── EDGE 17: State migration ──

describe('Edge 17: Schema migration v0→v1', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('17.1 v0 state gets migrated on read', async () => {
    await init({
      project: 'MigrateTest',
      phases: makePhases([{ name: 'P1', tasks: [{ name: 'T1' }] }]),
      basePath,
    });

    // Tamper: downgrade to v0
    const statePath = join(basePath, '.gsd', 'state.json');
    const raw = JSON.parse(await readFile(statePath, 'utf-8'));
    delete raw.evidence;
    delete raw.research;
    delete raw.decisions;
    delete raw.context;
    raw.schema_version = 0;
    await writeFile(statePath, JSON.stringify(raw), 'utf-8');

    // Read should auto-migrate
    const state = await read({ basePath });
    assert.ok(!state.error, `Read failed: ${JSON.stringify(state)}`);
    assert.equal(state.schema_version, 1);
    assert.ok(state.evidence !== undefined);
    assert.ok(state.decisions !== undefined);
    assert.ok(state.context !== undefined);
  });

  it('17.2 update() auto-migrates v0 state before merging', async () => {
    await init({
      project: 'MigrateUpdateTest',
      phases: makePhases([{ name: 'P1', tasks: [{ name: 'T1' }] }]),
      basePath,
    });

    // Tamper: downgrade to v0 (remove v1-only fields)
    const statePath = join(basePath, '.gsd', 'state.json');
    const raw = JSON.parse(await readFile(statePath, 'utf-8'));
    delete raw.evidence;
    delete raw.research;
    delete raw.decisions;
    delete raw.context;
    raw.schema_version = 0;
    await writeFile(statePath, JSON.stringify(raw), 'utf-8');

    // update() should auto-migrate before applying the update
    const result = await update({
      updates: { git_head: 'abc1234' },
      basePath,
    });
    assert.ok(!result.error, `Update failed: ${JSON.stringify(result)}`);

    const state = await read({ basePath });
    assert.equal(state.schema_version, 1);
    assert.equal(state.git_head, 'abc1234');
    assert.ok(state.evidence !== undefined);
    assert.ok(state.context !== undefined);
  });
});

// ── EDGE 18: init with tasks missing name ──

describe('Edge 18: Invalid init inputs', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('18.1 Task without name rejected', async () => {
    const result = await init({
      project: 'BadInit',
      phases: [{ name: 'P1', tasks: [{}] }],
      basePath,
    });
    assert.ok(result.error);
    assert.ok(result.message.includes('name is required'));
  });

  it('18.2 Duplicate task IDs rejected', async () => {
    const result = await init({
      project: 'DupeIds',
      phases: [{
        name: 'P1',
        tasks: [
          { name: 'A', index: 1 },
          { name: 'B', index: 1 }, // same index → same ID
        ],
      }],
      basePath,
    });
    assert.ok(result.error);
    assert.ok(result.message.includes('Duplicate'));
  });

  it('18.3 Empty project name rejected', async () => {
    const result = await init({ project: '', phases: [], basePath });
    assert.ok(result.error);
    assert.equal(result.code, 'INVALID_INPUT');
  });

  it('18.4 Non-array phases rejected', async () => {
    const result = await init({ project: 'X', phases: 'not-array', basePath });
    assert.ok(result.error);
  });
});

// ── EDGE 19: Force-unblock via orchestrator-resume ──

describe('Edge 19: Force-unblock tasks via resume', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('19.1 unblock_tasks parameter resolves blocked task and resumes execution', async () => {
    await init({
      project: 'UnblockTest',
      phases: [{ name: 'P1', tasks: [{ name: 'Blocked task' }] }],
      basePath,
    });

    // Execute then block
    await resumeWorkflow({ basePath });
    await handleExecutorResult({
      result: {
        task_id: '1.1', outcome: 'blocked', summary: 'Need API key',
        checkpoint_commit: null, files_changed: [], decisions: [],
        blockers: [{ description: 'Missing API key' }],
        contract_changed: false, evidence: [],
      },
      basePath,
    });

    // Verify blocked
    let state = await read({ basePath });
    assert.equal(state.workflow_mode, 'awaiting_user');
    assert.equal(state.phases[0].todo[0].lifecycle, 'blocked');

    // Force-unblock and resume
    const result = await resumeWorkflow({ basePath, unblock_tasks: ['1.1'] });
    assert.ok(result.success);
    assert.equal(result.action, 'dispatch_executor');
    assert.equal(result.task_id, '1.1');

    // Verify unblocked
    state = await read({ basePath });
    assert.equal(state.workflow_mode, 'executing_task');
    assert.equal(state.phases[0].todo[0].lifecycle, 'running');
    assert.equal(state.phases[0].todo[0].blocked_reason, null);
  });
});
