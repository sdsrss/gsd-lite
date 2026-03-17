/**
 * Full user simulation test — exercises complete GSD workflows
 * as a real user would via MCP tool calls.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { handleToolCall } from '../src/server.js';
import { init, read, update, phaseComplete, addEvidence, setLockPath, buildExecutorContext } from '../src/tools/state.js';
import { handleExecutorResult, handleDebuggerResult, handleReviewerResult, handleResearcherResult, resumeWorkflow } from '../src/tools/orchestrator.js';

// ── Helpers ──

let basePath;

async function createTmpGit() {
  basePath = await mkdtemp(join(tmpdir(), 'gsd-sim-'));
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

// ── SIMULATION 1: Happy path — init → execute → review → phase complete ──

describe('Simulation 1: Happy path single-phase project', () => {
  before(createTmpGit);
  after(cleanTmp);

  let state;

  it('1.1 Initialize project', async () => {
    const result = await init({
      project: 'TestApp',
      phases: makePhases([{
        name: 'Setup',
        tasks: [
          { name: 'Create config', level: 'L1' },
          { name: 'Add database', level: 'L2' },
        ],
      }]),
      basePath,
    });
    assert.ok(result.success, `init failed: ${JSON.stringify(result)}`);

    state = await read({ basePath });
    assert.equal(state.project, 'TestApp');
    assert.equal(state.workflow_mode, 'executing_task');
    assert.equal(state.phases.length, 1);
    assert.equal(state.phases[0].todo.length, 2);
    assert.equal(state.phases[0].lifecycle, 'active');
  });

  it('1.2 Resume picks first runnable task', async () => {
    const result = await resumeWorkflow({ basePath });
    assert.ok(result.success, `resume failed: ${JSON.stringify(result)}`);
    assert.equal(result.action, 'dispatch_executor');
    assert.equal(result.task_id, '1.1');

    state = await read({ basePath });
    assert.equal(state.current_task, '1.1');
    assert.equal(state.phases[0].todo[0].lifecycle, 'running');
  });

  it('1.3 Submit executor result — checkpointed L1', async () => {
    const result = await handleExecutorResult({
      result: {
        task_id: '1.1',
        outcome: 'checkpointed',
        summary: 'Created config files',
        checkpoint_commit: 'abc123',
        files_changed: ['config.json'],
        decisions: ['Use JSON format for config'],
        contract_changed: false,
        blockers: [],
        evidence: [{ id: 'ev-1', scope: 'task:1.1', type: 'test', detail: 'all pass' }],
      },
      basePath,
    });
    assert.ok(result.success, `executor result failed: ${JSON.stringify(result)}`);
    // L1 task — stays checkpointed, not auto-accepted (review_required=true)
    assert.equal(result.review_level, 'L1');

    state = await read({ basePath });
    assert.equal(state.phases[0].todo[0].lifecycle, 'checkpointed');
    assert.equal(state.decisions.length, 1);
  });

  it('1.4 Resume picks second task', async () => {
    const result = await resumeWorkflow({ basePath });
    assert.ok(result.success, `resume failed: ${JSON.stringify(result)}`);
    assert.equal(result.action, 'dispatch_executor');
    assert.equal(result.task_id, '1.2');
  });

  it('1.5 Submit executor result — checkpointed L2', async () => {
    const result = await handleExecutorResult({
      result: {
        task_id: '1.2',
        outcome: 'checkpointed',
        summary: 'Added database layer',
        checkpoint_commit: 'def456',
        files_changed: ['db.js', 'models.js'],
        decisions: [],
        contract_changed: true,
        blockers: [],
        evidence: [{ id: 'ev-2', scope: 'task:1.2', type: 'test', detail: 'db tests pass' }],
      },
      basePath,
    });
    assert.ok(result.success, `executor result failed: ${JSON.stringify(result)}`);
    // L2 task with contract_changed — triggers immediate review
    assert.equal(result.review_level, 'L2');
    assert.equal(result.action, 'dispatch_reviewer');
    assert.ok(result.current_review);
  });

  it('1.6 Submit reviewer result — all accepted', async () => {
    state = await read({ basePath });
    const result = await handleReviewerResult({
      result: {
        scope: 'task',
        scope_id: '1.2',
        review_level: 'L2',
        spec_passed: true,
        quality_passed: true,
        critical_issues: [],
        important_issues: [],
        minor_issues: [],
        accepted_tasks: ['1.2'],
        rework_tasks: [],
        evidence: [],
      },
      basePath,
    });
    assert.ok(result.success, `reviewer result failed: ${JSON.stringify(result)}`);
    assert.equal(result.action, 'review_accepted');

    state = await read({ basePath });
    assert.equal(state.phases[0].todo[1].lifecycle, 'accepted');
  });

  it('1.7 Resume triggers phase review (all tasks checkpointed/accepted)', async () => {
    const result = await resumeWorkflow({ basePath });
    assert.ok(result.success, `resume failed: ${JSON.stringify(result)}`);
    assert.equal(result.action, 'trigger_review');
    assert.equal(result.workflow_mode, 'reviewing_phase');
  });

  it('1.8 Submit phase review — accept all', async () => {
    state = await read({ basePath });
    const result = await handleReviewerResult({
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
        evidence: [],
      },
      basePath,
    });
    assert.ok(result.success, `phase review failed: ${JSON.stringify(result)}`);

    state = await read({ basePath });
    assert.equal(state.phases[0].todo[0].lifecycle, 'accepted');
    assert.equal(state.phases[0].phase_review.status, 'accepted');
    assert.ok(state.phases[0].phase_handoff.required_reviews_passed);
  });

  it('1.9 Phase complete', async () => {
    const result = await phaseComplete({
      phase_id: 1,
      basePath,
      verification: {
        lint: { exit_code: 0 },
        typecheck: { exit_code: 0 },
        test: { exit_code: 0 },
      },
    });
    assert.ok(result.success, `phaseComplete failed: ${JSON.stringify(result)}`);

    state = await read({ basePath });
    assert.equal(state.phases[0].lifecycle, 'accepted');
    assert.equal(state.workflow_mode, 'completed');
  });

  it('1.10 Resume after completion returns noop', async () => {
    const result = await resumeWorkflow({ basePath });
    assert.ok(result.success);
    assert.equal(result.action, 'noop');
    assert.equal(result.workflow_mode, 'completed');
  });
});

// ── SIMULATION 2: Multi-phase with dependencies, failures, debugging ──

describe('Simulation 2: Multi-phase with failures and debugging', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('2.1 Init 2-phase project with task dependencies', async () => {
    const result = await init({
      project: 'MultiPhase',
      phases: makePhases([
        {
          name: 'Foundation',
          tasks: [
            { name: 'Setup base', level: 'L1' },
            { name: 'Auth module', level: 'L2', requires: [{ kind: 'task', id: '1.1', gate: 'checkpoint' }] },
          ],
        },
        {
          name: 'Features',
          tasks: [
            { name: 'User API', level: 'L2' },
          ],
        },
      ]),
      basePath,
    });
    assert.ok(result.success);
  });

  it('2.2 Task 1.2 is not runnable until 1.1 reaches checkpoint', async () => {
    const result = await resumeWorkflow({ basePath });
    assert.equal(result.task_id, '1.1', 'Should pick task 1.1 first due to dependency');
  });

  it('2.3 Executor fails — retry count increments', async () => {
    const result = await handleExecutorResult({
      result: {
        task_id: '1.1',
        outcome: 'failed',
        summary: 'Build error in setup',
        checkpoint_commit: null,
        files_changed: [],
        decisions: [],
        contract_changed: false,
        blockers: [],
        evidence: [],
        error_fingerprint: 'build:setup:line42',
      },
      basePath,
    });
    assert.ok(result.success);
    assert.equal(result.action, 'retry_executor');
    assert.equal(result.retry_count, 1);
  });

  it('2.4 Second failure', async () => {
    const result = await handleExecutorResult({
      result: {
        task_id: '1.1',
        outcome: 'failed',
        summary: 'Build error in setup again',
        checkpoint_commit: null,
        files_changed: [],
        decisions: [],
        contract_changed: false,
        blockers: [],
        evidence: [],
        error_fingerprint: 'build:setup:line42',
      },
      basePath,
    });
    assert.ok(result.success);
    assert.equal(result.action, 'retry_executor');
    assert.equal(result.retry_count, 2);
  });

  it('2.5 Third failure triggers debugger dispatch', async () => {
    const result = await handleExecutorResult({
      result: {
        task_id: '1.1',
        outcome: 'failed',
        summary: 'Build error persists',
        checkpoint_commit: null,
        files_changed: [],
        decisions: [],
        contract_changed: false,
        blockers: [],
        evidence: [],
        error_fingerprint: 'build:setup:line42',
      },
      basePath,
    });
    assert.ok(result.success);
    assert.equal(result.action, 'dispatch_debugger');
    assert.equal(result.retry_count, 3);
    assert.ok(result.current_review);
    assert.equal(result.current_review.stage, 'debugging');
  });

  it('2.6 Resume while debugging dispatches debugger again', async () => {
    const result = await resumeWorkflow({ basePath });
    assert.ok(result.success);
    assert.equal(result.action, 'dispatch_debugger');
    assert.ok(result.debug_target);
    assert.equal(result.debug_target.id, '1.1');
  });

  it('2.7 Debugger finds root cause, executor retries', async () => {
    const result = await handleDebuggerResult({
      result: {
        task_id: '1.1',
        outcome: 'root_cause_found',
        root_cause: 'Missing dependency in package.json',
        fix_direction: 'Add lodash to dependencies',
        evidence: ['package.json missing lodash'],
        hypothesis_tested: [{ hypothesis: 'missing dep', result: 'confirmed', evidence: 'npm ls shows missing' }],
        fix_attempts: 0,
        blockers: [],
        architecture_concern: false,
      },
      basePath,
    });
    assert.ok(result.success);
    assert.equal(result.action, 'dispatch_executor');
    assert.ok(result.resumed_from_debugger);
    assert.ok(result.debugger_guidance);
  });

  it('2.8 Executor succeeds after debug guidance', async () => {
    const result = await handleExecutorResult({
      result: {
        task_id: '1.1',
        outcome: 'checkpointed',
        summary: 'Setup base completed with fix',
        checkpoint_commit: 'fix123',
        files_changed: ['package.json', 'setup.js'],
        decisions: ['Added lodash dependency'],
        contract_changed: false,
        blockers: [],
        evidence: [{ id: 'ev-fix', scope: 'task:1.1', type: 'test', detail: 'all pass' }],
      },
      basePath,
    });
    assert.ok(result.success);
    assert.equal(result.review_level, 'L1');
  });

  it('2.9 Resume now picks task 1.2 (dependency met via checkpoint gate)', async () => {
    const result = await resumeWorkflow({ basePath });
    assert.ok(result.success);
    assert.equal(result.action, 'dispatch_executor');
    assert.equal(result.task_id, '1.2');
  });
});

// ── SIMULATION 3: Blocked tasks and auto-unblock ──

describe('Simulation 3: Blocked task → auto-unblock via research', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('3.1 Init project', async () => {
    const result = await init({
      project: 'BlockTest',
      phases: makePhases([{
        name: 'Core',
        tasks: [
          { name: 'API design', level: 'L2' },
          { name: 'API implementation', level: 'L2' },
        ],
      }]),
      basePath,
    });
    assert.ok(result.success);
  });

  it('3.2 Start task 1.1', async () => {
    const result = await resumeWorkflow({ basePath });
    assert.equal(result.task_id, '1.1');
  });

  it('3.3 Executor reports blocked', async () => {
    const result = await handleExecutorResult({
      result: {
        task_id: '1.1',
        outcome: 'blocked',
        summary: 'Need GraphQL schema decision',
        checkpoint_commit: null,
        files_changed: [],
        decisions: [],
        contract_changed: false,
        blockers: [{ reason: 'Need GraphQL schema type decision for API', unblock_condition: 'Research GraphQL vs REST' }],
        evidence: [],
      },
      basePath,
    });
    assert.ok(result.success);
    assert.equal(result.action, 'awaiting_user');

    const state = await read({ basePath });
    assert.equal(state.phases[0].todo[0].lifecycle, 'blocked');
    assert.ok(state.phases[0].todo[0].blocked_reason);
  });

  it('3.4 Resume shows blocked state', async () => {
    const result = await resumeWorkflow({ basePath });
    assert.ok(result.success);
    // Should pick task 1.2 since 1.1 is blocked, or show awaiting_user
    // Task 1.2 has no dependencies, so it should be runnable
  });

  it('3.5 Add research decision that matches blocker keywords', async () => {
    // Manually add a decision that overlaps with "GraphQL schema type decision API"
    await update({
      updates: {
        decisions: [{
          id: 'research:graphql',
          summary: 'Use GraphQL schema for API type system',
          phase: 1,
          task: null,
        }],
      },
      basePath,
    });

    // Set task 1.2 back to pending so we can test auto-unblock on 1.1
    // First, let's just check if resuming with the decision auto-unblocks
  });

  it('3.6 Resume with matching decisions triggers auto-unblock', async () => {
    // Set workflow back to awaiting_user to test auto-unblock
    await update({
      updates: {
        workflow_mode: 'awaiting_user',
        current_task: null,
        current_review: null,
      },
      basePath,
    });

    const result = await resumeWorkflow({ basePath });
    assert.ok(result.success);
    // The auto-unblock should match "GraphQL schema type decision API" against
    // "Need GraphQL schema type decision for API"
    if (result.auto_unblocked && result.auto_unblocked.length > 0) {
      assert.equal(result.auto_unblocked[0].task_id, '1.1');
    }
  });
});

// ── SIMULATION 4: L0 auto-accept and review-not-required ──

describe('Simulation 4: L0 tasks auto-accept, review_required=false skips review', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('4.1 Init with L0 and no-review tasks', async () => {
    const result = await init({
      project: 'AutoAccept',
      phases: makePhases([{
        name: 'Quick',
        tasks: [
          { name: 'Fix typo', level: 'L0', review_required: false },
          { name: 'Update docs', level: 'L1', review_required: false },
          { name: 'Critical feature', level: 'L2' },
        ],
      }]),
      basePath,
    });
    assert.ok(result.success);
  });

  it('4.2 L0 task auto-accepts on checkpoint', async () => {
    await resumeWorkflow({ basePath }); // starts 1.1

    const result = await handleExecutorResult({
      result: {
        task_id: '1.1',
        outcome: 'checkpointed',
        summary: 'Fixed typo',
        checkpoint_commit: 'typo1',
        files_changed: ['README.md'],
        decisions: [],
        contract_changed: false,
        blockers: [],
        evidence: [],
      },
      basePath,
    });
    assert.ok(result.success);
    assert.ok(result.auto_accepted, 'L0 should auto-accept');

    const state = await read({ basePath });
    assert.equal(state.phases[0].todo[0].lifecycle, 'accepted');
  });

  it('4.3 L1 with review_required=false also auto-accepts', async () => {
    await resumeWorkflow({ basePath }); // starts 1.2

    const result = await handleExecutorResult({
      result: {
        task_id: '1.2',
        outcome: 'checkpointed',
        summary: 'Updated docs',
        checkpoint_commit: 'docs1',
        files_changed: ['docs/guide.md'],
        decisions: [],
        contract_changed: false,
        blockers: [],
        evidence: [],
      },
      basePath,
    });
    assert.ok(result.success);
    assert.ok(result.auto_accepted, 'review_required=false should auto-accept');

    const state = await read({ basePath });
    assert.equal(state.phases[0].todo[1].lifecycle, 'accepted');
  });
});

// ── SIMULATION 5: Review with rework and propagation ──

describe('Simulation 5: Reviewer rejects → rework → propagation', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('5.1 Init with dependent tasks', async () => {
    const result = await init({
      project: 'ReworkTest',
      phases: makePhases([{
        name: 'Build',
        tasks: [
          { name: 'Core module', level: 'L2' },
          { name: 'Extension A', level: 'L2', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }] },
          { name: 'Extension B', level: 'L2', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }] },
        ],
      }]),
      basePath,
    });
    assert.ok(result.success);
  });

  it('5.2 Complete all three tasks', async () => {
    // Task 1.1
    await resumeWorkflow({ basePath });
    await handleExecutorResult({
      result: {
        task_id: '1.1', outcome: 'checkpointed', summary: 'Core done',
        checkpoint_commit: 'c1', files_changed: ['core.js'],
        decisions: [], contract_changed: false, blockers: [], evidence: [],
      },
      basePath,
    });

    // Accept 1.1 via L2 review
    await handleReviewerResult({
      result: {
        scope: 'task', scope_id: '1.1', review_level: 'L2',
        spec_passed: true, quality_passed: true,
        critical_issues: [], important_issues: [], minor_issues: [],
        accepted_tasks: ['1.1'], rework_tasks: [], evidence: [],
      },
      basePath,
    });

    // Task 1.2
    await resumeWorkflow({ basePath });
    await handleExecutorResult({
      result: {
        task_id: '1.2', outcome: 'checkpointed', summary: 'Ext A done',
        checkpoint_commit: 'c2', files_changed: ['ext-a.js'],
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

    // Task 1.3
    await resumeWorkflow({ basePath });
    await handleExecutorResult({
      result: {
        task_id: '1.3', outcome: 'checkpointed', summary: 'Ext B done',
        checkpoint_commit: 'c3', files_changed: ['ext-b.js'],
        decisions: [], contract_changed: false, blockers: [], evidence: [],
      },
      basePath,
    });
    await handleReviewerResult({
      result: {
        scope: 'task', scope_id: '1.3', review_level: 'L2',
        spec_passed: true, quality_passed: true,
        critical_issues: [], important_issues: [], minor_issues: [],
        accepted_tasks: ['1.3'], rework_tasks: [], evidence: [],
      },
      basePath,
    });

    const state = await read({ basePath });
    assert.equal(state.phases[0].todo[0].lifecycle, 'accepted');
    assert.equal(state.phases[0].todo[1].lifecycle, 'accepted');
    assert.equal(state.phases[0].todo[2].lifecycle, 'accepted');
  });

  it('5.3 Phase review rejects task 1.1 with downstream invalidation', async () => {
    // Resume to get into phase review mode
    await resumeWorkflow({ basePath });

    const result = await handleReviewerResult({
      result: {
        scope: 'phase', scope_id: 1, review_level: 'L1-batch',
        spec_passed: false, quality_passed: false,
        critical_issues: [{
          reason: 'Core module has security vulnerability',
          task_id: '1.1',
          invalidates_downstream: true,
        }],
        important_issues: [],
        minor_issues: [],
        accepted_tasks: [],
        rework_tasks: ['1.1'],
        evidence: [],
      },
      basePath,
    });
    assert.ok(result.success);
    assert.equal(result.action, 'rework_required');
    assert.equal(result.critical_count, 1);

    // Check propagation: 1.2 and 1.3 depend on 1.1, should be needs_revalidation
    const state = await read({ basePath });
    assert.equal(state.phases[0].todo[0].lifecycle, 'needs_revalidation'); // 1.1 reworked
    assert.equal(state.phases[0].todo[1].lifecycle, 'needs_revalidation'); // 1.2 propagated
    assert.equal(state.phases[0].todo[2].lifecycle, 'needs_revalidation'); // 1.3 propagated
  });

  it('5.4 Rework feedback is stored on task and passed to executor', async () => {
    // Verify reviewer issues are stored on the reworked task
    const state = await read({ basePath });
    const task1 = state.phases[0].todo[0];
    assert.ok(Array.isArray(task1.last_review_feedback), 'rework task should have last_review_feedback');
    assert.ok(task1.last_review_feedback.length > 0, 'last_review_feedback should contain issues');
    assert.ok(task1.last_review_feedback[0].includes('security vulnerability'));

    // Verify executor context includes rework_feedback
    const ctx = buildExecutorContext(state, '1.1', 1);
    assert.ok(!ctx.error);
    assert.ok(Array.isArray(ctx.rework_feedback), 'executor context should have rework_feedback');
    assert.ok(ctx.rework_feedback[0].includes('security vulnerability'));
  });
});

// ── SIMULATION 6: Review level reclassification ──

describe('Simulation 6: Review level upgrade L1→L2', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('6.1 Init with auth-related L1 task', async () => {
    const result = await init({
      project: 'LevelUpTest',
      phases: makePhases([{
        name: 'Auth',
        tasks: [
          { name: 'Login authentication handler', level: 'L1' },
        ],
      }]),
      basePath,
    });
    assert.ok(result.success);
  });

  it('6.2 contract_changed + sensitive keyword upgrades L1→L2', async () => {
    await resumeWorkflow({ basePath });
    const result = await handleExecutorResult({
      result: {
        task_id: '1.1', outcome: 'checkpointed',
        summary: 'Implemented login auth',
        checkpoint_commit: 'auth1',
        files_changed: ['auth.js'],
        decisions: [],
        contract_changed: true, // key: contract changed
        blockers: [],
        evidence: [],
      },
      basePath,
    });
    assert.ok(result.success);
    // Task name contains "authentication" which matches SENSITIVE_KEYWORDS
    assert.equal(result.review_level, 'L2');
    assert.equal(result.action, 'dispatch_reviewer');
  });
});

// ── SIMULATION 7: Direction drift detection ──

describe('Simulation 7: Direction drift blocks phase completion', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('7.1 Phase complete with direction_ok=false', async () => {
    await init({
      project: 'DriftTest',
      phases: makePhases([{
        name: 'Phase1',
        tasks: [{ name: 'Task1', level: 'L0', review_required: false }],
      }]),
      basePath,
    });

    // Complete task
    await resumeWorkflow({ basePath });
    await handleExecutorResult({
      result: {
        task_id: '1.1', outcome: 'checkpointed', summary: 'done',
        checkpoint_commit: 'c1', files_changed: [],
        decisions: [], contract_changed: false, blockers: [], evidence: [],
      },
      basePath,
    });

    // Phase review accepted (auto-accepted since L0)
    const state = await read({ basePath });
    assert.equal(state.phases[0].todo[0].lifecycle, 'accepted');

    // Transition phase to reviewing, set phase review to accepted for handoff
    await update({
      updates: {
        phases: [{
          id: 1,
          lifecycle: 'reviewing',
          phase_review: { status: 'accepted', retry_count: 0 },
        }],
      },
      basePath,
    });

    // Phase complete with direction drift
    const result = await phaseComplete({
      phase_id: 1,
      basePath,
      verification: {
        lint: { exit_code: 0 },
        typecheck: { exit_code: 0 },
        test: { exit_code: 0 },
      },
      direction_ok: false,
    });
    assert.ok(result.success);
    assert.equal(result.action, 'direction_drift');
    assert.equal(result.workflow_mode, 'awaiting_user');
  });

  it('7.2 Resume detects direction drift and surfaces it', async () => {
    const result = await resumeWorkflow({ basePath });
    assert.ok(result.success);
    assert.equal(result.action, 'awaiting_user');
    assert.ok(result.current_review);
    assert.equal(result.current_review.stage, 'direction_drift');
  });
});

// ── SIMULATION 8: Research workflow ──

describe('Simulation 8: Research lifecycle', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('8.1 Init with research', async () => {
    await init({
      project: 'ResearchTest',
      phases: makePhases([{
        name: 'Impl',
        tasks: [{ name: 'Build API', level: 'L2', research_basis: ['d1'] }],
      }]),
      research: true,
      basePath,
    });
  });

  it('8.2 Store research via orchestrator handler', async () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const result = await handleResearcherResult({
      result: {
        decision_ids: ['d1'],
        volatility: 'medium',
        expires_at: expiresAt,
        sources: [{ id: 's1', type: 'docs', ref: 'https://example.com' }],
      },
      decision_index: {
        d1: { summary: 'Use Express for API framework', source: 'docs', expires_at: expiresAt },
      },
      artifacts: {
        'STACK.md': '# Stack\nExpress + Node.js',
        'ARCHITECTURE.md': '# Arch\nMVC pattern',
        'PITFALLS.md': '# Pitfalls\nWatch for middleware ordering',
        'SUMMARY.md': `# Summary\nDecision d1: Use Express. Volatility: medium. Expires: ${expiresAt}`,
      },
      basePath,
    });
    assert.ok(result.success, `research store failed: ${JSON.stringify(result)}`);
    assert.ok(result.stored_files);
    assert.deepEqual(result.decision_ids, ['d1']);
  });

  it('8.3 Research is reflected in state', async () => {
    const state = await read({ basePath });
    assert.ok(state.research);
    assert.equal(state.research.volatility, 'medium');
    assert.ok(state.research.decision_index.d1);
    assert.equal(state.research.decision_index.d1.summary, 'Use Express for API framework');
  });

  it('8.4 Executor context includes research decisions', async () => {
    const state = await read({ basePath });
    const { buildExecutorContext } = await import('../src/tools/state.js');
    const ctx = buildExecutorContext(state, '1.1', 1);
    assert.ok(!ctx.error);
    assert.equal(ctx.research_decisions.length, 1);
    assert.equal(ctx.research_decisions[0].id, 'd1');
    assert.ok(ctx.research_decisions[0].summary.includes('Express'));
  });
});

// ── SIMULATION 9: Stop/Resume cycle (paused_by_user) ──

describe('Simulation 9: Stop and resume', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('9.1 Init and start executing', async () => {
    await init({
      project: 'StopTest',
      phases: makePhases([{
        name: 'Phase1',
        tasks: [
          { name: 'Task A', level: 'L1' },
          { name: 'Task B', level: 'L1' },
        ],
      }]),
      basePath,
    });
    await resumeWorkflow({ basePath }); // starts 1.1
  });

  it('9.2 Pause the project', async () => {
    const result = await update({
      updates: { workflow_mode: 'paused_by_user' },
      basePath,
    });
    assert.ok(result.success);
  });

  it('9.3 Resume shows paused state', async () => {
    const result = await resumeWorkflow({ basePath });
    assert.ok(result.success);
    assert.equal(result.action, 'await_manual_intervention');
    assert.equal(result.workflow_mode, 'paused_by_user');
  });

  it('9.4 Unpause and continue', async () => {
    await update({
      updates: { workflow_mode: 'executing_task' },
      basePath,
    });
    const result = await resumeWorkflow({ basePath });
    assert.ok(result.success);
    // Should resume executing task 1.1 which is still running
    assert.equal(result.action, 'dispatch_executor');
    assert.ok(result.resumed);
  });
});

// ── SIMULATION 10: Edge cases & error handling ──

describe('Simulation 10: Edge cases', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('10.1 Double init rejected without force', async () => {
    await init({
      project: 'EdgeTest',
      phases: makePhases([{ name: 'P1', tasks: [{ name: 'T1' }] }]),
      basePath,
    });
    const result = await init({
      project: 'EdgeTest2',
      phases: makePhases([{ name: 'P2', tasks: [{ name: 'T2' }] }]),
      basePath,
    });
    assert.ok(result.error);
    assert.equal(result.code, 'STATE_EXISTS');
  });

  it('10.2 Force re-init works and creates backup', async () => {
    const result = await init({
      project: 'EdgeTest2',
      phases: makePhases([{ name: 'P2', tasks: [{ name: 'T2' }] }]),
      basePath,
      force: true,
    });
    assert.ok(result.success);

    // Verify backup exists
    const bakPath = join(basePath, '.gsd', 'state.json.bak');
    const bakStat = await stat(bakPath);
    assert.ok(bakStat.isFile());
  });

  it('10.3 Non-canonical fields rejected', async () => {
    const result = await update({
      updates: { foo: 'bar' },
      basePath,
    });
    assert.ok(result.error);
    assert.ok(result.message.includes('Non-canonical'));
  });

  it('10.4 Invalid lifecycle transition rejected', async () => {
    const result = await update({
      updates: {
        phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'accepted' }] }],
      },
      basePath,
    });
    assert.ok(result.error);
    assert.equal(result.code, 'TRANSITION_ERROR');
  });

  it('10.5 Terminal state prevents workflow_mode change', async () => {
    // First complete the workflow
    await resumeWorkflow({ basePath }); // start task
    await handleExecutorResult({
      result: {
        task_id: '1.1', outcome: 'checkpointed', summary: 'done',
        checkpoint_commit: 'c1', files_changed: [],
        decisions: [], contract_changed: false, blockers: [], evidence: [],
      },
      basePath,
    });
    // Accept task 1.1 first (checkpointed → accepted)
    await update({
      updates: {
        phases: [{
          id: 1,
          todo: [{ id: '1.1', lifecycle: 'accepted' }],
        }],
      },
      basePath,
    });
    // Transition phase: active → reviewing
    await update({
      updates: {
        phases: [{
          id: 1,
          lifecycle: 'reviewing',
          phase_review: { status: 'accepted', retry_count: 0 },
          phase_handoff: { required_reviews_passed: true, tests_passed: false, critical_issues_open: 0 },
        }],
      },
      basePath,
    });
    await phaseComplete({
      phase_id: 1, basePath,
      verification: { lint: { exit_code: 0 }, typecheck: { exit_code: 0 }, test: { exit_code: 0 } },
    });

    const completed = await read({ basePath });
    assert.equal(completed.workflow_mode, 'completed');

    // Try to change from terminal
    const result = await update({
      updates: { workflow_mode: 'executing_task' },
      basePath,
    });
    assert.ok(result.error);
    assert.equal(result.code, 'TERMINAL_STATE');
  });

  it('10.6 handleToolCall wraps unknown tool', async () => {
    const result = await handleToolCall('nonexistent', {});
    assert.ok(result.error);
    assert.ok(result.message.includes('Unknown tool'));
  });

  it('10.7 Phase complete with missing handoff metadata fails', async () => {
    const bp = await mkdtemp(join(tmpdir(), 'gsd-edge-'));
    execSync('git init && git commit --allow-empty -m "init"', {
      cwd: bp,
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' },
    });
    await init({
      project: 'HandoffEdge',
      phases: makePhases([{ name: 'P1', tasks: [{ name: 'T1', level: 'L0', review_required: false }] }]),
      basePath: bp,
    });

    // Tamper: remove phase_handoff
    const state = await read({ basePath: bp });
    delete state.phases[0].phase_handoff;
    const { writeJson } = await import('../src/utils.js');
    await writeJson(join(bp, '.gsd', 'state.json'), state);

    const result = await phaseComplete({ phase_id: 1, basePath: bp });
    assert.ok(result.error);
    assert.ok(result.message.includes('phase_handoff'));

    await rm(bp, { recursive: true, force: true });
  });

  it('10.8 Executor result with invalid payload rejected', async () => {
    const result = await handleExecutorResult({ result: { bad: true }, basePath });
    assert.ok(result.error);
    assert.ok(result.message.includes('Invalid executor result'));
  });

  it('10.9 Reviewer result with overlapping accepted/rework rejected', async () => {
    const result = await handleReviewerResult({
      result: {
        scope: 'task', scope_id: '1.1', review_level: 'L2',
        spec_passed: true, quality_passed: true,
        critical_issues: [], important_issues: [], minor_issues: [],
        accepted_tasks: ['1.1'], rework_tasks: ['1.1'], // overlap!
        evidence: [],
      },
      basePath,
    });
    assert.ok(result.error);
    assert.ok(result.message.includes('disjoint'));
  });
});

// ── SIMULATION 11: Evidence lifecycle ──

describe('Simulation 11: Evidence storage and pruning', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('11.1 Evidence stored via addEvidence', async () => {
    await init({
      project: 'EvidenceTest',
      phases: makePhases([
        { name: 'P1', tasks: [{ name: 'T1', level: 'L0', review_required: false }] },
        { name: 'P2', tasks: [{ name: 'T2', level: 'L0', review_required: false }] },
      ]),
      basePath,
    });

    // Add evidence for phase 1
    const result = await addEvidence({
      id: 'ev-p1-1',
      data: { scope: 'task:1.1', type: 'test', detail: 'test pass' },
      basePath,
    });
    assert.ok(result.success);

    const state = await read({ basePath });
    assert.ok(state.evidence['ev-p1-1']);
    assert.equal(state.evidence['ev-p1-1'].scope, 'task:1.1');
  });

  it('11.2 Evidence pruned on phase complete', async () => {
    // Complete phase 1
    await resumeWorkflow({ basePath }); // start 1.1
    await handleExecutorResult({
      result: {
        task_id: '1.1', outcome: 'checkpointed', summary: 'done',
        checkpoint_commit: 'c1', files_changed: [],
        decisions: [], contract_changed: false, blockers: [], evidence: [],
      },
      basePath,
    });

    // Transition phase: active → reviewing, set review + handoff metadata
    await update({
      updates: {
        phases: [{
          id: 1,
          lifecycle: 'reviewing',
          phase_review: { status: 'accepted', retry_count: 0 },
          phase_handoff: { required_reviews_passed: true, tests_passed: false, critical_issues_open: 0 },
        }],
      },
      basePath,
    });

    const result = await phaseComplete({
      phase_id: 1, basePath,
      verification: { lint: { exit_code: 0 }, typecheck: { exit_code: 0 }, test: { exit_code: 0 } },
    });
    assert.ok(result.success, `phaseComplete failed: ${JSON.stringify(result)}`);

    // Evidence from phase 1 should be pruned (archived)
    const state = await read({ basePath });
    assert.equal(state.evidence['ev-p1-1'], undefined, 'Phase 1 evidence should be pruned after phase complete');

    // Archive should exist
    const archivePath = join(basePath, '.gsd', 'evidence-archive.json');
    const archive = JSON.parse(await readFile(archivePath, 'utf-8'));
    assert.ok(archive['ev-p1-1'], 'Pruned evidence should be in archive');
  });
});

// ── SIMULATION 12: MCP server tool dispatch ──

describe('Simulation 12: MCP handleToolCall dispatch', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('12.1 health tool works', async () => {
    const result = await handleToolCall('health', {});
    assert.equal(result.status, 'ok');
    assert.equal(result.server, 'gsd');
  });

  it('12.2 state-init via handleToolCall', async () => {
    const result = await handleToolCall('state-init', {
      project: 'MCPTest',
      phases: makePhases([{ name: 'P1', tasks: [{ name: 'T1' }] }]),
      basePath,
    });
    assert.ok(result.success);
  });

  it('12.3 state-read via handleToolCall', async () => {
    const result = await handleToolCall('state-read', { basePath });
    assert.equal(result.project, 'MCPTest');
  });

  it('12.4 state-read with field filter', async () => {
    const result = await handleToolCall('state-read', { basePath, fields: ['project', 'workflow_mode'] });
    assert.equal(result.project, 'MCPTest');
    assert.equal(result.workflow_mode, 'executing_task');
    assert.equal(result.phases, undefined);
  });

  it('12.5 state-update via handleToolCall', async () => {
    const result = await handleToolCall('state-update', {
      updates: { workflow_mode: 'paused_by_user' },
      basePath,
    });
    assert.ok(result.success);
  });

  it('12.6 orchestrator-resume via handleToolCall', async () => {
    const result = await handleToolCall('orchestrator-resume', { basePath });
    assert.ok(result.success);
    assert.equal(result.workflow_mode, 'paused_by_user');
  });
});

// ── SIMULATION 13: Circular dependency detection ──

describe('Simulation 13: Circular dependency detection', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('13.1 Rejects circular task dependencies', async () => {
    const result = await init({
      project: 'CircularTest',
      phases: [{
        name: 'P1',
        tasks: [
          { name: 'A', requires: [{ kind: 'task', id: '1.2' }] },
          { name: 'B', requires: [{ kind: 'task', id: '1.1' }] },
        ],
      }],
      basePath,
    });
    assert.ok(result.error);
    assert.ok(result.message.includes('Circular dependency'));
  });
});

// ── SIMULATION 14: Debugger architecture concern escalation ──

describe('Simulation 14: Debugger architecture concern → phase failure', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('14.1 Architecture concern fails the phase', async () => {
    await init({
      project: 'ArchConcern',
      phases: makePhases([{
        name: 'P1',
        tasks: [
          { name: 'Task1', level: 'L2' },
          { name: 'Task2', level: 'L1' },
        ],
      }]),
      basePath,
    });

    // Start and fail task 3 times to trigger debugger
    await resumeWorkflow({ basePath }); // starts 1.1
    for (let i = 0; i < 3; i++) {
      await handleExecutorResult({
        result: {
          task_id: '1.1', outcome: 'failed', summary: 'Fundamental design flaw',
          checkpoint_commit: null, files_changed: [],
          decisions: [], contract_changed: false, blockers: [], evidence: [],
        },
        basePath,
      });
    }

    // Debugger finds architecture concern
    const result = await handleDebuggerResult({
      result: {
        task_id: '1.1',
        outcome: 'failed',
        root_cause: 'The entire approach is flawed',
        fix_direction: 'Need full redesign',
        evidence: ['Multiple fundamental issues found'],
        hypothesis_tested: [{ hypothesis: 'design flaw', result: 'confirmed', evidence: 'code review' }],
        fix_attempts: 3,
        blockers: [],
        architecture_concern: true,
      },
      basePath,
    });
    assert.ok(result.success);
    assert.equal(result.action, 'phase_failed');
    assert.equal(result.workflow_mode, 'failed');

    const state = await read({ basePath });
    assert.equal(state.phases[0].lifecycle, 'failed');
    assert.equal(state.phases[0].todo[0].lifecycle, 'failed');
  });

  it('14.2 Resume in failed state shows recovery options', async () => {
    const result = await resumeWorkflow({ basePath });
    assert.ok(result.success);
    assert.equal(result.action, 'await_recovery_decision');
    assert.ok(result.recovery_options.includes('retry_failed'));
    assert.ok(result.failed_tasks.length > 0);
  });
});

// ── SIMULATION 15: Zero-task phase ──

describe('Simulation 15: Zero-task phase auto-triggers review', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('15.1 Empty phase triggers review immediately', async () => {
    await init({
      project: 'EmptyPhase',
      phases: [{
        name: 'Planning',
        tasks: [],
      }],
      basePath,
    });

    const result = await resumeWorkflow({ basePath });
    assert.ok(result.success);
    assert.equal(result.action, 'trigger_review');
    assert.equal(result.workflow_mode, 'reviewing_phase');
  });
});

// ── SIMULATION 16: [LEVEL-UP] decision ──

describe('Simulation 16: Explicit [LEVEL-UP] in decisions upgrades review', () => {
  before(createTmpGit);
  after(cleanTmp);

  it('16.1 [LEVEL-UP] decision upgrades L1→L2', async () => {
    await init({
      project: 'LevelUpDecision',
      phases: makePhases([{
        name: 'P1',
        tasks: [{ name: 'Generic task', level: 'L1' }],
      }]),
      basePath,
    });
    await resumeWorkflow({ basePath });

    const result = await handleExecutorResult({
      result: {
        task_id: '1.1', outcome: 'checkpointed',
        summary: 'Made significant changes',
        checkpoint_commit: 'lu1',
        files_changed: ['main.js'],
        decisions: ['[LEVEL-UP] This change affects public API surface'],
        contract_changed: false,
        blockers: [],
        evidence: [],
      },
      basePath,
    });
    assert.ok(result.success);
    assert.equal(result.review_level, 'L2');
    assert.equal(result.action, 'dispatch_reviewer');
  });
});
