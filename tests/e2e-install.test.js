import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

// --- Shared helpers ---

async function makeClaudeHome(prefix) {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const claudeDir = join(home, '.claude');
  await mkdir(claudeDir, { recursive: true });
  return { home, claudeDir };
}

function runInstall(home, extraEnv = {}) {
  execFileSync('node', [join(PROJECT_ROOT, 'install.js')], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, HOME: home, ...extraEnv },
    encoding: 'utf-8',
  });
}

function runUninstall(home, extraEnv = {}) {
  execFileSync('node', [join(PROJECT_ROOT, 'uninstall.js')], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, HOME: home, ...extraEnv },
    encoding: 'utf-8',
  });
}

async function setupPluginMode(claudeDir) {
  const pluginsDir = join(claudeDir, 'plugins');
  await mkdir(pluginsDir, { recursive: true });
  await writeFile(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
    plugins: { 'gsd@gsd': { version: '0.6.0' } },
  }));
}

async function readSettings(claudeDir) {
  return JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf-8'));
}

// --- Shared assertions ---

async function assertInstallTree(claudeDir) {
  // Commands
  const cmds = await readdir(join(claudeDir, 'commands', 'gsd'));
  assert.deepEqual(cmds.sort(), ['doctor.md', 'prd.md', 'resume.md', 'start.md', 'status.md', 'stop.md'],
    'All 6 commands should be installed');

  // Agents
  const agents = await readdir(join(claudeDir, 'agents', 'gsd'));
  assert.deepEqual(agents.sort(), ['debugger.md', 'executor.md', 'researcher.md', 'reviewer.md'],
    'All 4 agents should be installed');

  // Workflows
  const wf = await readdir(join(claudeDir, 'workflows', 'gsd'));
  assert.equal(wf.length, 6, 'All 6 workflows should be installed');

  // References
  const refs = await readdir(join(claudeDir, 'references', 'gsd'));
  assert.equal(refs.length, 8, 'All 8 references should be installed');

  // Hooks
  const hookNames = [
    'gsd-session-init.cjs', 'gsd-auto-update.cjs', 'gsd-context-monitor.cjs',
    'gsd-statusline.cjs', 'gsd-session-stop.cjs',
  ];
  for (const h of hookNames) {
    const s = await stat(join(claudeDir, 'hooks', h));
    assert.ok(s.isFile(), `Hook ${h} should exist`);
  }

  // Hook libs
  for (const lib of ['gsd-finder.cjs', 'semver-sort.cjs', 'statusline-composite.cjs']) {
    const s = await stat(join(claudeDir, 'hooks', 'lib', lib));
    assert.ok(s.isFile(), `Hook lib ${lib} should exist`);
  }

  // Runtime
  const serverStat = await stat(join(claudeDir, 'gsd', 'src', 'server.js'));
  assert.ok(serverStat.isFile(), 'Runtime server.js should exist');
  const pkgStat = await stat(join(claudeDir, 'gsd', 'package.json'));
  assert.ok(pkgStat.isFile(), 'Runtime package.json should exist');
  const sdkStat = await stat(join(claudeDir, 'gsd', 'node_modules', '@modelcontextprotocol', 'sdk'));
  assert.ok(sdkStat.isDirectory(), 'Runtime @modelcontextprotocol/sdk should exist');
}

function assertSettingsHooks(settings) {
  // SessionStart
  const ss = settings.hooks?.SessionStart;
  assert.ok(Array.isArray(ss), 'SessionStart should be array');
  const gsdSS = ss.find(e => e.hooks?.some(h => h.command?.includes('gsd-session-init')));
  assert.ok(gsdSS, 'SessionStart should have gsd-session-init');
  assert.equal(gsdSS.matcher, 'startup|clear|compact');
  assert.equal(gsdSS.hooks[0].timeout, 5);

  // PostToolUse
  const ptu = settings.hooks?.PostToolUse;
  assert.ok(Array.isArray(ptu), 'PostToolUse should be array');
  const gsdPTU = ptu.find(e => e.hooks?.some(h => h.command?.includes('gsd-context-monitor')));
  assert.ok(gsdPTU, 'PostToolUse should have gsd-context-monitor');

  // Stop
  const stop = settings.hooks?.Stop;
  assert.ok(Array.isArray(stop), 'Stop should be array');
  const gsdStop = stop.find(e => e.hooks?.some(h => h.command?.includes('gsd-session-stop')));
  assert.ok(gsdStop, 'Stop should have gsd-session-stop');
  assert.equal(gsdStop.hooks[0].timeout, 3);
}

function assertHooksLoadable(claudeDir) {
  const _require = createRequire(import.meta.url);
  for (const h of ['gsd-finder.cjs', 'semver-sort.cjs', 'statusline-composite.cjs']) {
    const mod = _require(join(claudeDir, 'hooks', 'lib', h));
    assert.ok(mod, `Hook lib ${h} should be loadable`);
  }
}

async function assertCleanUninstall(claudeDir) {
  // GSD directories should not exist
  for (const dir of ['commands/gsd', 'agents/gsd', 'workflows/gsd', 'references/gsd', 'gsd']) {
    assert.ok(!existsSync(join(claudeDir, dir)), `${dir}/ should be removed`);
  }
  // Hook files should not exist
  for (const h of ['gsd-session-init.cjs', 'gsd-auto-update.cjs', 'gsd-context-monitor.cjs',
    'gsd-statusline.cjs', 'gsd-session-stop.cjs']) {
    assert.ok(!existsSync(join(claudeDir, 'hooks', h)), `hooks/${h} should be removed`);
  }
  // Hook libs should not exist
  for (const lib of ['gsd-finder.cjs', 'semver-sort.cjs', 'statusline-composite.cjs']) {
    assert.ok(!existsSync(join(claudeDir, 'hooks', 'lib', lib)), `hooks/lib/${lib} should be removed`);
  }
  // settings.json should have no GSD entries
  if (existsSync(join(claudeDir, 'settings.json'))) {
    const settings = await readSettings(claudeDir);
    assert.equal(settings.mcpServers?.gsd, undefined, 'mcpServers.gsd should be removed');
    assert.equal(settings.statusLine, undefined, 'statusLine should be removed');
    const gsdHooks = ['gsd-session-init', 'gsd-context-monitor', 'gsd-session-stop'];
    for (const hookType of ['SessionStart', 'PostToolUse', 'Stop']) {
      const arr = settings.hooks?.[hookType];
      if (arr) {
        const found = arr.find(e => e.hooks?.some(h =>
          gsdHooks.some(id => h.command?.includes(id))));
        assert.equal(found, undefined, `${hookType} should have no GSD entries`);
      }
    }
  }
}

async function assertMcpServerStarts(serverPath) {
  const child = spawn('node', [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: tmpdir() },
  });

  const initRequest = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e-test', version: '1.0.0' },
    },
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('MCP server did not respond within 10s'));
    }, 10000);

    let buf = '';
    child.stdout.on('data', (data) => {
      buf += data.toString();
      const lines = buf.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1 && msg.result) {
            clearTimeout(timeout);
            assert.ok(msg.result.serverInfo, 'Server should return serverInfo');
            assert.equal(msg.result.serverInfo.name, 'gsd');
            child.kill();
            resolve();
            return;
          }
        } catch { /* partial line, continue buffering */ }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.stdin.write(initRequest + '\n');
  });
}
