// E2E: Research refresh 4-rules combo, cross-phase impact, storeResearch flow
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTempDir,
  removeTempDir,
  initProject,
  checkpointTask,
  acceptTask,
  read,
  update,
} from './e2e-helpers.js';
import {
  applyResearchRefresh,
  storeResearch,
} from '../src/tools/state/index.js';
import { handleResearcherResult } from '../src/tools/orchestrator/index.js';

// ── TC1: All 4 refresh rules fire simultaneously ──

describe('TC1: all 4 research refresh rules fire simultaneously', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('applies rules 1-4 in one call with correct task lifecycle outcomes', async () => {
    // Init project with 4 tasks, each tied to a different decision
    await initProject(dir, {
      phases: [{
        name: 'P1',
        tasks: [
          { index: 1, name: 'Lint config', level: 'L1', requires: [], research_basis: ['d_unchanged'] },
          { index: 2, name: 'Test infra', level: 'L1', requires: [], research_basis: ['d_changed'] },
          { index: 3, name: 'Cache layer', level: 'L1', requires: [], research_basis: ['d_removed'] },
          { index: 4, name: 'Standalone', level: 'L1', requires: [] },
        ],
      }],
    });

    // Walk task lifecycles: accept 1.1, checkpoint 1.2, accept 1.3, leave 1.4 pending
    await acceptTask(dir, 1, '1.1');
    await checkpointTask(dir, 1, '1.2', 'commit-1.2');
    await acceptTask(dir, 1, '1.3');
    // 1.4 stays pending

    // Set up research with 3 existing decisions
    await update({
      updates: {
        research: {
          decision_index: {
            d_unchanged: { summary: 'Use ESLint', volatility: 'low', expires_at: '2026-01-01T00:00:00Z' },
            d_changed: { summary: 'Use Jest for testing', volatility: 'medium', expires_at: '2026-01-01T00:00:00Z' },
            d_removed: { summary: 'Use Redis for caching', volatility: 'high', expires_at: '2025-12-01T00:00:00Z' },
          },
          volatility: 'low',
          expires_at: '2026-06-01T00:00:00Z',
          sources: [{ id: 's1', type: 'docs', ref: 'internal docs' }],
          files: ['STACK.md', 'ARCHITECTURE.md', 'PITFALLS.md', 'SUMMARY.md'],
          updated_at: '2026-01-01T00:00:00Z',
        },
      },
      basePath: dir,
    });

    // Read state, then apply refresh in-memory
    const state = await read({ basePath: dir });

    const newResearch = {
      decision_index: {
        d_unchanged: { summary: 'Use ESLint', volatility: 'low', expires_at: '2027-01-01T00:00:00Z' },
        d_changed: { summary: 'Use Vitest instead of Jest', volatility: 'medium', expires_at: '2027-01-01T00:00:00Z' },
        // d_removed is NOT present → rule 3
        d_brand_new: { summary: 'Use Bun runtime', volatility: 'high', expires_at: '2027-06-01T00:00:00Z' },
      },
    };

    const { warnings } = applyResearchRefresh(state, newResearch);

    // Rule 1: d_unchanged — metadata updated, task 1.1 lifecycle unchanged (accepted)
    assert.equal(state.research.decision_index.d_unchanged.expires_at, '2027-01-01T00:00:00Z');
    const task11 = state.phases[0].todo.find(t => t.id === '1.1');
    assert.equal(task11.lifecycle, 'accepted', 'Rule 1: task with unchanged decision stays accepted');

    // Rule 2: d_changed — summary changed, task 1.2 invalidated
    assert.equal(state.research.decision_index.d_changed.summary, 'Use Vitest instead of Jest');
    const task12 = state.phases[0].todo.find(t => t.id === '1.2');
    assert.equal(task12.lifecycle, 'needs_revalidation', 'Rule 2: task with changed decision gets invalidated');
    assert.deepEqual(task12.evidence_refs, [], 'Rule 2: evidence_refs cleared');

    // Rule 3: d_removed — still in index (not deleted), task 1.3 invalidated, warning emitted
    assert.ok(state.research.decision_index.d_removed, 'Rule 3: removed decision still in index');
    const task13 = state.phases[0].todo.find(t => t.id === '1.3');
    assert.equal(task13.lifecycle, 'needs_revalidation', 'Rule 3: task with removed decision gets invalidated');
    assert.equal(warnings.length, 1, 'Rule 3: exactly one warning for removed decision');
    assert.match(warnings[0], /d_removed/, 'Rule 3: warning mentions the removed decision');

    // Rule 4: d_brand_new — added to index, task 1.4 unchanged
    assert.ok(state.research.decision_index.d_brand_new, 'Rule 4: new decision added');
    assert.equal(state.research.decision_index.d_brand_new.summary, 'Use Bun runtime');
    const task14 = state.phases[0].todo.find(t => t.id === '1.4');
    assert.equal(task14.lifecycle, 'pending', 'Rule 4: task without research_basis stays pending');
  });
});

