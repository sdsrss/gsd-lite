// `/plugin disable gsd` turns gsd off.
//
// An npx install registers three hooks, a statusline and an MCP server in
// settings.json; installing the plugin as well keeps those registrations, as a
// safety net that stands down while the plugin serves (hook-registry.cjs).
// Installed but disabled was read as "the plugin is not serving, so run":
// every hook, the statusline and the MCP server's tools carried on after the
// user switched gsd off. An explicit disable is the user's answer now, and
// each of them stands down; the plugin's own copies are not loaded by Claude
// Code while it is disabled. Each case that stands down is paired with one
// that must still run, so a hook that stops doing anything cannot pass.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const REPO = join(import.meta.dirname, '..');
const registry = require('../hooks/lib/hook-registry.cjs');
const { bridgePaths } = require('../hooks/lib/ctx-bridge.cjs');

// A user's machine: ~/.claude with an npx install's hooks and runtime, the
// plugin registry in a given shape, and a project with an active gsd state.
function machine(t, { records = null, user, project, local } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gsd-disabled-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const claudeDir = join(home, '.claude');
  const proj = join(root, 'project');
  mkdirSync(join(claudeDir, 'plugins'), { recursive: true });
  mkdirSync(join(proj, '.claude'), { recursive: true });
  if (records) writeFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: records }));
  const settings = (enabled) => (enabled === undefined ? null : JSON.stringify({ enabledPlugins: enabled }));
  if (user !== undefined) writeFileSync(join(claudeDir, 'settings.json'), settings(user));
  if (project !== undefined) writeFileSync(join(proj, '.claude', 'settings.json'), settings(project));
  if (local !== undefined) writeFileSync(join(proj, '.claude', 'settings.local.json'), settings(local));
  return { root, home, claudeDir, project: proj };
}

const USER_RECORD = (installPath = '/nowhere') => [{ scope: 'user', installPath, version: '0.18.0' }];

describe('pluginDisabled: an explicit disable is the user switching gsd off', () => {
  it('premise: the helper is exported', () => {
    assert.equal(typeof registry.pluginDisabled, 'function');
  });

  for (const [label, setup, cwdIsProject, expected] of [
    ['no plugin registry at all', {}, true, false],
    ['a registry without gsd', { records: { 'other@x': USER_RECORD() }, user: { 'gsd@gsd': false } }, true, false],
    ['gsd installed and enabled', { records: { 'gsd@gsd': USER_RECORD() }, user: { 'gsd@gsd': true } }, true, false],
    ['gsd installed and disabled', { records: { 'gsd@gsd': USER_RECORD() }, user: { 'gsd@gsd': false } }, true, true],
    ['disabled with the string "false"', { records: { 'gsd@gsd': USER_RECORD() }, user: { 'gsd@gsd': 'false' } }, true, true],
    ['installed with no enabledPlugins entry anywhere', { records: { 'gsd@gsd': USER_RECORD() }, user: {} }, true, false],
    ['enabled for the user, disabled in this project', { records: { 'gsd@gsd': USER_RECORD() }, user: { 'gsd@gsd': true }, project: { 'gsd@gsd': false } }, true, true],
    ['disabled in the project, enabled again locally', { records: { 'gsd@gsd': USER_RECORD() }, user: { 'gsd@gsd': true }, project: { 'gsd@gsd': false }, local: { 'gsd@gsd': true } }, true, false],
    ['disabled for the user, enabled in this project', { records: { 'gsd@gsd': USER_RECORD() }, user: { 'gsd@gsd': false }, project: { 'gsd@gsd': true } }, true, false],
    ['a fork installed and disabled', { records: { 'gsd@fork': USER_RECORD() }, user: { 'gsd@fork': false } }, true, true],
    ['two installs, one still enabled', { records: { 'gsd@gsd': USER_RECORD(), 'gsd@fork': USER_RECORD() }, user: { 'gsd@gsd': false, 'gsd@fork': true } }, true, false],
  ]) {
    it(`${label} → ${expected ? 'off' : 'not off'}`, (t) => {
      const m = machine(t, setup);
      assert.equal(registry.pluginDisabled(m.claudeDir, cwdIsProject ? m.project : m.root), expected);
    });
  }

  it('a project-scope install for another project does not turn gsd off here', (t) => {
    const m = machine(t, { records: { 'gsd@gsd': [{ scope: 'project', projectPath: '/some/other/project', installPath: '/nowhere' }] }, user: {} });
    writeFileSync(join(m.project, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'gsd@gsd': false } }));
    assert.equal(registry.pluginDisabled(m.claudeDir, m.project), false);
  });

  it('a project-scope install for this project, disabled here, does', (t) => {
    const m = machine(t, { user: {} });
    writeFileSync(join(m.claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'gsd@gsd': [{ scope: 'project', projectPath: m.project, installPath: '/nowhere' }] } }));
    writeFileSync(join(m.project, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'gsd@gsd': false } }));
    assert.equal(registry.pluginDisabled(m.claudeDir, m.project), true);
  });

  it('an unreadable registry is not a disable', (t) => {
    const m = machine(t, { user: { 'gsd@gsd': false } });
    writeFileSync(join(m.claudeDir, 'plugins', 'installed_plugins.json'), '{ torn');
    assert.equal(registry.pluginDisabled(m.claudeDir, m.project), false);
  });
});

