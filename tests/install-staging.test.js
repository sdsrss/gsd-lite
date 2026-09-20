import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

/**
 * Build a package copy that looks like the npx form: source, install.js and a
 * lock file, but no node_modules — so install.js has to shell out to npm.
 */
async function makeNpxPackage(root, { withLock = true } = {}) {
  const pkgDir = join(root, 'package');
  await mkdir(pkgDir, { recursive: true });
  for (const entry of ['src', 'commands', 'agents', 'workflows', 'references', 'hooks']) {
    cpSync(join(PROJECT_ROOT, entry), join(pkgDir, entry), { recursive: true });
  }
  for (const file of ['install.js', 'uninstall.js', 'package.json', 'cli.js', 'launcher.js']) {
    cpSync(join(PROJECT_ROOT, file), join(pkgDir, file));
  }
  if (withLock) cpSync(join(PROJECT_ROOT, 'package-lock.json'), join(pkgDir, 'package-lock.json'));
  return pkgDir;
}

/** A runtime from a previous, working install — the thing an update must not destroy. */
async function seedExistingRuntime(claudeDir, version = '0.9.0') {
  const runtime = join(claudeDir, 'gsd');
  await mkdir(join(runtime, 'src'), { recursive: true });
  await mkdir(join(runtime, 'node_modules', 'left-pad'), { recursive: true });
  await mkdir(join(runtime, 'runtime'), { recursive: true });
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'gsd-lite', version }));
  await writeFile(join(runtime, 'src', 'server.js'), '// the working server\n');
  await writeFile(join(runtime, 'node_modules', 'left-pad', 'index.js'), '// a dependency\n');
  await writeFile(join(runtime, 'runtime', 'update-state.json'), JSON.stringify({ lastCheck: 'before' }));
  return runtime;
}

/**
 * Run an installer with npm removed from PATH, so the dependency step must fail.
 *
 * process.execPath, not 'node': an empty PATH means the interpreter cannot be
 * looked up either, and the spawn then fails before install.js runs at all —
 * which looks exactly like a passing test while proving nothing.
 */
