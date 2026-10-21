// Research refresh, end to end, through the real handlers.
//
// 0.17.0 records planning research in state, which it never was before, and
// that makes the expiry refresh reachable for the first time. The 0.16.0
// pre-tag reviews found the refresh could not end in four different ways, each
// patched in turn and each repair finding the next. These cases assert the
// properties instead of the reported examples: a store either lands whole or
// changes nothing; a refresh replaces the decision index; a refresh that
// changes nothing returns the workflow to the action it was about to take; an
// invalidating refresh still reaches completion. See
// tasks/specs/research-in-state-0.17.md.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExecutorContext, init, phaseComplete, read, storeResearch, update } from '../src/tools/state/index.js';
import { WORKFLOW_MODES } from '../src/schema.js';
// A namespace import, so this file still loads on a tree without the export
// and gate-replay can see its cases fail there instead of a load error.
import * as orchestratorHelpers from '../src/tools/orchestrator/helpers.js';

const { REFRESH_MODES = [] } = orchestratorHelpers;
import {
  handleExecutorResult,
  handleResearcherResult,
  handleReviewerResult,
  resumeWorkflow,
} from '../src/tools/orchestrator/index.js';

const DAY = 86_400_000;
const future = (days = 7) => new Date(Date.now() + days * DAY).toISOString();
const past = (days = 1) => new Date(Date.now() - days * DAY).toISOString();
const ARTIFACTS = {
  'STACK.md': '# Stack\n',
  'ARCHITECTURE.md': '# Architecture\n',
  'PITFALLS.md': '# Pitfalls\n',
  'SUMMARY.md': '# Summary\n',
};

function payload(index, { expires_at = future() } = {}) {
  return {
    result: {
      decision_ids: Object.keys(index),
      volatility: 'medium',
      expires_at,
      sources: [{ id: 's1', type: 'docs', ref: 'https://example.com/docs' }],
    },
    decision_index: index,
    artifacts: ARTIFACTS,
  };
}

// Research as an earlier store would have left it, with every date in the past.
function expiredResearch(index) {
  const expired = Object.fromEntries(Object.entries(index).map(([id, d]) => [id, { ...d, expires_at: past() }]));
  return {
    volatility: 'medium',
    expires_at: past(),
    sources: [],
    files: Object.keys(ARTIFACTS),
    updated_at: past(30),
    decision_index: expired,
  };
}

async function walk(dir, phaseId, taskId, lifecycles) {
  for (const lifecycle of lifecycles) {
    const res = await update({
      updates: { phases: [{ id: phaseId, todo: [{ id: taskId, lifecycle, ...(lifecycle === 'checkpointed' ? { checkpoint_commit: `c${taskId}` } : {}) }] }] },
      basePath: dir,
    });
    assert.ok(res.success, `walk ${taskId} → ${lifecycle}: ${JSON.stringify(res)}`);
  }
}

// Run the orchestration loop with canned agents until it stops, recording
// every action. Executors checkpoint, reviewers accept every target, phases
// complete with green verification, the researcher answers with `researcher`.
async function drive(dir, { researcher, stopWhen = () => false, limit = 80 } = {}) {
  const actions = [];
  for (let step = 0; step < limit; step++) {
    if (stopWhen(await read({ basePath: dir }))) return actions;
    const r = await resumeWorkflow({ basePath: dir });
    assert.ok(!r.error, `resume failed after ${actions.join(' → ')}: ${JSON.stringify(r)}`);
    actions.push(r.task_id ? `${r.action}:${r.task_id}` : r.action);
    let res = { success: true };
    switch (r.action) {
      case 'dispatch_executor':
        res = await handleExecutorResult({
          result: {
            task_id: r.task_id, outcome: 'checkpointed', summary: 'done', checkpoint_commit: `c-${r.task_id}-${step}`,
            files_changed: [], decisions: [], blockers: [], contract_changed: false, evidence: [],
          },
          basePath: dir,
        });
        break;
      case 'dispatch_reviewer': {
        const ids = r.review_scope === 'task' ? [r.review_target.id] : r.review_targets.map((t) => t.id);
        res = await handleReviewerResult({
          result: {
            scope: r.review_scope, scope_id: r.review_scope === 'task' ? r.review_target.id : r.phase_id,
            review_level: r.review_scope === 'task' ? 'L2' : 'L1-batch', spec_passed: true, quality_passed: true,
            critical_issues: [], important_issues: [], minor_issues: [], accepted_tasks: ids, rework_tasks: [], evidence: [],
          },
          basePath: dir,
        });
        break;
      }
      case 'complete_phase':
        res = await phaseComplete({
          phase_id: r.phase_id, basePath: dir, direction_ok: true,
          verification: { lint: { exit_code: 0 }, typecheck: { exit_code: 0 }, test: { exit_code: 0 } },
        });
        break;
      case 'dispatch_researcher':
        assert.ok(researcher, `the loop asked for research nobody expected: ${actions.join(' → ')}`);
        res = await handleResearcherResult({ ...researcher(r), basePath: dir });
        break;
      case 'trigger_review':
      case 'rollback_to_dirty_phase':
        break;
      default:
        return actions;
    }
    assert.ok(res.success, `${r.action} handler failed after ${actions.join(' → ')}: ${JSON.stringify(res)}`);
  }
  assert.fail(`the loop did not stop within ${limit} steps: ${actions.join(' → ')}`);
}

