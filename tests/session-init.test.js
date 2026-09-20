import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, readFileSync, symlinkSync } from 'node:fs';
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
      cpSync(LIB_DIR, join(pluginRoot, 'hooks', 'lib'), { recursive: true });
      // Also copy statusline to stable path (install.js always does this)
      cpSync(STATUSLINE, join(claudeDir, 'hooks', 'gsd-statusline.cjs'));
      await writeFile(notifPath, JSON.stringify({
        kind: 'available',
        from: '0.3.0',
        to: '0.3.1',
        action: 'plugin_update',
      }) + '\n');

      const output = execFileSync(process.execPath, [join(pluginRoot, 'hooks', 'gsd-session-init.cjs')], {
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), PLUGIN_AUTO_UPDATE: '1' },
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
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), PLUGIN_AUTO_UPDATE: '1' },
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
      cpSync(LIB_DIR, join(claudeDir, 'hooks', 'lib'), { recursive: true });

      // Write corrupted settings.json
      const settingsPath = join(claudeDir, 'settings.json');
      await writeFile(settingsPath, '{invalid json!!!');

      // Should not throw, but should NOT overwrite corrupted file with empty object
      execFileSync(process.execPath, [join(claudeDir, 'hooks', 'gsd-session-init.cjs')], {
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), PLUGIN_AUTO_UPDATE: '1' },
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
      cpSync(LIB_DIR, join(claudeDir, 'hooks', 'lib'), { recursive: true });

      // No settings.json exists — ENOENT case
      execFileSync(process.execPath, [join(claudeDir, 'hooks', 'gsd-session-init.cjs')], {
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), PLUGIN_AUTO_UPDATE: '1' },
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

describe('session init reads repo-controlled paths without blocking', () => {
  // SessionStart reads .gsd/.session-end and the project CLAUDE.md, both of them
  // paths a checkout controls, both on bare readFileSync inside a try/catch that
  // cannot catch a blocking read. This is worse than the statusline version of
  // the same bug: a hook that never returns stops the session from starting.
  async function withProject(name, fn) {
    const root = await mkdtemp(join(tmpdir(), `gsd-si-${name}-`));
    const home = join(root, 'home');
    const claudeDir = join(home, '.claude');
    const project = join(root, 'project');
    try {
      await mkdir(join(claudeDir, 'hooks'), { recursive: true });
      await mkdir(join(claudeDir, 'gsd', 'runtime'), { recursive: true });
      await mkdir(join(project, '.gsd'), { recursive: true });
      cpSync(SESSION_INIT, join(claudeDir, 'hooks', 'gsd-session-init.cjs'));
      cpSync(STATUSLINE, join(claudeDir, 'hooks', 'gsd-statusline.cjs'));
      cpSync(AUTO_UPDATE, join(claudeDir, 'hooks', 'gsd-auto-update.cjs'));
      cpSync(LIB_DIR, join(claudeDir, 'hooks', 'lib'), { recursive: true });
      await writeFile(join(project, '.gsd', 'state.json'), JSON.stringify({
        schema_version: 'v1', project: 'p', workflow_mode: 'executing_task',
        current_phase: 1, current_task: '1.1', total_phases: 1,
        phases: [{ id: 1, name: 'Core', lifecycle: 'active', todo: [{ id: '1.1', name: 'A', lifecycle: 'pending' }] }],
      }));
      await fn({ root, home, claudeDir, project });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  function runInit({ home, claudeDir, project }) {
    // execFileSync throws ETIMEDOUT on a hang, which is the failure under test.
    return execFileSync(process.execPath, [join(claudeDir, 'hooks', 'gsd-session-init.cjs')], {
      cwd: project,
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeDir, PLUGIN_AUTO_UPDATE: '0' },
      encoding: 'utf8',
      timeout: 6000,
    });
  }

  it('does not hang when .gsd/.session-end is a fifo', async () => {
    await withProject('endfifo', async (ctx) => {
      execFileSync('mkfifo', [join(ctx.project, '.gsd', '.session-end')]);
      runInit(ctx);
    });
  });

  it('does not hang when the project CLAUDE.md is a fifo', async () => {
    await withProject('mdfifo', async (ctx) => {
      execFileSync('mkfifo', [join(ctx.project, 'CLAUDE.md')]);
      runInit(ctx);
    });
  });

  it('never writes over a CLAUDE.md it could not read', async () => {
    // "Could not read" and "is not there" are different answers, and treating
    // them as one destroys the file: the read fails, the caller starts from an
    // empty string, appends its status block, and renames that over the user's
    // notes. Measured before this guard: a mode-000 CLAUDE.md holding 40 bytes of
    // someone's content came back as 178 bytes of status block, exit 0, silent.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root ignores the mode bits
    await withProject('mdunreadable', async (ctx) => {
      const md = join(ctx.project, 'CLAUDE.md');
      const original = '# My project notes\n\nIrreplaceable line.\n';
      await writeFile(md, original);
      chmodSync(md, 0o000);

      runInit(ctx);

      chmodSync(md, 0o644);
      assert.equal(readFileSync(md, 'utf8'), original,
        'the hook replaced a file it could not read with its own generated content');
    });
  });

  it('still reads and writes through a CLAUDE.md that is a symlink', async () => {
    // The guard for the two cases above must not be readMarker: that rejects a
    // symlink outright, and a symlinked CLAUDE.md is supported — a dotfiles or
    // shared-team setup, which atomicWriteThroughLink deliberately writes
    // through. Reading it as absent would be worse than no guard at all: the
    // hook would treat empty as the whole file and write the status block
    // through the link, over the real content. So the read has to follow the
    // link and reject only what it lands on.
    await withProject('mdlink', async (ctx) => {
      // Inside the project root on purpose: atomicWriteThroughLink refuses a link
      // that resolves outside it, which is the arbitrary-file-write guard, so
      // `CLAUDE.md -> docs/CLAUDE.md` is the shape that is actually supported.
      const real = join(ctx.project, 'docs', 'CLAUDE.md');
      await mkdir(join(ctx.project, 'docs'), { recursive: true });
      await writeFile(real, '# Team standards\n\nDo not lose this line.\n');
      symlinkSync(real, join(ctx.project, 'CLAUDE.md'));

      runInit(ctx);

      assert.equal(lstatSync(join(ctx.project, 'CLAUDE.md')).isSymbolicLink(), true,
        'the symlink was replaced with a regular file');
      const after = readFileSync(real, 'utf8');
      assert.match(after, /Do not lose this line\./, 'the original content was clobbered');
      assert.match(after, /GSD-STATUS-BEGIN/, 'the status block was not written through the link');
    });
  });
});