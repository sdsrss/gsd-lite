import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { init, read, update } from '../src/tools/state/index.js';
import { handleExecutorResult } from '../src/tools/orchestrator/index.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

async function withBlockedTask(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-blocker-'));
  try {
    await init({
      project: 'blockers',
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }, { index: 2, name: 'Task B' }] }],
      basePath: dir,
    });
    await update({ updates: { workflow_mode: 'executing_task', current_task: '1.1' }, basePath: dir });
    await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: dir });
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const blockedResult = (blockers) => ({
  task_id: '1.1',
  outcome: 'blocked',
  summary: 'could not finish',
  checkpoint_commit: null,
  files_changed: [],
  decisions: [],
  blockers,
  contract_changed: false,
  evidence: [],
});

// Three places described a blocker and no two agreed: the MCP tool schema said
// [{description}], helpers.js read .reason and .unblock_condition, and
// agents/executor.md showed an empty array and nothing else. An executor that
// followed the published schema produced blockers whose reason the orchestrator
// could not see, so blocked_reason always fell back to the generic summary and
// unblock_condition was always null — while resume.md, status.md and stop.md all
// promise to display both.
describe('blocker shape is one shape', () => {
  it('stores reason and unblock_condition from a structured blocker', async () => {
    await withBlockedTask(async (dir) => {
      const result = await handleExecutorResult({
        result: blockedResult([{ reason: 'API key missing', unblock_condition: 'set STRIPE_KEY in .env' }]),
        basePath: dir,
      });
      assert.ok(!result.error, `${result.code}: ${result.message}`);

      const task = (await read({ basePath: dir })).phases[0].todo.find(t => t.id === '1.1');
      assert.equal(task.blocked_reason, 'API key missing');
      assert.equal(task.unblock_condition, 'set STRIPE_KEY in .env');
    });
  });

  it('still reads a blocker written to the old published schema', async () => {
    // The tool schema told agents to send {description} for several releases, so
    // dropping it on the floor would silently degrade every executor still
    // following the text that shipped.
    await withBlockedTask(async (dir) => {
      const result = await handleExecutorResult({
        result: blockedResult([{ description: 'API key missing' }]),
        basePath: dir,
      });
      assert.ok(!result.error, `${result.code}: ${result.message}`);

      const task = (await read({ basePath: dir })).phases[0].todo.find(t => t.id === '1.1');
      assert.equal(task.blocked_reason, 'API key missing',
        'the blocker text was discarded and blocked_reason fell back to the generic summary');
    });
  });

  it('falls back to the summary only when the blocker carries no text at all', async () => {
    await withBlockedTask(async (dir) => {
      await handleExecutorResult({ result: blockedResult([{}]), basePath: dir });
      const task = (await read({ basePath: dir })).phases[0].todo.find(t => t.id === '1.1');
      assert.equal(task.blocked_reason, 'could not finish');
    });
  });

  it('the tool schema and the executor contract describe the same fields', () => {
    // The drift was only visible by reading three files side by side. This is
    // the cheap check that keeps them together.
    const serverSrc = readFileSync(join(PROJECT_ROOT, 'src', 'server.js'), 'utf8');
    const executorMd = readFileSync(join(PROJECT_ROOT, 'agents', 'executor.md'), 'utf8');

    const schemaLine = serverSrc.split('\n').find(l => l.includes('Executor result:'));
    assert.ok(schemaLine, 'could not find the executor result schema description in server.js');
    assert.match(schemaLine, /blockers: \[\{reason[^\]]*unblock_condition/,
      'the MCP schema must describe blockers as {reason, unblock_condition}');
    assert.ok(!schemaLine.includes('blockers: [{description}]'),
      'the schema still advertises the field the orchestrator does not read');

    assert.match(executorMd, /"unblock_condition"/,
      'agents/executor.md must show the blocker shape, not just an empty array');
    assert.match(executorMd, /"reason"/);
  });
});
