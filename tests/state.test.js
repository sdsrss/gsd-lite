import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat as fsStat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('state tools', () => {
  let tempDir;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-state-'));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('init', () => {
    it('creates .gsd directory with state.json', async () => {
      const { init } = await import('../src/tools/state.js');
      const result = await init({
        project: 'test-project',
        phases: [{ name: 'setup', tasks: [{ index: 1, name: 'init repo' }] }],
        basePath: tempDir,
      });
      assert.equal(result.success, true);

      const { readJson } = await import('../src/utils.js');
      const readResult = await readJson(join(tempDir, '.gsd', 'state.json'));
      assert.equal(readResult.ok, true);
      const state = readResult.data;
      assert.equal(state.project, 'test-project');
      assert.equal(state.workflow_mode, 'executing_task');
      assert.equal(state.phases.length, 1);
      assert.equal(state.phases[0].lifecycle, 'active');
    });

    it('creates phases directory', async () => {
      const s = await fsStat(join(tempDir, '.gsd', 'phases'));
      assert.ok(s.isDirectory());
    });

    it('creates plan.md', async () => {
      const s = await fsStat(join(tempDir, '.gsd', 'plan.md'));
      assert.ok(s.isFile());
    });
  });

  describe('read', () => {
    it('returns full state', async () => {
      const { read } = await import('../src/tools/state.js');
      const result = await read({ basePath: tempDir });
      assert.equal(result.project, 'test-project');
      assert.equal(result.workflow_mode, 'executing_task');
    });

    it('returns filtered fields', async () => {
      const { read } = await import('../src/tools/state.js');
      const result = await read({ fields: ['project', 'workflow_mode'], basePath: tempDir });
      assert.equal(result.project, 'test-project');
      assert.equal(result.workflow_mode, 'executing_task');
      assert.equal(result.phases, undefined);
    });

    it('returns error when state not found', async () => {
      const { read } = await import('../src/tools/state.js');
      const result = await read({ basePath: '/tmp/nonexistent-gsd-12345' });
      assert.equal(result.error, true);
    });
  });

  describe('update', () => {
    it('updates canonical fields', async () => {
      const { update, read } = await import('../src/tools/state.js');
      const result = await update({
        updates: { workflow_mode: 'executing_task', current_task: '1.1' },
        basePath: tempDir,
      });
      assert.equal(result.success, true);
      const state = await read({ basePath: tempDir });
      assert.equal(state.workflow_mode, 'executing_task');
      assert.equal(state.current_task, '1.1');
    });

    it('rejects non-canonical fields', async () => {
      const { update } = await import('../src/tools/state.js');
      const result = await update({
        updates: { stopped_at: 'some value' },
        basePath: tempDir,
      });
      assert.equal(result.error, true);
      assert.ok(result.message.includes('stopped_at'));
    });

    it('validates state after update', async () => {
      const { update } = await import('../src/tools/state.js');
      const result = await update({
        updates: { workflow_mode: 'invalid_mode' },
        basePath: tempDir,
      });
      assert.equal(result.error, true);
    });

    it('rejects null updates payload', async () => {
      const { update } = await import('../src/tools/state.js');
      const result = await update({ updates: null, basePath: tempDir });
      assert.equal(result.error, true);
      assert.match(result.message, /updates must be a non-null object/);
    });

    it('rejects malformed phases that fail schema validation', async () => {
      const { update } = await import('../src/tools/state.js');
      const result = await update({
        updates: {
          phases: [{ id: 2, name: 'broken', lifecycle: 'pending' }],
          total_phases: 2,
        },
        basePath: tempDir,
      });
      assert.equal(result.error, true);
      assert.match(result.message, /todo must be an array/);
    });
  });

  describe('update lifecycle validation', () => {
    it('rejects illegal task lifecycle transition (pending → accepted)', async () => {
      const { update, read } = await import('../src/tools/state.js');
      const state = await read({ basePath: tempDir });
      const phases = JSON.parse(JSON.stringify(state.phases));
      phases[0].todo[0].lifecycle = 'accepted'; // skip running+checkpointed
      const result = await update({ updates: { phases }, basePath: tempDir });
      assert.equal(result.error, true);
      assert.ok(result.message.includes('pending'));
    });

    it('rejects illegal phase lifecycle transition (pending → reviewing)', async () => {
      const { update, read } = await import('../src/tools/state.js');
      const state = await read({ basePath: tempDir });
      const phases = JSON.parse(JSON.stringify(state.phases));
      phases[0].lifecycle = 'accepted'; // skip reviewing
      const result = await update({ updates: { phases }, basePath: tempDir });
      assert.equal(result.error, true);
      assert.ok(result.message.includes('active'));
    });

    it('allows legal task lifecycle transition (pending → running)', async () => {
      const { update, read } = await import('../src/tools/state.js');
      const state = await read({ basePath: tempDir });
      const phases = JSON.parse(JSON.stringify(state.phases));
      phases[0].todo[0].lifecycle = 'running';
      const result = await update({ updates: { phases }, basePath: tempDir });
      assert.equal(result.success, true);
    });
  });

  describe('phaseComplete', () => {
    it('rejects when handoff gate not met', async () => {
      const { phaseComplete } = await import('../src/tools/state.js');
      const result = await phaseComplete({ phase_id: 1, basePath: tempDir });
      assert.equal(result.error, true);
    });
  });
});
