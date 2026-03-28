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

// ============================================================
// Layer A: Simulated install (fast CI)
// ============================================================

describe('Layer A: manual/npm install E2E', () => {
  let home, claudeDir;

  before(async () => {
    ({ home, claudeDir } = await makeClaudeHome('gsd-e2e-manual-'));
    runInstall(home);
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('installs all 9 units to correct locations', async () => {
    await assertInstallTree(claudeDir);
  });

  it('registers MCP server in settings.json', async () => {
    const settings = await readSettings(claudeDir);
    assert.ok(settings.mcpServers?.gsd, 'mcpServers.gsd should exist');
    assert.equal(settings.mcpServers.gsd.command, 'node');
    assert.ok(settings.mcpServers.gsd.args[0].endsWith('server.js'),
      'MCP args should point to server.js');
  });

  it('registers statusLine in settings.json', async () => {
    const settings = await readSettings(claudeDir);
    assert.ok(settings.statusLine, 'statusLine should exist');
    assert.equal(settings.statusLine.type, 'command');
    assert.ok(settings.statusLine.command.includes('gsd-statusline'),
      'statusLine should reference gsd-statusline');
  });

  it('registers all 3 hook types in settings.json', async () => {
    const settings = await readSettings(claudeDir);
    assertSettingsHooks(settings);
  });

  it('installed hook libs are loadable via require()', () => {
    assertHooksLoadable(claudeDir);
  });

  it('installed MCP server can start and respond to initialize', async () => {
    const serverPath = join(claudeDir, 'gsd', 'src', 'server.js');
    await assertMcpServerStarts(serverPath);
  });
});

describe('Layer A: npx install E2E (npm ci fallback)', { timeout: 60000 }, () => {
  let home, claudeDir, npxSimDir;

  before(async () => {
    ({ home, claudeDir } = await makeClaudeHome('gsd-e2e-npx-'));

    // Create a copy of the project without node_modules to simulate npx
    npxSimDir = await mkdtemp(join(tmpdir(), 'gsd-npx-sim-'));
    const filesToCopy = [
      'install.js', 'uninstall.js', 'package.json', 'package-lock.json',
    ];
    const dirsToCopy = [
      'commands', 'agents', 'workflows', 'references', 'hooks', 'src',
    ];
    for (const f of filesToCopy) {
      const content = await readFile(join(PROJECT_ROOT, f));
      await writeFile(join(npxSimDir, f), content);
    }
    for (const d of dirsToCopy) {
      await mkdir(join(npxSimDir, d), { recursive: true });
      const entries = await readdir(join(PROJECT_ROOT, d), { withFileTypes: true });
      for (const entry of entries) {
        const src = join(PROJECT_ROOT, d, entry.name);
        const dest = join(npxSimDir, d, entry.name);
        if (entry.isDirectory()) {
          execSync(`cp -r ${JSON.stringify(src)} ${JSON.stringify(dest)}`);
        } else {
          const content = await readFile(src);
          await writeFile(dest, content);
        }
      }
    }

    // Run install.js from the npx-sim dir (no node_modules present)
    execFileSync('node', [join(npxSimDir, 'install.js')], {
      cwd: npxSimDir,
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
      timeout: 55000,
    });
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(npxSimDir, { recursive: true, force: true });
  });

  it('installs runtime dependencies via npm ci when node_modules absent', async () => {
    const sdkPath = join(claudeDir, 'gsd', 'node_modules', '@modelcontextprotocol', 'sdk');
    const sdkStat = await stat(sdkPath);
    assert.ok(sdkStat.isDirectory(),
      'npm ci should have installed @modelcontextprotocol/sdk');
  });

  it('installs all files same as manual mode', async () => {
    await assertInstallTree(claudeDir);
  });

  it('registers MCP server (not plugin mode)', async () => {
    const settings = await readSettings(claudeDir);
    assert.ok(settings.mcpServers?.gsd, 'mcpServers.gsd should exist in npx mode');
  });
});

describe('Layer A: plugin install E2E', () => {
  let home, claudeDir;

  before(async () => {
    ({ home, claudeDir } = await makeClaudeHome('gsd-e2e-plugin-'));
    await setupPluginMode(claudeDir);
    runInstall(home);
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('does NOT register mcpServers.gsd in settings.json', async () => {
    const settings = await readSettings(claudeDir);
    assert.equal(settings.mcpServers?.gsd, undefined,
      'Plugin mode should not register MCP in settings.json');
  });

  it('still registers statusLine in settings.json', async () => {
    const settings = await readSettings(claudeDir);
    assert.ok(settings.statusLine, 'statusLine should still be registered in plugin mode');
    assert.ok(settings.statusLine.command.includes('gsd-statusline'));
  });

  it('still registers all 3 hook types in settings.json', async () => {
    const settings = await readSettings(claudeDir);
    assertSettingsHooks(settings);
  });

  it('installs all files to correct locations', async () => {
    await assertInstallTree(claudeDir);
  });

  it('prunes old cache versions keeping latest 3', async () => {
    // Set up 5 cache versions
    const cacheBase = join(claudeDir, 'plugins', 'cache', 'gsd', 'gsd');
    for (const ver of ['0.5.1', '0.5.2', '0.5.3', '0.5.4', '0.5.5']) {
      await mkdir(join(cacheBase, ver), { recursive: true });
      await writeFile(join(cacheBase, ver, 'marker.txt'), ver);
    }
    // Re-run install to trigger pruning
    runInstall(home);
    const remaining = (await readdir(cacheBase)).filter(d => /^\d+\.\d+\.\d+$/.test(d)).sort();
    assert.deepEqual(remaining, ['0.5.3', '0.5.4', '0.5.5'],
      'Should keep latest 3 semver versions');
  });
});

describe('Layer A: uninstall E2E (manual mode)', () => {
  let home, claudeDir;

  before(async () => {
    ({ home, claudeDir } = await makeClaudeHome('gsd-e2e-uninstall-manual-'));
    runInstall(home);
    runUninstall(home);
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('removes all GSD files and settings entries', async () => {
    await assertCleanUninstall(claudeDir);
  });

  it('preserves non-GSD hooks during uninstall', async () => {
    // Set up fresh with a non-GSD hook present
    await rm(home, { recursive: true, force: true });
    ({ home, claudeDir } = await makeClaudeHome('gsd-e2e-uninstall-preserve-'));
    // Pre-seed non-GSD hook
    await mkdir(join(claudeDir), { recursive: true });
    await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: '*', hooks: [{ type: 'command', command: 'node /custom/hook.js' }] },
        ],
      },
    }, null, 2));
    runInstall(home);
    runUninstall(home);

    const settings = await readSettings(claudeDir);
    const customHook = settings.hooks?.PostToolUse?.find(e =>
      e.hooks?.some(h => h.command === 'node /custom/hook.js'));
    assert.ok(customHook, 'Non-GSD hook should be preserved after uninstall');
  });
});