// The npx install's copies, laid out where install.js puts them.
function npxInstall(m) {
  cpSync(join(REPO, 'hooks'), join(m.claudeDir, 'hooks'), { recursive: true });
  rmSync(join(m.claudeDir, 'hooks', 'hooks.json'));
  const runtime = join(m.claudeDir, 'gsd');
  cpSync(join(REPO, 'src'), join(runtime, 'src'), { recursive: true });
  for (const sub of ['references', 'workflows']) cpSync(join(REPO, sub), join(runtime, sub), { recursive: true });
  cpSync(join(REPO, 'package.json'), join(runtime, 'package.json'));
  mkdirSync(join(runtime, 'node_modules'));
  for (const entry of readdirSync(join(REPO, 'node_modules'))) symlinkSync(join(REPO, 'node_modules', entry), join(runtime, 'node_modules', entry));
  mkdirSync(join(m.project, '.gsd'), { recursive: true });
  writeFileSync(join(m.project, '.gsd', 'state.json'), JSON.stringify({
    schema_version: 1, project: 'p', workflow_mode: 'executing_task', current_phase: 1, current_task: '1.1', total_phases: 1,
    phases: [{ id: 1, name: 'Core', lifecycle: 'active', todo: [{ id: '1.1', name: 'A', lifecycle: 'pending' }] }],
  }));
}

const runHook = (m, file, { input = '', env = {} } = {}) => execFileSync(process.execPath, [join(m.claudeDir, 'hooks', file)], {
  cwd: m.project,
  input,
  encoding: 'utf8',
  timeout: 8000,
  env: { ...process.env, HOME: m.home, CLAUDE_CONFIG_DIR: m.claudeDir, PLUGIN_AUTO_UPDATE: '1', GSD_DEBUG: '', ...env },
});

