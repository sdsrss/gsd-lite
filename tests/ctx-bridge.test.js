import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, '..');
const _require = createRequire(import.meta.url);
const { ctxDir, isPrivateSelfOwnedDir } = _require('../hooks/lib/ctx-bridge.cjs');

const STATUSLINE = join(PROJECT_ROOT, 'hooks', 'gsd-statusline.cjs');
const MONITOR = join(PROJECT_ROOT, 'hooks', 'gsd-context-monitor.cjs');

/**
 * #8: the context bridge lived in `os.tmpdir()`, which on Linux is shared and
 * world-writable. A *directory* planted at either bridge path pinned it —
 * `rename` cannot replace a directory, and `/tmp` is sticky so another user's
 * directory cannot be removed by us either. The statusline's write then failed
 * on every render, the monitor read nothing, and the context-exhaustion
 * warning went silent for that session with nothing able to self-heal.
 *
 * The fix is not a better reaction to what gets planted: the files move to a
 * directory only this user can enter, which removes the plant as a category.
 * These tests are about that property — where the files are and who can reach
 * them — not about the one shape that was reported.
 */
describe('context bridge lives somewhere only this user can reach (#8)', () => {
  function sandbox(fn) {
    const root = mkdtempSync(join(tmpdir(), 'gsd-ctxb-'));
    try {
      const xdg = join(root, 'run');
      const tmp = join(root, 'tmp');
      mkdirSync(xdg, { recursive: true, mode: 0o700 });
      mkdirSync(tmp, { recursive: true });
      return fn({ root, xdg, tmp, env: { XDG_RUNTIME_DIR: xdg, TMPDIR: tmp } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  function runHook(script, input, env) {
    try {
      const stdout = execFileSync(process.execPath, [script], {
        input: JSON.stringify(input),
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, GSD_DEBUG: '1', ...env },
      });
      return { stdout, stderr: '', status: 0 };
    } catch (err) {
      return { stdout: err.stdout || '', stderr: err.stderr || '', status: err.status };
    }
  }

  it('the directory it picks is a real directory, owned by us, with no group or other write bit', () => {
    const dir = ctxDir();
    assert.ok(dir, 'no private directory could be established');
    const st = lstatSync(dir);
    assert.ok(st.isDirectory(), 'must be a directory, and not a symlink to one');
    if (process.platform !== 'win32') {
      assert.equal(st.uid, process.getuid(), 'must be owned by this user');
      assert.equal(st.mode & 0o022, 0, `must not be group- or other-writable (mode ${(st.mode & 0o777).toString(8)})`);
    }
  });

  it('rejects a candidate that is world-writable, a symlink, or someone else\'s', () => {
    const root = mkdtempSync(join(tmpdir(), 'gsd-ctxb-neg-'));
    try {
      const open = join(root, 'open');
      mkdirSync(open, { recursive: true, mode: 0o777 });
      chmodSync(open, 0o777);
      assert.equal(isPrivateSelfOwnedDir(open), false, 'a world-writable directory is exactly the case #8 is about');

      const target = join(root, 'target');
      mkdirSync(target, { recursive: true, mode: 0o700 });
      const link = join(root, 'link');
      symlinkSync(target, link);
      assert.equal(isPrivateSelfOwnedDir(link), false, 'a symlink to a private directory is still a symlink');

      assert.equal(isPrivateSelfOwnedDir(join(root, 'missing')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers XDG_RUNTIME_DIR, and both paths sit inside it', () => {
    sandbox(({ xdg, env }) => {
      const out = execFileSync(process.execPath, [
        '-e',
        'const {bridgePaths}=require(process.argv[1]);process.stdout.write(JSON.stringify(bridgePaths("abc123")))',
        join(PROJECT_ROOT, 'hooks', 'lib', 'ctx-bridge.cjs'),
      ], { encoding: 'utf8', env: { ...process.env, ...env } });
      const paths = JSON.parse(out);
      assert.equal(paths.dir, join(xdg, 'gsd'));
      assert.equal(paths.metrics, join(xdg, 'gsd', 'gsd-ctx-abc123.json'));
      assert.equal(paths.warned, join(xdg, 'gsd', 'gsd-ctx-abc123-warned.json'));
    });
  });

  it('falls back to the config dir when XDG_RUNTIME_DIR is unset, and makes it private', () => {
    // macOS has no XDG_RUNTIME_DIR, and neither do plenty of Linux sessions, so
    // this is the branch most users are on. The suite's preload sets the
    // variable for isolation, which would otherwise leave this path untested —
    // it has to be unset explicitly here, in a child that inherits nothing else.
    sandbox(({ root, env }) => {
      const claudeDir = join(root, 'claude');
      const child = execFileSync(process.execPath, [
        '-e',
        'const {bridgePaths}=require(process.argv[1]);const fs=require("node:fs");const p=bridgePaths("fallback1");process.stdout.write(JSON.stringify({p,mode:fs.statSync(p.dir).mode & 0o777}))',
        join(PROJECT_ROOT, 'hooks', 'lib', 'ctx-bridge.cjs'),
      ], {
        encoding: 'utf8',
        env: { ...process.env, ...env, XDG_RUNTIME_DIR: undefined, CLAUDE_CONFIG_DIR: claudeDir },
      });
      const { p, mode } = JSON.parse(child);
      assert.equal(p.dir, join(claudeDir, 'gsd', 'runtime', 'ctx'));
      assert.equal(p.metrics, join(claudeDir, 'gsd', 'runtime', 'ctx', 'gsd-ctx-fallback1.json'));
      if (process.platform !== 'win32') {
        assert.equal(mode & 0o022, 0, `the fallback directory must not be group- or other-writable (got ${mode.toString(8)})`);
      }
    });
  });

  it('the statusline writes the bridge there and leaves nothing in the shared temp directory', () => {
    sandbox(({ xdg, tmp, env }) => {
      const session = 'ctxb-write';
      const project = join(tmp, 'project');
      mkdirSync(join(project, '.gsd'), { recursive: true });

      runHook(STATUSLINE, {
        model: { display_name: 'Claude' },
        workspace: { current_dir: project },
        session_id: session,
        context_window: { remaining_percentage: 55 },
      }, env);

      const bridge = join(xdg, 'gsd', `gsd-ctx-${session}.json`);
      assert.ok(existsSync(bridge), `expected the bridge at ${bridge}`);
      assert.equal(JSON.parse(readFileSync(bridge, 'utf8')).remaining_percentage, 55);

      // The category, not the instance: nothing of ours in the shared directory
      // at all, so there is no path there for anyone to pre-create.
      assert.ok(!existsSync(join(tmp, `gsd-ctx-${session}.json`)), 'the shared temp directory must not be used any more');
      assert.equal(statSync(join(xdg, 'gsd')).mode & 0o022, 0, 'the directory it created must not be group- or other-writable');
    });
  });

  it('the monitor reads what the statusline wrote — one path, two processes', () => {
    sandbox(({ tmp, env }) => {
      const session = 'ctxb-roundtrip';
      const project = join(tmp, 'project');
      mkdirSync(join(project, '.gsd'), { recursive: true });
      // A real state file: the monitor stands aside for non-GSD sessions, so
      // without one this would pass for the wrong reason — silence either way.
      writeFileSync(join(project, '.gsd', 'state.json'), JSON.stringify({ project: 'ctxb', phases: [] }));

      runHook(STATUSLINE, {
        model: { display_name: 'Claude' },
        workspace: { current_dir: project },
        session_id: session,
        context_window: { remaining_percentage: 8 },
      }, env);

      const monitor = runHook(MONITOR, { session_id: session }, env);
      assert.match(
        `${monitor.stdout}${monitor.stderr}`,
        /context|compact|⚠|保存/i,
        'the monitor found no metrics, which is what a disagreement about the path looks like',
      );
    });
  });

  it('a directory planted at the old shared path no longer affects anything', () => {
    sandbox(({ xdg, tmp, env }) => {
      const session = 'ctxb-planted';
      const project = join(tmp, 'project');
      mkdirSync(join(project, '.gsd'), { recursive: true });
      // The exact obstruction from #8, at the path it used to be written to.
      mkdirSync(join(tmp, `gsd-ctx-${session}.json`), { recursive: true });

      runHook(STATUSLINE, {
        model: { display_name: 'Claude' },
        workspace: { current_dir: project },
        session_id: session,
        context_window: { remaining_percentage: 12 },
      }, env);

      assert.ok(existsSync(join(xdg, 'gsd', `gsd-ctx-${session}.json`)), 'the bridge is written regardless of what sits in the shared directory');
    });
  });
});
