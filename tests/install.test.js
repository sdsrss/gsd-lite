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

  it('prefers code-graph statusline-chain.js CLI when available', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-chain-cli-');
    try {
      // Composite statusLine is active
      await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({
        statusLine: {
          type: 'command',
          command: 'node "/path/to/statusline-composite.js"',
        },
      }, null, 2));

      // Install a stub statusline-chain.js in code-graph's plugin cache.
      // The stub records its argv to a file, exits 0.
      const chainDir = join(claudeDir, 'plugins', 'cache', 'code-graph-mcp',
        'code-graph-mcp', '0.13.0', 'scripts');
      await mkdir(chainDir, { recursive: true });
      const chainLog = join(home, 'chain-invocations.jsonl');
      const chainScript = join(chainDir, 'statusline-chain.js');
      await writeFile(chainScript,
        `require('node:fs').appendFileSync(${JSON.stringify(chainLog)}, ` +
        `JSON.stringify(process.argv.slice(2)) + '\\n');\n`);

      runScript('install.js', home);

      // Chain CLI should have been invoked with register args, not direct registry write.
      const invocations = (await readFile(chainLog, 'utf-8'))
        .trim().split('\n').map(l => JSON.parse(l));
      const register = invocations.find(a => a[0] === 'register');
      assert.ok(register, 'install should invoke chain CLI register');
      assert.equal(register[1], 'gsd');
      assert.ok(register[2].includes('gsd-statusline.cjs'),
        'register should pass gsd-statusline command');
      assert.equal(register[3], '--stdin');

      // Uninstall should invoke unregister via CLI.
      runScript('uninstall.js', home);
      const after = (await readFile(chainLog, 'utf-8'))
        .trim().split('\n').map(l => JSON.parse(l));
      const unregister = after.find(a => a[0] === 'unregister' && a[1] === 'gsd');
      assert.ok(unregister, 'uninstall should invoke chain CLI unregister');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('falls back to direct registry write when chain CLI is unavailable', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-chain-fallback-');
    try {
      await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({
        statusLine: {
          type: 'command',
          command: 'node "/path/to/statusline-composite.js"',
        },
      }, null, 2));

      const registryDir = join(home, '.cache', 'code-graph');
      await mkdir(registryDir, { recursive: true });
      await writeFile(join(registryDir, 'statusline-registry.json'), JSON.stringify([
        { id: 'code-graph', command: 'node "/path/to/cg-statusline.js"', needsStdin: false },
      ]));

      // Create cache dir but WITHOUT statusline-chain.js — chain-CLI path should
      // return null and fall through to the registry-write path.
      await mkdir(join(claudeDir, 'plugins', 'cache', 'code-graph-mcp',
        'code-graph-mcp', '0.12.0', 'scripts'), { recursive: true });

      runScript('install.js', home);

      const registry = JSON.parse(await readFile(
        join(registryDir, 'statusline-registry.json'), 'utf-8'));
      assert.ok(registry.find(p => p.id === 'gsd'),
        'fallback path should register GSD in cache registry');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('scrubs ghost _previous entries pointing at gsd-statusline (dedup both registries)', async () => {
    // Reproduces the 0.7.4 statusline-duplicated-entry bug: code-graph's
    // composite-takeover moves a pre-existing GSD top-level statusLine into
    // `_previous`, then GSD's registerProvider adds `gsd` without touching
    // `_previous`, producing double-rendering on every install.
    const { home, claudeDir } = await makeClaudeHome('gsd-ghost-scrub-');
    try {
      await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({
        statusLine: {
          type: 'command',
          command: 'node "/path/to/statusline-composite.js"',
        },
      }, null, 2));

      const registryDir = join(home, '.cache', 'code-graph');
      await mkdir(registryDir, { recursive: true });
      const gsdCmd = `node "${join(claudeDir, 'hooks', 'gsd-statusline.cjs')}"`;
      // Pre-seed BOTH registries with ghost _previous AND a stale canonical
      // `gsd` entry (user's real-world state before the fix).
      const seeded = [
        { id: '_previous', command: gsdCmd, needsStdin: true },
        { id: 'code-graph', command: 'node "/p/cg.js"', needsStdin: false },
        { id: 'gsd', command: gsdCmd, needsStdin: true },
      ];
      await writeFile(join(registryDir, 'statusline-registry.json'),
        JSON.stringify(seeded));
      await writeFile(join(claudeDir, 'statusline-providers.json'),
        JSON.stringify(seeded));

      runScript('install.js', home);

      for (const p of [
        join(registryDir, 'statusline-registry.json'),
        join(claudeDir, 'statusline-providers.json'),
      ]) {
        const reg = JSON.parse(await readFile(p, 'utf-8'));
        const gsdEntries = reg.filter(e => (e.command || '').includes('gsd-statusline'));
        assert.equal(gsdEntries.length, 1,
          `${p} should have exactly 1 GSD entry, got ${gsdEntries.length}`);
        assert.equal(gsdEntries[0].id, 'gsd',
          `canonical GSD entry in ${p} must have id=gsd`);
        assert.equal(reg.find(e => e.id === '_previous'), undefined,
          `_previous ghost must be scrubbed from ${p}`);
        // Order: gsd before code-graph
        const gsdIdx = reg.findIndex(e => e.id === 'gsd');
        const cgIdx = reg.findIndex(e => e.id === 'code-graph');
        assert.ok(gsdIdx >= 0 && cgIdx >= 0 && gsdIdx < cgIdx,
          `gsd must precede code-graph in ${p}`);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('normalizes providers mirror even when chain CLI owns the primary registry', async () => {
    // Exercises the path where chain CLI registers in the primary cache
    // registry but the ~/.claude/statusline-providers.json mirror has a
    // stale ghost. Post-scrub must normalize the mirror regardless.
    const { home, claudeDir } = await makeClaudeHome('gsd-mirror-scrub-');
    try {
      await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({
        statusLine: {
          type: 'command',
          command: 'node "/path/to/statusline-composite.js"',
        },
      }, null, 2));

      const gsdCmd = `node "${join(claudeDir, 'hooks', 'gsd-statusline.cjs')}"`;

      // Install a stub chain CLI that ONLY writes to the primary registry —
      // it registers `gsd` without touching the mirror. This simulates
      // code-graph's real CLI behaviour pre-fix.
      const chainDir = join(claudeDir, 'plugins', 'cache', 'code-graph-mcp',
        'code-graph-mcp', '0.16.4', 'scripts');
      await mkdir(chainDir, { recursive: true });
      const registryDir = join(home, '.cache', 'code-graph');
      await mkdir(registryDir, { recursive: true });
      const primaryPath = join(registryDir, 'statusline-registry.json');
      await writeFile(join(chainDir, 'statusline-chain.js'),
        `const fs = require('node:fs');
         const p = ${JSON.stringify(primaryPath)};
         let reg; try { reg = JSON.parse(fs.readFileSync(p,'utf8')); } catch { reg = []; }
         const idx = reg.findIndex(e => e.id === process.argv[3]);
         const entry = { id: process.argv[3], command: process.argv[4], needsStdin: process.argv[5] === '--stdin' };
         if (idx >= 0) reg[idx] = entry; else reg.unshift(entry);
         fs.writeFileSync(p, JSON.stringify(reg));`);

      // Seed primary with just code-graph (chain CLI will add gsd via register).
      await writeFile(primaryPath,
        JSON.stringify([{ id: 'code-graph', command: 'node "/p/cg.js"', needsStdin: false }]));
      // Seed mirror with a ghost _previous pointing at GSD (no canonical gsd yet).
      await writeFile(join(claudeDir, 'statusline-providers.json'),
        JSON.stringify([
          { id: '_previous', command: gsdCmd, needsStdin: true },
          { id: 'code-graph', command: 'node "/p/cg.js"', needsStdin: false },
        ]));

      runScript('install.js', home);

      const mirror = JSON.parse(await readFile(
        join(claudeDir, 'statusline-providers.json'), 'utf-8'));
      assert.equal(mirror.find(e => e.id === '_previous'), undefined,
        '_previous ghost must be scrubbed from mirror even when chain CLI owns primary');
      const gsdInMirror = mirror.filter(e => (e.command || '').includes('gsd-statusline'));
      assert.equal(gsdInMirror.length, 1,
        'mirror should end with exactly 1 GSD entry');
      assert.equal(gsdInMirror[0].id, 'gsd');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('plugin-mode install: user-scope copy suppression', () => {
  it('does NOT write user-scope copies of commands/agents/workflows/references when installed as plugin', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-plugin-noscope-');
    try {
      const pluginsDir = join(claudeDir, 'plugins');
      await mkdir(pluginsDir, { recursive: true });
      await writeFile(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
        plugins: { 'gsd@gsd': { version: '0.7.3' } },
      }));

      runScript('install.js', home);

      // These 4 dirs are served by the plugin system from
      // ~/.claude/plugins/cache/gsd/gsd/<ver>/ — writing user-scope copies
      // duplicates slash-command registration and silently drifts.
      for (const sub of ['commands/gsd', 'agents/gsd', 'workflows/gsd', 'references/gsd']) {
        assert.ok(
          !existsSync(join(claudeDir, sub)),
          `plugin mode should not write ${sub}/ (plugin system already serves it from cache)`,
        );
      }
      // Runtime (MCP server) still copied — that's a separate concern.
      assert.ok(existsSync(join(claudeDir, 'gsd', 'src', 'server.js')),
        'runtime src should still be copied in plugin mode');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('removes legacy user-scope copies left by earlier install.js versions', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-plugin-cleanup-legacy-');
    try {
      const pluginsDir = join(claudeDir, 'plugins');
      await mkdir(pluginsDir, { recursive: true });
      await writeFile(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
        plugins: { 'gsd@gsd': { version: '0.7.3' } },
      }));

      // Simulate pre-existing stale user-scope copies from a previous install.js
      for (const [sub, marker] of [
        ['commands/gsd', 'stale-doctor.md'],
        ['agents/gsd', 'stale-agent.md'],
        ['workflows/gsd', 'stale-flow.md'],
        ['references/gsd', 'stale-ref.md'],
      ]) {
        const dir = join(claudeDir, sub);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, marker), 'legacy content v0.6.x');
      }

      runScript('install.js', home);

      for (const sub of ['commands/gsd', 'agents/gsd', 'workflows/gsd', 'references/gsd']) {
        assert.ok(
          !existsSync(join(claudeDir, sub)),
          `plugin mode should clean up legacy ${sub}/ from prior non-plugin installs`,
        );
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('still writes user-scope copies in non-plugin (npx/manual) mode', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-manual-scope-');
    try {
      // No installed_plugins.json → non-plugin mode
      runScript('install.js', home);

      // User-scope copies are the only command-delivery path in npx/manual mode
      assert.ok(existsSync(join(claudeDir, 'commands', 'gsd', 'start.md')),
        'non-plugin mode must still write commands/gsd/');
      assert.ok(existsSync(join(claudeDir, 'agents', 'gsd')),
        'non-plugin mode must still write agents/gsd/');
      assert.ok(existsSync(join(claudeDir, 'workflows', 'gsd')),
        'non-plugin mode must still write workflows/gsd/');
      assert.ok(existsSync(join(claudeDir, 'references', 'gsd')),
        'non-plugin mode must still write references/gsd/');
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

  it('ignores non-semver directory names during pruning', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-prune-nonsemver-');
    try {
      // Simulate plugin installation
      const pluginsDir = join(claudeDir, 'plugins');
      await mkdir(pluginsDir, { recursive: true });
      await writeFile(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
        plugins: { 'gsd@gsd': { version: '0.5.14' } },
      }));

      // Create cache with mix of valid semver and non-semver entries
      const cacheBase = join(claudeDir, 'plugins', 'cache', 'gsd', 'gsd');
      const versions = ['0.5.10', '0.5.11', '0.5.12', '0.5.13', '0.5.14'];
      for (const ver of versions) {
        await mkdir(join(cacheBase, ver), { recursive: true });
        await writeFile(join(cacheBase, ver, 'marker.txt'), ver);
      }
      // Create non-semver directory (path traversal attempt)
      await mkdir(join(cacheBase, '..%2F..%2Fetc'), { recursive: true });
      await mkdir(join(cacheBase, 'not-a-version'), { recursive: true });

      runScript('install.js', home);

      // Non-semver dirs should be untouched
      const remaining = readdirSync(cacheBase).sort();
      assert.ok(remaining.includes('..%2F..%2Fetc'),
        'Non-semver directory should not be touched by pruning');
      assert.ok(remaining.includes('not-a-version'),
        'Non-semver directory should not be touched by pruning');
      // Latest 3 semver should remain
      assert.ok(remaining.includes('0.5.12'));
      assert.ok(remaining.includes('0.5.13'));
      assert.ok(remaining.includes('0.5.14'));
      // Old semver should be pruned
      assert.ok(!remaining.includes('0.5.10'), '0.5.10 should be pruned');
      assert.ok(!remaining.includes('0.5.11'), '0.5.11 should be pruned');
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