let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'gsd-research-refresh-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('a store lands whole or changes nothing', () => {
  async function snapshot() {
    const gsd = join(dir, '.gsd');
    const files = {};
    for (const name of Object.keys(ARTIFACTS)) {
      files[name] = await readFile(join(gsd, 'research', name), 'utf8').catch(() => null);
    }
    return {
      state: await readFile(join(gsd, 'state.json'), 'utf8'),
      files,
      gsd: (await readdir(gsd)).sort(),
    };
  }

  async function seeded() {
    await init({ project: 'p', phases: [{ name: 'A', tasks: [{ index: 1, name: 'a', research_basis: ['decision:a'] }] }], research: true, basePath: dir });
    const first = await handleResearcherResult({ ...payload({ 'decision:a': { summary: 'A', source: 'docs' } }), basePath: dir });
    assert.equal(first.action, 'research_stored', JSON.stringify(first));
    for (const name of Object.keys(ARTIFACTS)) await writeFile(join(dir, '.gsd', 'research', name), `previous ${name}\n`);
    return snapshot();
  }

  for (const [label, make] of [
    ['the research expires_at is already past', () => payload({ 'decision:a': { summary: 'A2', source: 'docs' } }, { expires_at: past() })],
    ['one decision expires_at is already past', () => payload({ 'decision:a': { summary: 'A2', source: 'docs', expires_at: past() } })],
    ['the research expires_at is not a date', () => payload({ 'decision:a': { summary: 'A2', source: 'docs' } }, { expires_at: 'next week' })],
    // Two seconds out was stored and expired before the next resume (pre-tag review).
    ['the research expires in two seconds', () => payload({ 'decision:a': { summary: 'A2', source: 'docs' } }, { expires_at: new Date(Date.now() + 2000).toISOString() })],
  ]) {
    it(`refuses research that would expire on arrival (${label}), writing nothing`, async () => {
      // Stored as-is it was expired on the next resume, and the refresh it
      // triggered could store the same thing again.
      const before = await seeded();
      const res = await handleResearcherResult({ ...make(), basePath: dir });
      assert.equal(res.error, true, JSON.stringify(res));
      assert.match(res.message, /expires_at/, res.message);
      assert.deepEqual(await snapshot(), before, 'a refused store changed the project');
    });
  }

  it('refuses to let a blocked result replace the research on record', async () => {
    // With every source down the researcher returns a [BLOCKED] placeholder.
    // As a refresh it replaced every decision on record, sent every task
    // citing them back, reopened accepted phases and overwrote the four
    // documents with "研究受阻" (pre-tag review).
    const before = await seeded();
    const blocked = payload({ 'decision:blocked-no-sources': { summary: '[BLOCKED] 研究来源不可用，请提供替代信息或缩小范围', source: 'none' } });
    const res = await handleResearcherResult({ ...blocked, basePath: dir });
    assert.equal(res.error, true, JSON.stringify(res));
    assert.match(res.message, /blocked research result/, res.message);
    assert.deepEqual(await snapshot(), before, 'a refused store changed the project');
  });

  for (const [label, index] of [
    // The prefix with whitespace in front was not recognised (third pre-tag review).
    ['a blocked result whose summary starts with a space', { 'decision:blocked-no-sources': { summary: ' [BLOCKED] 研究来源不可用', source: 'none' } }],
    ['a blocked result whose summary starts with a newline', { 'decision:blocked-no-sources': { summary: '\n[BLOCKED] 研究来源不可用', source: 'none' } }],
    // Stored, it replaced every decision on record with nothing.
    ['a result with no decisions', {}],
  ]) {
    it(`refuses ${label} over the research on record, writing nothing`, async () => {
      const before = await seeded();
      const res = await handleResearcherResult({ ...payload(index), basePath: dir });
      assert.equal(res.code, 'VALIDATION_FAILED', JSON.stringify(res));
      assert.ok(res.message.includes('research: null') && res.message.includes('workflow_mode: "executing_task"'), res.message);
      assert.deepEqual(await snapshot(), before, 'a refused store changed the project');
    });
  }

  it('reads a placeholder on record whose summary starts with a space as blocked, and stores the next blocked result', async () => {
    // Read as real research, the placeholder made every later blocked
    // refresh a refusal, and an offline project could not move on.
    await init({ project: 'p', phases: [{ name: 'A', tasks: [{ index: 1, name: 'a' }] }], basePath: dir });
    const placeholder = payload({ 'decision:blocked-no-sources': { summary: ' [BLOCKED] 研究来源不可用', source: 'none' } });
    assert.equal((await handleResearcherResult({ ...placeholder, basePath: dir })).action, 'research_stored', 'premise: the placeholder is stored');
    const res = await handleResearcherResult({ ...payload({ 'decision:blocked-no-sources': { summary: '[BLOCKED] 研究来源不可用', source: 'none' } }), basePath: dir });
    assert.equal(res.action, 'research_stored', JSON.stringify(res));
  });

  it('stores a result with no decisions when there is no research on record', async () => {
    await init({ project: 'p', phases: [{ name: 'A', tasks: [{ index: 1, name: 'a' }] }], basePath: dir });
    const res = await handleResearcherResult({ ...payload({}), basePath: dir });
    assert.equal(res.action, 'research_stored', JSON.stringify(res));
  });

  // The researcher's fallback asks for an expiry 24 hours out (agents/researcher.md).
  const blockedPayload = () => payload(
    { 'decision:blocked-no-sources': { summary: '[BLOCKED] 研究来源不可用，请提供替代信息或缩小范围', source: 'none', expires_at: future(1) } },
    { expires_at: future(1) },
  );

  it('stores a blocked result when there is no research on record yet', async () => {
    // Planning with no sources: there is nothing to keep, and the blocked
    // decision is what tells the user.
    await init({ project: 'p', phases: [{ name: 'A', tasks: [{ index: 1, name: 'a' }] }], basePath: dir });
    const res = await handleResearcherResult({ ...blockedPayload(), basePath: dir });
    assert.equal(res.action, 'research_stored', JSON.stringify(res));
  });

  for (const [label, record, result] of [
    // A record mixing a real decision with a placeholder still holds research.
    ['a record that mixes real and blocked decisions',
      { 'decision:a': { summary: 'A', source: 'docs' }, 'decision:blocked-no-sources': { summary: '[BLOCKED] 部分来源不可用', source: 'none' } },
      { 'decision:blocked-no-sources': { summary: '[BLOCKED] 研究来源不可用', source: 'none', expires_at: future(1) } }],
    // A result that carries real decisions next to a blocked one is still a
    // research that could not be completed.
    ['a result that mixes real and blocked decisions',
      { 'decision:a': { summary: 'A', source: 'docs' } },
      { 'decision:c': { summary: 'C', source: 'docs' }, 'decision:blocked-no-sources': { summary: '[BLOCKED] 研究来源不可用', source: 'none', expires_at: future(1) } }],
  ]) {
    it(`refuses a blocked refresh over ${label}, writing nothing`, async () => {
      // Third pre-tag review: both mutations — treating a mixed record as
      // having no research, and refusing only all-blocked results — were green.
      await init({ project: 'p', phases: [{ name: 'A', tasks: [{ index: 1, name: 'a', research_basis: ['decision:a'] }] }], basePath: dir });
      assert.equal((await handleResearcherResult({ ...payload(record), basePath: dir })).action, 'research_stored', 'premise: the record is stored');
      const before = await snapshot();
      const res = await handleResearcherResult({ ...payload(result, { expires_at: future(1) }), basePath: dir });
      assert.equal(res.code, 'VALIDATION_FAILED', JSON.stringify(res));
      // The refusal names the way out that resume.md and the CHANGELOG give.
      assert.ok(res.message.includes('research: null') && res.message.includes('workflow_mode: "executing_task"'), res.message);
      assert.deepEqual(await snapshot(), before, 'a refused store changed the project');
    });
  }

  it('a write that fails before renaming anything, with no earlier marker, leaves none', async () => {
    // The marker means "the documents may not match state.json"; a failure
    // that replaced nothing must not raise it.
    await seeded();
    const stack = join(dir, '.gsd', 'research', 'STACK.md');
    await unlink(stack);
    await mkdir(stack);
    await assert.rejects(storeResearch({ ...payload({ 'decision:a': { summary: 'A2', source: 'docs' } }), basePath: dir }));
    const marker = await stat(join(dir, '.gsd', '.research-commit-pending')).then(() => true, () => false);
    assert.equal(marker, false, 'a failure that renamed nothing left a marker');
  });

  it('stores a blocked refresh over research that was itself blocked, so an offline project keeps going', async () => {
    // Refusing every blocked result while research was on record left a
    // project planned offline dispatching the researcher on every resume once
    // its 24-hour placeholder expired (second pre-tag review). There is no
    // research to protect in a record holding only blocked decisions.
    await init({ project: 'p', phases: [{ name: 'A', tasks: [{ index: 1, name: 'a' }] }], basePath: dir });
    assert.equal((await handleResearcherResult({ ...blockedPayload(), basePath: dir })).action, 'research_stored');
    await update({ updates: { research: expiredResearch({ 'decision:blocked-no-sources': { summary: '[BLOCKED] 研究来源不可用', source: 'none' } }) }, basePath: dir });
    assert.equal((await resumeWorkflow({ basePath: dir })).action, 'dispatch_researcher', 'premise: the placeholder expired');
    const res = await handleResearcherResult({ ...blockedPayload(), basePath: dir });
    assert.equal(res.action, 'research_stored', JSON.stringify(res));
    assert.equal((await resumeWorkflow({ basePath: dir })).action, 'dispatch_executor');
  });

  it('keeps the commit marker when a write fails after some documents were renamed in', async () => {
    // The catch removed the marker even after three of four renames, so
    // state.json disagreed with the documents and nothing reported it.
    await seeded();
    const summary = join(dir, '.gsd', 'research', 'SUMMARY.md');
    await unlink(summary);
    await mkdir(summary);
    await assert.rejects(storeResearch({ ...payload({ 'decision:a': { summary: 'A2', source: 'docs' } }), basePath: dir }));
    const marker = await stat(join(dir, '.gsd', '.research-commit-pending')).then(() => true, () => false);
    assert.ok(marker, 'the marker was removed although documents had already been replaced');
    const r = await resumeWorkflow({ basePath: dir });
    assert.ok((r.research_warnings ?? []).length > 0 || r.warnings?.length > 0, `resume does not report the half-written research: ${JSON.stringify(r).slice(0, 400)}`);
  });

  it('a retry that fails before renaming anything leaves the earlier marker in place', async () => {
    // The first failure kept the marker; a retry that failed at its first
    // rename then removed it, while the documents were still the first
    // attempt's (second pre-tag review).
    await seeded();
    const research = join(dir, '.gsd', 'research');
    await unlink(join(research, 'SUMMARY.md'));
    await mkdir(join(research, 'SUMMARY.md'));
    await assert.rejects(storeResearch({ ...payload({ 'decision:a': { summary: 'A2', source: 'docs' } }), basePath: dir }));
    await unlink(join(research, 'STACK.md'));
    await mkdir(join(research, 'STACK.md'));
    await assert.rejects(storeResearch({ ...payload({ 'decision:a': { summary: 'A3', source: 'docs' } }), basePath: dir }));
    const marker = await stat(join(dir, '.gsd', '.research-commit-pending')).then(() => true, () => false);
    assert.ok(marker, 'the retry removed the marker the first failure left');
  });

  it('refuses when the resulting state is invalid, before touching the research documents', async () => {
    // It used to rewrite all four documents, then validate, then drop the
    // commit marker and report the failure: the documents were the new
    // research and state.json the old one, with nothing to say so.
    const before = await seeded();
    const statePath = join(dir, '.gsd', 'state.json');
    const raw = JSON.parse(before.state);
    raw.total_phases = 99;
    await writeFile(statePath, `${JSON.stringify(raw, null, 2)}\n`);
    const broken = await snapshot();

    const res = await storeResearch({ ...payload({ 'decision:a': { summary: 'A2', source: 'docs' } }), basePath: dir });
    assert.equal(res.code, 'VALIDATION_FAILED', JSON.stringify(res));
    assert.match(res.message, /total_phases/, `premise: the state was refused for the planted defect: ${res.message}`);
    assert.deepEqual(await snapshot(), broken, 'a refused store changed the project');
  });
});

