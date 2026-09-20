// Editing settings.json hooks without destroying other tools' hooks.
//
// Claude Code groups hooks by matcher, and several tools routinely share a
// group. Four call sites — install.js registering, uninstall.js removing, and
// the orphan cleanup inside gsd-session-init.cjs — each edited at GROUP
// granularity and each silently deleted any co-located hook. They now share
// hooks/lib/hook-registry.cjs; these tests pin the shared behaviour and then
// re-check it through the call sites, because a correct helper that one call
// site bypasses is not a fix.
//
// The second half covers the duplicate-registration case: a user who ran
// `npx gsd-lite install` and then installed the plugin has both registrations.
// Neither is deleted — the redundant copy stands down instead, because the
// settings.json registration is the only GSD code that survives a
// `/plugin uninstall` and removing it strands the user silently.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { cpSync, existsSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const _require = createRequire(import.meta.url);
const { removeHookEntry, upsertHookEntry } = _require('../hooks/lib/hook-registry.cjs');

const FOREIGN = { type: 'command', command: 'node "/opt/othertool/audit.js"' };
const OURS = { type: 'command', command: 'node "/home/x/.claude/hooks/gsd-context-monitor.cjs"' };

async function makeClaudeHome(prefix) {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const claudeDir = join(home, '.claude');
  await mkdir(claudeDir, { recursive: true });
  return { home, claudeDir };
}

/**
 * Register a plugin the way Claude Code does: a registry entry carrying
 * installPath, and a cache directory holding hooks/hooks.json. `manifest`
 * picks what that file contains, because "installed" and "serving hooks" are
 * different things and the guard has to tell them apart.
 */