describe('the npx install stands down when the plugin is disabled', () => {
  // Installed and enabled but with no hooks.json to serve from, so the
  // settings.json copies are the live registration and must run.
  const STATES = {
    disabled: { records: { 'gsd@gsd': USER_RECORD() }, user: { 'gsd@gsd': false } },
    enabled: { records: { 'gsd@gsd': USER_RECORD() }, user: { 'gsd@gsd': true } },
    'not installed': { user: {} },
  };

  for (const [name, setup] of Object.entries(STATES)) {
    const off = name === 'disabled';

    it(`SessionStart ${off ? 'does nothing' : 'runs'} (${name})`, (t) => {
      const m = machine(t, setup);
      npxInstall(m);
      runHook(m, 'gsd-session-init.cjs');
      const claudeMd = join(m.project, 'CLAUDE.md');
      assert.equal(existsSync(claudeMd) && readFileSync(claudeMd, 'utf8').includes('GSD-STATUS-BEGIN'), !off, 'the status block in CLAUDE.md');
    });

    it(`Stop ${off ? 'does nothing' : 'runs'} (${name})`, (t) => {
      const m = machine(t, setup);
      npxInstall(m);
      runHook(m, 'gsd-session-stop.cjs');
      assert.equal(existsSync(join(m.project, '.gsd', '.session-end')), !off, 'the session-end marker');
    });

    it(`PostToolUse ${off ? 'does nothing' : 'runs'} (${name})`, (t) => {
      const m = machine(t, setup);
      npxInstall(m);
      const sid = `disabled-test-${name.replace(/\W/g, '')}-${process.pid}`;
      writeFileSync(bridgePaths(sid).metrics, JSON.stringify({ remaining_percentage: 20, used_pct: 80, has_gsd: true, timestamp: Math.floor(Date.now() / 1000) }));
      try {
        const out = runHook(m, 'gsd-context-monitor.cjs', { input: JSON.stringify({ session_id: sid }) });
        assert.equal(out.trim() !== '', !off, `the context warning: ${JSON.stringify(out)}`);
      } finally {
        for (const p of [bridgePaths(sid).metrics, bridgePaths(sid).warned]) rmSync(p, { force: true });
      }
    });

    it(`the statusline ${off ? 'prints nothing' : 'prints'} (${name})`, (t) => {
      const m = machine(t, setup);
      npxInstall(m);
      const sid = `disabled-sl-${name.replace(/\W/g, '')}-${process.pid}`;
      try {
        const out = runHook(m, 'gsd-statusline.cjs', {
          input: JSON.stringify({ session_id: sid, model: { display_name: 'Opus' }, workspace: { current_dir: m.project }, context_window: { remaining_percentage: 50 } }),
        });
        assert.equal(out.trim() !== '', !off, `statusline output: ${JSON.stringify(out)}`);
        assert.equal(existsSync(bridgePaths(sid).metrics), !off, 'the context bridge');
      } finally {
        for (const p of [bridgePaths(sid).metrics, bridgePaths(sid).warned]) rmSync(p, { force: true });
      }
    });

    it(`the MCP server ${off ? 'lists no tools' : 'lists its tools'} (${name})`, async (t) => {
      const m = machine(t, setup);
      npxInstall(m);
      const { tools, call } = await mcpSession(join(m.claudeDir, 'gsd', 'src', 'server.js'), m);
      if (off) {
        assert.deepEqual(tools, []);
        assert.equal(call.isError, true);
        assert.match(call.content[0].text, /gsd plugin is disabled/);
      } else {
        assert.ok(tools.length > 5, `tools: ${tools.length}`);
        assert.notEqual(call.isError, true);
      }
    });
  }

  // Only the copies the npx install registered: the repository's own server
  // (or the plugin's) is never the one that stands down.
  it('a server that is not the npx runtime copy keeps its tools', async (t) => {
    const m = machine(t, STATES.disabled);
    npxInstall(m);
    const { tools } = await mcpSession(join(REPO, 'src', 'server.js'), m);
    assert.ok(tools.length > 5, `tools: ${tools.length}`);
  });

  // Claude Code does not run a disabled plugin's hooks, so the plugin's own
  // copy running means Claude Code has it enabled. Reading enabledPlugins
  // there could only disagree with Claude Code, and silence it.
  it("the plugin's own copy of a hook never reads enabledPlugins", (t) => {
    const m = machine(t, STATES.disabled);
    npxInstall(m);
    const pluginRoot = join(m.claudeDir, 'plugins', 'cache', 'gsd', 'gsd', '0.18.0');
    cpSync(join(REPO, 'hooks'), join(pluginRoot, 'hooks'), { recursive: true });
    execFileSync(process.execPath, [join(pluginRoot, 'hooks', 'gsd-session-stop.cjs')], {
      cwd: m.project,
      encoding: 'utf8',
      timeout: 8000,
      env: { ...process.env, HOME: m.home, CLAUDE_CONFIG_DIR: m.claudeDir, CLAUDE_PLUGIN_ROOT: '', PLUGIN_AUTO_UPDATE: '1', GSD_DEBUG: '' },
    });
    assert.ok(existsSync(join(m.project, '.gsd', '.session-end')), 'the session-end marker');
  });
});

async function mcpSession(serverPath, m) {
  const proc = spawn(process.execPath, [serverPath], {
    cwd: m.project,
    env: { ...process.env, HOME: m.home, CLAUDE_CONFIG_DIR: m.claudeDir, CLAUDE_PLUGIN_ROOT: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const pending = new Map();
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try { const msg = JSON.parse(line); pending.get(msg.id)?.(msg); } catch { /* not JSON-RPC */ }
    }
  });
  let id = 0;
  const request = (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 8000);
    pending.set(n, (msg) => { clearTimeout(timer); resolve(msg); });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  try {
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'disabled-test', version: '0' } });
    const list = await request('tools/list', {});
    const call = await request('tools/call', { name: 'health', arguments: {} });
    return { tools: list.result?.tools ?? [], call: call.result };
  } finally {
    proc.stdin.end();
    proc.kill();
  }
}
