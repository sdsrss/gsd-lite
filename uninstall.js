#!/usr/bin/env node
// Plugin uninstaller for GSD-Lite

import { existsSync, rmSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, chmodSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
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

// The other half of the same state. Files are deleted before the registrations
// that point at them are removed, so a swallowed registry failure leaves hooks
// registered at paths that no longer exist — every session then runs a command
// that is not there. The closing line and the exit code are both derived from
// {removedCount, problems} at the end of main(): one state, two readings of it,
// so they cannot disagree the way they did when the message was printed
// unconditionally and the exit code was whatever fell out of control flow.
const problems = [];
function logProblem(what, hint) {
  problems.push({ what, hint });
  log(`  ! ${what}`);
  if (hint) log(`    ${hint}`);
}

// A registry file that is not there is not a failure — there is nothing to
// deregister. Anything else (unparseable, unwritable, unreadable) is, because
// the entry survives and we have already deleted what it points at.
function isAbsent(err) {
  return err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
}

// Prefer the shared helper — a unique temp name is not an unguessable one, and
// this writes settings.json. The inline fallback stays because hooks/lib may be
// gone by the time an orphan cleanup runs this, and an uninstaller that throws
// on a missing helper leaves more behind than one that writes slightly less
// carefully.
function atomicWriteSync(filePath, content) {
  if (_sharedAtomicWrite) return _sharedAtomicWrite(filePath, content);
  // Mirror the shared helper rather than the pattern it replaced: a unique name
  // is not an unguessable one, and a fallback that quietly reinstates
  // writeFileSync-onto-a-predictable-path is the old bug wearing a new name.
  const tmp = `${filePath}.gsd-tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, content);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  try { chmodSync(tmp, statSync(filePath).mode & 0o777); } catch { /* new file — 0600 stands */ }
  try {
    renameSync(tmp, filePath);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

function removeDir(path, label) {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
    logRemoved(`Removed ${label}`);
  }
}

export function main() {
  log('GSD-Lite Uninstaller\n');
  // Both halves of the summary are module state, so a second call in one
  // process (cli.js imports this) must not inherit the first call's tally.
  removedCount = 0;
  problems.length = 0;

  // Without this, a wrong CLAUDE_CONFIG_DIR — a typo, or an unset one under
  // sudo/systemd/CI where HOME differs — removes nothing, reports success, and
  // leaves a live install whose hooks keep firing every session.
  if (!existsSync(CLAUDE_DIR)) {
    log(`Error: ${CLAUDE_DIR} not found, so there is nothing to uninstall there.`);
    log('  If your Claude Code config lives elsewhere, set CLAUDE_CONFIG_DIR and run this again.');
    process.exit(1);
  }

  // Clean up GSD entry from composite statusLine registry before removing files
  const compositeLib = join(CLAUDE_DIR, 'hooks', 'lib', 'statusline-composite.cjs');
  try {
    const _require = createRequire(import.meta.url);
    if (existsSync(compositeLib)) {
      const { removeProvider } = _require(compositeLib);
      if (removeProvider()) logRemoved('Removed GSD from composite statusLine registry');
    }
  } catch (err) {
    // Same reasoning as the registry files: a leftover entry here points at a
    // statusline file this run is about to delete, so it is not "best effort".
    if (!isAbsent(err)) {
      logProblem(
        `Could not remove GSD from the composite statusLine registry: ${err.message}`,
        `It still names a file this run deletes: ${compositeLib}`,
      );
    }
  }

  log('Removing files...');

  removeDir(join(CLAUDE_DIR, 'commands', 'gsd'), 'commands/gsd/');
  // Agents now namespaced under gsd/ [I-5]
  removeDir(join(CLAUDE_DIR, 'agents', 'gsd'), 'agents/gsd/');
  removeDir(join(CLAUDE_DIR, 'workflows', 'gsd'), 'workflows/gsd/');
  removeDir(join(CLAUDE_DIR, 'references', 'gsd'), 'references/gsd/');
  removeDir(RUNTIME_DIR, 'gsd runtime/');
  removeDir(join(CLAUDE_DIR, 'gsd-lite'), 'legacy gsd-lite runtime/');
  // Deliberately NOT removing $XDG_RUNTIME_DIR/gsd, where the context bridge
  // lives when that variable is set (#8). It is outside the config directory
  // this uninstaller was pointed at, and an uninstaller whose blast radius
  // extends past its own target is the shape of every bug this file has had.
  // Those files are tmpfs, cleared at logout, and swept after a day anyway.
  // The fallback location, <config dir>/gsd/runtime/ctx, went with the runtime
  // directory removed above.

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
    for (const libFile of ['gsd-finder.cjs', 'statusline-composite.cjs', 'semver-sort.cjs', 'hook-registry.cjs', 'atomic-write.cjs', 'ctx-bridge.cjs']) {
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
    } catch (err) {
      if (isAbsent(err)) return;
      logProblem(`Could not remove '${key}' from ${label}: ${err.message}`, `Edit it by hand: ${filePath}`);
    }
  }
  function removeNestedEntry(filePath, parentKey, key, label) {
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (data[parentKey] && key in data[parentKey]) {
        delete data[parentKey][key];
        atomicWriteSync(filePath, JSON.stringify(data, null, 2) + '\n');
        logRemoved(`Removed '${key}' from ${label}`);
      }
    } catch (err) {
      if (isAbsent(err)) return;
      logProblem(`Could not remove '${key}' from ${label}: ${err.message}`, `Edit it by hand: ${filePath}`);
    }
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
        logProblem(
          'hooks/lib/hook-registry.cjs not found — settings.json hook entries left in place',
          `Remove them by hand, or reinstall and uninstall again: ${settingsPath}`,
        );
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
  } catch (err) {
    if (!isAbsent(err)) {
      logProblem(
        `Could not deregister from settings.json: ${err.message}`,
        `The hook and MCP entries still point at files this run deleted. Fix the file and run this again: ${settingsPath}`,
      );
    }
  }

  // One state, read twice — closing line and exit code. The previous attempt at
  // this was reverted for having them drift apart again (7b39ae0): it printed a
  // new message and still exited 0, and it reported removals on a run that had
  // removed nothing.
  const summary = { removed: removedCount, problems };
  if (problems.length > 0) {
    log(`\n! GSD-Lite is only partly uninstalled — ${problems.length} step(s) did not finish:`);
    for (const p of problems) log(`    - ${p.what}`);
    log('  Anything still registered keeps firing every session, at paths this run deleted.');
    log('  Deal with the cause and run this again.');
  } else if (removedCount === 0) {
    log(`\nNothing to remove — no GSD-Lite files or registrations found in ${CLAUDE_DIR}.`);
  } else {
    log('\n✓ GSD-Lite uninstalled.');
  }
  // Raise only. Forcing 0 on the happy path would let this erase a failure some
  // other part of the process already recorded — the quiet direction again.
  if (problems.length > 0) process.exitCode = 1;
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
