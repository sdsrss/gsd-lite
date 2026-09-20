import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
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
  await mkdir(join(pluginRoot, 'hooks'), { recursive: true });
  // Copy hooks. The whole lib/ directory goes across, the way install.js copies
  // it — picking individual files here meant every new shared helper broke this
  // suite with a MODULE_NOT_FOUND that says nothing about the real dependency.
  const { cpSync } = await import('node:fs');
  cpSync(join(HOOKS_DIR, 'gsd-session-stop.cjs'), join(pluginRoot, 'hooks', 'gsd-session-stop.cjs'));
  cpSync(join(HOOKS_DIR, 'lib'), join(pluginRoot, 'hooks', 'lib'), { recursive: true });
  return pluginRoot;
}

/**
 * Run the stop hook, but hold it inside its `git rev-parse HEAD` call until the
 * caller says go.
 *
 * The marker's temp file used to be named `.session-end.<pid>.tmp` — derivable
 * from the pid alone — so the exploit is to plant a symlink there before the
 * hook writes. Reproducing that needs the pid, which only exists once the child
 * is spawned, and needs the write not to have happened yet. A `git` shim that
 * blocks on a sentinel file gives both: the hook is provably parked in execSync
 * when `onBlocked` runs, so the test never races the write.
 */
async function runStopHookPaused(cwd, pluginRoot, root, onBlocked) {
  const shimDir = join(root, 'shim');
  const startedPath = join(root, 'git-started');
  const sentinelPath = join(root, 'git-go');
  await mkdir(shimDir, { recursive: true });
  await writeFile(
    join(shimDir, 'git'),
    '#!/bin/sh\n'
    + `touch "${startedPath}"\n`
    + `while [ ! -e "${sentinelPath}" ]; do sleep 0.01; done\n`
    + 'echo 0000000000000000000000000000000000000000\n',
    { mode: 0o755 },
  );

  const child = spawn(process.execPath, [join(pluginRoot, 'hooks', 'gsd-session-stop.cjs')], {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GSD_DEBUG: '1', PATH: `${shimDir}:${process.env.PATH}` },
  });

  const deadline = Date.now() + 5000;
  while (!existsSync(startedPath) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5));
  }
  assert.equal(existsSync(startedPath), true, 'git shim never ran — hook did not reach the marker write');

  await onBlocked(child.pid);

  await writeFile(sentinelPath, '');
  await new Promise(resolve => child.on('exit', resolve));
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

// `.gsd/` is part of the repository, so opening a cloned project hands its
// author control of every path the Stop hook writes to. 0.9.0 closed this for
// the SessionStart hook; these pin it closed for Stop too.
describe('session stop hook — hostile .gsd/ contents', () => {
  it('does not write through a symlink planted at the predictable temp path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-stop-sym-'));
    try {
      const pluginRoot = await setupPluginRoot(root);
      const { gsdDir, projectDir } = await createGsdProject(root);

      const secretPath = join(root, 'secret.txt');
      await writeFile(secretPath, 'untouched');

      await runStopHookPaused(projectDir, pluginRoot, root, async (pid) => {
        // Exactly the name the old code derived: marker path + '.' + pid + '.tmp'.
        await symlink(secretPath, join(gsdDir, `.session-end.${pid}.tmp`));
      });

      assert.equal(
        readFileSync(secretPath, 'utf8'),
        'untouched',
        'hook followed a planted symlink and wrote outside .gsd/',
      );
      // The marker still lands — the fix must not cost the feature.
      const marker = JSON.parse(readFileSync(join(gsdDir, '.session-end'), 'utf8'));
      assert.equal(marker.workflow_mode_was, 'executing_task');
      assert.equal(lstatSync(join(gsdDir, '.session-end')).isSymbolicLink(), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('evicts a symlink planted at .session-end instead of writing through it', async () => {
    // Refusing here was the earlier behaviour and it was wrong in the direction
    // that matters: the rename never followed the link anyway, so refusing added
    // no safety and handed a hostile checkout a way to disable the crash marker
    // permanently by planting one.
    const root = await mkdtemp(join(tmpdir(), 'gsd-stop-sym-'));
    try {
      const pluginRoot = await setupPluginRoot(root);
      const { gsdDir, projectDir } = await createGsdProject(root);

      const secretPath = join(root, 'secret.txt');
      await writeFile(secretPath, 'untouched');
      await symlink(secretPath, join(gsdDir, '.session-end'));

      runStopHook(projectDir, pluginRoot);

      assert.equal(readFileSync(secretPath, 'utf8'), 'untouched', 'wrote through the planted link');
      assert.equal(lstatSync(join(gsdDir, '.session-end')).isSymbolicLink(), false,
        'the link survived, so the marker is pinned for good');
      const marker = JSON.parse(readFileSync(join(gsdDir, '.session-end'), 'utf8'));
      assert.equal(marker.workflow_mode_was, 'executing_task');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
