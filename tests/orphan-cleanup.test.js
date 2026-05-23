import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const SESSION_INIT = join(REPO_ROOT, 'hooks', 'gsd-session-init.cjs');
const STATUSLINE = join(REPO_ROOT, 'hooks', 'gsd-statusline.cjs');
const CONTEXT_MONITOR = join(REPO_ROOT, 'hooks', 'gsd-context-monitor.cjs');
const SESSION_STOP = join(REPO_ROOT, 'hooks', 'gsd-session-stop.cjs');
const AUTO_UPDATE = join(REPO_ROOT, 'hooks', 'gsd-auto-update.cjs');
const LIB_DIR = join(REPO_ROOT, 'hooks', 'lib');
const UNINSTALL = join(REPO_ROOT, 'uninstall.js');
const require = createRequire(import.meta.url);

async function makeClaudeHome(prefix) {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const claudeDir = join(home, '.claude');
  await mkdir(claudeDir, { recursive: true });
  return { home, claudeDir };
}

function runInstall(home, extraEnv = {}) {
  execFileSync('node', [join(REPO_ROOT, 'install.js')], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, ...extraEnv },
    encoding: 'utf-8',
  });
}

// Install GSD hooks/runtime into a temp claudeDir as if install.js had run.
// We don't actually invoke install.js (it runs npm install which is slow);
// we just lay down the files Phase 0 expects to see.
async function seedInstalledState(claudeDir, { mode = 'plugin', withCompositeRegistry = false } = {}) {
  await mkdir(join(claudeDir, 'hooks', 'lib'), { recursive: true });
  await mkdir(join(claudeDir, 'gsd', 'runtime'), { recursive: true });
  await mkdir(join(claudeDir, 'plugins'), { recursive: true });

  cpSync(SESSION_INIT, join(claudeDir, 'hooks', 'gsd-session-init.cjs'));
  cpSync(STATUSLINE, join(claudeDir, 'hooks', 'gsd-statusline.cjs'));
  cpSync(CONTEXT_MONITOR, join(claudeDir, 'hooks', 'gsd-context-monitor.cjs'));
  cpSync(SESSION_STOP, join(claudeDir, 'hooks', 'gsd-session-stop.cjs'));
  cpSync(AUTO_UPDATE, join(claudeDir, 'hooks', 'gsd-auto-update.cjs'));
  cpSync(LIB_DIR, join(claudeDir, 'hooks', 'lib'), { recursive: true });
  cpSync(UNINSTALL, join(claudeDir, 'gsd', 'uninstall.js'));

  await writeFile(join(claudeDir, 'gsd', '.install-mode'), `${mode}\n`);
  await writeFile(join(claudeDir, 'gsd', 'package.json'),
    JSON.stringify({ name: 'gsd-lite', type: 'module', version: '0.7.6' }) + '\n');

  const settings = {
    statusLine: { type: 'command', command: `node ${JSON.stringify(join(claudeDir, 'hooks', 'gsd-statusline.cjs'))}` },
    extraKnownMarketplaces: { gsd: { source: { source: 'github', repo: 'sdsrss/gsd-lite' } } },
    hooks: {
      PostToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: `node ${JSON.stringify(join(claudeDir, 'hooks', 'gsd-context-monitor.cjs'))}` }] },
      ],
      SessionStart: [
        { matcher: 'startup|clear|compact', hooks: [{ type: 'command', command: `node ${JSON.stringify(join(claudeDir, 'hooks', 'gsd-session-init.cjs'))}`, timeout: 5 }] },
      ],
      Stop: [
        { matcher: '*', hooks: [{ type: 'command', command: `node ${JSON.stringify(join(claudeDir, 'hooks', 'gsd-session-stop.cjs'))}`, timeout: 3 }] },
      ],
    },
  };
  await writeFile(join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');

  await writeFile(join(claudeDir, 'plugins', 'known_marketplaces.json'),
    JSON.stringify({ gsd: { source: { source: 'github', repo: 'sdsrss/gsd-lite' } } }, null, 2) + '\n');

  if (withCompositeRegistry) {
    const registry = [{ id: 'gsd', command: `node ${JSON.stringify(join(claudeDir, 'hooks', 'gsd-statusline.cjs'))}`, needsStdin: true }];
    await writeFile(join(claudeDir, 'statusline-providers.json'), JSON.stringify(registry, null, 2) + '\n');
  }
}

function runSessionInit(home) {
  return execFileSync(process.execPath, [join(home, '.claude', 'hooks', 'gsd-session-init.cjs')], {
    env: { ...process.env, HOME: home, PLUGIN_AUTO_UPDATE: '1' },
    encoding: 'utf8',
    timeout: 5000,
  });
}