function runInstallWithoutNpm(pkgDir, home) {
  const emptyBin = join(home, 'no-npm-bin');
  try {
    execFileSync(process.execPath, [join(pkgDir, 'install.js')], {
      cwd: pkgDir,
      env: {
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        PATH: emptyBin,
        PLUGIN_AUTO_UPDATE: '1',
      },
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return { failed: false };
  } catch (err) {
    return { failed: true, status: err.status, stderr: String(err.stderr || '') + String(err.stdout || '') };
  }
}

// The background updater downloads a release, unpacks it and spawns its
// install.js. install.js used to wipe the managed runtime first and only then
// run `npm ci`, so a dependency install that could not complete — no npm on
// PATH, no network, a registry 500 — left ~/.claude/gsd holding new src/ with no
// node_modules. The MCP server then threw ERR_MODULE_NOT_FOUND on every start.
describe('a failed install leaves the working runtime alone', () => {
  it('keeps src, package.json and node_modules when the dependency step fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gsd-staging-fail-'));
    try {
      const claudeDir = join(home, '.claude');
      await mkdir(join(home, 'no-npm-bin'), { recursive: true });
      const runtime = await seedExistingRuntime(claudeDir);
      const pkgDir = await makeNpxPackage(home);

      const result = runInstallWithoutNpm(pkgDir, home);
      assert.equal(result.failed, true, 'the install should fail without npm — otherwise this proves nothing');

      assert.equal(existsSync(join(runtime, 'node_modules', 'left-pad', 'index.js')), true,
        'dependencies were removed and not replaced — the MCP server cannot start');
      assert.equal(readFileSync(join(runtime, 'src', 'server.js'), 'utf-8'), '// the working server\n',
        'the previous source was overwritten by a version that cannot run');
      assert.equal(JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf-8')).version, '0.9.0',
        'the recorded version advanced on a failed install, so the updater will never retry');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('creates a staging directory and leaves none behind after a failure', async () => {
    // Both halves, because the second alone is vacuous: asserting "no staging
    // directory afterwards" passes against a version that never stages at all,
    // which is exactly what main does. A shim standing in for npm records
    // whether staging existed at the moment the dependency step ran, so the
    // absence afterwards means cleaned up rather than never created.
    const home = await mkdtemp(join(tmpdir(), 'gsd-staging-residue-'));
    try {
      const claudeDir = join(home, '.claude');
      const shimDir = join(home, 'shim-bin');
      const witness = join(home, 'staging-at-npm-time.txt');
      await mkdir(shimDir, { recursive: true });
      await seedExistingRuntime(claudeDir);
      const pkgDir = await makeNpxPackage(home);

      // Shell builtins only: PATH is the shim directory alone, so `ls` and
      // friends are not reachable. Glob expansion and echo are part of sh.
      await writeFile(join(shimDir, 'npm'), '#!/bin/sh\n'
        + `for d in "${claudeDir}"/.gsd-staging-*; do echo "$d"; done > "${witness}"\n`
        + 'exit 1\n', { mode: 0o755 });

      try {
        execFileSync(process.execPath, [join(pkgDir, 'install.js')], {
          cwd: pkgDir,
          env: { HOME: home, CLAUDE_CONFIG_DIR: claudeDir, PATH: shimDir, PLUGIN_AUTO_UPDATE: '1' },
          encoding: 'utf-8',
          stdio: 'pipe',
        });
        assert.fail('the install should have failed at the dependency step');
      } catch (err) {
        assert.equal(err.status, 1, `expected exit 1, got ${err.status}`);
      }

      assert.match(readFileSync(witness, 'utf-8'), /\.gsd-staging-\d+/,
        'nothing was staged — this test cannot tell cleanup from never having run');

      const stray = (await readdir(claudeDir)).filter(e => e.startsWith('.gsd-staging'));
      assert.deepEqual(stray, [], `staging left behind: ${stray.join(', ')}`);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does not merge a same-pid leftover into the new runtime', async () => {
    // The sweep reads our own pid as alive, so a directory left by an earlier
    // run whose pid was recycled onto this process would be skipped — and
    // copyDir merges rather than replaces, so its files would ride into the
    // swap. Reproduced exactly by creating the leftover under the pid that then
    // runs the installer in-process.
    const home = await mkdtemp(join(tmpdir(), 'gsd-staging-samepid-'));
    try {
      const claudeDir = join(home, '.claude');
      await mkdir(claudeDir, { recursive: true });
      const pkgDir = await makeNpxPackage(home);
      cpSync(join(PROJECT_ROOT, 'node_modules'), join(pkgDir, 'node_modules'), { recursive: true });

      const launcher = join(home, 'launcher.mjs');
      await writeFile(launcher, `
        import { mkdirSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        const staging = join(${JSON.stringify(claudeDir)}, '.gsd-staging-' + process.pid);
        mkdirSync(join(staging, 'src'), { recursive: true });
        writeFileSync(join(staging, 'src', 'ghost.js'), '// left by a crashed run\\n');
        const { main } = await import(${JSON.stringify(join(pkgDir, 'install.js'))});
        main();
      `);

      execFileSync(process.execPath, [launcher], {
        cwd: pkgDir,
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeDir, PLUGIN_AUTO_UPDATE: '1' },
        encoding: 'utf-8',
        stdio: 'pipe',
      });

      assert.equal(existsSync(join(claudeDir, 'gsd', 'src', 'ghost.js')), false,
        'a stale file from an abandoned staging directory was installed into the runtime');
      assert.equal(existsSync(join(claudeDir, 'gsd', 'src', 'server.js')), true,
        'the real runtime should still be there');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  // The staging rewrite added `.gsd-staging-*` to the start-of-run sweep. On main
  // that sweep only matched `.gsd-runtime-backup-*`, which nothing created, so it
  // was a no-op. Now it matches a directory a CONCURRENT install is building
  // into — and concurrent installs are reachable: the auto-updater's lock goes
  // stale after 10s (gsd-auto-update.cjs LOCK_STALE_MS) while an install holding
  // it can run for 60s, so a second session takes the lock and spawns a second
  // install.js. Deleting its tree mid-copy gives an uncatchable SIGABRT out of
  // cpSync, or a silently truncated copy that still reports success.
  it('does not sweep a staging directory belonging to a live process', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gsd-staging-live-'));
    try {
      const claudeDir = join(home, '.claude');
      await mkdir(claudeDir, { recursive: true });
      const pkgDir = await makeNpxPackage(home);
      cpSync(join(PROJECT_ROOT, 'node_modules'), join(pkgDir, 'node_modules'), { recursive: true });

      // This test process is alive by definition.
      const live = join(claudeDir, `.gsd-staging-${process.pid}`);
      await mkdir(live, { recursive: true });
      await writeFile(join(live, 'in-progress.txt'), 'another install is building here');

      execFileSync(process.execPath, [join(pkgDir, 'install.js')], {
        cwd: pkgDir,
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeDir, PLUGIN_AUTO_UPDATE: '1' },
        encoding: 'utf-8',
        stdio: 'pipe',
      });

      assert.equal(existsSync(join(live, 'in-progress.txt')), true,
        'swept a live install\'s staging directory out from under it');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('still sweeps a staging directory left by a dead process', async () => {
    // The sweep has to keep working, or an interrupted install litters forever.
    const home = await mkdtemp(join(tmpdir(), 'gsd-staging-dead-'));
    try {
      const claudeDir = join(home, '.claude');
      await mkdir(claudeDir, { recursive: true });
      const pkgDir = await makeNpxPackage(home);
      cpSync(join(PROJECT_ROOT, 'node_modules'), join(pkgDir, 'node_modules'), { recursive: true });

      // Spawn and reap, so the pid is provably gone.
      const corpse = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
      const deadPid = corpse.pid;
      const stale = join(claudeDir, `.gsd-staging-${deadPid}`);
      await mkdir(stale, { recursive: true });
      await writeFile(join(stale, 'abandoned.txt'), 'left by an interrupted run');

      execFileSync(process.execPath, [join(pkgDir, 'install.js')], {
        cwd: pkgDir,
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeDir, PLUGIN_AUTO_UPDATE: '1' },
        encoding: 'utf-8',
        stdio: 'pipe',
      });

      assert.equal(existsSync(stale), false, 'abandoned staging directory was not cleaned up');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('abandons staging when a copy throws part-way through the build', async () => {
    // Everything between staging creation and the swap runs outside any
    // try/catch, so a throw there left the tree behind. The exit handler covers
    // it. Forced by making a file the installer copies into staging a directory
    // instead, which is a genuine throw on an otherwise unguarded path.
    const home = await mkdtemp(join(tmpdir(), 'gsd-staging-throw-'));
    try {
      const claudeDir = join(home, '.claude');
      await mkdir(claudeDir, { recursive: true });
      const pkgDir = await makeNpxPackage(home);
      cpSync(join(PROJECT_ROOT, 'node_modules'), join(pkgDir, 'node_modules'), { recursive: true });

      await rm(join(pkgDir, 'uninstall.js'), { force: true });
      await mkdir(join(pkgDir, 'uninstall.js'), { recursive: true });

      try {
        execFileSync(process.execPath, [join(pkgDir, 'install.js')], {
          cwd: pkgDir,
          env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeDir, PLUGIN_AUTO_UPDATE: '1' },
          encoding: 'utf-8',
          stdio: 'pipe',
        });
        assert.fail('copying a directory as a file should have thrown');
      } catch (err) {
        assert.notEqual(err.status, 0);
      }

      const stray = (await readdir(claudeDir)).filter(e => e.startsWith('.gsd-staging'));
      assert.deepEqual(stray, [], `staging survived an unguarded throw: ${stray.join(', ')}`);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('installs normally and preserves runtime/ state when dependencies are available', async () => {
    // The success path still has to work, and update-state.json under runtime/
    // must survive the swap — losing it resets the update-check throttle.
    const home = await mkdtemp(join(tmpdir(), 'gsd-staging-ok-'));
    try {
      const claudeDir = join(home, '.claude');
      const runtime = await seedExistingRuntime(claudeDir);
      const pkgDir = await makeNpxPackage(home);
      cpSync(join(PROJECT_ROOT, 'node_modules'), join(pkgDir, 'node_modules'), { recursive: true });

      execFileSync('node', [join(pkgDir, 'install.js')], {
        cwd: pkgDir,
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeDir, PLUGIN_AUTO_UPDATE: '1' },
        encoding: 'utf-8',
        stdio: 'pipe',
      });

      const installed = JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf-8'));
      const shipped = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8'));
      assert.equal(installed.version, shipped.version, 'the new runtime should be in place');
      assert.equal(existsSync(join(runtime, 'src', 'server.js')), true);
      assert.equal(existsSync(join(runtime, 'node_modules')), true);
      assert.equal(
        JSON.parse(readFileSync(join(runtime, 'runtime', 'update-state.json'), 'utf-8')).lastCheck,
        'before',
        'runtime/ carries update-check state and must survive the swap',
      );
      // Stale entries from the old install must not ride along.
      assert.equal(existsSync(join(runtime, 'node_modules', 'left-pad')), false,
        'the swap should replace the tree, not merge into it');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
