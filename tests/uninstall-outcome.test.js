import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `gsd uninstall` deletes the hook files first and deregisters them second, and
 * every registry edit used to sit in a bare `catch {}`. So a settings.json it
 * could not parse produced: files gone, registrations still there pointing at
 * paths that no longer exist, `✓ GSD-Lite uninstalled.`, exit 0. Every session
 * after that runs a hook command that is not on disk, and the one line the user
 * read said it was done.
 *
 * The first attempt at this was reverted (7b39ae0) because the new path still
 * exited 0, and because with nothing removed it claimed files had been deleted.
 * So these tests pin the *pair* — exit code and closing line — across the whole
 * failure class rather than the one case that was reported:
 *
 *   outcome            | exit | closing line
 *   -------------------|------|---------------------------------
 *   removed everything |  0   | ✓ GSD-Lite uninstalled.
 *   nothing installed  |  0   | Nothing to remove …
 *   any step failed    | ≠0   | only partly uninstalled + what failed
 *
 * A fourth row is impossible by construction: both are read off one summary.
 */
describe('gsd uninstall: exit code and closing line agree with what happened', () => {
  /** A ~/.claude that looks installed, without paying for a real install.js run. */
  function makeInstalled(claudeDir, { hookLib = true } = {}) {
    mkdirSync(join(claudeDir, 'hooks', 'lib'), { recursive: true });
    mkdirSync(join(claudeDir, 'gsd'), { recursive: true });
    mkdirSync(join(claudeDir, 'plugins'), { recursive: true });

    for (const name of ['gsd-session-init.cjs', 'gsd-context-monitor.cjs', 'gsd-statusline.cjs', 'gsd-session-stop.cjs']) {
      writeFileSync(join(claudeDir, 'hooks', name), '// installed\n');
    }
    if (hookLib) {
      for (const lib of ['hook-registry.cjs', 'atomic-write.cjs', 'gsd-finder.cjs']) {
        cpSync(join(PROJECT_ROOT, 'hooks', 'lib', lib), join(claudeDir, 'hooks', 'lib', lib));
      }
    }
    writeFileSync(join(claudeDir, 'gsd', 'package.json'), '{"name":"gsd-lite"}\n');
    writeFileSync(
      join(claudeDir, 'plugins', 'known_marketplaces.json'),
      JSON.stringify({ gsd: { source: 'sdsrss/gsd-lite' } }, null, 2),
    );
    writeFileSync(
      join(claudeDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'gsd@gsd': { version: '0.11.1' } } }, null, 2),
    );
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        mcpServers: { gsd: { command: 'node', args: [join(claudeDir, 'gsd', 'launcher.js')] } },
        enabledPlugins: { 'gsd@gsd': true },
        hooks: {
          SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${join(claudeDir, 'hooks', 'gsd-session-init.cjs')}"` }] }],
          Stop: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${join(claudeDir, 'hooks', 'gsd-session-stop.cjs')}"` }] }],
        },
      }, null, 2),
    );
  }

  /**
   * Run the uninstaller the way the orphan cleanup does when `scriptDir` is
   * given: a copy at ~/.claude/gsd/uninstall.js, with only whatever hooks/lib
   * the install left behind. Otherwise run it from the repo root.
   */
  function runUninstall(home, { scriptDir } = {}) {
    const script = scriptDir ? join(scriptDir, 'uninstall.js') : join(PROJECT_ROOT, 'uninstall.js');
    if (scriptDir) cpSync(join(PROJECT_ROOT, 'uninstall.js'), script);
    try {
      const stdout = execFileSync('node', [script], {
        cwd: scriptDir || PROJECT_ROOT,
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') },
        encoding: 'utf-8',
      });
      return { status: 0, output: stdout };
    } catch (err) {
      return { status: err.status ?? 1, output: `${err.stdout || ''}${err.stderr || ''}` };
    }
  }

  async function withHome(prefix, fn) {
    const home = await mkdtemp(join(tmpdir(), prefix));
    const claudeDir = join(home, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    try {
      return await fn(home, claudeDir);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  it('a clean uninstall: exit 0 and the success line', async () => {
    await withHome('gsd-uninst-clean-', async (home, claudeDir) => {
      makeInstalled(claudeDir);
      const { status, output } = runUninstall(home);
      assert.equal(status, 0, `clean uninstall should exit 0:\n${output}`);
      assert.match(output, /✓ GSD-Lite uninstalled/);
      assert.doesNotMatch(output, /partly uninstalled/);
      assert.ok(!existsSync(join(claudeDir, 'hooks', 'gsd-session-init.cjs')), 'hook files should be gone');
    });
  });

  it('nothing installed: exit 0 and no claim that anything was removed', async () => {
    await withHome('gsd-uninst-absent-', async (home) => {
      const { status, output } = runUninstall(home);
      assert.equal(status, 0, 'a no-op is not a failure');
      assert.doesNotMatch(output, /✓ GSD-Lite uninstalled/, 'nothing was removed, so nothing was uninstalled');
      assert.match(output, /Nothing to remove/i);
    });
  });

  // The class: every registry file the uninstaller edits, plus the helper it
  // needs to edit settings.json hooks. Each leaves a registration behind while
  // the files it points at are already deleted.
  const brokenRegistry = [
    {
      name: 'settings.json cannot be parsed',
      break: (claudeDir) => writeFileSync(join(claudeDir, 'settings.json'), '{ "mcpServers": '),
      mentions: /settings\.json/,
    },
    {
      name: 'known_marketplaces.json cannot be parsed',
      break: (claudeDir) => writeFileSync(join(claudeDir, 'plugins', 'known_marketplaces.json'), 'not json'),
      mentions: /known_marketplaces\.json/,
    },
    {
      name: 'installed_plugins.json cannot be parsed',
      break: (claudeDir) => writeFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), '[[['),
      mentions: /installed_plugins\.json/,
    },
  ];

  for (const shape of brokenRegistry) {
    it(`${shape.name}: exit non-zero, and say which step did not finish`, async () => {
      await withHome('gsd-uninst-broken-', async (home, claudeDir) => {
        makeInstalled(claudeDir);
        shape.break(claudeDir);

        const { status, output } = runUninstall(home);
        assert.notEqual(status, 0, `a registration left behind must not exit 0:\n${output}`);
        assert.doesNotMatch(output, /✓ GSD-Lite uninstalled/, 'it did not uninstall GSD-Lite');
        assert.match(output, /partly uninstalled/, 'say that the uninstall is incomplete');
        assert.match(output, shape.mentions, 'name the file the user has to deal with');
      });
    });
  }

  it('the hook-registry helper is missing: exit non-zero, because the hook entries stay', async () => {
    await withHome('gsd-uninst-nolib-', async (home, claudeDir) => {
      // The orphan-cleanup shape: ~/.claude/gsd/uninstall.js runs with no
      // sibling hooks/lib, and the copy under ~/.claude/hooks/lib is gone too.
      makeInstalled(claudeDir, { hookLib: false });
      const scriptDir = join(claudeDir, 'gsd');

      const { status, output } = runUninstall(home, { scriptDir });
      assert.notEqual(status, 0, `hook entries left in settings.json must not exit 0:\n${output}`);
      assert.doesNotMatch(output, /✓ GSD-Lite uninstalled/);
      assert.match(output, /hook-registry|hook entries/, 'name what could not be removed');
    });
  });
});