// ── TC2: Cross-phase impact — same decision in phase 1 and 2 ──

describe('TC2: cross-phase impact — same decision invalidates tasks across phases', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('changed decision invalidates accepted + checkpointed tasks in different phases', async () => {
    await initProject(dir, {
      phases: [
        { name: 'P1', tasks: [
          { index: 1, name: 'API setup', level: 'L1', requires: [], research_basis: ['d_api'] },
        ]},
        { name: 'P2', tasks: [
          { index: 1, name: 'API tests', level: 'L1', requires: [{ kind: 'phase', id: 1, gate: 'accepted' }], research_basis: ['d_api'] },
        ]},
      ],
    });

    // Set up initial research
    await update({
      updates: {
        research: {
          decision_index: {
            d_api: { summary: 'Use REST with Express', volatility: 'medium', expires_at: '2026-06-01T00:00:00Z' },
          },
          volatility: 'medium',
          expires_at: '2026-06-01T00:00:00Z',
          sources: [{ id: 's1', type: 'docs', ref: 'API docs' }],
          files: ['STACK.md', 'ARCHITECTURE.md', 'PITFALLS.md', 'SUMMARY.md'],
          updated_at: '2026-01-01T00:00:00Z',
        },
      },
      basePath: dir,
    });

    // Read state and manipulate in-memory for cross-phase testing
    const state = await read({ basePath: dir });

    // Manually set task lifecycles to test cross-phase behavior
    state.phases[0].todo[0].lifecycle = 'accepted';  // task 1.1
    state.phases[1].todo[0].lifecycle = 'checkpointed';  // task 2.1
    state.phases[1].lifecycle = 'active';

    const newResearch = {
      decision_index: {
        d_api: { summary: 'Use GraphQL with Apollo', volatility: 'medium', expires_at: '2027-01-01T00:00:00Z' },
      },
    };

    const { warnings } = applyResearchRefresh(state, newResearch);

    // Both tasks reference d_api and have invalidatable lifecycles
    const task11 = state.phases[0].todo[0];
    assert.equal(task11.lifecycle, 'needs_revalidation', 'Phase 1 accepted task gets invalidated');

    const task21 = state.phases[1].todo[0];
    assert.equal(task21.lifecycle, 'needs_revalidation', 'Phase 2 checkpointed task gets invalidated');

    // No warnings (rule 2 — changed summary, not removed)
    assert.equal(warnings.length, 0, 'No warnings for rule 2 (changed summary)');
  });
});

// ── TC3: Null research → new research (Rule 4 only) ──

describe('TC3: null research → new research (rule 4 only)', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('adds brand new decisions to null research without invalidating tasks', async () => {
    await initProject(dir, {
      phases: [{
        name: 'P1',
        tasks: [
          { index: 1, name: 'Task A', level: 'L1', requires: [] },
        ],
      }],
    });

    const state = await read({ basePath: dir });
    assert.equal(state.research, null, 'Initial state has null research');

    const newResearch = {
      decision_index: {
        d_new: { summary: 'Use Bun', volatility: 'high', expires_at: '2026-06-01T00:00:00Z' },
      },
    };

    const { warnings } = applyResearchRefresh(state, newResearch);

    assert.ok(state.research, 'Research object created');
    assert.ok(state.research.decision_index.d_new, 'New decision added');
    assert.equal(state.research.decision_index.d_new.summary, 'Use Bun');
    assert.equal(warnings.length, 0, 'No warnings for brand new decisions');

    // Task unchanged
    const task = state.phases[0].todo[0];
    assert.equal(task.lifecycle, 'pending', 'Task lifecycle unchanged');
  });
});

