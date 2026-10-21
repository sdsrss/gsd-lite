// A project set aside mid-way comes back to what it was doing.
//
// Three paths set the workflow mode aside and restore it later from
// current_review: a /clear (awaiting_clear), a pause (paused_by_user, whose
// resume reports resume_to), and a research refresh. Each derived the mode on
// its own. After a /clear an interrupted task review was dropped and the next
// task dispatched, while the refresh path restored the same review; a project
// paused while debugging reported resume_to: reviewing_task. These cases build
// every current_review shape the server writes, resume it directly, then
// resume it after a /clear and after a pause, and require the same action.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempDir, removeTempDir, initProject, checkpointTask, read, update } from './e2e-helpers.js';
import { resumeWorkflow } from '../src/tools/orchestrator/index.js';

const ONE_PHASE = [{ name: 'Phase 1', tasks: [
  { index: 1, name: 'Task A', level: 'L3', requires: [] },
  { index: 2, name: 'Task B', level: 'L1', requires: [] },
] }];

// Each shape is the mode and current_review a handler leaves behind, with the
// task lifecycles that go with it.
const SHAPES = [
  { label: 'no review', mode: 'executing_task', review: null, setup: async () => {} },
  {
    label: 'debugging a running task',
    mode: 'executing_task',
    review: { scope: 'task', scope_id: '1.1', stage: 'debugging' },
    current_task: '1.1',
    setup: (dir) => update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: dir }),
  },
  {
    label: 'a task review at spec',
    mode: 'reviewing_task',
    review: { scope: 'task', scope_id: '1.1', stage: 'spec' },
    setup: (dir) => checkpointTask(dir, 1, '1.1'),
  },
  {
    label: 'a task review at quality',
    mode: 'reviewing_task',
    review: { scope: 'task', scope_id: '1.1', stage: 'quality' },
    setup: (dir) => checkpointTask(dir, 1, '1.1'),
  },
  {
    label: 'a phase review',
    mode: 'reviewing_phase',
    review: { scope: 'phase', scope_id: 1 },
    setup: async (dir) => { await checkpointTask(dir, 1, '1.1'); await checkpointTask(dir, 1, '1.2'); },
  },
  {
    label: 'a phase review at spec',
    mode: 'reviewing_phase',
    review: { scope: 'phase', scope_id: 1, stage: 'spec' },
    setup: async (dir) => { await checkpointTask(dir, 1, '1.1'); await checkpointTask(dir, 1, '1.2'); },
  },
  {
    label: 'an L3 task held for human confirmation',
    mode: 'awaiting_user',
    review: { scope: 'task', scope_id: '1.1', stage: 'human_confirmation', pending_tasks: ['1.1'], security_implications: [] },
    setup: (dir) => checkpointTask(dir, 1, '1.1'),
  },
  {
    label: 'a phase review out of retries',
    mode: 'awaiting_user',
    review: { scope: 'phase', scope_id: 1, stage: 'review_retry_exhausted', retry_count: 6 },
    setup: async (dir) => { await checkpointTask(dir, 1, '1.1'); await checkpointTask(dir, 1, '1.2'); },
  },
  {
    label: 'a direction drift hold',
    mode: 'awaiting_user',
    review: { scope: 'phase', scope_id: 1, stage: 'direction_drift', summary: 'Direction drift detected for phase 1' },
    setup: async () => {},
  },
];

const dirs = [];
afterEach(async () => { while (dirs.length > 0) await removeTempDir(dirs.pop()); });

async function build(shape) {
  const dir = await createTempDir();
  dirs.push(dir);
  await initProject(dir, { phases: ONE_PHASE });
  await shape.setup(dir);
  const res = await update({
    updates: { workflow_mode: shape.mode, current_task: shape.current_task ?? null, current_review: shape.review },
    basePath: dir,
  });
  assert.ok(res.success, `premise: ${shape.label} could not be built: ${JSON.stringify(res)}`);
  return dir;
}

// What a resume is about to do, without the fields that differ run to run.
function next(r) {
  assert.ok(!r.error, `resume failed: ${JSON.stringify(r)}`);
  return { action: r.action, workflow_mode: r.workflow_mode, target: r.task_id ?? r.review_target?.id ?? null };
}

describe('a project set aside comes back to what it was doing', () => {
  for (const shape of SHAPES) {
    it(`after a /clear: ${shape.label}`, async () => {
      const expected = next(await resumeWorkflow({ basePath: await build(shape) }));
      const dir = await build(shape);
      const held = await update({ updates: { workflow_mode: 'awaiting_clear' }, basePath: dir });
      assert.ok(held.success, `premise: ${shape.mode} cannot move to awaiting_clear: ${JSON.stringify(held)}`);
      assert.deepEqual(next(await resumeWorkflow({ basePath: dir })), expected);
    });

    it(`after a pause, resuming to resume_to: ${shape.label}`, async () => {
      const expected = next(await resumeWorkflow({ basePath: await build(shape) }));
      const dir = await build(shape);
      const held = await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: dir });
      assert.ok(held.success, `premise: ${shape.mode} cannot be paused: ${JSON.stringify(held)}`);
      const paused = await resumeWorkflow({ basePath: dir });
      assert.equal(paused.workflow_mode, 'paused_by_user', 'premise: the pause holds');
      // commands/resume.md: on the user's confirmation, set workflow_mode to resume_to.
      const back = await update({ updates: { workflow_mode: paused.resume_to }, basePath: dir });
      assert.ok(back.success, `resume_to ${paused.resume_to} cannot be written: ${JSON.stringify(back)}`);
      assert.deepEqual(next(await resumeWorkflow({ basePath: dir })), expected, `resume_to was ${paused.resume_to}`);
    });
  }

  it('covers every stage the server writes into current_review', async () => {
    // A stage added later has to say where a project held at it comes back to.
    const src = join(import.meta.dirname, '..', 'src');
    const files = (await readdir(src, { recursive: true })).filter((f) => f.endsWith('.js'));
    const written = new Set();
    for (const file of files) {
      for (const m of (await readFile(join(src, file), 'utf8')).matchAll(/stage: '(\w+)'/g)) written.add(m[1]);
    }
    assert.ok(written.size >= 4, `premise: found only ${[...written].join(', ')}`);
    const covered = new Set(SHAPES.map((s) => s.review?.stage).filter(Boolean));
    assert.deepEqual([...written].filter((s) => !covered.has(s)), []);
  });

  it('keeps the pause itself until the user confirms', async () => {
    // premise of the pause cases above: resume reports, it does not resume.
    const dir = await build(SHAPES[2]);
    await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: dir });
    const r = await resumeWorkflow({ basePath: dir });
    assert.equal(r.action, 'await_manual_intervention');
    assert.equal((await read({ basePath: dir })).workflow_mode, 'paused_by_user');
  });
});
