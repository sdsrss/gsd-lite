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
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function home(t, { linked = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gsd-install-mode-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, 'real-home');
  mkdirSync(join(real, '.claude'), { recursive: true });
  const homeDir = linked ? join(root, 'home') : real;
  if (linked) symlinkSync(real, homeDir, 'dir');
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

describe('install mode, as the updater reads it', () => {
  it('an npx install under a symlinked config directory is the npx install', (t) => {
    assert.equal(updaterMode(home(t, { linked: true })), 'manual');
  });

  it('a plugin installed at project scope does not make the npx install a plugin install', (t) => {
    const ctx = home(t);
    writePlugins(ctx.claudeDir, [{ scope: 'project', projectPath: join(ctx.root, 'some-project'), version: '0.19.0' }]);
    assert.equal(updaterMode(ctx), 'manual');
  });

  it('an empty plugin record is no plugin', (t) => {
    const ctx = home(t);
    writePlugins(ctx.claudeDir, []);
    assert.equal(updaterMode(ctx), 'manual');
  });

  for (const [label, entry] of [['at user scope', { scope: 'user', version: '0.19.0' }], ['in a record with no scope (older Claude Code)', { version: '0.19.0' }]]) {
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

  it('a plugin installed at user scope is the plugin install', (t) => {
    const ctx = home(t);
    writePlugins(ctx.claudeDir, [{ scope: 'user', version: '0.19.0' }]);
    install(ctx);
    assert.equal(userMcp(ctx.claudeDir), undefined);
    assert.equal(readFileSync(join(ctx.claudeDir, 'gsd', '.install-mode'), 'utf8').trim(), 'plugin');
  });
});
