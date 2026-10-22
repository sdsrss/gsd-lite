// Which install is this: the npx/manual one, or the plugin? install.js asks to
// decide what to install (and whether to register the MCP server), and the
// updater asks to decide whether to run install.js at all. Two answers were
// wrong (pre-tag review of 0.19.0):
//
// - The updater compared its own directory, which Node resolves through
//   symlinks, with the config directory as given. Under a symlinked ~/.claude
//   an npx install read as a plugin install: no update was ever installed, and
//   the notice said to run `claude plugin update`.
// - Both took any gsd@gsd record for a plugin serving everywhere. A plugin
//   installed at project or local scope serves the project it names, and the
//   npx install then removed its own user-scope MCP registration, leaving
//   every other project with no gsd tools and no message.
//
// The delta review after those repairs found two more: a symlinked
// <config>/hooks alone (a dotfiles layout) still read as a plugin install, and
// a plugin installed by policy (`managed` scope, which applies to every
// project) was no longer counted as one.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function home(t, { linked = false, linkedHooks = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gsd-install-mode-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, 'real-home');
  mkdirSync(join(real, '.claude'), { recursive: true });
  const homeDir = linked ? join(root, 'home') : real;
  if (linked) symlinkSync(real, homeDir, 'dir');
  if (linkedHooks) {
    mkdirSync(join(root, 'dotfiles', 'claude-hooks'), { recursive: true });
    symlinkSync(join(root, 'dotfiles', 'claude-hooks'), join(real, '.claude', 'hooks'), 'dir');
  }
  return { root, home: homeDir, claudeDir: join(homeDir, '.claude') };
}

function writePlugins(claudeDir, entries) {
  mkdirSync(join(claudeDir, 'plugins'), { recursive: true });
  writeFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'gsd@gsd': entries } }));
}