describe('install.js — install-mode marker + runtime uninstall.js', () => {
  it('writes .install-mode = manual and copies uninstall.js when no plugin entry exists', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-install-mode-manual-');
    try {
      runInstall(home);
      const mode = await readFile(join(claudeDir, 'gsd', '.install-mode'), 'utf-8');
      assert.equal(mode.trim(), 'manual');
      assert.ok(existsSync(join(claudeDir, 'gsd', 'uninstall.js')));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('writes .install-mode = plugin when installed_plugins.json has gsd@gsd', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-install-mode-plugin-');
    try {
      await mkdir(join(claudeDir, 'plugins'), { recursive: true });
      await writeFile(
        join(claudeDir, 'plugins', 'installed_plugins.json'),
        JSON.stringify({ plugins: { 'gsd@gsd': [{ scope: 'user', installPath: '/fake', version: '0.7.6' }] } }),
      );
      runInstall(home);
      const mode = await readFile(join(claudeDir, 'gsd', '.install-mode'), 'utf-8');
      assert.equal(mode.trim(), 'plugin');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('clears stale .orphaned_at on the current plugin cache version during reinstall', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-install-clear-orphan-');
    try {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
      const cacheVersionDir = join(claudeDir, 'plugins', 'cache', 'gsd', 'gsd', pkg.version);
      await mkdir(cacheVersionDir, { recursive: true });
      const orphanMarker = join(cacheVersionDir, '.orphaned_at');
      await writeFile(orphanMarker, String(Date.now()));
      // Mark as plugin install so install.js takes the plugin branch
      await mkdir(join(claudeDir, 'plugins'), { recursive: true });
      await writeFile(
        join(claudeDir, 'plugins', 'installed_plugins.json'),
        JSON.stringify({ plugins: { 'gsd@gsd': [{ scope: 'user', installPath: cacheVersionDir, version: pkg.version }] } }),
      );
      runInstall(home);
      assert.equal(existsSync(orphanMarker), false, '.orphaned_at should be cleared on reinstall');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('session-init Phase 0 — orphan self-cleanup', () => {
  it('cleans up settings.json + hook files + runtime when plugin marker present but installed_plugins.json lacks entry', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-orphan-plugin-');
    try {
      await seedInstalledState(claudeDir, { mode: 'plugin', withCompositeRegistry: true });
      await writeFile(
        join(claudeDir, 'plugins', 'installed_plugins.json'),
        JSON.stringify({ plugins: { 'other@other': [{}] } }, null, 2) + '\n',
      );

      const output = runSessionInit(home);

      assert.match(output, /plugin uninstalled/i);
      // Settings.json scrubbed
      const settings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'));
      assert.equal(settings.statusLine, undefined);
      assert.equal(settings.extraKnownMarketplaces, undefined);
      assert.equal(settings.hooks?.PostToolUse, undefined);
      assert.equal(settings.hooks?.SessionStart, undefined);
      assert.equal(settings.hooks?.Stop, undefined);
      // Hook files gone
      assert.equal(existsSync(join(claudeDir, 'hooks', 'gsd-context-monitor.cjs')), false);
      assert.equal(existsSync(join(claudeDir, 'hooks', 'gsd-statusline.cjs')), false);
      assert.equal(existsSync(join(claudeDir, 'hooks', 'gsd-session-init.cjs')), false);
      assert.equal(existsSync(join(claudeDir, 'hooks', 'gsd-session-stop.cjs')), false);
      assert.equal(existsSync(join(claudeDir, 'hooks', 'gsd-auto-update.cjs')), false);
      // Lib files gone
      assert.equal(existsSync(join(claudeDir, 'hooks', 'lib', 'gsd-finder.cjs')), false);
      assert.equal(existsSync(join(claudeDir, 'hooks', 'lib', 'statusline-composite.cjs')), false);
      assert.equal(existsSync(join(claudeDir, 'hooks', 'lib', 'semver-sort.cjs')), false);
      // Runtime gone
      assert.equal(existsSync(join(claudeDir, 'gsd')), false);
      // known_marketplaces.json scrubbed
      const km = JSON.parse(await readFile(join(claudeDir, 'plugins', 'known_marketplaces.json'), 'utf8'));
      assert.equal(km.gsd, undefined);
      // Composite registry scrubbed
      const compositeRegistry = JSON.parse(await readFile(join(claudeDir, 'statusline-providers.json'), 'utf8'));
      assert.equal(compositeRegistry.find(p => p.id === 'gsd'), undefined);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does NOT cleanup when .install-mode = manual (npx user)', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-orphan-manual-skip-');
    try {
      await seedInstalledState(claudeDir, { mode: 'manual' });
      // No installed_plugins.json — npx user never registered with plugin system
      runSessionInit(home);
      // Settings still has GSD
      const settings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'));
      assert.ok(settings.statusLine?.command?.includes('gsd-statusline'));
      assert.ok(existsSync(join(claudeDir, 'hooks', 'gsd-session-init.cjs')));
      assert.ok(existsSync(join(claudeDir, 'gsd', 'package.json')));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does NOT cleanup when plugin entry exists in installed_plugins.json', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-orphan-plugin-installed-');
    try {
      await seedInstalledState(claudeDir, { mode: 'plugin' });
      await writeFile(
        join(claudeDir, 'plugins', 'installed_plugins.json'),
        JSON.stringify({ plugins: { 'gsd@gsd': [{ scope: 'user', installPath: '/fake', version: '0.7.6' }] } }) + '\n',
      );
      runSessionInit(home);
      const settings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'));
      assert.ok(settings.statusLine?.command?.includes('gsd-statusline'));
      assert.ok(existsSync(join(claudeDir, 'hooks', 'gsd-session-init.cjs')));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('falls back to .orphaned_at heuristic for pre-marker installs', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-orphan-fallback-');
    try {
      await seedInstalledState(claudeDir, { mode: 'plugin' });
      // Simulate pre-fix install: remove the marker, set up orphan cache
      await rm(join(claudeDir, 'gsd', '.install-mode'), { force: true });
      const cacheVersionDir = join(claudeDir, 'plugins', 'cache', 'gsd', 'gsd', '0.7.6');
      await mkdir(cacheVersionDir, { recursive: true });
      await writeFile(join(cacheVersionDir, '.orphaned_at'), String(Date.now()));
      // installed_plugins.json present but without gsd entry
      await writeFile(
        join(claudeDir, 'plugins', 'installed_plugins.json'),
        JSON.stringify({ plugins: {} }) + '\n',
      );

      const output = runSessionInit(home);
      assert.match(output, /plugin uninstalled/i);
      assert.equal(existsSync(join(claudeDir, 'hooks', 'gsd-session-init.cjs')), false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('gsd-auto-update.cjs — isOrphan guard', () => {
  it('isOrphan returns true when plugin marker + no installed_plugins entry', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-orphan-auto-update-');
    const prevHome = process.env.HOME;
    const prevAuto = process.env.PLUGIN_AUTO_UPDATE;
    try {
      await mkdir(join(claudeDir, 'gsd'), { recursive: true });
      await mkdir(join(claudeDir, 'plugins'), { recursive: true });
      await writeFile(join(claudeDir, 'gsd', '.install-mode'), 'plugin\n');
      await writeFile(
        join(claudeDir, 'plugins', 'installed_plugins.json'),
        JSON.stringify({ plugins: {} }) + '\n',
      );
      process.env.HOME = home;
      delete process.env.PLUGIN_AUTO_UPDATE;
      // Load fresh — clear module cache so claudeDir captures correctly
      delete require.cache[require.resolve(AUTO_UPDATE)];
      delete require.cache[require.resolve(join(LIB_DIR, 'semver-sort.cjs'))];
      const mod = require(AUTO_UPDATE);
      assert.equal(mod.isOrphan(), true);
      const result = await mod.checkForUpdate({
        force: true,
        install: true,
        fetchLatestRelease: async () => { throw new Error('should not be reached'); },
      });
      assert.equal(result, null, 'checkForUpdate must short-circuit on orphan');
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevAuto === undefined) delete process.env.PLUGIN_AUTO_UPDATE; else process.env.PLUGIN_AUTO_UPDATE = prevAuto;
      delete require.cache[require.resolve(AUTO_UPDATE)];
      delete require.cache[require.resolve(join(LIB_DIR, 'semver-sort.cjs'))];
      await rm(home, { recursive: true, force: true });
    }
  });

  it('isOrphan returns false when marker = manual', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-orphan-manual-marker-');
    const prevHome = process.env.HOME;
    const prevAuto = process.env.PLUGIN_AUTO_UPDATE;
    try {
      await mkdir(join(claudeDir, 'gsd'), { recursive: true });
      await writeFile(join(claudeDir, 'gsd', '.install-mode'), 'manual\n');
      process.env.HOME = home;
      delete process.env.PLUGIN_AUTO_UPDATE;
      delete require.cache[require.resolve(AUTO_UPDATE)];
      delete require.cache[require.resolve(join(LIB_DIR, 'semver-sort.cjs'))];
      const mod = require(AUTO_UPDATE);
      assert.equal(mod.isOrphan(), false);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevAuto === undefined) delete process.env.PLUGIN_AUTO_UPDATE; else process.env.PLUGIN_AUTO_UPDATE = prevAuto;
      delete require.cache[require.resolve(AUTO_UPDATE)];
      delete require.cache[require.resolve(join(LIB_DIR, 'semver-sort.cjs'))];
      await rm(home, { recursive: true, force: true });
    }
  });
});