// ── TC4: C-3 guard — pending task not invalidated ──

describe('TC4: C-3 guard — pending task not invalidated by research change', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('pending task stays pending even when its research_basis decision changes', async () => {
    await initProject(dir, {
      phases: [{
        name: 'P1',
        tasks: [
          { index: 1, name: 'Task A', level: 'L1', requires: [], research_basis: ['d_test'] },
        ],
      }],
    });

    // Set up initial research
    await update({
      updates: {
        research: {
          decision_index: {
            d_test: { summary: 'Use PostgreSQL', volatility: 'low', expires_at: '2026-06-01T00:00:00Z' },
          },
          volatility: 'low',
          expires_at: '2026-06-01T00:00:00Z',
          sources: [{ id: 's1', type: 'docs', ref: 'DB docs' }],
          files: ['STACK.md', 'ARCHITECTURE.md', 'PITFALLS.md', 'SUMMARY.md'],
          updated_at: '2026-01-01T00:00:00Z',
        },
      },
      basePath: dir,
    });

    const state = await read({ basePath: dir });
    assert.equal(state.phases[0].todo[0].lifecycle, 'pending');

    // Change d_test summary — triggers rule 2
    const newResearch = {
      decision_index: {
        d_test: { summary: 'Use SQLite instead', volatility: 'low', expires_at: '2027-01-01T00:00:00Z' },
      },
    };

    applyResearchRefresh(state, newResearch);

    // pending→needs_revalidation is NOT in TASK_LIFECYCLE, so task stays pending
    const task = state.phases[0].todo[0];
    assert.equal(task.lifecycle, 'pending', 'C-3: pending task not invalidated');
    assert.equal(state.research.decision_index.d_test.summary, 'Use SQLite instead', 'Decision summary updated');
  });
});

// ── TC5: storeResearch validates artifacts — missing file rejected ──

describe('TC5: storeResearch rejects invalid artifacts', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('returns error when required artifact file is missing', async () => {
    await initProject(dir, {
      research: true,
      phases: [{
        name: 'P1',
        tasks: [{ index: 1, name: 'Task A', level: 'L1', requires: [] }],
      }],
    });

    const result = await storeResearch({
      basePath: dir,
      result: {
        decision_ids: ['d_test'],
        volatility: 'medium',
        expires_at: '2026-06-01T00:00:00Z',
        sources: [{ id: 's1', type: 'docs', ref: 'React docs' }],
      },
      decision_index: {
        d_test: { summary: 'Use React 18', expires_at: '2026-06-01T00:00:00Z' },
      },
      artifacts: {
        // Missing STACK.md
        'ARCHITECTURE.md': 'Architecture info\n',
        'PITFALLS.md': 'Pitfalls info\n',
        'SUMMARY.md': 'Summary d_test medium 2026-06-01T00:00:00Z\n',
      },
    });

    assert.equal(result.error, true, 'Should return error');
    assert.match(result.message, /STACK\.md/, 'Error mentions missing STACK.md');
  });
});

// ── TC6: storeResearch with research_refresh_needed → infers workflow_mode ──