describe('a refresh replaces the decision index', () => {
  it('replaces a record holding a malformed decision, and sends the tasks citing it back', async () => {
    // 0.17.0's state-update let a decision_index entry of null be written;
    // the refresh over it read `.summary` of null and threw a TypeError
    // (pre-tag review). Written straight to disk, as that state-update did.
    await init({ project: 'p', phases: [{ name: 'A', tasks: [{ index: 1, name: 'a', research_basis: ['decision:a'] }] }], basePath: dir });
    await walk(dir, 1, '1.1', ['running', 'checkpointed', 'accepted']);
    const statePath = join(dir, '.gsd', 'state.json');
    const raw = JSON.parse(await readFile(statePath, 'utf8'));
    raw.research = { ...expiredResearch({ 'decision:b': { summary: 'B', source: 'docs' } }), decision_index: { 'decision:a': null } };
    await writeFile(statePath, `${JSON.stringify(raw, null, 2)}\n`);
    const res = await handleResearcherResult({ ...payload({ 'decision:a': { summary: 'A', source: 'docs' } }), basePath: dir });
    assert.equal(res.action, 'research_stored', JSON.stringify(res));
    const state = await read({ basePath: dir });
    assert.deepEqual(state.research.decision_index, { 'decision:a': { summary: 'A', source: 'docs' } });
    assert.equal(state.phases[0].todo[0].lifecycle, 'needs_revalidation', 'a task citing an unreadable decision kept its acceptance');
  });

  for (const [label, index] of [['a string', 'decisions'], ['a number', 42], ['an array', ['decision:a']]]) {
    it(`replaces a record whose decision_index is ${label}`, async () => {
      // 0.17.0's state-update could write one. With a task citing a decision
      // neither index has, the store threw "Cannot use 'in' operator", and
      // every resume dispatched the researcher into the same throw.
      await init({ project: 'p', phases: [{ name: 'A', tasks: [{ index: 1, name: 'a', research_basis: ['decision:gone'] }] }], basePath: dir });
      const statePath = join(dir, '.gsd', 'state.json');
      const raw = JSON.parse(await readFile(statePath, 'utf8'));
      raw.research = { ...expiredResearch({}), decision_index: index };
      await writeFile(statePath, `${JSON.stringify(raw, null, 2)}\n`);
      const next = { 'decision:a': { summary: 'A', source: 'docs' } };
      const res = await handleResearcherResult({ ...payload(next), basePath: dir });
      assert.equal(res.action, 'research_stored', JSON.stringify(res));
      assert.deepEqual((await read({ basePath: dir })).research.decision_index, next);
      // Nothing on record to compare with: no decision of it reads as removed.
      assert.ok(!res.research_warnings.some((w) => /removed/.test(w)), JSON.stringify(res.research_warnings));
    });
  }

  it('stores exactly the new index: a dropped decision is gone, a kept one keeps no stale date', async () => {
    // Rule 3 kept a dropped decision with its past expires_at, and rule 1 kept
    // the old expires_at when the new entry had none; either one expired the
    // research again on the next resume.
    await init({ project: 'p', phases: [{ name: 'A', tasks: [{ index: 1, name: 'a' }] }], basePath: dir });
    await update({ updates: { research: expiredResearch({
      'decision:a': { summary: 'A', source: 'docs' },
      'decision:b': { summary: 'B', source: 'docs' },
      'decision:c': { summary: 'C', source: 'docs' },
    }) }, basePath: dir });
    const next = { 'decision:a': { summary: 'A', source: 'docs' }, 'decision:c': { summary: 'C2', source: 'docs' }, 'decision:d': { summary: 'D', source: 'docs' } };

    const res = await handleResearcherResult({ ...payload(next), basePath: dir });
    assert.equal(res.action, 'research_stored', JSON.stringify(res));
    assert.deepEqual((await read({ basePath: dir })).research.decision_index, next);
    const again = await resumeWorkflow({ basePath: dir });
    assert.notEqual(again.action, 'dispatch_researcher', `the refreshed research expired again: ${JSON.stringify(again.expired_research)}`);
  });

  it('a second identical refresh invalidates nothing', async () => {
    // Rule 3's kept entry was "missing from the new research" on every later
    // refresh too, so each one sent the tasks citing it back for revalidation.
    await init({ project: 'p', phases: [{ name: 'A', tasks: [
      { index: 1, name: 'cites b', research_basis: ['decision:b'] },
      { index: 2, name: 'cites a', research_basis: ['decision:a'] },
    ] }], basePath: dir });
    const both = { 'decision:a': { summary: 'A', source: 'docs' }, 'decision:b': { summary: 'B', source: 'docs' } };
    assert.equal((await handleResearcherResult({ ...payload(both), basePath: dir })).action, 'research_stored');
    for (const id of ['1.1', '1.2']) await walk(dir, 1, id, ['running', 'checkpointed', 'accepted']);

    const onlyA = { 'decision:a': { summary: 'A', source: 'docs' } };
    const first = await handleResearcherResult({ ...payload(onlyA), basePath: dir });
    assert.deepEqual(first.invalidated_tasks, ['1.1'], JSON.stringify(first));
    await walk(dir, 1, '1.1', ['pending', 'running', 'checkpointed', 'accepted']);

    const second = await handleResearcherResult({ ...payload(onlyA), basePath: dir });
    assert.equal(second.action, 'research_stored', JSON.stringify(second));
    assert.deepEqual(second.invalidated_tasks ?? [], [], 'the same research invalidated tasks a second time');
    // The citation 1.1 still carries is reported (it resolves to nothing), but
    // nothing is removed a second time.
    assert.ok(!second.research_warnings.some((w) => /removed/.test(w)), JSON.stringify(second.research_warnings));
    const lifecycles = (await read({ basePath: dir })).phases[0].todo.map((t) => t.lifecycle);
    assert.deepEqual(lifecycles, ['accepted', 'accepted']);
  });

  it('warns about a task that cites a decision the research does not have', async () => {
    // A planning typo in research_basis resolved to summary "not found" in
    // every executor dispatch, silently.
    await init({ project: 'p', phases: [{ name: 'A', tasks: [{ index: 1, name: 'a', research_basis: ['decision:a', 'decision:typo'] }] }], basePath: dir });
    const res = await handleResearcherResult({ ...payload({ 'decision:a': { summary: 'A', source: 'docs' } }), basePath: dir });
    assert.equal(res.action, 'research_stored', JSON.stringify(res));
    assert.ok(res.research_warnings.some((w) => w.includes('1.1') && w.includes('decision:typo')), JSON.stringify(res.research_warnings));
    const ctx = buildExecutorContext(await read({ basePath: dir }), '1.1', 1, dir);
    assert.deepEqual(ctx.research_decisions.map((d) => d.summary), ['A', 'not found']);
  });

  it('hands the researcher the decisions on record, so it can keep their ids', async () => {
    // Both paths that dispatch it: preflight finding the research expired, and
    // a project already held for a refresh whose research no longer reads as
    // expired (resume's research_refresh_needed case).
    await init({ project: 'p', phases: [{ name: 'A', tasks: [{ index: 1, name: 'a' }] }], basePath: dir });
    const index = { 'decision:a': { summary: 'A', source: 'docs' } };
    const onRecord = expiredResearch(index);
    await update({ updates: { research: onRecord }, basePath: dir });
    const fromPreflight = await resumeWorkflow({ basePath: dir });
    await update({ updates: { research: { ...expiredResearch(index), expires_at: future(), decision_index: index } }, basePath: dir });
    const fromHold = await resumeWorkflow({ basePath: dir });
    for (const [path, r, expected] of [['preflight', fromPreflight, onRecord.decision_index], ['hold', fromHold, index]]) {
      assert.equal(r.action, 'dispatch_researcher', `${path}: ${JSON.stringify(r)}`);
      assert.equal(r.workflow_mode, 'research_refresh_needed', `${path}: ${JSON.stringify(r)}`);
      assert.deepEqual(r.current_decision_index, expected, `${path}: ${JSON.stringify(r)}`);
    }
    assert.deepEqual(fromHold.expired_research, [], 'premise: the hold path ran with nothing expired');
  });
});

