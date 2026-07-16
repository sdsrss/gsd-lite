import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ============================================================
// Driven plugin E2E: unlike e2e-install.test.js (which asserts the
// installed FILE TREE), this test simulates a real user's plugin session —
// it populates the plugin cache the way `/plugin install gsd@gsd` does, boots
// the MCP server through the true `.mcp.json` entry point (launcher.js), drives
// real slash-command flows over JSON-RPC (/gsd:status → health, /gsd:start →
// state-init), and renders the statusLine hook from the resulting live state.
// It verifies the plugin is USABLE end-to-end, not merely present on disk.
// ============================================================

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

// Files/dirs Claude Code copies into plugins/cache/gsd/gsd/<version>/ from the
// marketplace source (`.` = repo root). node_modules is copied so launcher.js
// skips its runtime `npm install` (kept fast + offline).
const CACHE_ITEMS = [
  'commands', 'agents', 'workflows', 'references', 'hooks', 'src',
  '.claude-plugin', 'launcher.js', 'install.js', 'uninstall.js',
  '.mcp.json', 'package.json', 'package-lock.json', 'node_modules',
];

const HOOK_FILES = [
  'gsd-session-init.cjs', 'gsd-auto-update.cjs', 'gsd-context-monitor.cjs',
  'gsd-statusline.cjs', 'gsd-session-stop.cjs',
];

/**
 * Drive a stdio MCP server through a fixed list of JSON-RPC requests. Resolves
 * once every request id has a response (or rejects on a 20s timeout, surfacing
 * captured stderr for diagnosis).
 */
function driveMcp(command, args, requests, opts) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
    const responses = new Map();
    const pending = new Set(requests.map(r => r.id));
    let buf = '';
    let stderr = '';
    const finish = () => { try { child.kill(); } catch { /* already dead */ } };
    const timer = setTimeout(() => {
      finish();
      reject(new Error(`MCP session timed out; stderr: ${stderr.slice(0, 400)}`));
    }, 20000);

    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.stdout.on('data', d => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null) { responses.set(msg.id, msg); pending.delete(msg.id); }
        } catch { /* partial line — keep buffering */ }
      }
      if (pending.size === 0) { clearTimeout(timer); finish(); resolvePromise({ responses, stderr }); }
    });

    for (const req of requests) child.stdin.write(JSON.stringify(req) + '\n');
  });
}

function toolBody(response) {
  try { return JSON.parse(response?.result?.content?.[0]?.text || '{}'); } catch { return {}; }
}

