import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function makeClaudeHome(prefix) {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const claudeDir = join(home, '.claude');
  await mkdir(claudeDir, { recursive: true });
  return { home, claudeDir };
}

function runScript(script, home, extraEnv = {}) {
  execFileSync('node', [script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, ...extraEnv },
    encoding: 'utf-8',
  });
}

describe('install and uninstall scripts', () => {
  it('registers hooks against the copied hook file', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-install-');
    try {
      runScript('install.js', home);
      const settings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf-8'));
      const statuslinePath = join(claudeDir, 'hooks', 'gsd-statusline.cjs');
      const contextMonitorPath = join(claudeDir, 'hooks', 'gsd-context-monitor.cjs');
      const serverPath = join(claudeDir, 'gsd', 'src', 'server.js');
      const sdkPath = join(claudeDir, 'gsd', 'node_modules', '@modelcontextprotocol', 'sdk');
      const runtimePackagePath = join(claudeDir, 'gsd', 'package.json');
      // StatusLine is registered as top-level statusLine setting
      assert.deepEqual(settings.statusLine, {
        type: 'command',
        command: `node ${JSON.stringify(statuslinePath)}`,
      });
      assert.equal(settings.hooks.StatusLine, undefined);
      // PostToolUse is registered as array entry in hooks
      assert.ok(Array.isArray(settings.hooks.PostToolUse));
      const gsdHook = settings.hooks.PostToolUse.find(e =>
        e.hooks?.some(h => h.command?.includes('gsd-context-monitor')));
      assert.ok(gsdHook);
      assert.equal(gsdHook.hooks[0].command, `node ${JSON.stringify(contextMonitorPath)}`);
      assert.ok(settings.mcpServers.gsd);
      assert.equal(settings.mcpServers.gsd.args[0], serverPath);
      const statuslineStat = await stat(statuslinePath);
      const contextMonitorStat = await stat(contextMonitorPath);
      const serverStat = await stat(serverPath);
      const sdkStat = await stat(sdkPath);
      const runtimePackageStat = await stat(runtimePackagePath);
      assert.ok(statuslineStat.isFile());
      assert.ok(contextMonitorStat.isFile());
      assert.ok(serverStat.isFile());
      assert.ok(sdkStat.isDirectory());
      assert.ok(runtimePackageStat.isFile());
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('preserves existing non-gsd hooks during install', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-install-existing-');
    try {
      await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({
        statusLine: { type: 'command', command: 'node /custom/status.js' },
        hooks: {
          PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node /custom/post.js' }] }],
        },
      }, null, 2));
      runScript('install.js', home);
      const settings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf-8'));
      // Non-GSD statusLine preserved
      assert.equal(settings.statusLine.command, 'node /custom/status.js');
      // Non-GSD PostToolUse entry preserved, GSD entry added
      const customHook = settings.hooks.PostToolUse.find(e =>
        e.hooks?.some(h => h.command === 'node /custom/post.js'));
      assert.ok(customHook);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('registers GSD in composite statusLine registry when composite is active', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-composite-');
    try {
      // Set up a composite statusLine in settings.json
      await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({
        statusLine: {
          type: 'command',
          command: 'node "/path/to/statusline-composite.js"',
        },
      }, null, 2));

      // Create the composite registry
      const registryDir = join(home, '.cache', 'code-graph');
      await mkdir(registryDir, { recursive: true });
      await writeFile(join(registryDir, 'statusline-registry.json'), JSON.stringify([
        { id: 'code-graph', command: 'node "/path/to/cg-statusline.js"', needsStdin: false },
      ]));

      runScript('install.js', home);

      const settings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf-8'));

      // Composite statusLine should be preserved (not overwritten)
      assert.ok(settings.statusLine.command.includes('statusline-composite'),
        'Composite statusLine should be preserved');

      // GSD should be registered as a provider in the composite registry
      const registry = JSON.parse(await readFile(
        join(registryDir, 'statusline-registry.json'), 'utf-8'));
      const gsdEntry = registry.find(p => p.id === 'gsd');
      assert.ok(gsdEntry, 'GSD should be registered in composite registry');
      assert.ok(gsdEntry.command.includes('gsd-statusline'),
        'GSD command should reference gsd-statusline');
      assert.equal(gsdEntry.needsStdin, true, 'GSD needs stdin for context data');

      // GSD should appear before code-graph in registry
      const gsdIdx = registry.findIndex(p => p.id === 'gsd');
      const cgIdx = registry.findIndex(p => p.id === 'code-graph');
      assert.ok(gsdIdx < cgIdx, 'GSD should appear before code-graph for display priority');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('registers GSD in composite registry even in plugin mode', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-composite-plugin-');
    try {
      // Simulate plugin installation
      const pluginsDir = join(claudeDir, 'plugins');
      await mkdir(pluginsDir, { recursive: true });
      await writeFile(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
        plugins: { 'gsd@gsd': { version: '0.6.0' } },
      }));

      // Set up composite statusLine
      await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({
        statusLine: {
          type: 'command',
          command: 'node "/path/to/statusline-composite.js"',
        },
      }, null, 2));

      // Create composite registry
      const registryDir = join(home, '.cache', 'code-graph');
      await mkdir(registryDir, { recursive: true });
      await writeFile(join(registryDir, 'statusline-registry.json'), JSON.stringify([
        { id: 'code-graph', command: 'node "/path/to/cg-statusline.js"', needsStdin: false },
      ]));

      runScript('install.js', home);

      // GSD should be in composite registry
      const registry = JSON.parse(await readFile(
        join(registryDir, 'statusline-registry.json'), 'utf-8'));
      const gsdEntry = registry.find(p => p.id === 'gsd');
      assert.ok(gsdEntry,
        'Plugin mode should still register GSD in composite statusLine registry');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('removes managed hooks during uninstall', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-uninstall-');
    try {
      runScript('install.js', home);
      runScript('uninstall.js', home);
      const settings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf-8'));
      assert.equal(settings.mcpServers?.gsd, undefined);
      assert.equal(settings.statusLine, undefined);
      const gsdHook = settings.hooks?.PostToolUse?.find(e =>
        e.hooks?.some(h => h.command?.includes('gsd-context-monitor')));
      assert.equal(gsdHook, undefined);
      await assert.rejects(stat(join(claudeDir, 'gsd')));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('removes GSD from composite statusLine registry on uninstall', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-uninstall-composite-');
    try {
      // Set up composite statusLine
      const registryDir = join(home, '.cache', 'code-graph');
      await mkdir(registryDir, { recursive: true });

      // Install with composite active
      await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({
        statusLine: {
          type: 'command',
          command: 'node "/path/to/statusline-composite.js"',
        },
      }, null, 2));
      await writeFile(join(registryDir, 'statusline-registry.json'), JSON.stringify([
        { id: 'code-graph', command: 'node "/path/to/cg-statusline.js"', needsStdin: false },
      ]));

      runScript('install.js', home);

      // Verify GSD was registered
      let registry = JSON.parse(await readFile(
        join(registryDir, 'statusline-registry.json'), 'utf-8'));
      assert.ok(registry.find(p => p.id === 'gsd'),
        'GSD should be registered after install');

      // Uninstall
      runScript('uninstall.js', home);

      // GSD should be removed from composite registry
      registry = JSON.parse(await readFile(
        join(registryDir, 'statusline-registry.json'), 'utf-8'));
      assert.equal(registry.find(p => p.id === 'gsd'), undefined,
        'GSD should be removed from composite registry after uninstall');

      // code-graph entry should be preserved
      assert.ok(registry.find(p => p.id === 'code-graph'),
        'code-graph entry should be preserved after GSD uninstall');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('plugin-mode install', () => {
  it('registers statusLine and hooks in settings.json even when installed as plugin', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-plugin-install-');
    try {
      // Simulate plugin installation by creating installed_plugins.json
      const pluginsDir = join(claudeDir, 'plugins');
      await mkdir(pluginsDir, { recursive: true });
      await writeFile(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
        plugins: { 'gsd@gsd': { version: '0.5.15' } },
      }));

      // Pre-seed settings.json with a stale manual MCP entry
      await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({
        mcpServers: { gsd: { command: 'node', args: ['/old/server.js'] } },
      }, null, 2));

      runScript('install.js', home);
      const settings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf-8'));

      // MCP entry should be removed (plugin .mcp.json handles it)
      assert.equal(settings.mcpServers?.gsd, undefined,
        'Plugin mode should remove manual MCP entry');

      // StatusLine SHOULD be registered (plugin system cannot manage it)
      const statuslinePath = join(claudeDir, 'hooks', 'gsd-statusline.cjs');
      assert.deepEqual(settings.statusLine, {
        type: 'command',
        command: `node ${JSON.stringify(statuslinePath)}`,
      }, 'Plugin mode should still register statusLine in settings.json');

      // Hooks MUST be registered in settings.json (plugin hooks.json auto-loading is unreliable)
      const postToolUse = settings.hooks?.PostToolUse;
      assert.ok(postToolUse, 'PostToolUse hooks should exist');
      const gsdPTU = postToolUse.find(e =>
        e.hooks?.some(h => h.command?.includes('gsd-context-monitor')));
      assert.ok(gsdPTU, 'PostToolUse hook for gsd-context-monitor should be registered');

      const sessionStart = settings.hooks?.SessionStart;
      assert.ok(sessionStart, 'SessionStart hooks should exist');
      const gsdSS = sessionStart.find(e =>
        e.hooks?.some(h => h.command?.includes('gsd-session-init')));
      assert.ok(gsdSS, 'SessionStart hook for gsd-session-init should be registered');

      // Files should still be copied
      const serverPath = join(claudeDir, 'gsd', 'src', 'server.js');
      const hookPath = join(claudeDir, 'hooks', 'gsd-context-monitor.cjs');
      assert.ok((await stat(serverPath)).isFile(), 'Runtime files should still be copied');
      assert.ok((await stat(hookPath)).isFile(), 'Hook scripts should still be copied');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('updates stale hook entries from previous install when reinstalled as plugin', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-plugin-cleanup-');
    try {
      // Simulate plugin installation
      const pluginsDir = join(claudeDir, 'plugins');
      await mkdir(pluginsDir, { recursive: true });
      await writeFile(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
        plugins: { 'gsd@gsd': { version: '0.5.15' } },
      }));

      // Pre-seed settings.json with stale manual hook entries (from a previous non-plugin install)
      const contextMonitorPath = join(claudeDir, 'hooks', 'gsd-context-monitor.cjs');
      const sessionInitPath = join(claudeDir, 'hooks', 'gsd-session-init.cjs');
      const sessionStopPath = join(claudeDir, 'hooks', 'gsd-session-stop.cjs');
      await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({
        mcpServers: {},
        hooks: {
          PostToolUse: [
            { matcher: '*', hooks: [{ type: 'command', command: `node ${JSON.stringify(contextMonitorPath)}` }] },
            { matcher: '*', hooks: [{ type: 'command', command: 'node /custom/other-hook.js' }] },
          ],
          SessionStart: [
            { matcher: 'startup', hooks: [{ type: 'command', command: `node ${JSON.stringify(sessionInitPath)}` }] },
          ],
          Stop: [
            { matcher: '*', hooks: [{ type: 'command', command: `node ${JSON.stringify(sessionStopPath)}` }] },
          ],
        },
      }, null, 2));

      runScript('install.js', home);
      const settings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf-8'));

      // GSD hooks should be updated in-place (not removed)
      const gsdPTU = settings.hooks?.PostToolUse?.find(e =>
        e.hooks?.some(h => h.command?.includes('gsd-context-monitor')));
      assert.ok(gsdPTU, 'gsd-context-monitor hook should still be present (updated)');

      const gsdSS = settings.hooks?.SessionStart?.find(e =>
        e.hooks?.some(h => h.command?.includes('gsd-session-init')));
      assert.ok(gsdSS, 'gsd-session-init hook should still be present (updated)');
      assert.equal(gsdSS.matcher, 'startup|clear|compact',
        'SessionStart matcher should be updated to include clear|compact');

      const gsdStop = settings.hooks?.Stop?.find(e =>
        e.hooks?.some(h => h.command?.includes('gsd-session-stop')));
      assert.ok(gsdStop, 'gsd-session-stop hook should still be present (updated)');

      // Non-GSD hooks should be preserved
      const customHook = settings.hooks?.PostToolUse?.find(e =>
        e.hooks?.some(h => h.command === 'node /custom/other-hook.js'));
      assert.ok(customHook, 'Non-GSD hooks should be preserved');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('cache pruning', () => {
  it('prunes old cache versions keeping latest 3', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-prune-');
    try {
      // Simulate plugin installation
      const pluginsDir = join(claudeDir, 'plugins');
      await mkdir(pluginsDir, { recursive: true });
      await writeFile(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
        plugins: { 'gsd@gsd': { version: '0.5.15' } },
      }));

      // Create cache directory with 5 version subdirectories
      const cacheBase = join(claudeDir, 'plugins', 'cache', 'gsd', 'gsd');
      const versions = ['0.5.10', '0.5.11', '0.5.12', '0.5.13', '0.5.14'];
      for (const ver of versions) {
        await mkdir(join(cacheBase, ver), { recursive: true });
        // Put a marker file so we can verify which ones survive
        await writeFile(join(cacheBase, ver, 'marker.txt'), ver);
      }

      runScript('install.js', home);

      // Check which versions remain
      const remaining = readdirSync(cacheBase).sort();

      // Latest 3 should be kept: 0.5.12, 0.5.13, 0.5.14
      assert.deepEqual(remaining, ['0.5.12', '0.5.13', '0.5.14'],
        `Expected latest 3 versions, got: ${remaining.join(', ')}`);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does not prune when 3 or fewer versions exist', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-prune-few-');
    try {
      // Simulate plugin installation
      const pluginsDir = join(claudeDir, 'plugins');
      await mkdir(pluginsDir, { recursive: true });
      await writeFile(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
        plugins: { 'gsd@gsd': { version: '0.5.12' } },
      }));

      // Create cache directory with only 3 versions
      const cacheBase = join(claudeDir, 'plugins', 'cache', 'gsd', 'gsd');
      const versions = ['0.5.10', '0.5.11', '0.5.12'];
      for (const ver of versions) {
        await mkdir(join(cacheBase, ver), { recursive: true });
        await writeFile(join(cacheBase, ver, 'marker.txt'), ver);
      }

      runScript('install.js', home);

      // All 3 should remain
      const remaining = readdirSync(cacheBase).sort();
      assert.deepEqual(remaining, ['0.5.10', '0.5.11', '0.5.12'],
        `All 3 versions should be kept, got: ${remaining.join(', ')}`);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('sorts versions correctly by semver (not lexicographic)', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-prune-semver-');
    try {
      // Simulate plugin installation
      const pluginsDir = join(claudeDir, 'plugins');
      await mkdir(pluginsDir, { recursive: true });
      await writeFile(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
        plugins: { 'gsd@gsd': { version: '0.6.2' } },
      }));

      // Create versions that would sort differently lexicographically vs semver
      // Lexicographic: 0.5.9 < 0.6.1 < 0.6.10 < 0.6.2
      // Semver:        0.5.9 < 0.6.1 < 0.6.2 < 0.6.10
      const cacheBase = join(claudeDir, 'plugins', 'cache', 'gsd', 'gsd');
      const versions = ['0.5.9', '0.6.1', '0.6.10', '0.6.2'];
      for (const ver of versions) {
        await mkdir(join(cacheBase, ver), { recursive: true });
        await writeFile(join(cacheBase, ver, 'marker.txt'), ver);
      }

      runScript('install.js', home);

      // With semver sort, oldest is 0.5.9, latest 3 are: 0.6.1, 0.6.2, 0.6.10
      const remaining = readdirSync(cacheBase).sort();
      assert.deepEqual(remaining, ['0.6.1', '0.6.10', '0.6.2'],
        `Should keep semver-latest 3 (0.6.1, 0.6.2, 0.6.10), got: ${remaining.join(', ')}`);
      // 0.5.9 should have been pruned
      assert.ok(!existsSync(join(cacheBase, '0.5.9')),
        'Oldest semver version (0.5.9) should be pruned');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does not prune when not in plugin mode', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-prune-noplugin-');
    try {
      // No installed_plugins.json — not plugin mode

      // Create cache directory with many versions
      const cacheBase = join(claudeDir, 'plugins', 'cache', 'gsd', 'gsd');
      const versions = ['0.5.10', '0.5.11', '0.5.12', '0.5.13', '0.5.14'];
      for (const ver of versions) {
        await mkdir(join(cacheBase, ver), { recursive: true });
        await writeFile(join(cacheBase, ver, 'marker.txt'), ver);
      }

      runScript('install.js', home);

      // All should remain since pruning only runs in plugin mode
      const remaining = readdirSync(cacheBase).sort();
      assert.deepEqual(remaining, ['0.5.10', '0.5.11', '0.5.12', '0.5.13', '0.5.14'],
        `Non-plugin mode should not prune, got: ${remaining.join(', ')}`);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
