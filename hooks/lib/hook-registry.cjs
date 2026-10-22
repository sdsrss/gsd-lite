#!/usr/bin/env node
// Editing GSD's entries in a settings.json `hooks` object.
//
// Claude Code groups hooks by matcher: one entry is `{ matcher, hooks: [...] }`
// and several tools' hooks routinely share a group. Every edit here therefore
// works at HOOK granularity, never at group granularity. Three call sites used
// to get this wrong independently — install.js registering, install.js
// deregistering on the plugin path, and uninstall.js removing — and each one
// silently deleted any other tool's hook that happened to share a matcher group
// with ours. They all route through this file now, so there is one place to get
// it right rather than three places to remember.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Should this copy of a GSD hook stand down because the plugin is serving it?
 *
 * Both install paths register the same three hooks: the plugin system loads
 * hooks/hooks.json out of the plugin cache, and install.js writes settings.json.
 * A user who has both gets every hook twice, from two different versions.
 *
 * The obvious fix — delete one registration — is wrong here, and this comment
 * is the reason. After `/plugin uninstall` the plugin's hooks stop loading, so
 * the settings.json registration is the only GSD code that still runs. Anything
 * that removed it also removed the only execution that could ever notice and
 * repair the state, stranding a complete npx install on disk with nothing
 * registered anywhere and no message saying so. So neither registration is
 * removed; the redundant one stands down while the other is live, and comes
 * straight back when it isn't.
 *
 * Suppression is deliberately conservative: anything unreadable or ambiguous
 * returns false. Running twice is a visible annoyance; running zero times is
 * silent, and silence is the failure mode with no feedback loop.
 *
 * @param {string} claudeDir  resolved CLAUDE_CONFIG_DIR / ~/.claude
 * @param {string} scriptDir  the calling hook's __dirname
 */
