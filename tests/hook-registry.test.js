// Editing settings.json hooks without destroying other tools' hooks.
//
// Claude Code groups hooks by matcher, and several tools routinely share a
// group. Three call sites — install.js registering, install.js deregistering on
// the plugin path, uninstall.js removing — each edited at GROUP granularity and
// each silently deleted any co-located hook. They now share
// hooks/lib/hook-registry.cjs; these tests pin the shared behaviour and then
// re-check it through all three call sites, because a correct helper that one
// call site bypasses is not a fix.
//
// The second half covers the duplicate-registration case the plugin path
// creates: a user who ran `npx gsd-lite install` and then installed the plugin
// has both registrations live and every hook fires twice.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { cpSync } from 'node:fs';
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

async function markPluginInstalled(claudeDir, version = '0.10.0') {
  const pluginsDir = join(claudeDir, 'plugins');
  await mkdir(pluginsDir, { recursive: true });
  await writeFile(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
    plugins: { 'gsd@gsd': [{ version }] },
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
  it('install.js on the plugin path removes ours and keeps the other tool\'s', async () => {
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
      assert.ok(!commands.some(c => c.includes('gsd-context-monitor')),
        'our entry is served by the plugin hooks.json and must not remain here');
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

describe('plugin-path session removes duplicate settings.json registrations', () => {
  /**
   * Stage a cache copy of the plugin's hooks and run gsd-session-init.cjs from
   * it, which is what the plugin system does. `from` picks whether the hook
   * runs as the plugin's copy or as an npx install's ~/.claude/hooks copy.
   */
  async function runSessionInit(claudeDir, from) {
    const hookDir = from === 'plugin'
      ? join(claudeDir, 'plugins', 'cache', 'gsd', 'gsd', '0.10.0', 'hooks')
      : join(claudeDir, 'hooks');
    await mkdir(hookDir, { recursive: true });
    for (const item of ['gsd-session-init.cjs', 'lib']) {
      cpSync(join(PROJECT_ROOT, 'hooks', item), join(hookDir, item), { recursive: true });
    }
    const cwd = await mkdtemp(join(tmpdir(), 'gsd-hookreg-proj-'));
    try {
      execFileSync('node', [join(hookDir, 'gsd-session-init.cjs')], {
        cwd,
        // CLAUDE_PLUGIN_ROOT deliberately unset: the path check has to carry
        // this on its own, so the fix does not rest on an env var we cannot
        // verify from a test.
        env: { ...process.env, HOME: join(claudeDir, '..'), CLAUDE_CONFIG_DIR: claudeDir, CLAUDE_PLUGIN_ROOT: '' },
        encoding: 'utf-8',
        timeout: 30000,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  const duplicatedSettings = () => ({
    hooks: {
      SessionStart: [{ matcher: 'startup|clear|compact', hooks: [{ type: 'command', command: 'node "/home/x/.claude/hooks/gsd-session-init.cjs"' }] }],
      PostToolUse: [{ matcher: '*', hooks: [FOREIGN, OURS] }],
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "/home/x/.claude/hooks/gsd-session-stop.cjs"' }] }],
    },
  });

  it('clears the npx-era entries when the hook runs from the plugin cache', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-hookreg-dedupe-');
    try {
      await markPluginInstalled(claudeDir);
      await writeFile(join(claudeDir, 'settings.json'), JSON.stringify(duplicatedSettings(), null, 2));

      await runSessionInit(claudeDir, 'plugin');

      const settings = await readSettings(claudeDir);
      const entries = Object.values(settings.hooks || {}).flat();
      const commands = entries.flatMap(e => (Array.isArray(e?.hooks) ? e.hooks.map(h => h.command) : []));
      for (const id of ['gsd-session-init', 'gsd-context-monitor', 'gsd-session-stop']) {
        assert.ok(!commands.some(c => c.includes(id)),
          `${id} still registered in settings.json — it would fire twice per event`);
      }
      assert.ok(commands.includes(FOREIGN.command), 'the other tool\'s hook must survive the dedupe');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('leaves settings.json alone for an npx-only install', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-hookreg-npxonly-');
    try {
      // No plugin registered, and the hook runs from ~/.claude/hooks — these
      // settings.json entries are the only live registration. Removing them
      // would disable the hooks outright.
      const original = duplicatedSettings();
      await writeFile(join(claudeDir, 'settings.json'), JSON.stringify(original, null, 2));

      await runSessionInit(claudeDir, 'user');

      const settings = await readSettings(claudeDir);
      assert.deepEqual(settings.hooks, original.hooks,
        'an npx-only install must keep its settings.json registrations');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
