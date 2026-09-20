import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

  it('leaves no staging directory behind after a failure', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gsd-staging-residue-'));
    try {
      const claudeDir = join(home, '.claude');
      await mkdir(join(home, 'no-npm-bin'), { recursive: true });
      await seedExistingRuntime(claudeDir);
      const pkgDir = await makeNpxPackage(home);

      runInstallWithoutNpm(pkgDir, home);

      const stray = (await readdir(claudeDir)).filter(e => e.startsWith('.gsd-staging') || e.startsWith('gsd.new'));
      assert.deepEqual(stray, [], `staging left behind: ${stray.join(', ')}`);
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