function pluginServesHooks(claudeDir, scriptDir, hookType) {
  // We ARE the plugin's copy — we are the live registration, never stand down.
  if (process.env.CLAUDE_PLUGIN_ROOT) return false;
  // Node resolves __dirname through symlinks and path.join does not, so compare
  // resolved paths. Unresolved, a symlinked config dir makes this clause quietly
  // inoperative, and the plugin's own copy would fall through to the registry
  // lookup below and stand itself down — zero hooks, silently.
  if (scriptDir && realish(scriptDir).startsWith(realish(path.join(claudeDir, 'plugins', 'cache')) + path.sep)) {
    return false;
  }

  // We are the ~/.claude/hooks copy an npx/manual install wrote.
  //
  // The id is marketplace-qualified, and the same plugin installed from a fork
  // or mirror is `gsd@<other>`. Matching only `gsd@gsd` would miss it and both
  // copies would run.
  let entry = null;
  let pluginId = null;
  try {
    const registry = JSON.parse(
      fs.readFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8'),
    );
    const ids = Object.keys(registry.plugins ?? {}).filter(k => k === 'gsd@gsd' || k.startsWith('gsd@'));
    pluginId = ids.includes('gsd@gsd') ? 'gsd@gsd' : ids[0];
    if (!pluginId) return false;
    const record = registry.plugins[pluginId];
    entry = Array.isArray(record) ? record[0] : record;
  } catch {
    // No registry, unreadable, or a torn read while Claude Code rewrites it
    // during install/update/enable/disable. Never read that as "the plugin is
    // there" — that would stand us down on a transient error.
    return false;
  }
  if (!entry) return false;

  // A record installed at project or local scope only serves the project it
  // names. Reading record[0] and ignoring `scope` made every OTHER project stand
  // this copy down for a plugin that does not load there — the `--scope project`
  // install, which is the worst version of this failure because nothing on disk
  // says "disabled" and nothing is printed. Anything we cannot pin to this
  // directory keeps us running.
  if (entry.scope && entry.scope !== 'user') {
    if (!entry.projectPath) return false;
    if (realish(entry.projectPath) !== realish(process.cwd())) return false;
  }

  // Installed but disabled means hooks.json is not loaded, so we are still the
  // only registration. enabledPlugins can live in the user settings or in the
  // project's, so a disabling value in any of them keeps us running. Claude
  // Code treats the string "false" as disabled too, and `=== false` is the one
  // comparison that would let that through as "enabled" — test for an explicit
  // key that is not literally true.
  //
  // A missing key is NOT consent. Claude Code writes `enabledPlugins[id] = true`
  // explicitly when it installs a plugin, so the absence of any entry means the
  // plugin is not enabled for this session — the ordinary case being a
  // project-scope install whose key lives in a different project's settings.
  // Treating absence as "enabled" is what let this stand down into zero hooks.
  const cwdClaude = path.join(process.cwd(), '.claude');
  let enabledSomewhere = false;
  for (const file of [
    path.join(claudeDir, 'settings.json'),
    path.join(cwdClaude, 'settings.json'),
    path.join(cwdClaude, 'settings.local.json'),
  ]) {
    try {
      const enabled = JSON.parse(fs.readFileSync(file, 'utf8')).enabledPlugins;
      if (enabled && Object.hasOwn(enabled, pluginId)) {
        if (enabled[pluginId] !== true) return false;
        enabledSomewhere = true;
      }
    } catch { /* absent or unreadable — no opinion from this file */ }
  }
  if (!enabledSomewhere) return false;

  // Installed and enabled is not the same as serving. A plugin whose
  // hooks/hooks.json is missing, truncated or malformed registers nothing —
  // `claude plugin details` says Hooks (0) — and standing down against it is
  // how this safety net would go silent on the exact fault it exists to catch:
  // Hooks (0) is the state 0.9.0 shipped in, and back then the settings.json
  // registration is what kept those users working. So check the manifest
  // actually declares the hook we implement, and run whenever it does not.
  //
  // installPath is not reliably the copy that runs: with a marketplace added
  // from a local directory, Claude Code runs the plugin out of that source
  // directory and records the cache. So check every manifest we can identify
  // and stand down only if they all declare the hook — any one of them broken
  // means the copy that runs might be the broken one.
  const roots = [entry.installPath];
  try {
    const source = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'))
      .extraKnownMarketplaces?.[pluginId.slice(pluginId.indexOf('@') + 1)]?.source;
    if (source?.path) roots.push(source.path);
  } catch { /* no marketplace record — installPath is all we have */ }

  let checked = 0;
  for (const root of roots) {
    if (!root) continue;
    const manifestPath = path.join(root, 'hooks', 'hooks.json');
    if (!fs.existsSync(manifestPath)) continue;
    if (!declaresHook(manifestPath, hookType)) return false;
    checked += 1;
  }
  return checked > 0;
}

/**
 * Does this hooks.json actually register a command for `hookType`?
 *
 * Counting matcher groups is not enough: `[{matcher:"*", hooks:[]}]`,
 * `[{matcher:"*"}]` and a bare string all have a truthy length or pass a
 * presence test while registering nothing, and `claude plugin details` reports
 * `Hooks (3)` for some of them — so it is not a usable cross-check either.
 * Require a command we can see.
 */
function declaresHook(manifestPath, hookType) {
  try {
    const entries = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).hooks?.[hookType];
    if (!Array.isArray(entries)) return false;
    return entries.some(entry =>
      Array.isArray(entry?.hooks) && entry.hooks.some(h => typeof h?.command === 'string' && h.command.trim()));
  } catch {
    return false;
  }
}