describe('Driven plugin E2E: /plugin install → MCP tools → statusLine', { timeout: 60000 }, () => {
  let home, claudeDir, cacheRoot, version, projectDir;
  let settings, installOutput;
  let mcp, healthBody, startBody, stateJson, statuslineOut;

  before(async () => {
    version = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8')).version;
    home = await mkdtemp(join(tmpdir(), 'gsd-driven-e2e-'));
    claudeDir = join(home, '.claude');
    await mkdir(claudeDir, { recursive: true });
    const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeDir };

    // STEP 1 — simulate `/plugin marketplace add` + `/plugin install gsd@gsd`:
    // Claude Code copies the plugin into the versioned cache and records it.
    cacheRoot = join(claudeDir, 'plugins', 'cache', 'gsd', 'gsd', version);
    await mkdir(cacheRoot, { recursive: true });
    for (const item of CACHE_ITEMS) {
      const src = join(PROJECT_ROOT, item);
      if (existsSync(src)) cpSync(src, join(cacheRoot, item), { recursive: true });
    }
    await mkdir(join(claudeDir, 'plugins', 'marketplaces', 'gsd'), { recursive: true });
    cpSync(join(PROJECT_ROOT, '.claude-plugin'), join(claudeDir, 'plugins', 'marketplaces', 'gsd', '.claude-plugin'), { recursive: true });
    await writeFile(join(claudeDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'gsd@gsd': { version, source: 'gsd' } } }, null, 2));

    // STEP 2 — first session: GSD's install.js wires settings.json (plugin mode).
    installOutput = execFileSync('node', [join(cacheRoot, 'install.js')], { cwd: cacheRoot, env, encoding: 'utf8' });
    settings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'));

    // STEP 3+4 — boot the MCP server via launcher.js (the .mcp.json entry) and
    // drive a realistic session: initialize → tools/list → /gsd:status → /gsd:start.
    projectDir = await mkdtemp(join(tmpdir(), 'gsd-driven-project-'));
    ({ responses: mcp } = await driveMcp('node', [join(cacheRoot, 'launcher.js')], [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e-user', version: '1.0.0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'health', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'state-init', arguments: { project: 'demo-app', phases: [{ name: 'Foundation', tasks: [{ name: 'scaffold repo', level: 'L1' }] }] } } },
    ], { cwd: projectDir, env: { ...env, CLAUDE_PLUGIN_ROOT: cacheRoot } }));
    healthBody = toolBody(mcp.get(3));
    startBody = toolBody(mcp.get(4));
    const statePath = join(projectDir, '.gsd', 'state.json');
    stateJson = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;

    // STEP 5 — render the statusLine hook from the live project state.
    statuslineOut = execFileSync('node', [join(claudeDir, 'hooks', 'gsd-statusline.cjs')], {
      cwd: projectDir,
      env,
      input: JSON.stringify({
        session_id: 'e2e-driven-session',
        workspace: { current_dir: projectDir },
        model: { display_name: 'Sonnet' },
        context_window: { remaining_percentage: 82 },
      }),
      encoding: 'utf8',
      timeout: 5000,
    });
  });

  after(async () => {
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
    if (home) await rm(home, { recursive: true, force: true });
  });

  // ── STEP 1: plugin install ────────────────────────────────
  it('registers gsd@gsd and exposes all 6 slash commands from the plugin cache', async () => {
    const installed = JSON.parse(await readFile(join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8'));
    assert.ok(installed.plugins?.['gsd@gsd'], 'installed_plugins.json should register gsd@gsd');
    const cmds = (await readdir(join(cacheRoot, 'commands'))).filter(f => f.endsWith('.md')).map(f => f.replace('.md', '')).sort();
    assert.deepEqual(cmds, ['doctor', 'prd', 'resume', 'start', 'status', 'stop'], 'all 6 slash commands present in cache');
  });

  it('cache plugin.json identifies the plugin and .mcp.json boots via launcher.js', async () => {
    const pj = JSON.parse(await readFile(join(cacheRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(pj.name, 'gsd');
    assert.equal(pj.version, version);
    const mcpJson = JSON.parse(await readFile(join(cacheRoot, '.mcp.json'), 'utf8'));
    assert.ok((mcpJson.mcpServers?.gsd?.args || []).some(a => a.includes('launcher.js')),
      '.mcp.json should launch the MCP server via launcher.js');
  });

  // ── STEP 2: plugin-mode wiring ────────────────────────────
  it('plugin mode does NOT create a duplicate manual MCP entry or user-scope commands', () => {
    assert.equal(settings.mcpServers?.gsd, undefined, 'plugin mode: MCP served by .mcp.json, not settings.json');
    assert.ok(!existsSync(join(claudeDir, 'commands', 'gsd')), 'plugin mode: no user-scope commands/gsd copy');
    assert.ok(installOutput.includes('installed successfully'), 'installer reports success');
  });

  it('wires statusLine + all 3 hook types and copies all 5 hook scripts', () => {
    assert.ok(settings.statusLine?.command?.includes('gsd-statusline'), 'statusLine registered');
    const hasHook = (t, id) => settings.hooks?.[t]?.some(e => e.hooks?.some(h => h.command?.includes(id)));
    assert.ok(hasHook('SessionStart', 'gsd-session-init'), 'SessionStart hook wired');
    assert.ok(hasHook('PostToolUse', 'gsd-context-monitor'), 'PostToolUse hook wired');
    assert.ok(hasHook('Stop', 'gsd-session-stop'), 'Stop hook wired');
    for (const h of HOOK_FILES) {
      assert.ok(existsSync(join(claudeDir, 'hooks', h)), `hook script ${h} copied`);
    }
  });

  // ── STEP 3: MCP boot via launcher.js ──────────────────────
  it('boots the MCP server via launcher.js and lists the 11 GSD tools', () => {
    const init = mcp.get(1);
    assert.equal(init?.result?.serverInfo?.name, 'gsd', 'initialize returns serverInfo.name = gsd');
    const tools = (mcp.get(2)?.result?.tools || []).map(t => t.name);
    assert.equal(tools.length, 11, `tools/list returns 11 tools, got ${tools.length}`);
    assert.ok(tools.includes('health') && tools.includes('state-init'), 'core tools present');
  });

  // ── STEP 4: driven command flows ──────────────────────────
  it('/gsd:status on a fresh install reports health ok with no project', () => {
    assert.equal(healthBody.status, 'ok', 'health status ok');
    assert.equal(healthBody.state_exists, false, 'no project state yet on fresh install');
  });

  it('/gsd:start initializes state.json with the declared project and phase', () => {
    assert.ok(startBody.success === true || startBody.state, 'state-init succeeds');
    assert.ok(stateJson, '.gsd/state.json written into the project dir');
    assert.equal(stateJson.project, 'demo-app', 'state records project name');
    assert.ok(stateJson.schema_version, 'state records schema_version');
    assert.ok(Array.isArray(stateJson.phases) && stateJson.phases.some(p => p.name === 'Foundation'),
      'declared phase seeded into state');
  });

  // ── STEP 5: statusLine renders live state ─────────────────
  it('statusLine hook renders a non-empty line from the live project state', () => {
    assert.ok(statuslineOut.trim().length > 0, 'statusLine emits output');
    assert.ok(statuslineOut.includes('Sonnet'), 'statusLine reflects the model name');
  });
});