describe('TC6: storeResearch transitions workflow_mode from research_refresh_needed', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('workflow_mode transitions to executing_task after storing research', async () => {
    await initProject(dir, {
      research: true,
      phases: [{
        name: 'P1',
        tasks: [{ index: 1, name: 'Task A', level: 'L1', requires: [] }],
      }],
    });

    // Set workflow_mode to research_refresh_needed
    await update({
      updates: { workflow_mode: 'research_refresh_needed' },
      basePath: dir,
    });

    let state = await read({ basePath: dir });
    assert.equal(state.workflow_mode, 'research_refresh_needed');

    const result = await storeResearch({
      basePath: dir,
      result: {
        decision_ids: ['d_test'],
        volatility: 'medium',
        expires_at: '2026-06-01T00:00:00Z',
        sources: [{ id: 's1', type: 'docs', ref: 'React docs' }],
      },
      decision_index: {
        d_test: { summary: 'Use React 18', expires_at: '2026-06-01T00:00:00Z' },
      },
      artifacts: {
        'STACK.md': 'Stack info d_test\n',
        'ARCHITECTURE.md': 'Architecture info\n',
        'PITFALLS.md': 'Pitfalls info\n',
        'SUMMARY.md': 'Summary d_test medium 2026-06-01T00:00:00Z\n',
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.workflow_mode, 'executing_task', 'workflow_mode inferred to executing_task');

    // Verify persisted state
    state = await read({ basePath: dir });
    assert.equal(state.workflow_mode, 'executing_task');
    assert.ok(state.research, 'Research stored');
    assert.equal(state.research.decision_index.d_test.summary, 'Use React 18');
  });
});

// ── TC7: handleResearcherResult end-to-end ──

describe('TC7: handleResearcherResult end-to-end stores research and resumes workflow', () => {
  let dir;
  before(async () => { dir = await createTempDir(); });
  after(async () => { await removeTempDir(dir); });

  it('stores artifacts, updates state, and resumes workflow', async () => {
    await initProject(dir, {
      research: true,
      phases: [{
        name: 'P1',
        tasks: [
          { index: 1, name: 'Task A', level: 'L1', requires: [], research_basis: ['d_framework'] },
        ],
      }],
    });

    // Set up initial research so refresh rules apply
    await update({
      updates: {
        research: {
          decision_index: {
            d_framework: { summary: 'Use React', volatility: 'medium', expires_at: '2026-03-01T00:00:00Z' },
          },
          volatility: 'medium',
          expires_at: '2026-03-01T00:00:00Z',
          sources: [{ id: 's1', type: 'docs', ref: 'Framework docs' }],
          files: ['STACK.md', 'ARCHITECTURE.md', 'PITFALLS.md', 'SUMMARY.md'],
          updated_at: '2026-01-01T00:00:00Z',
        },
      },
      basePath: dir,
    });

    const res = await handleResearcherResult({
      basePath: dir,
      result: {
        decision_ids: ['d_framework'],
        volatility: 'high',
        expires_at: '2027-06-01T00:00:00Z',
        sources: [{ id: 's2', type: 'docs', ref: 'Updated framework docs' }],
      },
      decision_index: {
        d_framework: { summary: 'Use React', volatility: 'high', expires_at: '2027-06-01T00:00:00Z' },
      },
      artifacts: {
        'STACK.md': 'Stack d_framework info\n',
        'ARCHITECTURE.md': 'Architecture info\n',
        'PITFALLS.md': 'Pitfalls info\n',
        'SUMMARY.md': 'Summary d_framework high 2027-06-01T00:00:00Z\n',
      },
    });

    assert.equal(res.success, true);
    assert.equal(res.action, 'research_stored');
    assert.deepEqual(res.stored_files, ['STACK.md', 'ARCHITECTURE.md', 'PITFALLS.md', 'SUMMARY.md']);
    assert.deepEqual(res.decision_ids, ['d_framework']);

    // Verify research persisted in state
    const state = await read({ basePath: dir });
    assert.equal(state.research.volatility, 'high');
    assert.equal(state.research.expires_at, '2027-06-01T00:00:00Z');
    assert.equal(state.research.decision_index.d_framework.summary, 'Use React');

    // Same summary → rule 1 → task NOT invalidated by research refresh.
    // handleResearcherResult no longer auto-resumes; task stays pending.
    // The caller (orchestrator loop) is responsible for calling resumeWorkflow() next.
    const task = state.phases[0].todo[0];
    assert.equal(task.lifecycle, 'pending', 'Task stays pending (researcher no longer auto-advances)');

    // Verify artifacts written to disk
    const summaryContent = await readFile(join(dir, '.gsd', 'research', 'SUMMARY.md'), 'utf-8');
    assert.match(summaryContent, /d_framework/);
    assert.match(summaryContent, /2027-06-01T00:00:00Z/);
  });
});