/**
 * Has the user switched gsd off with `/plugin disable`?
 *
 * Claude Code decides whether a plugin is enabled from settings this can only
 * partly see: managed settings that may come from a server or MDM, the
 * session's `--settings`, the project files of the directory the session
 * started in (or moved to with /cd), the local file at the git root or the
 * main checkout. So it answers yes only when every reading it can make says
 * off, and anything else is "not disabled": the npx registrations then run,
 * which is visible, where a wrong yes silences them — and with them the
 * StatusLine that feeds the plugin's own context monitor — with nothing
 * printed (hook-registry's rule: running twice is an annoyance, zero times
 * is silent).
 *
 * Yes requires all of:
 * - a plugin record that is gsd-lite (its package.json says so; a record
 *   named `gsd@…` can be another plugin) and applies here: user scope, or
 *   project or local scope for this project;
 * - for every such record, a deciding value of exactly `false`, taken in
 *   Claude Code's order: the project's settings.local.json (at the main
 *   checkout's root or the git root first, then in the project directory),
 *   its settings.json, the user's settings.json;
 * - every one of those files that exists parses.
 *
 * @param {string} claudeDir   resolved CLAUDE_CONFIG_DIR / ~/.claude
 * @param {string} projectDir  the directory the session started in
 *   (CLAUDE_PROJECT_DIR, a StatusLine's workspace.project_dir); not the
 *   current directory, which follows Claude's cd
 */
function pluginDisabled(claudeDir, projectDir = process.cwd()) {
  let plugins;
  try {
    plugins = JSON.parse(fs.readFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8')).plugins;
  } catch {
    return false;
  }
  if (!plugins || typeof plugins !== 'object') return false;
  const here = realish(projectDir);
  const ids = Object.keys(plugins)
    .filter((id) => id.startsWith('gsd@'))
    .filter((id) => (Array.isArray(plugins[id]) ? plugins[id] : [plugins[id]]).some((record) => record
      && isGsdLite(record.installPath)
      && (!record.scope || record.scope === 'user' || (record.projectPath && realish(record.projectPath) === here))));
  if (ids.length === 0) return false;
  const roots = gitRoots(projectDir);
  const files = [
    ...[...roots, projectDir].map((dir) => path.join(dir, '.claude', 'settings.local.json')),
    path.join(projectDir, '.claude', 'settings.json'),
    path.join(claudeDir, 'settings.json'),
  ];
  const enabled = [];
  for (const file of new Set(files)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    try {
      enabled.push(JSON.parse(text)?.enabledPlugins);
    } catch {
      return false;
    }
  }
  return ids.every((id) => {
    const deciding = enabled.find((map) => map && typeof map === 'object' && Object.hasOwn(map, id));
    return deciding !== undefined && deciding[id] === false;
  });
}

/** Whether an install path holds gsd-lite. */
function isGsdLite(installPath) {
  if (typeof installPath !== 'string' || !installPath) return false;
  try {
    return JSON.parse(fs.readFileSync(path.join(installPath, 'package.json'), 'utf8')).name === 'gsd-lite';
  } catch {
    return false;
  }
}

/**
 * Where Claude Code keeps the local settings file for a session started in
 * `dir`, besides `dir` itself: the main checkout's root in a worktree, else
 * the git root — not when that root is the home directory, where the file
 * stays put.
 */
function gitRoots(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const dotGit = path.join(d, '.git');
    let stat;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      if (path.dirname(d) === d) return [];
      continue;
    }
    if (d === path.resolve(require('node:os').homedir())) return [];
    if (stat.isDirectory()) return [d];
    try {
      const gitDir = path.resolve(d, fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)[1]);
      const common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
      return [path.dirname(common)];
    } catch {
      return [d];
    }
  }
}

/**
 * Should this hook stand down? When the plugin serves it (pluginServesHooks),
 * and — for the copy an npx install registered in settings.json, the only one
 * Claude Code still runs while the plugin is disabled — when the user has
 * switched gsd off (pluginDisabled). The plugin's own copy is not loaded while
 * it is disabled, so it never gets here to ask.
 */
