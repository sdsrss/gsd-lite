import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('server tool handling', () => {
  it('returns structured errors for invalid tool input', async () => {
    const { handleToolCall } = await import('../src/server.js');
    const result = await handleToolCall('gsd-state-update', { updates: null, basePath: process.cwd() });
    assert.equal(result.error, true);
    assert.match(result.message, /updates must be a non-null object/);
  });

  it('returns unknown tool errors without throwing', async () => {
    const { handleToolCall } = await import('../src/server.js');
    const result = await handleToolCall('unknown-tool', {});
    assert.equal(result.error, true);
    assert.match(result.message, /Unknown tool/);
  });
});

describe('MCP tool call chain', () => {
  let tempDir;
  let handleToolCall;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-server-'));
    ({ handleToolCall } = await import('../src/server.js'));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('init creates project state', async () => {
    const result = await handleToolCall('gsd-state-init', {
      project: 'smoke-test',
      phases: [{
        name: 'Core',
        tasks: [
          { index: 1, name: 'Task A' },
          { index: 2, name: 'Task B' },
        ],
      }],
      basePath: tempDir,
    });
    assert.equal(result.success, true);
  });

  it('read after init returns full state', async () => {
    const state = await handleToolCall('gsd-state-read', { basePath: tempDir });
    assert.equal(state.project, 'smoke-test');
    assert.equal(state.workflow_mode, 'executing_task');
    assert.equal(state.phases.length, 1);
    assert.equal(state.phases[0].name, 'Core');
    assert.equal(state.phases[0].todo.length, 2);
    assert.equal(state.phases[0].todo[0].lifecycle, 'pending');
    assert.equal(state.phases[0].todo[1].lifecycle, 'pending');
  });

  it('update task A to running', async () => {
    const result = await handleToolCall('gsd-state-update', {
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);
  });

  it('update task A to checkpointed with commit', async () => {
    const result = await handleToolCall('gsd-state-update', {
      updates: {
        phases: [{
          id: 1,
          todo: [{ id: '1.1', lifecycle: 'checkpointed', checkpoint_commit: 'abc123' }],
        }],
      },
      basePath: tempDir,
    });
    assert.equal(result.success, true);
  });

  it('update task A to accepted', async () => {
    const result = await handleToolCall('gsd-state-update', {
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'accepted' }] }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);
  });

  it('walk task B through full lifecycle', async () => {
    const toRunning = await handleToolCall('gsd-state-update', {
      updates: { phases: [{ id: 1, todo: [{ id: '1.2', lifecycle: 'running' }] }] },
      basePath: tempDir,
    });
    assert.equal(toRunning.success, true);

    const toCheckpointed = await handleToolCall('gsd-state-update', {
      updates: {
        phases: [{
          id: 1,
          todo: [{ id: '1.2', lifecycle: 'checkpointed', checkpoint_commit: 'def456' }],
        }],
      },
      basePath: tempDir,
    });
    assert.equal(toCheckpointed.success, true);

    const toAccepted = await handleToolCall('gsd-state-update', {
      updates: { phases: [{ id: 1, todo: [{ id: '1.2', lifecycle: 'accepted' }] }] },
      basePath: tempDir,
    });
    assert.equal(toAccepted.success, true);
  });

  it('transition phase to reviewing before completion', async () => {
    const result = await handleToolCall('gsd-state-update', {
      updates: { phases: [{ id: 1, lifecycle: 'reviewing' }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);
  });

  it('phaseComplete succeeds when all tasks accepted', async () => {
    const result = await handleToolCall('gsd-phase-complete', {
      phase_id: 1,
      basePath: tempDir,
    });
    assert.equal(result.success, true);
  });

  it('read final state shows completed phase', async () => {
    const state = await handleToolCall('gsd-state-read', { basePath: tempDir });
    assert.equal(state.phases[0].lifecycle, 'accepted');
    assert.equal(state.phases[0].todo[0].lifecycle, 'accepted');
    assert.equal(state.phases[0].todo[1].lifecycle, 'accepted');
    assert.equal(state.phases[0].todo[0].checkpoint_commit, 'abc123');
    assert.equal(state.phases[0].todo[1].checkpoint_commit, 'def456');
    assert.equal(state.phases[0].phase_handoff.required_reviews_passed, true);
    assert.equal(state.phases[0].phase_handoff.tests_passed, true);
  });
});

describe('MCP tool error handling', () => {
  let tempDir;
  let handleToolCall;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-server-err-'));
    ({ handleToolCall } = await import('../src/server.js'));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('init rejects missing project', async () => {
    const result = await handleToolCall('gsd-state-init', {
      phases: [{ name: 'P1', tasks: [] }],
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /project/);
  });

  it('read from nonexistent basePath returns error', async () => {
    // Use /tmp directly to avoid ancestor .gsd discovery (tmpdir() may be under $HOME)
    const fakePath = '/tmp/nonexistent-gsd-xyz-' + Date.now();
    const result = await handleToolCall('gsd-state-read', { basePath: fakePath });
    assert.equal(result.error, true);
    assert.match(result.message, /No .gsd directory/);
  });

  it('update rejects non-canonical fields', async () => {
    // First init a valid project in this temp dir
    await handleToolCall('gsd-state-init', {
      project: 'err-test',
      phases: [{ name: 'P1', tasks: [{ index: 1, name: 'T1' }] }],
      basePath: tempDir,
    });

    const result = await handleToolCall('gsd-state-update', {
      updates: { foo: 'bar' },
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /Non-canonical/);
  });

  it('phaseComplete fails when tasks are not accepted', async () => {
    // Phase has tasks still in pending — gate should block
    const result = await handleToolCall('gsd-phase-complete', {
      phase_id: 1,
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /not met|not accepted|transition/i);
  });
});