describe('an invalidating refresh still reaches completion', () => {
  it('reopens the accepted phase it invalidates, re-runs it, and returns to where it was', async () => {
    // Fourth 0.16.0 pre-tag review: a refresh that drops a decision cited in
    // an accepted phase set the task to needs_revalidation and left the phase
    // accepted; validateState refused every store and each resume dispatched
    // the researcher again. Past that, phase-complete advanced current_phase
    // by one, into a phase that was already accepted.
    await init({ project: 'p', phases: [
      { name: 'One', tasks: [{ index: 1, name: 'cites b', research_basis: ['decision:b'] }] },
      { name: 'Two', tasks: [{ index: 1, name: 'plain' }] },
      { name: 'Three', tasks: [{ index: 1, name: 'x' }, { index: 2, name: 'y' }] },
    ], basePath: dir });
    const both = { 'decision:a': { summary: 'A', source: 'docs' }, 'decision:b': { summary: 'B', source: 'docs' } };
    assert.equal((await handleResearcherResult({ ...payload(both), basePath: dir })).action, 'research_stored');

    const before = await drive(dir, { stopWhen: (s) => s.current_phase === 3 });
    assert.ok(!before.includes('dispatch_researcher'), before.join(' → '));
    await update({ updates: { research: expiredResearch(both) }, basePath: dir });

    let researched = 0;
    const after = await drive(dir, {
      researcher: () => { researched += 1; return payload({ 'decision:a': { summary: 'A', source: 'docs' } }); },
    });
    const trace = after.join(' → ');
    assert.equal(researched, 1, trace);
    assert.equal(after.at(-1), 'noop', `the project did not complete: ${trace}`);
    assert.ok(after.includes('rollback_to_dirty_phase'), trace);
    assert.ok(after.includes('dispatch_executor:1.1'), `the invalidated task was not re-run: ${trace}`);
    assert.ok(!after.includes('dispatch_executor:2.1'), `phase 2 was re-run though nothing in it was invalidated: ${trace}`);

    const state = await read({ basePath: dir });
    assert.equal(state.workflow_mode, 'completed');
    assert.deepEqual(state.phases.map((p) => p.lifecycle), ['accepted', 'accepted', 'accepted']);
  });

  it('a reopened phase carries no record of its old review or handoff', async () => {
    await init({ project: 'p', phases: [
      { name: 'One', tasks: [{ index: 1, name: 'cites b', research_basis: ['decision:b'] }] },
      { name: 'Two', tasks: [{ index: 1, name: 'plain' }] },
    ], basePath: dir });
    const both = { 'decision:a': { summary: 'A', source: 'docs' }, 'decision:b': { summary: 'B', source: 'docs' } };
    assert.equal((await handleResearcherResult({ ...payload(both), basePath: dir })).action, 'research_stored');
    await drive(dir, { stopWhen: (s) => s.current_phase === 2 });
    const res = await handleResearcherResult({ ...payload({ 'decision:a': { summary: 'A', source: 'docs' } }), basePath: dir });
    assert.deepEqual(res.invalidated_tasks, ['1.1'], JSON.stringify(res));
    const one = (await read({ basePath: dir })).phases[0];
    assert.equal(one.lifecycle, 'active');
    assert.deepEqual(one.phase_review, { status: 'pending', retry_count: 0 });
    assert.equal(one.phase_handoff.required_reviews_passed, false);
  });

  it('completing the last unfinished phase completes the project, whatever its number', async () => {
    // After a rollback the phase being redone can be the only one left; the
    // phases after it are accepted already.
    await init({ project: 'p', phases: [
      { name: 'One', tasks: [{ index: 1, name: 'a' }] },
      { name: 'Two', tasks: [{ index: 1, name: 'b' }] },
      { name: 'Three', tasks: [{ index: 1, name: 'c' }] },
    ], basePath: dir });
    const verification = { lint: { exit_code: 0 }, typecheck: { exit_code: 0 }, test: { exit_code: 0 } };
    for (const id of [2, 3]) {
      await update({ updates: { phases: [{ id, lifecycle: 'active' }] }, basePath: dir });
      await walk(dir, id, `${id}.1`, ['running', 'checkpointed', 'accepted']);
      await update({ updates: { phases: [{ id, lifecycle: 'reviewing', phase_review: { status: 'accepted', retry_count: 0 } }] }, basePath: dir });
      const done = await phaseComplete({ phase_id: id, basePath: dir, verification, direction_ok: true });
      assert.ok(done.success, `premise: phase ${id} completes out of order: ${JSON.stringify(done)}`);
    }
    await walk(dir, 1, '1.1', ['running', 'checkpointed', 'accepted']);
    await update({ updates: { phases: [{ id: 1, lifecycle: 'reviewing', phase_review: { status: 'accepted', retry_count: 0 } }] }, basePath: dir });
    const last = await phaseComplete({ phase_id: 1, basePath: dir, verification, direction_ok: true });
    assert.ok(last.success, JSON.stringify(last));
    assert.equal((await read({ basePath: dir })).workflow_mode, 'completed');
  });

  it('drops the phase review it interrupted and re-runs the invalidated task first', async () => {
    // Restoring reviewing_phase would review a phase whose work just changed.
    await init({ project: 'p', phases: [{ name: 'One', tasks: [
      { index: 1, name: 'cites a', research_basis: ['decision:a'] },
      { index: 2, name: 'plain' },
    ] }], basePath: dir });
    const index = { 'decision:a': { summary: 'A', source: 'docs' } };
    assert.equal((await handleResearcherResult({ ...payload(index), basePath: dir })).action, 'research_stored');
    for (const id of ['1.1', '1.2']) await walk(dir, 1, id, ['running', 'checkpointed']);
    await update({ updates: { workflow_mode: 'reviewing_phase', current_review: { scope: 'phase', scope_id: 1 }, phases: [{ id: 1, lifecycle: 'reviewing' }] }, basePath: dir });
    await update({ updates: { research: expiredResearch(index) }, basePath: dir });

    const after = await drive(dir, { researcher: () => payload({ 'decision:a': { summary: 'A, revised', source: 'docs' } }) });
    const trace = after.join(' → ');
    assert.deepEqual(after.slice(0, 2), ['dispatch_researcher', 'dispatch_executor:1.1'], trace);
    assert.equal(after.at(-1), 'noop', trace);
  });
});

