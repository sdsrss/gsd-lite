import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SESSION_INIT = join(import.meta.dirname, '..', 'hooks', 'gsd-session-init.cjs');
const STATUSLINE = join(import.meta.dirname, '..', 'hooks', 'gsd-statusline.cjs');
const AUTO_UPDATE = join(import.meta.dirname, '..', 'hooks', 'gsd-auto-update.cjs');
const LIB_DIR = join(import.meta.dirname, '..', 'hooks', 'lib');

describe('session init update notifications', () => {
  it('shows plugin update notification and clears it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-session-init-'));
    const home = join(root, 'home');
    const claudeDir = join(home, '.claude');
    const pluginRoot = join(root, 'plugin-root');
    const notifPath = join(claudeDir, 'gsd', 'runtime', 'update-notification.json');

    try {
      await mkdir(join(pluginRoot, 'hooks'), { recursive: true });
      await mkdir(join(claudeDir, 'gsd', 'runtime'), { recursive: true });
      await mkdir(join(claudeDir, 'hooks'), { recursive: true });
      cpSync(SESSION_INIT, join(pluginRoot, 'hooks', 'gsd-session-init.cjs'));
      cpSync(STATUSLINE, join(pluginRoot, 'hooks', 'gsd-statusline.cjs'));
      cpSync(AUTO_UPDATE, join(pluginRoot, 'hooks', 'gsd-auto-update.cjs'));
      // Also copy statusline to stable path (install.js always does this)
      cpSync(STATUSLINE, join(claudeDir, 'hooks', 'gsd-statusline.cjs'));
      await writeFile(notifPath, JSON.stringify({
        kind: 'available',
        from: '0.3.0',
        to: '0.3.1',
        action: 'plugin_update',
      }) + '\n');

      const output = execFileSync(process.execPath, [join(pluginRoot, 'hooks', 'gsd-session-init.cjs')], {
        env: { ...process.env, HOME: home, PLUGIN_AUTO_UPDATE: '1' },
        encoding: 'utf8',
        timeout: 5000,
      });

      assert.match(output, /Run \/plugin update gsd/);
      assert.equal(existsSync(notifPath), false);

      const settings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'));
      assert.deepEqual(settings.statusLine, {
        type: 'command',
        command: `node ${JSON.stringify(join(claudeDir, 'hooks', 'gsd-statusline.cjs'))}`,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('session init CLAUDE.md injection sanitization (C2)', () => {
  it('strips HTML comment markers from project/phase/task names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-session-sanitize-'));
    const home = join(root, 'home');
    const claudeDir = join(home, '.claude');
    const projectDir = join(root, 'project');
    const gsdDir = join(projectDir, '.gsd');

    try {
      await mkdir(join(claudeDir, 'hooks', 'lib'), { recursive: true });
      await mkdir(join(claudeDir, 'gsd', 'runtime'), { recursive: true });
      await mkdir(gsdDir, { recursive: true });

      // Copy session-init and dependencies
      cpSync(SESSION_INIT, join(claudeDir, 'hooks', 'gsd-session-init.cjs'));
      cpSync(STATUSLINE, join(claudeDir, 'hooks', 'gsd-statusline.cjs'));
      cpSync(AUTO_UPDATE, join(claudeDir, 'hooks', 'gsd-auto-update.cjs'));
      cpSync(LIB_DIR, join(claudeDir, 'hooks', 'lib'), { recursive: true });

      // Create state.json with injection attempts in names
      const state = {
        project: 'evil<!-- injection -->project',
        workflow_mode: 'orchestrator',
        current_phase: 'P1',
        total_phases: 2,
        current_task: 'T1',
        git_head: 'abc1234',
        phases: [{
          id: 'P1',
          name: 'phase<!--with-->comment',
          todo: [{
            id: 'T1',
            name: 'task<!--injected-->name',
            lifecycle: 'running',
          }],
        }],
      };
      await writeFile(join(gsdDir, 'state.json'), JSON.stringify(state));

      // Create a minimal CLAUDE.md
      await writeFile(join(projectDir, 'CLAUDE.md'), '# Project\n');

      execFileSync(process.execPath, [join(claudeDir, 'hooks', 'gsd-session-init.cjs')], {
        cwd: projectDir,
        env: { ...process.env, HOME: home, PLUGIN_AUTO_UPDATE: '1' },
        encoding: 'utf8',
        timeout: 5000,
      });

      // Read the CLAUDE.md and check that injected HTML comments are stripped
      // (legitimate GSD-STATUS-BEGIN/END markers use <!-- --> but those are controlled)
      const content = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8');
      // Strip the legitimate GSD markers before checking for injected comments
      const withoutMarkers = content
        .replace(/<!-- GSD-STATUS-BEGIN -->/g, '')
        .replace(/<!-- GSD-STATUS-END -->/g, '');
      assert.ok(!withoutMarkers.includes('<!--'), 'CLAUDE.md should not contain injected <!-- after sanitization');
      assert.ok(!withoutMarkers.includes('-->'), 'CLAUDE.md should not contain injected --> after sanitization');
      assert.ok(content.includes('evil injection project'), 'Project name should be sanitized but readable');
      assert.ok(content.includes('phasewithcomment'), 'Phase name should be sanitized but readable');
      assert.ok(content.includes('taskinjectedname'), 'Task name should be sanitized but readable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('session init settings.json parse error handling (H5)', () => {
  it('skips statusLine registration on corrupted settings.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-session-parse-'));
    const home = join(root, 'home');
    const claudeDir = join(home, '.claude');

    try {
      await mkdir(join(claudeDir, 'hooks'), { recursive: true });
      await mkdir(join(claudeDir, 'gsd', 'runtime'), { recursive: true });

      cpSync(SESSION_INIT, join(claudeDir, 'hooks', 'gsd-session-init.cjs'));
      cpSync(STATUSLINE, join(claudeDir, 'hooks', 'gsd-statusline.cjs'));
      cpSync(AUTO_UPDATE, join(claudeDir, 'hooks', 'gsd-auto-update.cjs'));

      // Write corrupted settings.json
      const settingsPath = join(claudeDir, 'settings.json');
      await writeFile(settingsPath, '{invalid json!!!');

      // Should not throw, but should NOT overwrite corrupted file with empty object
      execFileSync(process.execPath, [join(claudeDir, 'hooks', 'gsd-session-init.cjs')], {
        env: { ...process.env, HOME: home, PLUGIN_AUTO_UPDATE: '1' },
        encoding: 'utf8',
        timeout: 5000,
      });

      // The corrupted content should be preserved (not overwritten)
      const afterContent = readFileSync(settingsPath, 'utf8');
      assert.equal(afterContent, '{invalid json!!!',
        'Corrupted settings.json should not be overwritten');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates fresh settings.json when ENOENT', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-session-enoent-'));
    const home = join(root, 'home');
    const claudeDir = join(home, '.claude');

    try {
      await mkdir(join(claudeDir, 'hooks'), { recursive: true });
      await mkdir(join(claudeDir, 'gsd', 'runtime'), { recursive: true });

      cpSync(SESSION_INIT, join(claudeDir, 'hooks', 'gsd-session-init.cjs'));
      cpSync(STATUSLINE, join(claudeDir, 'hooks', 'gsd-statusline.cjs'));
      cpSync(AUTO_UPDATE, join(claudeDir, 'hooks', 'gsd-auto-update.cjs'));

      // No settings.json exists — ENOENT case
      execFileSync(process.execPath, [join(claudeDir, 'hooks', 'gsd-session-init.cjs')], {
        env: { ...process.env, HOME: home, PLUGIN_AUTO_UPDATE: '1' },
        encoding: 'utf8',
        timeout: 5000,
      });

      // settings.json should be created with statusLine registered
      const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
      assert.ok(settings.statusLine, 'StatusLine should be registered when settings.json did not exist');
      assert.ok(settings.statusLine.command.includes('gsd-statusline'),
        'StatusLine should point to gsd-statusline');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});