// The updater as the npx install placed it: <config>/hooks, beside its lib.
function updaterMode({ home: homeDir, claudeDir }) {
  mkdirSync(join(claudeDir, 'hooks', 'lib'), { recursive: true });
  mkdirSync(join(claudeDir, 'gsd'), { recursive: true });
  cpSync(join(PROJECT_ROOT, 'hooks', 'gsd-auto-update.cjs'), join(claudeDir, 'hooks', 'gsd-auto-update.cjs'));
  cpSync(join(PROJECT_ROOT, 'hooks', 'lib'), join(claudeDir, 'hooks', 'lib'), { recursive: true });
  writeFileSync(join(claudeDir, 'gsd', 'package.json'), JSON.stringify({ name: 'gsd-lite', version: '0.18.0' }));
  const run = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(join(claudeDir, 'hooks', 'gsd-auto-update.cjs'))}).getInstallMode())`], {
    env: { ...process.env, HOME: homeDir, CLAUDE_CONFIG_DIR: claudeDir },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

function install({ home: homeDir, claudeDir }) {
  const run = spawnSync(process.execPath, [join(PROJECT_ROOT, 'install.js')], {
    cwd: homeDir,
    env: { ...process.env, HOME: homeDir, CLAUDE_CONFIG_DIR: claudeDir },
    encoding: 'utf8',
    timeout: 90000,
  });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  return run.stdout;
}

const userMcp = (claudeDir) => {
  try {
    return JSON.parse(readFileSync(join(claudeDir, '.claude.json'), 'utf8')).mcpServers?.gsd;
  } catch {
    return undefined;
  }
};

// Records of a plugin that serves every project. Claude Code 2.1.308's
// installed_plugins.json schema has the scopes managed, user, project and
// local; a managed record (a plugin installed by policy) has no projectPath.
const PLUGIN_FOR_EVERY_PROJECT = [
  ['at user scope', { scope: 'user', version: '0.19.0' }],
  ['at managed scope (by policy)', { scope: 'managed', version: '0.19.0' }],
  ['in a record with no scope (older Claude Code)', { version: '0.19.0' }],
];

describe('install mode, as the updater reads it', () => {
  it('an npx install under a symlinked config directory is the npx install', (t) => {
    assert.equal(updaterMode(home(t, { linked: true })), 'manual');
  });

  it('an npx install whose hooks directory alone is a symlink is the npx install', (t) => {
    assert.equal(updaterMode(home(t, { linkedHooks: true })), 'manual');
  });

  it('a plugin installed at project scope does not make the npx install a plugin install', (t) => {
    const ctx = home(t);
    writePlugins(ctx.claudeDir, [{ scope: 'project', projectPath: join(ctx.root, 'some-project'), version: '0.19.0' }]);
    assert.equal(updaterMode(ctx), 'manual');
  });

  for (const [label, entries] of [['an empty plugin record', []], ['a record holding an empty list', [[]]], ['a record holding null', [null]]]) {
    it(`${label} is no plugin`, (t) => {
      const ctx = home(t);
      writePlugins(ctx.claudeDir, entries);
      assert.equal(updaterMode(ctx), 'manual');
    });
  }

  for (const [label, entry] of PLUGIN_FOR_EVERY_PROJECT) {
    it(`a plugin installed ${label} is the plugin install`, (t) => {
      const ctx = home(t);
      writePlugins(ctx.claudeDir, [entry]);
      assert.equal(updaterMode(ctx), 'plugin');
    });
  }
});

describe('install mode, as install.js reads it', { timeout: 180000 }, () => {
  it('a plugin installed at project scope leaves the npx install whole: registered, files copied, marked manual', (t) => {
    const ctx = home(t);
    install(ctx);
    assert.ok(userMcp(ctx.claudeDir), 'premise: the npx install registered the server');
    writePlugins(ctx.claudeDir, [{ scope: 'project', projectPath: join(ctx.root, 'some-project'), version: '0.19.0' }]);
    const out = install(ctx);
    assert.doesNotMatch(out, /Removed the user-scope MCP registration/);
    assert.ok(userMcp(ctx.claudeDir), 'the registration every other project uses was removed');
    assert.ok(existsSync(join(ctx.claudeDir, 'commands', 'gsd', 'start.md')), 'the commands the other projects use were removed');
    assert.equal(readFileSync(join(ctx.claudeDir, 'gsd', '.install-mode'), 'utf8').trim(), 'manual');
  });

  for (const [label, entry] of PLUGIN_FOR_EVERY_PROJECT) {
    it(`a plugin installed ${label} is the plugin install`, (t) => {
      const ctx = home(t);
      writePlugins(ctx.claudeDir, [entry]);
      install(ctx);
      assert.equal(userMcp(ctx.claudeDir), undefined);
      assert.equal(existsSync(join(ctx.claudeDir, 'commands', 'gsd', 'start.md')), false, 'the plugin serves the commands');
      assert.equal(readFileSync(join(ctx.claudeDir, 'gsd', '.install-mode'), 'utf8').trim(), 'plugin');
    });
  }
});

// The server's health check warns when the plugin's record names another
// version than the one running: the plugin was updated, restart the server.
// That is the plugin's server's question. Asked by the npx install's copy, the
// first release whose npx server Claude Code actually starts, it warned beside
// any plugin record of another version, such as one installed at project
// scope for another project (delta review).
describe("the server's version check reads the plugin's record for the plugin's server only", () => {
  async function health(serverPath, claudeDir) {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    try {
      const { handleToolCall } = await import(pathToFileURL(serverPath).href);
      return await handleToolCall('health', {});
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  }

  function withOtherPluginVersion(t) {
    const ctx = home(t);
    writePlugins(ctx.claudeDir, [{ scope: 'project', projectPath: join(ctx.root, 'some-project'), version: '0.0.1' }]);
    return ctx;
  }

  it("the npx install's copy does not warn about the plugin's version", async (t) => {
    const ctx = withOtherPluginVersion(t);
    const runtime = join(ctx.claudeDir, 'gsd');
    cpSync(join(PROJECT_ROOT, 'src'), join(runtime, 'src'), { recursive: true });
    cpSync(join(PROJECT_ROOT, 'package.json'), join(runtime, 'package.json'));
    mkdirSync(join(runtime, 'node_modules'));
    for (const entry of readdirSync(join(PROJECT_ROOT, 'node_modules'))) symlinkSync(join(PROJECT_ROOT, 'node_modules', entry), join(runtime, 'node_modules', entry));
    const result = await health(join(runtime, 'src', 'server.js'), ctx.claudeDir);
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.equal(result.warning, undefined);
  });

  it('any other copy still does', async (t) => {
    const result = await health(join(PROJECT_ROOT, 'src', 'server.js'), withOtherPluginVersion(t).claudeDir);
    assert.match(String(result.warning), /plugin registry has v0\.0\.1/);
  });
});