describe('a refresh that changes nothing returns the workflow to the action it was about to take', () => {
  // Each shape is a state preflight runs in, built twice: once with research
  // that has not expired, once with the same research expired. The fresh one
  // says what resume would do. In a mode the server refreshes in, the expired
  // one must refresh and then do the same; in any other mode, expiry must not
  // change what resume does at all. inferWorkflowModeAfterResearch read only
  // current_review.scope, so a task being debugged came back as a task review;
  // and refreshing over a state that was not executing (planning, reconciling,
  // re-planning, waiting for /clear, waiting on the user) resumed execution.
  const INDEX = { 'decision:a': { summary: 'A', source: 'docs' } };
  const research = (expired) => (expired ? expiredResearch(INDEX) : { ...expiredResearch(INDEX), expires_at: future(), decision_index: payload(INDEX).decision_index });

  async function project(level = 'L1') {
    await init({ project: 'p', phases: [{ name: 'A', tasks: [{ index: 1, name: 'a', level, research_basis: ['decision:a'] }, { index: 2, name: 'b' }] }], basePath: dir });
  }

  const SHAPES = {
    'executing a pending task': { mode: 'executing_task', build: async () => { await project(); } },
    'debugging a task': { mode: 'executing_task', build: async () => {
      await project();
      await walk(dir, 1, '1.1', ['running']);
      await update({ updates: {
        current_task: '1.1',
        current_review: { scope: 'task', scope_id: '1.1', stage: 'debugging', retry_count: 3, error_fingerprint: 'e', summary: 's' },
        phases: [{ id: 1, todo: [{ id: '1.1', retry_count: 3 }] }],
      }, basePath: dir });
    } },
    'reviewing a task': { mode: 'reviewing_task', build: async () => {
      await project('L2');
      await walk(dir, 1, '1.1', ['running', 'checkpointed']);
      await update({ updates: { workflow_mode: 'reviewing_task', current_review: { scope: 'task', scope_id: '1.1', stage: 'spec' } }, basePath: dir });
    } },
    'reviewing a phase': { mode: 'reviewing_phase', build: async () => {
      await project();
      for (const id of ['1.1', '1.2']) await walk(dir, 1, id, ['running', 'checkpointed']);
      await update({ updates: { workflow_mode: 'reviewing_phase', current_review: { scope: 'phase', scope_id: 1 }, phases: [{ id: 1, lifecycle: 'reviewing' }] }, basePath: dir });
    } },
  };

  const HOLDS = {
    'paused by the user': { mode: 'paused_by_user', build: async () => {
      await project();
      await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: dir });
    } },
    'a review that ran out of retries': { mode: 'awaiting_user', build: async () => {
      await project();
      for (const id of ['1.1', '1.2']) await walk(dir, 1, id, ['running', 'checkpointed']);
      await update({ updates: {
        workflow_mode: 'awaiting_user',
        current_review: { scope: 'phase', scope_id: 1, stage: 'review_retry_exhausted', retry_count: 6 },
        phases: [{ id: 1, phase_review: { status: 'rework_required', retry_count: 6 } }],
      }, basePath: dir });
    } },
    'a blocked task': { mode: 'awaiting_user', build: async () => {
      await project();
      await walk(dir, 1, '1.1', ['running', 'blocked']);
      await update({ updates: { workflow_mode: 'awaiting_user', phases: [{ id: 1, todo: [{ id: '1.1', blocked_reason: 'needs a credential', unblock_condition: 'user provides it' }, { id: '1.2', lifecycle: 'running' }] }] }, basePath: dir });
      await walk(dir, 1, '1.2', ['blocked']);
      await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.2', blocked_reason: 'needs a credential too', unblock_condition: 'user provides it' }] }] }, basePath: dir });
    } },
    're-planning': { mode: 'planning', build: async () => {
      await project();
      await update({ updates: { workflow_mode: 'planning' }, basePath: dir });
    } },
    'a workspace to reconcile': { mode: 'reconcile_workspace', build: async () => {
      await project();
      await update({ updates: { workflow_mode: 'reconcile_workspace' }, basePath: dir });
    } },
    'a plan to re-align': { mode: 'replan_required', build: async () => {
      await project();
      await update({ updates: { workflow_mode: 'replan_required' }, basePath: dir });
    } },
    'waiting for /clear with little context left': { mode: 'awaiting_clear', build: async () => {
      await project();
      await update({ updates: { workflow_mode: 'awaiting_clear' }, basePath: dir });
      await writeFile(join(dir, '.gsd', '.context-health'), '10');
    } },
  };

  it('covers every workflow mode, on the side the server puts it', () => {
    // Preflight skips completed and failed; research_refresh_needed is the
    // refresh itself. A mode added later fails here until it has a shape.
    assert.ok(REFRESH_MODES.length > 0, 'premise: orchestrator/helpers.js exports REFRESH_MODES');
    const covered = new Set(['completed', 'failed', 'research_refresh_needed']);
    for (const [name, { mode }] of Object.entries(SHAPES)) {
      assert.ok(REFRESH_MODES.includes(mode), `${name}: ${mode} is not a mode the server refreshes in`);
      covered.add(mode);
    }
    for (const [name, { mode }] of Object.entries(HOLDS)) {
      assert.ok(!REFRESH_MODES.includes(mode), `${name}: the server refreshes in ${mode}`);
      covered.add(mode);
    }
    assert.deepEqual(WORKFLOW_MODES.filter((m) => !covered.has(m)), [], 'workflow modes with no shape');
  });

  const key = (r) => JSON.stringify([r.action, r.task_id ?? null, r.review_scope ?? null, r.debug_target?.id ?? null]);

  async function rebuild(build, expired) {
    await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(join(tmpdir(), 'gsd-research-refresh-'));
    await build();
    await update({ updates: { research: research(expired) }, basePath: dir });
  }

  for (const [name, { build }] of Object.entries(SHAPES)) {
    it(name, async () => {
      await rebuild(build, false);
      const expected = await resumeWorkflow({ basePath: dir });
      assert.ok(!expected.error && expected.action !== 'dispatch_researcher', `premise: ${JSON.stringify(expected)}`);

      await rebuild(build, true);
      const refresh = await resumeWorkflow({ basePath: dir });
      assert.equal(refresh.action, 'dispatch_researcher', JSON.stringify(refresh));
      const stored = await handleResearcherResult({ ...payload(INDEX), basePath: dir });
      assert.equal(stored.action, 'research_stored', JSON.stringify(stored));
      const resumed = await resumeWorkflow({ basePath: dir });
      assert.equal(key(resumed), key(expected), `after the refresh: ${JSON.stringify(resumed)}`);
    });
  }

  for (const [name, { build }] of Object.entries(HOLDS)) {
    it(`expired research does not take over ${name}`, async () => {
      await rebuild(build, false);
      const expected = await resumeWorkflow({ basePath: dir });
      assert.ok(!expected.error, `premise: ${JSON.stringify(expected)}`);

      await rebuild(build, true);
      const held = await resumeWorkflow({ basePath: dir });
      assert.equal(key(held), key(expected), JSON.stringify(held));
    });
  }
});