function hookStandsDown(claudeDir, scriptDir, hookType) {
  if (pluginServesHooks(claudeDir, scriptDir, hookType)) return true;
  const settingsCopy = Boolean(scriptDir) && realish(scriptDir) === realish(path.join(claudeDir, 'hooks'));
  return settingsCopy && pluginDisabled(claudeDir, process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

/** realpath when it resolves, the path as given when it does not. */
function realish(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Is the gsd plugin installed for every project: at user scope, or in a
 * record from before Claude Code had scopes? install.js asks to decide what it
 * installs and whether to register the MCP server; the updater asks to decide
 * whether to run install.js. They must give the same answer. A project or
 * local install serves the project it names only, so it is no reason for the
 * npx install to step aside anywhere: taking it for one removed the npx
 * install's MCP registration, and with it every other project's gsd tools.
 * Unreadable or absent → false.
 */
function pluginInstalledForUser(claudeDir) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8')).plugins?.['gsd@gsd'];
    const entries = Array.isArray(record) ? record : record ? [record] : [];
    return entries.some((entry) => entry !== null && typeof entry === 'object' && (!entry.scope || entry.scope === 'user'));
  } catch {
    return false;
  }
}

/** Hook identifiers GSD owns, current and legacy. */
const GSD_HOOK_IDENTIFIERS = Object.freeze([
  'gsd-session-init',
  'gsd-context-monitor',
  'gsd-session-stop',
]);

function matchesIdentifier(hook, identifier) {
  return typeof hook?.command === 'string' && hook.command.includes(identifier);
}

/**
 * Remove our hook from one hook type, leaving every co-located hook in place.
 *
 * A matcher group survives minus our hook whenever anything else is still in
 * it; the group is dropped only when it held nothing but ours; the hook type
 * key is dropped only when no group survives. A legacy string value is deleted
 * only when it is ours.
 *
 * @returns {boolean} true when something was actually removed.
 */
function removeHookEntry(hooks, hookType, identifier) {
  const entries = hooks?.[hookType];
  if (typeof entries === 'string') {
    if (!entries.includes(identifier)) return false;
    delete hooks[hookType];
    return true;
  }
  if (!Array.isArray(entries)) return false;

  let removed = false;
  const kept = [];
  for (const entry of entries) {
    if (!Array.isArray(entry?.hooks)) {
      kept.push(entry);
      continue;
    }
    const keptHooks = entry.hooks.filter(h => !matchesIdentifier(h, identifier));
    if (keptHooks.length === entry.hooks.length) {
      kept.push(entry);
      continue;
    }
    removed = true;
    // Someone else's hook is still in this group — keep the group for them.
    if (keptHooks.length > 0) kept.push({ ...entry, hooks: keptHooks });
  }
  if (!removed) return false;

  if (kept.length === 0) delete hooks[hookType];
  else hooks[hookType] = kept;
  return true;
}

/**
 * Register our hook, refreshing matcher/timeout/path if an older copy is there.
 *
 * Implemented as remove-then-append rather than replace-in-place: our matcher
 * and timeout belong to the group, so rewriting a group we share would impose
 * them on whoever else is in it. Pulling our hook out and giving it its own
 * group keeps the change to exactly our entry.
 *
 * @returns {boolean} true when the hook is registered, false when a foreign
 *   legacy string value occupies the slot and was preserved instead.
 */
function upsertHookEntry(hooks, { hookType, identifier, matcher, command, timeout }) {
  if (typeof hooks[hookType] === 'string' && !hooks[hookType].includes(identifier)) {
    return false; // someone else's legacy registration — do not clobber it
  }
  removeHookEntry(hooks, hookType, identifier);

  const hook = { type: 'command', command };
  if (timeout) hook.timeout = timeout;
  const entry = { matcher, hooks: [hook] };

  if (!Array.isArray(hooks[hookType])) hooks[hookType] = [];
  hooks[hookType].push(entry);
  return true;
}

module.exports = { GSD_HOOK_IDENTIFIERS, hookStandsDown, pluginDisabled, pluginInstalledForUser, pluginServesHooks, realish, removeHookEntry, upsertHookEntry };