describe('Layer A: uninstall E2E (plugin mode)', () => {
  let home, claudeDir;

  before(async () => {
    ({ home, claudeDir } = await makeClaudeHome('gsd-e2e-uninstall-plugin-'));
    await setupPluginMode(claudeDir);
    // Create plugin dirs that uninstall should clean
    await mkdir(join(claudeDir, 'plugins', 'marketplaces', 'gsd'), { recursive: true });
    await mkdir(join(claudeDir, 'plugins', 'cache', 'gsd', 'gsd', '0.6.0'), { recursive: true });
    runInstall(home);
    runUninstall(home);
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('removes all GSD files and settings entries', async () => {
    await assertCleanUninstall(claudeDir);
  });

  it('removes plugin directories (marketplaces + cache)', async () => {
    assert.ok(!existsSync(join(claudeDir, 'plugins', 'marketplaces', 'gsd')),
      'plugins/marketplaces/gsd/ should be removed');
    assert.ok(!existsSync(join(claudeDir, 'plugins', 'cache', 'gsd')),
      'plugins/cache/gsd/ should be removed');
  });

  it('removes gsd entry from installed_plugins.json', async () => {
    const pluginsFile = join(claudeDir, 'plugins', 'installed_plugins.json');
    if (existsSync(pluginsFile)) {
      const data = JSON.parse(await readFile(pluginsFile, 'utf-8'));
      assert.equal(data.plugins?.['gsd@gsd'], undefined,
        'gsd@gsd should be removed from installed_plugins.json');
    }
  });
});

describe('Layer A: install idempotency', () => {
  let home, claudeDir;

  before(async () => {
    ({ home, claudeDir } = await makeClaudeHome('gsd-e2e-idempotent-'));
    runInstall(home);
    runInstall(home); // second install
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('second install does not duplicate hook entries', async () => {
    const settings = await readSettings(claudeDir);

    for (const [hookType, id] of [
      ['SessionStart', 'gsd-session-init'],
      ['PostToolUse', 'gsd-context-monitor'],
      ['Stop', 'gsd-session-stop'],
    ]) {
      const arr = settings.hooks?.[hookType] || [];
      const gsdEntries = arr.filter(e => e.hooks?.some(h => h.command?.includes(id)));
      assert.equal(gsdEntries.length, 1,
        `${hookType} should have exactly 1 ${id} entry after double install, got ${gsdEntries.length}`);
    }
  });

  it('second install keeps all files intact', async () => {
    await assertInstallTree(claudeDir);
  });

  it('MCP server still works after double install', async () => {
    const serverPath = join(claudeDir, 'gsd', 'src', 'server.js');
    await assertMcpServerStarts(serverPath);
  });
});