async function markPluginInstalled(claudeDir, { id = 'gsd@gsd', version = '0.10.0', manifest = 'real' } = {}) {
  const installPath = join(claudeDir, 'plugins', 'cache', 'gsd', 'gsd', version);
  await mkdir(join(installPath, 'hooks'), { recursive: true });
  const manifestPath = join(installPath, 'hooks', 'hooks.json');
  if (manifest === 'real') {
    cpSync(join(PROJECT_ROOT, 'hooks', 'hooks.json'), manifestPath);
  } else if (manifest === 'malformed') {
    await writeFile(manifestPath, '{ "hooks": { not json');
  } else if (manifest === 'empty') {
    await writeFile(manifestPath, JSON.stringify({ hooks: {} }));
  } else if (manifest === 'sessionstart-only') {
    const real = JSON.parse(await readFile(join(PROJECT_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
    await writeFile(manifestPath, JSON.stringify({ hooks: { SessionStart: real.hooks.SessionStart } }));
  } // 'missing' → write nothing
  await mkdir(join(claudeDir, 'plugins'), { recursive: true });
  await writeFile(join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { [id]: [{ version, installPath }] },
  }));
}

const readSettings = async (claudeDir) =>
  JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf-8'));

function runScript(script, home, { cwd = PROJECT_ROOT } = {}) {
  return execFileSync('node', [script], {
    cwd,
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') },
    encoding: 'utf-8',
    timeout: 60000,
  });
}

describe('hook-registry: edits at hook granularity, not matcher-group granularity', () => {
  it('keeps a co-located foreign hook when removing ours', () => {
    const hooks = { PostToolUse: [{ matcher: '*', hooks: [FOREIGN, OURS] }] };
    assert.equal(removeHookEntry(hooks, 'PostToolUse', 'gsd-context-monitor'), true);
    assert.deepEqual(hooks.PostToolUse, [{ matcher: '*', hooks: [FOREIGN] }],
      'the group must survive, carrying the other tool\'s hook');
  });

  it('drops the group only when it held nothing but ours', () => {
    const hooks = {
      PostToolUse: [
        { matcher: 'Edit', hooks: [OURS] },
        { matcher: '*', hooks: [FOREIGN] },
      ],
    };
    removeHookEntry(hooks, 'PostToolUse', 'gsd-context-monitor');
    assert.deepEqual(hooks.PostToolUse, [{ matcher: '*', hooks: [FOREIGN] }]);
  });

  it('drops the hook-type key only when no group survives', () => {
    const hooks = { PostToolUse: [{ matcher: '*', hooks: [OURS] }] };
    removeHookEntry(hooks, 'PostToolUse', 'gsd-context-monitor');
    assert.equal('PostToolUse' in hooks, false);
  });

  it('reports false, and changes nothing, when ours is not there', () => {
    const hooks = { PostToolUse: [{ matcher: '*', hooks: [FOREIGN] }] };
    assert.equal(removeHookEntry(hooks, 'PostToolUse', 'gsd-context-monitor'), false);
    assert.deepEqual(hooks.PostToolUse, [{ matcher: '*', hooks: [FOREIGN] }]);
  });

  it('preserves a foreign legacy string value instead of deleting it', () => {
    const hooks = { Stop: 'node /opt/othertool/stop.js' };
    assert.equal(removeHookEntry(hooks, 'Stop', 'gsd-session-stop'), false);
    assert.equal(hooks.Stop, 'node /opt/othertool/stop.js');
  });

  it('refreshes our hook without imposing our matcher on a shared group', () => {
    const hooks = { PostToolUse: [{ matcher: 'Edit', hooks: [FOREIGN, OURS] }] };
    assert.equal(upsertHookEntry(hooks, {
      hookType: 'PostToolUse',
      identifier: 'gsd-context-monitor',
      matcher: '*',
      command: 'node "/new/path/gsd-context-monitor.cjs"',
    }), true);
    assert.deepEqual(hooks.PostToolUse[0], { matcher: 'Edit', hooks: [FOREIGN] },
      'the other tool keeps its own matcher');
    assert.deepEqual(hooks.PostToolUse[1], {
      matcher: '*',
      hooks: [{ type: 'command', command: 'node "/new/path/gsd-context-monitor.cjs"' }],
    });
    assert.equal(hooks.PostToolUse.length, 2, 'ours is not registered twice');
  });

  it('will not clobber a foreign legacy string on register', () => {
    const hooks = { Stop: 'node /opt/othertool/stop.js' };
    assert.equal(upsertHookEntry(hooks, {
      hookType: 'Stop', identifier: 'gsd-session-stop', matcher: '*', command: 'node ours.cjs',
    }), false);
    assert.equal(hooks.Stop, 'node /opt/othertool/stop.js');
  });
});

describe('hook-registry: every call site goes through it', () => {
  it('install.js keeps the other tool\'s hook when refreshing ours', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-hookreg-install-');
    try {
      await markPluginInstalled(claudeDir);
      await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({
        hooks: { PostToolUse: [{ matcher: '*', hooks: [FOREIGN, OURS] }] },
      }, null, 2));

      runScript('install.js', home);

      const settings = await readSettings(claudeDir);
      const commands = (settings.hooks?.PostToolUse || []).flatMap(e => e.hooks.map(h => h.command));
      assert.ok(commands.includes(FOREIGN.command), '/opt/othertool/audit.js must survive');
      assert.equal(commands.filter(c => c.includes('gsd-context-monitor')).length, 1,
        'ours is refreshed exactly once, not duplicated and not dropped');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('uninstall.js removes ours and keeps the other tool\'s', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-hookreg-uninstall-');
    try {
      runScript('install.js', home); // npx-mode install: writes our entries
      const before = await readSettings(claudeDir);
      before.hooks.PostToolUse[0].hooks.unshift(FOREIGN); // other tool joins our group
      await writeFile(join(claudeDir, 'settings.json'), JSON.stringify(before, null, 2));

      runScript('uninstall.js', home);

      const settings = await readSettings(claudeDir);
      const commands = Object.values(settings.hooks || {}).flat()
        .flatMap(e => (Array.isArray(e?.hooks) ? e.hooks.map(h => h.command) : []));
      assert.ok(commands.includes(FOREIGN.command), '/opt/othertool/audit.js must survive uninstall');
      assert.ok(!commands.some(c => c.includes('gsd-')), 'no GSD hook may remain after uninstall');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('every hooks/lib file is on the uninstall list', () => {
  // Adding a file to hooks/lib means adding its name to two hardcoded removal
  // lists (uninstall.js and the orphan cleanup in gsd-session-init.cjs).
  // hook-registry.cjs was missed on the first pass and would have been left
  // behind in ~/.claude/hooks/lib after uninstall. Deriving the expectation
  // from the directory makes the next omission fail here instead of shipping.
  it('uninstall.js and the orphan cleanup name every file in hooks/lib', async () => {
    const { readdirSync } = _require('node:fs');
    const libs = readdirSync(join(PROJECT_ROOT, 'hooks', 'lib')).filter(f => f.endsWith('.cjs'));
    assert.ok(libs.length > 0, 'hooks/lib should contain .cjs files');

    // Parse the removal list itself. A whole-file `includes` would pass on the
    // require path `join(_selfDir, 'hooks', 'lib', 'hook-registry.cjs')` in
    // uninstall.js and assert nothing — it did, until removing the entry from
    // the list failed to turn this test red.
    for (const [file, pattern, label] of [
      ['uninstall.js', /for \(const libFile of \[([^\]]*)\]\)/, 'uninstall.js'],
      [join('hooks', 'gsd-session-init.cjs'), /for \(const lib of \[([^\]]*)\]\)/, 'orphan cleanup'],
    ]) {
      const source = await readFile(join(PROJECT_ROOT, file), 'utf-8');
      const match = source.match(pattern);
      assert.ok(match, `${label}: could not find the hooks/lib removal list`);
      const listed = [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
      for (const lib of libs) {
        assert.ok(listed.includes(lib),
          `${label} does not remove hooks/lib/${lib} — it would survive uninstall`);
      }
    }
  });
});

describe('the ~/.claude/hooks copies stand down while the plugin serves', () => {
  // Both install paths register the same three hooks. Rather than deleting one
  // registration — which strands the user, because the settings.json one is the
  // only GSD code that survives `/plugin uninstall` — the redundant copy exits
  // early. Each hook carries its own guard, so each is checked here: covering
  // two of three is how this class of bug keeps coming back.

  /** Stage a hook plus lib/ at `dir` and run it; returns {stdout, cwd}. */
  async function runHook(script, dir, claudeDir, { project } = {}) {
    await mkdir(dir, { recursive: true });
    for (const item of [script, 'lib']) {
      cpSync(join(PROJECT_ROOT, 'hooks', item), join(dir, item), { recursive: true });
    }
    const cwd = project || await mkdtemp(join(tmpdir(), 'gsd-standdown-proj-'));
    try {
      const stdout = execFileSync('node', [join(dir, script)], {
        cwd,
        env: { ...process.env, HOME: join(claudeDir, '..'), CLAUDE_CONFIG_DIR: claudeDir, CLAUDE_PLUGIN_ROOT: '' },
        encoding: 'utf-8',
        timeout: 30000,
        input: JSON.stringify({ session_id: 'standdown-session' }),
      });
      return { stdout };
    } finally {
      if (!project) await rm(cwd, { recursive: true, force: true });
    }
  }

  const userHooks = (claudeDir) => join(claudeDir, 'hooks');
  const cacheHooks = (claudeDir) => join(claudeDir, 'plugins', 'cache', 'gsd', 'gsd', '0.10.0', 'hooks');
  const ranMarker = (claudeDir) => join(claudeDir, 'gsd', 'runtime', 'last-cleanup');

  for (const [label, setup, shouldRun] of [
    ['plugin installed and enabled', async (d) => { await markPluginInstalled(d); }, false],
    ['no plugin installed', async () => {}, true],
    ['plugin installed but disabled', async (d) => {
      await markPluginInstalled(d);
      await writeFile(join(d, 'settings.json'), JSON.stringify({ enabledPlugins: { 'gsd@gsd': false } }));
    }, true],
    ['plugin registry unreadable', async (d) => {
      await mkdir(join(d, 'plugins'), { recursive: true });
      await writeFile(join(d, 'plugins', 'installed_plugins.json'), '{ not json');
    }, true],
  ]) {
    it(`session-init from ~/.claude/hooks ${shouldRun ? 'runs' : 'stands down'} — ${label}`, async () => {
      const { home, claudeDir } = await makeClaudeHome('gsd-standdown-init-');
      try {
        await setup(claudeDir);
        await runHook('gsd-session-init.cjs', userHooks(claudeDir), claudeDir);
        assert.equal(existsSync(ranMarker(claudeDir)), shouldRun,
          shouldRun
            ? 'this copy is the only registration there is — it must run'
            : "the plugin's copy is live; running here would fire the hook twice");
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  }

  it('runs when the project disables the plugin, not just the user config', async () => {
    // enabledPlugins can live in the project's settings as well as the user's.
    // Reading only ~/.claude/settings.json would stand this copy down while the
    // disabled plugin serves nothing — zero hooks, from one `/plugin disable`.
    for (const file of ['settings.json', 'settings.local.json']) {
      const { home, claudeDir } = await makeClaudeHome('gsd-standdown-proj-disable-');
      const project = await mkdtemp(join(tmpdir(), 'gsd-standdown-projdir-'));
      try {
        await markPluginInstalled(claudeDir);
        await mkdir(join(project, '.claude'), { recursive: true });
        await writeFile(join(project, '.claude', file),
          JSON.stringify({ enabledPlugins: { 'gsd@gsd': false } }));
        await runHook('gsd-session-init.cjs', userHooks(claudeDir), claudeDir, { project });
        assert.equal(existsSync(ranMarker(claudeDir)), true,
          `project ${file} disabled the plugin, so this copy is the only one left`);
      } finally {
        await rm(project, { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
      }
    }
  });

  it('recognises its own cache location through a symlinked config dir', async () => {
    // Node resolves __dirname through symlinks; path.join(claudeDir, …) does
    // not. Compared unresolved, the plugin's own copy fails the "am I the
    // plugin?" test, falls through to the registry lookup, and stands ITSELF
    // down — the plugin-only user then has no hooks at all.
    const realHome = await mkdtemp(join(tmpdir(), 'gsd-standdown-real-'));
    const linkHome = join(await mkdtemp(join(tmpdir(), 'gsd-standdown-link-')), 'linked');
    try {
      const realClaude = join(realHome, '.claude');
      await mkdir(realClaude, { recursive: true });
      await markPluginInstalled(realClaude);
      symlinkSync(realHome, linkHome, 'dir');
      const linkClaude = join(linkHome, '.claude');
      await runHook('gsd-session-init.cjs', cacheHooks(linkClaude), linkClaude);
      assert.equal(existsSync(ranMarker(realClaude)), true,
        'the plugin\'s own copy must never stand itself down');
    } finally {
      await rm(realHome, { recursive: true, force: true });
      await rm(join(linkHome, '..'), { recursive: true, force: true });
    }
  });

  // "Installed" is not "serving". A plugin whose hooks/hooks.json is missing or
  // broken registers nothing — `claude plugin details` reports Hooks (0) — and
  // standing down against it points the safety net at the exact fault it exists
  // to catch: Hooks (0) is the state 0.9.0 shipped in, and back then these
  // settings.json copies are what kept those users working.
  for (const [manifest, label] of [
    ['malformed', 'its hooks.json does not parse'],
    ['missing', 'its hooks.json is absent'],
    ['empty', 'its hooks.json declares no hooks'],
  ]) {
    it(`runs when the plugin is installed and enabled but ${label}`, async () => {
      const { home, claudeDir } = await makeClaudeHome('gsd-standdown-broken-');
      try {
        await markPluginInstalled(claudeDir, { manifest });
        await runHook('gsd-session-init.cjs', userHooks(claudeDir), claudeDir);
        assert.equal(existsSync(ranMarker(claudeDir)), true,
          'the plugin serves nothing, so standing down here means no hooks at all');
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  }

  it('stands down only for the hook the plugin actually declares', async () => {
    // A manifest declaring SessionStart but not Stop serves one and not the
    // other, so the answer differs per hook. One shared yes/no would silence
    // the Stop hook for a plugin that never registered it.
    const { home, claudeDir } = await makeClaudeHome('gsd-standdown-partial-');
    const project = await mkdtemp(join(tmpdir(), 'gsd-standdown-partialproj-'));
    try {
      await markPluginInstalled(claudeDir, { manifest: 'sessionstart-only' });
      await runHook('gsd-session-init.cjs', userHooks(claudeDir), claudeDir);
      assert.equal(existsSync(ranMarker(claudeDir)), false,
        'SessionStart is declared, so this copy stands down');

      await mkdir(join(project, '.gsd'), { recursive: true });
      await writeFile(join(project, '.gsd', 'state.json'), JSON.stringify({
        project: 'demo', workflow_mode: 'executing_task', current_phase: 1, phases: [],
      }));
      await runHook('gsd-session-stop.cjs', userHooks(claudeDir), claudeDir, { project });
      assert.equal(existsSync(join(project, '.gsd', '.session-end')), true,
        'Stop is NOT declared, so this copy must still run');
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  for (const [value, shouldRun, label] of [
    [true, false, 'boolean true'],
    ['false', true, 'the string "false"'],
    [0, true, 'the number 0'],
  ]) {
    it(`treats enabledPlugins ${label} the way Claude Code does`, async () => {
      // Claude Code reports a plugin with the string "false" as disabled, and a
      // disabled plugin loads no hooks. `=== false` is the one comparison that
      // lets a wrong-typed value through as enabled — straight to zero hooks.
      const { home, claudeDir } = await makeClaudeHome('gsd-standdown-enabled-');
      try {
        await markPluginInstalled(claudeDir);
        await writeFile(join(claudeDir, 'settings.json'),
          JSON.stringify({ enabledPlugins: { 'gsd@gsd': value } }));
        await runHook('gsd-session-init.cjs', userHooks(claudeDir), claudeDir);
        assert.equal(existsSync(ranMarker(claudeDir)), shouldRun,
          `enabledPlugins ${JSON.stringify(value)}: should run = ${shouldRun}`);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  }

  it('stands down for the plugin installed from another marketplace', async () => {
    // The registry id is marketplace-qualified. A fork or mirror installs as
    // gsd@<other>, and matching only gsd@gsd would run both copies.
    const { home, claudeDir } = await makeClaudeHome('gsd-standdown-mirror-');
    try {
      await markPluginInstalled(claudeDir, { id: 'gsd@gsdmirror' });
      await runHook('gsd-session-init.cjs', userHooks(claudeDir), claudeDir);
      assert.equal(existsSync(ranMarker(claudeDir)), false,
        'gsd@gsdmirror serves the same hooks, so this copy stands down');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('session-init from the plugin cache always runs', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-standdown-cache-');
    try {
      await markPluginInstalled(claudeDir);
      await runHook('gsd-session-init.cjs', cacheHooks(claudeDir), claudeDir);
      assert.equal(existsSync(ranMarker(claudeDir)), true,
        "the plugin's own copy is the live registration and must never stand down");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('context-monitor stands down under the plugin and warns without it', async () => {
    for (const [pluginPresent, expectWarning] of [[true, false], [false, true]]) {
      const { home, claudeDir } = await makeClaudeHome('gsd-standdown-ctx-');
      try {
        if (pluginPresent) await markPluginInstalled(claudeDir);
        const bridge = join(tmpdir(), 'gsd-ctx-standdown-session.json');
        await writeFile(bridge, JSON.stringify({
          remaining_percentage: 20, used_pct: 80, timestamp: Math.floor(Date.now() / 1000), has_gsd: true,
        }));
        try {
          const { stdout } = await runHook('gsd-context-monitor.cjs', userHooks(claudeDir), claudeDir);
          assert.equal(stdout.includes('CONTEXT CRITICAL'), expectWarning,
            `plugin present=${pluginPresent}: warning expected=${expectWarning}`);
        } finally {
          await rm(bridge, { force: true });
          await rm(join(tmpdir(), 'gsd-ctx-standdown-session-warned.json'), { force: true });
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  });

  it('session-stop stands down under the plugin and writes the marker without it', async () => {
    for (const [pluginPresent, expectMarker] of [[true, false], [false, true]]) {
      const { home, claudeDir } = await makeClaudeHome('gsd-standdown-stop-');
      const project = await mkdtemp(join(tmpdir(), 'gsd-standdown-stopproj-'));
      try {
        if (pluginPresent) await markPluginInstalled(claudeDir);
        await mkdir(join(project, '.gsd'), { recursive: true });
        await writeFile(join(project, '.gsd', 'state.json'), JSON.stringify({
          project: 'demo', workflow_mode: 'executing_task', current_phase: 1, phases: [],
        }));
        await runHook('gsd-session-stop.cjs', userHooks(claudeDir), claudeDir, { project });
        assert.equal(existsSync(join(project, '.gsd', '.session-end')), expectMarker,
          `plugin present=${pluginPresent}: .session-end expected=${expectMarker}`);
      } finally {
        await rm(project, { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
      }
    }
  });
});
