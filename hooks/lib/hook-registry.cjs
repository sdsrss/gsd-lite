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

module.exports = { GSD_HOOK_IDENTIFIERS, removeHookEntry, upsertHookEntry };
