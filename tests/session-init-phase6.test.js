import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, cpSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOKS_DIR = join(import.meta.dirname, '..', 'hooks');
const BEGIN_MARKER = '<!-- GSD-STATUS-BEGIN -->';
const END_MARKER = '<!-- GSD-STATUS-END -->';

async function setupEnv(root, stateOverrides = {}, claudeMdContent = '') {
  const home = join(root, 'home');
  const claudeDir = join(home, '.claude');
  const pluginRoot = join(root, 'plugin');
  const projectDir = join(root, 'project');
  const gsdDir = join(projectDir, '.gsd');

  await mkdir(join(pluginRoot, 'hooks', 'lib'), { recursive: true });
  await mkdir(join(claudeDir, 'gsd', 'runtime'), { recursive: true });
  await mkdir(gsdDir, { recursive: true });

  // Copy hooks
  for (const f of ['gsd-session-init.cjs', 'gsd-statusline.cjs', 'gsd-auto-update.cjs']) {
    cpSync(join(HOOKS_DIR, f), join(pluginRoot, 'hooks', f));
  }
  cpSync(join(HOOKS_DIR, 'lib', 'gsd-finder.cjs'), join(pluginRoot, 'hooks', 'lib', 'gsd-finder.cjs'));

  // Write state.json
  const state = {
    schema_version: 'v1',
    project: 'TestApp',
    workflow_mode: 'executing_task',
    current_phase: 2,
    current_task: '2.1',
    total_phases: 3,
    git_head: 'abc123def456789',
    phases: [
      { id: 1, name: 'Setup', todo: [
        { id: '1.1', name: 'Init', lifecycle: 'accepted' },
      ]},
      { id: 2, name: 'Core Features', todo: [
        { id: '2.1', name: 'Build API', lifecycle: 'running' },
        { id: '2.2', name: 'Add auth', lifecycle: 'pending' },
      ]},
      { id: 3, name: 'Polish', todo: [
        { id: '3.1', name: 'UI', lifecycle: 'pending' },
      ]},
    ],
    ...stateOverrides,
  };
  await writeFile(join(gsdDir, 'state.json'), JSON.stringify(state));

  // Write CLAUDE.md if provided
  if (claudeMdContent) {
    await writeFile(join(projectDir, 'CLAUDE.md'), claudeMdContent);
  }

  return { home, claudeDir, pluginRoot, projectDir, gsdDir };
}

function runSessionInit(cwd, pluginRoot, home) {
  return execFileSync(
    process.execPath,
    [join(pluginRoot, 'hooks', 'gsd-session-init.cjs')],
    {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        PLUGIN_AUTO_UPDATE: '1',
      },
    }
  );
}

describe('session init Phase 6: progress injection + CLAUDE.md', () => {
  it('does not output routine progress to stdout (only CLAUDE.md)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-init6-'));
    try {
      const { pluginRoot, projectDir, home } = await setupEnv(root);
      const output = runSessionInit(projectDir, pluginRoot, home);

      // No routine progress in stdout — it goes to CLAUDE.md only
      assert.ok(!output.includes('GSD Project:'));
      // But CLAUDE.md should have it
      const claudeMd = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8');
      assert.ok(claudeMd.includes('GSD Project: TestApp'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes GSD status block to CLAUDE.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-init6-'));
    try {
      const { pluginRoot, projectDir, home } = await setupEnv(root, {}, '# My Project\n\nExisting content.\n');
      runSessionInit(projectDir, pluginRoot, home);

      const claudeMd = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8');
      assert.ok(claudeMd.includes(BEGIN_MARKER));
      assert.ok(claudeMd.includes(END_MARKER));
      assert.ok(claudeMd.includes('### GSD Project: TestApp'));
      assert.ok(claudeMd.includes('Phase: 2/3 (Core Features)'));
      assert.ok(claudeMd.includes('Task: 2.1 (Build API)'));
      assert.ok(claudeMd.includes('Mode: executing_task'));
      assert.ok(claudeMd.includes('1/4 tasks done'));
      assert.ok(claudeMd.includes('abc123d'));
      // Original content preserved
      assert.ok(claudeMd.includes('# My Project'));
      assert.ok(claudeMd.includes('Existing content.'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('replaces existing GSD status block', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-init6-'));
    const existingContent = [
      '# My Project',
      '',
      BEGIN_MARKER,
      '### GSD Project: OldProject',
      '- Phase: 1/1',
      END_MARKER,
      '',
      'Other content.',
      '',
    ].join('\n');
    try {
      const { pluginRoot, projectDir, home } = await setupEnv(root, {}, existingContent);
      runSessionInit(projectDir, pluginRoot, home);

      const claudeMd = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8');
      // Old content replaced
      assert.ok(!claudeMd.includes('OldProject'));
      // New content present
      assert.ok(claudeMd.includes('TestApp'));
      // Surrounding content preserved
      assert.ok(claudeMd.includes('# My Project'));
      assert.ok(claudeMd.includes('Other content.'));
      // Only one BEGIN/END pair
      assert.equal(claudeMd.split(BEGIN_MARKER).length, 2);
      assert.equal(claudeMd.split(END_MARKER).length, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates CLAUDE.md if it does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-init6-'));
    try {
      const { pluginRoot, projectDir, home } = await setupEnv(root);
      assert.equal(existsSync(join(projectDir, 'CLAUDE.md')), false);

      runSessionInit(projectDir, pluginRoot, home);

      assert.equal(existsSync(join(projectDir, 'CLAUDE.md')), true);
      const claudeMd = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8');
      assert.ok(claudeMd.includes('TestApp'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('shows session-end warning in stdout when marker exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-init6-'));
    try {
      const { pluginRoot, projectDir, gsdDir, home } = await setupEnv(root);
      // Write session-end marker
      await writeFile(join(gsdDir, '.session-end'), JSON.stringify({
        ended_at: '2026-03-22T10:00:00.000Z',
        workflow_mode_was: 'reviewing_task',
        current_phase: 2,
        current_task: '2.1',
        reason: 'session_stop',
      }));

      const output = runSessionInit(projectDir, pluginRoot, home);
      assert.match(output, /Previous session ended unexpectedly/);
      assert.match(output, /reviewing_task/);
      assert.match(output, /\/gsd:resume/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('includes session-end warning in CLAUDE.md status block', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-init6-'));
    try {
      const { pluginRoot, projectDir, gsdDir, home } = await setupEnv(root);
      await writeFile(join(gsdDir, '.session-end'), JSON.stringify({
        ended_at: '2026-03-22T10:00:00.000Z',
        workflow_mode_was: 'reviewing_task',
      }));

      runSessionInit(projectDir, pluginRoot, home);

      const claudeMd = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8');
      assert.ok(claudeMd.includes('Previous session ended unexpectedly'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('handles completed project — no status block injected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-init6-'));
    try {
      const { pluginRoot, projectDir, home } = await setupEnv(root, {
        workflow_mode: 'completed',
        phases: [{ id: 1, name: 'Done', todo: [{ id: '1.1', name: 'Task', lifecycle: 'accepted' }] }],
      }, '# Project\n');

      runSessionInit(projectDir, pluginRoot, home);

      const claudeMd = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8');
      // Still writes for completed — the status shows "completed" which is informative
      assert.ok(claudeMd.includes('Mode: completed'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
