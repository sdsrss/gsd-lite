// tests/corrupt-state.test.js — a state.json that exists but is unusable must
// reach the caller as a structured, actionable error.
//
// Regression: read()/update()/phaseComplete()/resumeWorkflow() migrated whatever
// JSON.parse returned straight into the caller. A file holding `null`, an array,
// a scalar, or a non-array `phases` therefore crashed with a raw TypeError
// ("Cannot read properties of null (reading 'error')",
// "state.phases?.find is not a function") surfaced to the user as
// "Tool execution failed: …". An unparseable file was reported as
// NO_PROJECT_DIR, which sends the user to /gsd:start — which then refuses with
// STATE_EXISTS.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ERROR_CODES, read, update, phaseComplete, patchPlan } from '../src/tools/state/index.js';
import { resumeWorkflow } from '../src/tools/orchestrator/index.js';
import { handleToolCall } from '../src/server.js';

const MALFORMED = {
  'null literal': 'null',
  'JSON array': '[1, 2, 3]',
  'scalar number': '42',
  'quoted string': '"not a state"',
  'object without phases': '{"project":"x"}',
  'phases as a string': '{"project":"x","phases":"nope"}',
  'phases as an object': '{"project":"x","phases":{"1":{}}}',
};

const UNPARSEABLE = {
  'truncated write': '{"project":"x","phases":[{"id":1,',
  'empty file': '',
  'git merge conflict markers': '<<<<<<< HEAD\n{"project":"a"}\n=======\n{"project":"b"}\n>>>>>>> other\n',
};

// Every sandbox this file creates is registered here and removed after the
// test that made it — a mkdtemp per case with no cleanup leaves hundreds of
// directories behind in the system temp dir across a full run.
const sandboxes = [];
async function sandbox(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  sandboxes.push(dir);
  return dir;
}
async function cleanupSandboxes() {
  await Promise.all(sandboxes.splice(0).map(d => rm(d, { recursive: true, force: true })));
}

async function withState(content) {
  const dir = await sandbox('gsd-corrupt-');
  await mkdir(join(dir, '.gsd'), { recursive: true });
  await writeFile(join(dir, '.gsd', 'state.json'), content);
  return dir;
}

describe('corrupt state.json surfaces a structured error, never a raw TypeError', () => {
  afterEach(cleanupSandboxes);

  for (const [label, content] of Object.entries(MALFORMED)) {
    it(`read() rejects ${label} with VALIDATION_FAILED`, async () => {
      const result = await read({ basePath: await withState(content) });
      assert.ok(result, 'read must not return null/undefined');
      assert.equal(result.error, true);
      assert.equal(result.code, ERROR_CODES.VALIDATION_FAILED);
      assert.match(result.message, /corrupt/i);
      assert.match(result.message, /state\.json\.bak|force/, 'message names a recovery path');
    });

    it(`resumeWorkflow() rejects ${label} without throwing`, async () => {
      const result = await resumeWorkflow({ basePath: await withState(content) });
      assert.equal(result.error, true);
      assert.equal(result.code, ERROR_CODES.VALIDATION_FAILED);
      assert.ok(!/is not a function|Cannot read properties/.test(result.message),
        `raw TypeError leaked: ${result.message}`);
    });
  }

  for (const [label, content] of Object.entries(UNPARSEABLE)) {
    it(`read() reports ${label} as corruption, not a missing project`, async () => {
      const result = await read({ basePath: await withState(content) });
      assert.equal(result.error, true);
      assert.equal(result.code, ERROR_CODES.VALIDATION_FAILED,
        'an existing-but-unreadable state.json is not NO_PROJECT_DIR');
      assert.match(result.message, /unreadable/i);
    });
  }

  it('a genuinely absent state.json is still NO_PROJECT_DIR', async () => {
    const dir = await sandbox('gsd-corrupt-');
    await mkdir(join(dir, '.gsd'), { recursive: true });
    const result = await read({ basePath: dir });
    assert.equal(result.code, ERROR_CODES.NO_PROJECT_DIR);
  });

  it('every mutating entry point refuses a corrupt state', async () => {
    const dir = await withState('null');
    for (const [name, call] of [
      ['update', () => update({ updates: { workflow_mode: 'planning' }, basePath: dir })],
      ['phaseComplete', () => phaseComplete({ phase_id: 1, basePath: dir })],
      ['patchPlan', () => patchPlan({ operations: [{ op: 'add_task', phase_id: 1, task: { name: 'x' } }], basePath: dir })],
    ]) {
      const result = await call();
      assert.equal(result.error, true, `${name} must return an error`);
      assert.equal(result.code, ERROR_CODES.VALIDATION_FAILED, `${name} code`);
    }
  });

  it('health reports the corruption instead of looking like a fresh install', async () => {
    const dir = await withState('null');
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const result = await handleToolCall('health', {});
      assert.equal(result.status, 'ok', 'the server itself is still healthy');
      assert.ok(result.state_error, 'health must surface why the state is unusable');
      assert.match(result.state_error, /corrupt/i);
      assert.ok(!/Tool execution failed/.test(JSON.stringify(result)),
        'health must not crash on a corrupt state');
    } finally {
      process.chdir(cwd);
    }
  });
});

// ── Regression: state-read `fields` contract ──
// `fields` is declared as an array of names. A non-array fell through the
// filter branch silently and returned the ENTIRE state — on a large plan that
// is hundreds of KB of JSON returned for a request that asked for one field.
describe('state-read rejects a malformed fields argument', () => {
  afterEach(cleanupSandboxes);

  async function project() {
    const dir = await sandbox('gsd-fields-');
    const { init } = await import('../src/tools/state/index.js');
    await init({ project: 'p', phases: [{ name: 'P1', tasks: [{ name: 'a' }] }], basePath: dir });
    return dir;
  }

  for (const [label, value] of [
    ['a string', 'project'],
    ['an object', { project: true }],
    ['a number', 7],
    ['a boolean', true],
  ]) {
    it(`rejects fields given as ${label}`, async () => {
      const result = await read({ fields: value, basePath: await project() });
      assert.equal(result.error, true, 'must not silently return the whole state');
      assert.equal(result.code, ERROR_CODES.INVALID_INPUT);
      assert.match(result.message, /fields must be an array/);
    });
  }

  it('still supports a valid array, an empty array, and no fields at all', async () => {
    const dir = await project();
    const filtered = await read({ fields: ['project', 'workflow_mode'], basePath: dir });
    assert.deepEqual(Object.keys(filtered).sort(), ['project', 'workflow_mode']);

    const empty = await read({ fields: [], basePath: dir });
    assert.ok(empty.phases, 'an empty array means no filter — full state');

    const all = await read({ basePath: dir });
    assert.ok(all.phases, 'omitting fields returns the full state');

    const nulled = await read({ fields: null, basePath: dir });
    assert.ok(nulled.phases, 'null fields behaves like omitted');
  });
});
