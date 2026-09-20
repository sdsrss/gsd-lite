#!/usr/bin/env node
// Plugin uninstaller for GSD-Lite

import { existsSync, rmSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const RUNTIME_DIR = join(CLAUDE_DIR, 'gsd');

// Hook removal is shared with install.js so both edit settings.json at hook
// granularity rather than matcher-group granularity — deleting a whole group
// takes any other tool's hook that happens to sit in it. This file runs from
// two places: the package root (npx/manual uninstall, sibling hooks/lib) and
// ~/.claude/gsd/uninstall.js (spawned by the orphan cleanup, where install.js
// has already copied hooks/lib into ~/.claude/hooks/lib). One of the two
// always exists when there is anything to uninstall.
const _uninstallRequire = createRequire(import.meta.url);
const _selfDir = dirname(fileURLToPath(import.meta.url));
function _requireHookLib(file) {
  for (const candidate of [
    join(_selfDir, 'hooks', 'lib', file),
    join(CLAUDE_DIR, 'hooks', 'lib', file),
  ]) {
    if (existsSync(candidate)) return _uninstallRequire(candidate);
  }
  return {};
}
const { removeHookEntry } = _requireHookLib('hook-registry.cjs');
const { atomicWrite: _sharedAtomicWrite } = _requireHookLib('atomic-write.cjs');

function log(msg) { console.log(msg); }

// Every removal below is existsSync-gated and every registry edit sits in a bare
// catch, so "did anything happen?" is not observable from control flow alone.
// Count it, and let the closing line say what actually happened rather than
// asserting success unconditionally.
let removedCount = 0;
function logRemoved(msg) {
  removedCount += 1;
  log(`  ✓ ${msg}`);
}

// Prefer the shared helper — a unique temp name is not an unguessable one, and
// this writes settings.json. The inline fallback stays because hooks/lib may be
// gone by the time an orphan cleanup runs this, and an uninstaller that throws
// on a missing helper leaves more behind than one that writes slightly less
// carefully.
function atomicWriteSync(filePath, content) {
  if (_sharedAtomicWrite) return _sharedAtomicWrite(filePath, content);
  const tmp = filePath + `.${process.pid}-${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, filePath);
}

function removeDir(path, label) {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
    logRemoved(`Removed ${label}`);
  }
}

export function main() {
  log('GSD-Lite Uninstaller\n');

  // Without this, a wrong CLAUDE_CONFIG_DIR — a typo, or an unset one under
  // sudo/systemd/CI where HOME differs — removes nothing, reports success, and
  // leaves a live install whose hooks keep firing every session.
  if (!existsSync(CLAUDE_DIR)) {
    log(`Error: ${CLAUDE_DIR} not found, so there is nothing to uninstall there.`);
    log('  If your Claude Code config lives elsewhere, set CLAUDE_CONFIG_DIR and run this again.');
    process.exit(1);
  }

  // Clean up GSD entry from composite statusLine registry before removing files
  try {
    const _require = createRequire(import.meta.url);
    const compositeLib = join(CLAUDE_DIR, 'hooks', 'lib', 'statusline-composite.cjs');
    if (existsSync(compositeLib)) {
      const { removeProvider } = _require(compositeLib);
      if (removeProvider()) logRemoved('Removed GSD from composite statusLine registry');
    }
  } catch { /* best effort */ }

  log('Removing files...');

  removeDir(join(CLAUDE_DIR, 'commands', 'gsd'), 'commands/gsd/');
  // Agents now namespaced under gsd/ [I-5]
  removeDir(join(CLAUDE_DIR, 'agents', 'gsd'), 'agents/gsd/');
  removeDir(join(CLAUDE_DIR, 'workflows', 'gsd'), 'workflows/gsd/');
  removeDir(join(CLAUDE_DIR, 'references', 'gsd'), 'references/gsd/');
  removeDir(RUNTIME_DIR, 'gsd runtime/');
  removeDir(join(CLAUDE_DIR, 'gsd-lite'), 'legacy gsd-lite runtime/');

  // Remove hook files (both legacy and current names)
  for (const name of ['context-monitor.js', 'gsd-statusline.cjs', 'gsd-context-monitor.cjs', 'gsd-session-init.cjs', 'gsd-auto-update.cjs', 'gsd-session-stop.cjs']) {
    const hookFile = join(CLAUDE_DIR, 'hooks', name);
    if (existsSync(hookFile)) {
      rmSync(hookFile);
      logRemoved(`Removed hooks/${name}`);
    }
  }
  // Remove hook library dependencies
  const hookLibDir = join(CLAUDE_DIR, 'hooks', 'lib');
  if (existsSync(hookLibDir)) {
    // Only remove GSD-owned files, not other plugins' libs
    for (const libFile of ['gsd-finder.cjs', 'statusline-composite.cjs', 'semver-sort.cjs', 'hook-registry.cjs', 'atomic-write.cjs']) {
      const fullPath = join(hookLibDir, libFile);
      if (existsSync(fullPath)) {
        rmSync(fullPath);
        logRemoved(`Removed hooks/lib/${libFile}`);
      }
    }
  }

  // Clean up plugin system directories (from /plugin install)
  removeDir(join(CLAUDE_DIR, 'plugins', 'marketplaces', 'gsd'), 'plugins/marketplaces/gsd/');
  removeDir(join(CLAUDE_DIR, 'plugins', 'cache', 'gsd'), 'plugins/cache/gsd/');
  // Legacy "gsd-lite" plugin directories
  removeDir(join(CLAUDE_DIR, 'plugins', 'marketplaces', 'gsd-lite'), 'plugins/marketplaces/gsd-lite/');
  removeDir(join(CLAUDE_DIR, 'plugins', 'cache', 'gsd-lite'), 'plugins/cache/gsd-lite/');

  // Deregister from plugin registry files
  const pluginsDir = join(CLAUDE_DIR, 'plugins');
  function removeJsonEntry(filePath, key, label) {
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (key in data) {
        delete data[key];
        atomicWriteSync(filePath, JSON.stringify(data, null, 2) + '\n');
        logRemoved(`Removed '${key}' from ${label}`);
      }
    } catch {}
  }
  function removeNestedEntry(filePath, parentKey, key, label) {
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (data[parentKey] && key in data[parentKey]) {
        delete data[parentKey][key];
        atomicWriteSync(filePath, JSON.stringify(data, null, 2) + '\n');
        logRemoved(`Removed '${key}' from ${label}`);
      }
    } catch {}
  }
  for (const name of ['gsd', 'gsd-lite']) {
    removeJsonEntry(join(pluginsDir, 'known_marketplaces.json'), name, 'known_marketplaces.json');
    removeNestedEntry(join(pluginsDir, 'installed_plugins.json'), 'plugins', `${name}@${name}`, 'installed_plugins.json');
  }

  // Deregister MCP server, hooks, and plugin entries from settings.json
  const settingsPath = join(CLAUDE_DIR, 'settings.json');
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    let changed = false;
    // Remove both current and legacy MCP server + plugin entries
    for (const name of ['gsd', 'gsd-lite']) {
      if (settings.mcpServers?.[name]) {
        delete settings.mcpServers[name];
        changed = true;
      }
      const pluginKey = `${name}@${name}`;
      if (settings.enabledPlugins?.[pluginKey]) {
        delete settings.enabledPlugins[pluginKey];
        changed = true;
      }
      if (settings.extraKnownMarketplaces?.[name]) {
        delete settings.extraKnownMarketplaces[name];
        changed = true;
      }
    }
    if (settings.extraKnownMarketplaces && Object.keys(settings.extraKnownMarketplaces).length === 0) {
      delete settings.extraKnownMarketplaces;
    }
    // Remove top-level statusLine if GSD's (match both old and new patterns)
    if (settings.statusLine?.command?.includes('gsd-statusline') ||
        settings.statusLine?.command?.includes('context-monitor.js')) {
      delete settings.statusLine;
      changed = true;
    }
    if (settings.hooks) {
      // Remove legacy StatusLine hook entry
      if (typeof settings.hooks.StatusLine === 'string'
          && (settings.hooks.StatusLine.includes('gsd-statusline') ||
              settings.hooks.StatusLine.includes('context-monitor.js'))) {
        delete settings.hooks.StatusLine;
        changed = true;
      }
      // Remove GSD entries from hook arrays. removeHookEntry strips only our
      // hook out of a matcher group and keeps the group for whoever else is in
      // it; the earlier inline filter here dropped the whole group.
      if (typeof removeHookEntry !== 'function') {
        // The shared helper is the only correct remover — an inline retry here
        // is how the group-granularity bug got written three times. Say so
        // rather than leaving the caller to infer it from a silent success.
        log('  ! hooks/lib/hook-registry.cjs not found — settings.json hook entries left in place');
        log(`    Remove them by hand, or reinstall and uninstall again: ${settingsPath}`);
      } else {
        for (const [hookType, identifier] of [
          ['PostToolUse', 'gsd-context-monitor'],
          ['PostToolUse', 'context-monitor.js'],
          ['SessionStart', 'gsd-session-init'],
          ['Stop', 'gsd-session-stop'],
        ]) {
          if (removeHookEntry(settings.hooks, hookType, identifier)) changed = true;
        }
      }
    }
    if (changed) {
      atomicWriteSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      logRemoved('MCP server + hooks + plugin entries deregistered from settings.json');
    }
  } catch {}

  if (removedCount === 0) {
    log(`\nNothing to remove — no GSD-Lite files or registrations found in ${CLAUDE_DIR}.`);
    return;
  }
  log('\n✓ GSD-Lite uninstalled.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
