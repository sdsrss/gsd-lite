import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOKS_DIR = join(import.meta.dirname, '..', 'hooks');

/**
 * Copy the stop hook and its lib dependency into a temp plugin root,
 * then run it from a given cwd.
 */
function runStopHook(cwd, pluginRoot) {
  return execFileSync(process.execPath, [join(pluginRoot, 'hooks', 'gsd-session-stop.cjs')], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      GSD_DEBUG: '1',
      // Prevent git commands from using the real user's config
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
  });
}

async function setupPluginRoot(root) {
  const pluginRoot = join(root, 'plugin');
  await mkdir(join(pluginRoot, 'hooks', 'lib'), { recursive: true });
  // Copy hooks
  const { cpSync } = await import('node:fs');
  cpSync(join(HOOKS_DIR, 'gsd-session-stop.cjs'), join(pluginRoot, 'hooks', 'gsd-session-stop.cjs'));
  cpSync(join(HOOKS_DIR, 'lib', 'gsd-finder.cjs'), join(pluginRoot, 'hooks', 'lib', 'gsd-finder.cjs'));
  return pluginRoot;
}

async function createGsdProject(root, stateOverrides = {}) {
  const gsdDir = join(root, 'project', '.gsd');
  const projectDir = join(root, 'project');
  await mkdir(gsdDir, { recursive: true });
  const state = {
    schema_version: 'v1',
    project: 'TestProject',
    workflow_mode: 'executing_task',
    current_phase: 1,
    current_task: '1.1',
    total_phases: 2,
    git_head: 'abc123',
    phases: [],
    ...stateOverrides,
  };
  await writeFile(join(gsdDir, 'state.json'), JSON.stringify(state));
  return { gsdDir, projectDir };
}

describe('session stop hook', () => {
  it('writes .session-end marker for active project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-stop-'));
    try {
      const pluginRoot = await setupPluginRoot(root);
      const { gsdDir, projectDir } = await createGsdProject(root);

      runStopHook(projectDir, pluginRoot);

      const markerPath = join(gsdDir, '.session-end');
      assert.equal(existsSync(markerPath), true);

      const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
      assert.equal(marker.workflow_mode_was, 'executing_task');
      assert.equal(marker.current_phase, 1);
      assert.equal(marker.current_task, '1.1');
      assert.equal(marker.reason, 'session_stop');
      assert.ok(marker.ended_at);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips completed projects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-stop-'));
    try {
      const pluginRoot = await setupPluginRoot(root);
      const { gsdDir, projectDir } = await createGsdProject(root, {
        workflow_mode: 'completed',
      });

      runStopHook(projectDir, pluginRoot);

      assert.equal(existsSync(join(gsdDir, '.session-end')), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips paused_by_user projects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-stop-'));
    try {
      const pluginRoot = await setupPluginRoot(root);
      const { gsdDir, projectDir } = await createGsdProject(root, {
        workflow_mode: 'paused_by_user',
      });

      runStopHook(projectDir, pluginRoot);

      assert.equal(existsSync(join(gsdDir, '.session-end')), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips failed projects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-stop-'));
    try {
      const pluginRoot = await setupPluginRoot(root);
      const { gsdDir, projectDir } = await createGsdProject(root, {
        workflow_mode: 'failed',
      });

      runStopHook(projectDir, pluginRoot);

      assert.equal(existsSync(join(gsdDir, '.session-end')), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does nothing when no .gsd directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-stop-'));
    try {
      const pluginRoot = await setupPluginRoot(root);
      const emptyDir = join(root, 'empty');
      await mkdir(emptyDir, { recursive: true });

      // Should not throw
      runStopHook(emptyDir, pluginRoot);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes marker for reviewing_task mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-stop-'));
    try {
      const pluginRoot = await setupPluginRoot(root);
      const { gsdDir, projectDir } = await createGsdProject(root, {
        workflow_mode: 'reviewing_task',
        current_task: '2.3',
      });

      runStopHook(projectDir, pluginRoot);

      const marker = JSON.parse(readFileSync(join(gsdDir, '.session-end'), 'utf8'));
      assert.equal(marker.workflow_mode_was, 'reviewing_task');
      assert.equal(marker.current_task, '2.3');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes marker for awaiting_user mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-stop-'));
    try {
      const pluginRoot = await setupPluginRoot(root);
      const { gsdDir, projectDir } = await createGsdProject(root, {
        workflow_mode: 'awaiting_user',
      });

      runStopHook(projectDir, pluginRoot);

      const marker = JSON.parse(readFileSync(join(gsdDir, '.session-end'), 'utf8'));
      assert.equal(marker.workflow_mode_was, 'awaiting_user');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
