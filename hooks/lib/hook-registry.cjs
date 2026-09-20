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
    pluginId = Object.keys(registry.plugins ?? {}).find(k => k === 'gsd@gsd' || k.startsWith('gsd@'));
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

  // Installed but disabled means hooks.json is not loaded, so we are still the
  // only registration. enabledPlugins can live in the user settings or in the
  // project's, so a disabling value in any of them keeps us running. Claude
  // Code treats the string "false" as disabled too, and `=== false` is the one
  // comparison that would let that through as "enabled" — test for an explicit
  // key that is not literally true. A missing key means enabled.
  const cwdClaude = path.join(process.cwd(), '.claude');
  for (const file of [
    path.join(claudeDir, 'settings.json'),
    path.join(cwdClaude, 'settings.json'),
    path.join(cwdClaude, 'settings.local.json'),
  ]) {
    try {
      const enabled = JSON.parse(fs.readFileSync(file, 'utf8')).enabledPlugins;
      if (enabled && Object.hasOwn(enabled, pluginId) && enabled[pluginId] !== true) return false;
    } catch { /* absent or unreadable — no opinion from this file */ }
  }

  // Installed and enabled is not the same as serving. A plugin whose
  // hooks/hooks.json is missing, truncated or malformed registers nothing —
  // `claude plugin details` says Hooks (0) — and standing down against it is
  // how this safety net would go silent on the exact fault it exists to catch:
  // Hooks (0) is the state 0.9.0 shipped in, and back then the settings.json
  // registration is what kept those users working. So check the manifest
  // actually declares the hook we implement, and run whenever it does not.
  if (!entry.installPath) return false;
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(entry.installPath, 'hooks', 'hooks.json'), 'utf8'),
    );
    if (!manifest.hooks?.[hookType]?.length) return false;
  } catch {
    return false;
  }

  return true;
}

/** realpath when it resolves, the path as given when it does not. */
function realish(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
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

module.exports = { GSD_HOOK_IDENTIFIERS, pluginServesHooks, removeHookEntry, upsertHookEntry };
