// A research refresh that sends tasks back for revalidation drops the review
// in progress: what it reviewed may have to be redone. That held for a refresh
// hold sitting directly on the review, and for a pause over that hold. In
// three other shapes the review was kept, and once released it ran over the
// tasks the refresh had just sent back: a refresh stored in the review mode
// itself, a refresh hold over a pause over the review, and a hold whose stack
// an older version's write had dropped. The rule is now the review's, not the
// stack's: whatever sits over it, the review goes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORK_MODES } from '../src/schema.js';
import * as stateApi from '../src/tools/state/index.js';
import { handleResearcherResult, resumeWorkflow } from '../src/tools/orchestrator/index.js';
import { acceptTask, checkpointTask, createTempDir, read, removeTempDir, update } from './e2e-helpers.js';

const research = {
  result: { decision_ids: ['decision:a'], blocked: false, volatility: 'medium', expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), sources: [{ id: 's1', type: 'docs', ref: 'https://example.com/docs' }] },
  decision_index: { 'decision:a': { summary: 'A', source: 'docs' } },
  artifacts: { 'STACK.md': '# Stack\n', 'ARCHITECTURE.md': '# Architecture\n', 'PITFALLS.md': '# Pitfalls\n', 'SUMMARY.md': '# Summary\n' },
};
const revised = { ...research, decision_index: { 'decision:a': { summary: 'A, revised', source: 'docs' } } };

const REVIEWS = {
  task: { mode: 'reviewing_task', review: { scope: 'task', scope_id: '1.1', stage: 'quality' } },
  phase: { mode: 'reviewing_phase', review: { scope: 'phase', scope_id: 1 } },
};

// A project with research on record and a review of `scope` in progress over
// task 1.1, which cites decision:a.
async function reviewing(t, scope) {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  await stateApi.init({ project: 'p', phases: [{ name: 'A', tasks: [
    { index: 1, name: 'cites a', research_basis: ['decision:a'] },
    { index: 2, name: 'b' },
  ] }], basePath: dir });
  assert.equal((await handleResearcherResult({ ...research, basePath: dir })).action, 'research_stored', 'premise: research on record');
  if (scope === 'phase') {
    await acceptTask(dir, 1, '1.1');
    await acceptTask(dir, 1, '1.2');
    await update({ updates: { phases: [{ id: 1, lifecycle: 'reviewing' }] }, basePath: dir });
  } else {
    await checkpointTask(dir, 1, '1.1');
  }
  const { mode, review } = REVIEWS[scope];
  assert.ok((await update({ updates: { workflow_mode: mode, current_review: review }, basePath: dir })).success, 'premise: reviewing');
  return dir;
}

// Release whatever holds there are, the way /gsd:resume does: write the
// resume_to a hold names, or let the server release the ones it releases.
// The review must not be dispatched on the way out, and execution is where
// the way out ends.
async function releaseAll(dir) {
  for (let i = 0; i < 6; i++) {
    const before = await read({ basePath: dir });
    if (WORK_MODES.includes(before.workflow_mode)) break;
    const res = await resumeWorkflow({ basePath: dir });
    assert.notEqual(res.action, 'dispatch_reviewer', `released into the dropped review: ${JSON.stringify(res)}`);
    if (res.resume_to && (await read({ basePath: dir })).workflow_mode === before.workflow_mode) {
      const written = await update({ updates: { workflow_mode: res.resume_to }, basePath: dir });
      assert.ok(written.success, `writing resume_to ${res.resume_to}: ${JSON.stringify(written)}`);
    }
  }
  const after = await read({ basePath: dir });
  assert.equal(after.workflow_mode, 'executing_task');
  const res = await resumeWorkflow({ basePath: dir });
  assert.notEqual(res.action, 'dispatch_reviewer', JSON.stringify(res));
}

async function storeRevised(dir) {
  const stored = await handleResearcherResult({ ...revised, basePath: dir });
  assert.deepEqual(stored.invalidated_tasks, ['1.1'], JSON.stringify(stored));
  assert.equal((await read({ basePath: dir })).current_review, null, 'the review the refresh invalidated is still held');
}

describe('a refresh that sends tasks back drops the review in progress, whatever sits over it', () => {
  // Holds entered over the review, in order. Every allowed order of up to two
  // of the three that a review can sit under while a refresh is stored.
  const STACKS = [
    [],
    ['research_refresh_needed'],
    ['paused_by_user'],
    ['awaiting_clear'],
    ['research_refresh_needed', 'paused_by_user'],
    ['paused_by_user', 'research_refresh_needed'],
    ['paused_by_user', 'awaiting_clear'],
    ['awaiting_clear', 'paused_by_user'],
    ['awaiting_clear', 'research_refresh_needed'],
  ];
  for (const scope of Object.keys(REVIEWS)) {
    for (const holds of STACKS) {
      it(`${scope} review, refresh stored under [${holds.join(', ') || 'nothing'}]`, async (t) => {
        const dir = await reviewing(t, scope);
        for (const mode of holds) {
          const res = await update({ updates: { workflow_mode: mode }, basePath: dir });
          assert.ok(res.success, `entering ${mode}: ${JSON.stringify(res)}`);
        }
        await storeRevised(dir);
        await releaseAll(dir);
      });
    }

    // An older version's write leaves the stack dropped: in a hold, with the
    // review on record and nothing saying what the hold interrupted.
    it(`${scope} review, refresh stored under a pause whose stack an older version dropped`, async (t) => {
      const dir = await reviewing(t, scope);
      await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: dir });
      const statePath = join(dir, '.gsd', 'state.json');
      const raw = JSON.parse(await readFile(statePath, 'utf8'));
      raw._version += 1; // an older version's write: _version moved, the stamp did not
      await writeFile(statePath, JSON.stringify(raw));
      assert.deepEqual((await read({ basePath: dir })).suspended_modes, [], 'premise: the stack was dropped on load');
      await storeRevised(dir);
      await releaseAll(dir);
    });
  }

  it('a decision held at a stage is not a review in progress, and stays', async (t) => {
    const dir = await reviewing(t, 'phase');
    const decision = { scope: 'phase', scope_id: 1, stage: 'review_retry_exhausted', retry_count: 6 };
    assert.ok((await update({ updates: { workflow_mode: 'awaiting_user', current_review: decision }, basePath: dir })).success);
    const stored = await handleResearcherResult({ ...revised, basePath: dir });
    assert.deepEqual(stored.invalidated_tasks, ['1.1'], JSON.stringify(stored));
    const after = await read({ basePath: dir });
    assert.deepEqual(after.current_review, decision);
    assert.equal(after.workflow_mode, 'awaiting_user');
  });

  it('a refresh that sends nothing back keeps the review', async (t) => {
    const dir = await reviewing(t, 'task');
    const same = await handleResearcherResult({ ...research, basePath: dir });
    assert.deepEqual(same.invalidated_tasks ?? [], [], JSON.stringify(same));
    const after = await read({ basePath: dir });
    assert.deepEqual(after.current_review, REVIEWS.task.review);
    assert.equal(after.workflow_mode, 'reviewing_task');
  });
});
