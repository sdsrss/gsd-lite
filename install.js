#!/usr/bin/env node
// Plugin installer for GSD-Lite

import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const { semverSortComparator } = _require('./hooks/lib/semver-sort.cjs');
const { isCompositeStatusLine, registerProvider: registerCompositeProvider } = _require('./hooks/lib/statusline-composite.cjs');
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const RUNTIME_DIR = join(CLAUDE_DIR, 'gsd');
const DRY_RUN = process.argv.includes('--dry-run');

// Single source of truth for hook files (used by copy loop and registration)
const HOOK_FILES = ['gsd-session-init.cjs', 'gsd-auto-update.cjs', 'gsd-context-monitor.cjs', 'gsd-statusline.cjs', 'gsd-session-stop.cjs'];

// Hook registration config: hookType → { file identifier, matcher, timeout? }
//
// Plugin installs do NOT use this: the plugin system loads hooks/hooks.json out
// of the plugin cache instead, and a settings.json copy alongside it would fire
// every hook twice. hooks/hooks.json must therefore declare the same three
// hooks with the same matchers and timeouts — tests/plugin-hooks.test.js pins
// that, and the plugin branch below deregisters any settings.json entry an
// earlier npx/manual install left behind.
export const HOOK_REGISTRY = [
  { hookType: 'SessionStart', identifier: 'gsd-session-init', matcher: 'startup|clear|compact', timeout: 5 },
  { hookType: 'PostToolUse', identifier: 'gsd-context-monitor', matcher: '*' },
  { hookType: 'Stop', identifier: 'gsd-session-stop', matcher: '*', timeout: 3 },
];

function log(msg) { console.log(msg); }

function isInstalledAsPlugin(claudeDir) {
  try {
    const pluginsPath = join(claudeDir, 'plugins', 'installed_plugins.json');
    const data = JSON.parse(readFileSync(pluginsPath, 'utf-8'));
    return !!data.plugins?.['gsd@gsd'];
  } catch {
    return false;
  }
}

function registerStatusLine(settings, statuslineScriptPath) {
  const command = `node ${JSON.stringify(statuslineScriptPath)}`;

  // Clean up legacy format (was incorrectly placed in hooks)
  if (settings.hooks?.StatusLine) delete settings.hooks.StatusLine;

  const current = settings.statusLine?.command || '';

  // Already GSD → update command path
  if (current.includes('gsd-statusline')) {
    settings.statusLine = { type: 'command', command };
    return true;
  }

  // No statusLine → set GSD directly
  if (!current) {
    settings.statusLine = { type: 'command', command };
    return true;
  }

  // Composite statusLine (e.g., code-graph) → register as provider
  if (isCompositeStatusLine(current)) {
    if (registerCompositeProvider(statuslineScriptPath)) {
      log('  ✓ Registered GSD in composite statusLine registry');
      return true;
    }
  }

  // Other statusLine → don't overwrite
  log('  ! Preserved existing statusLine');
  return false;
}

function registerHookEntry(hooks, { hookType, identifier, matcher, timeout }) {
  const scriptPath = join(CLAUDE_DIR, 'hooks', `${identifier}.cjs`);
  const command = `node ${JSON.stringify(scriptPath)}`;
  const hookDef = { type: 'command', command };
  if (timeout) hookDef.timeout = timeout;
  const entry = { matcher, hooks: [hookDef] };

  if (!hooks[hookType]) {
    hooks[hookType] = [entry];
    return true;
  }
  // Handle legacy string format
  if (typeof hooks[hookType] === 'string') {
    if (!hooks[hookType].includes(identifier)) {
      log(`  ! Preserved existing ${hookType} hook`);
      return false;
    }
    hooks[hookType] = [entry];
    return true;
  }
  if (Array.isArray(hooks[hookType])) {
    const idx = hooks[hookType].findIndex(e =>
      e.hooks?.some(h => h.command?.includes(identifier)));
    if (idx >= 0) hooks[hookType][idx] = entry;
    else hooks[hookType].push(entry);
    return true;
  }
  return false;
}

/**
 * Drop a previously registered GSD hook entry from settings.json.
 *
 * Used only on the plugin path, where hooks/hooks.json in the plugin cache is
 * the live registration: an entry left here by an earlier npx/manual install
 * would run the same hook a second time on every event.
 *
 * Returns true only when an entry was actually removed, so the caller reports
 * what happened rather than inferring it from having reached this line.
 */
function unregisterHookEntry(hooks, { hookType, identifier }) {
  const entries = hooks[hookType];
  if (typeof entries === 'string') {
    if (!entries.includes(identifier)) return false;
    delete hooks[hookType];
    return true;
  }
  if (!Array.isArray(entries)) return false;
  const kept = entries.filter(e => !e.hooks?.some(h => h.command?.includes(identifier)));
  if (kept.length === entries.length) return false;
  if (kept.length === 0) delete hooks[hookType];
  else hooks[hookType] = kept;
  return true;
}

/**
 * Read ~/.claude/settings.json, or abort.
 *
 * Registering GSD rewrites this file wholesale, so a parse failure cannot be
 * shrugged off: continuing with `{}` serializes an empty object over the user's
 * model, permissions (deny rules included), env, enabledPlugins, and every other
 * plugin's hook registrations, and the installer still exits 0 saying it
 * succeeded. A file we cannot read is a file we must not overwrite.
 *
 * Missing or whitespace-only is not a failure — there are no settings to lose.
 */
function readSettingsOrExit(settingsPath) {
  if (!existsSync(settingsPath)) return {};

  let raw;
  try {
    raw = readFileSync(settingsPath, 'utf-8');
  } catch (err) {
    // EACCES (root-owned file, restrictive umask) or EISDIR. Unreadable is the
    // same situation as unparseable: we cannot know what is in there, so we must
    // not write over it — and the user deserves the guidance, not a stack trace.
    log(`Error: ${settingsPath} could not be read — ${err.message}`);
    log('  Installing would rewrite that file and discard everything in it.');
    log('  Fix its permissions (or move it aside) and run the installer again.');
    process.exit(1);
  }
  if (raw.trim() === '') return {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log(`Error: ${settingsPath} is not valid JSON — ${err.message}`);
    log('  Installing would rewrite that file and discard everything in it:');
    log('  your model, permissions, env, and other plugins\' hook registrations.');
    log('  Fix the JSON (or move the file aside) and run the installer again.');
    process.exit(1);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log(`Error: ${settingsPath} does not contain a JSON object.`);
    log('  Refusing to overwrite it. Fix the file and run the installer again.');
    process.exit(1);
  }
  return parsed;
}

function copyDir(src, dest, label) {
  if (DRY_RUN) {
    log(`  [dry-run] Would copy ${src} → ${dest}`);
    return;
  }
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  log(`  ✓ ${label}`);
}

function copyFile(src, dest, label) {
  if (DRY_RUN) {
    log(`  [dry-run] Would copy ${src} → ${dest}`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
  log(`  ✓ ${label}`);
}

export function main() {
  log('GSD-Lite Installer\n');

  if (!existsSync(CLAUDE_DIR)) {
    log(`Error: ${CLAUDE_DIR} not found. Is Claude Code installed?`);
    process.exit(1);
  }

  // Check settings.json before touching anything: a file we cannot parse stops
  // the install here, with nothing copied and nothing half-registered. This runs
  // above the DRY_RUN branches on purpose — `--dry-run` predicts the real run,
  // and a real run would fail here, so the dry run reports it too.
  //
  // The parsed result is deliberately discarded. Everything between here and the
  // write below takes real time (file copies, and `npm ci` when node_modules is
  // absent), and settings.json is live: a running Claude Code session or another
  // plugin's installer can write it in that window. Holding this copy and
  // renaming it over the file at the end would discard their write — the exact
  // harm this function exists to prevent. Re-read immediately before writing.
  const settingsPath = join(CLAUDE_DIR, 'settings.json');
  readSettingsOrExit(settingsPath);

  log('Installing files...');

  // Clean up legacy "gsd-lite" runtime directory from older versions
  const LEGACY_RUNTIME_DIR = join(CLAUDE_DIR, 'gsd-lite');
  if (!DRY_RUN && existsSync(LEGACY_RUNTIME_DIR)) {
    rmSync(LEGACY_RUNTIME_DIR, { recursive: true, force: true });
    log('  ✓ Removed legacy gsd-lite runtime');
  }

  // Reset the managed runtime directory to clear stale files on reinstall, while
  // keeping runtime/ (update-state.json, update-notification.json). Removing the
  // managed entries in place is what makes that safe: runtime/ is never moved,
  // so no failure between here and the end can lose it.
  if (!DRY_RUN && existsSync(RUNTIME_DIR)) {
    for (const entry of readdirSync(RUNTIME_DIR)) {
      if (entry === 'runtime') continue;
      rmSync(join(RUNTIME_DIR, entry), { recursive: true, force: true });
    }
  }

  // Sweep staging dirs stranded by earlier versions of the step above. Kept out
  // of that block deliberately: the failure it cleans up after could leave
  // ~/.claude/gsd missing entirely, which is exactly when the block does not run.
  if (!DRY_RUN) {
    for (const entry of readdirSync(CLAUDE_DIR)) {
      if (entry.startsWith('.gsd-runtime-backup-')) {
        rmSync(join(CLAUDE_DIR, entry), { recursive: true, force: true });
      }
    }
  }

  // Decide install mode once — plugin-system-managed vs npx/manual.
  // In plugin mode, Claude Code loads commands/agents/workflows/references directly
  // from ~/.claude/plugins/cache/gsd/gsd/<version>/, so writing user-scope copies at
  // ~/.claude/{commands,agents,workflows,references}/gsd/ produces duplicate slash-command
  // entries and silent drift against the plugin cache.
  const isPluginInstall = isInstalledAsPlugin(CLAUDE_DIR);

  // 1-4. Commands / agents / workflows / references
  // Only deliver these user-scope copies in non-plugin installs (npx / manual / npm -g),
  // where no plugin cache exists to serve them.
  const userScopeCopies = [
    ['commands', 'commands → ~/.claude/commands/gsd/'],
    ['agents', 'agents → ~/.claude/agents/gsd/'],
    ['workflows', 'workflows → ~/.claude/workflows/gsd/'],
    ['references', 'references → ~/.claude/references/gsd/'],
  ];
  if (isPluginInstall) {
    // Clean up stale copies left by earlier install.js versions (< 0.7.4) that wrote
    // user-scope copies unconditionally. Keeping them around caused 2× skill-list
    // entries and could shadow plugin-cache versions.
    if (!DRY_RUN) {
      for (const [sub] of userScopeCopies) {
        const dest = join(CLAUDE_DIR, sub, 'gsd');
        if (existsSync(dest)) {
          rmSync(dest, { recursive: true, force: true });
          log(`  ✓ Removed legacy user-scope ${sub}/gsd/ (served by plugin cache)`);
        }
      }
    } else {
      for (const [sub] of userScopeCopies) {
        const dest = join(CLAUDE_DIR, sub, 'gsd');
        if (existsSync(dest)) log(`  [dry-run] Would remove legacy ${dest}`);
      }
    }
  } else {
    for (const [sub, label] of userScopeCopies) {
      copyDir(join(__dirname, sub), join(CLAUDE_DIR, sub, 'gsd'), label);
    }
  }

  // 5. Hooks (copy scripts only, skip hooks.json to avoid overwriting other plugins)
  for (const hookFile of HOOK_FILES) {
    copyFile(join(__dirname, 'hooks', hookFile), join(CLAUDE_DIR, 'hooks', hookFile), `hooks/${hookFile}`);
  }
  // 5b. Hook library dependencies (e.g. gsd-finder.cjs used by statusline + session-init)
  const hookLibDir = join(__dirname, 'hooks', 'lib');
  if (existsSync(hookLibDir)) {
    copyDir(hookLibDir, join(CLAUDE_DIR, 'hooks', 'lib'), 'hooks/lib → ~/.claude/hooks/lib/');
  }

  // 6. Stable runtime for MCP server
  copyDir(join(__dirname, 'src'), join(RUNTIME_DIR, 'src'), 'runtime/src → ~/.claude/gsd/src/');
  // Write a sanitized package.json: strip dev-only npm lifecycle scripts
  // (prepare/prepublishOnly/version use POSIX shell + dev tooling absent from
  // the runtime). Leaving them in means a later manual `npm install` in
  // ~/.claude/gsd fails under cmd.exe on Windows (issue #2).
  if (DRY_RUN) {
    log('  [dry-run] Would write runtime/package.json (dev scripts stripped)');
  } else {
    const runtimePkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
    delete runtimePkg.scripts;
    mkdirSync(RUNTIME_DIR, { recursive: true });
    writeFileSync(join(RUNTIME_DIR, 'package.json'), JSON.stringify(runtimePkg, null, 2) + '\n');
    log('  ✓ runtime/package.json → ~/.claude/gsd/package.json (scripts stripped)');
  }
  // Copy uninstall.js so the SessionStart hook's Phase 0 orphan-cleanup can
  // spawn it when /plugin uninstall has removed the plugin without running our
  // uninstaller. Without this, hooks/runtime/settings.json entries written by
  // install.js outlive the plugin and keep firing.
  copyFile(join(__dirname, 'uninstall.js'), join(RUNTIME_DIR, 'uninstall.js'), 'runtime/uninstall.js → ~/.claude/gsd/uninstall.js');
  // Copy lock file so `npm ci` works when node_modules are not present (npx scenario)
  const lockFile = join(__dirname, 'package-lock.json');
  if (existsSync(lockFile)) {
    copyFile(lockFile, join(RUNTIME_DIR, 'package-lock.json'), 'runtime/package-lock.json → ~/.claude/gsd/package-lock.json');
  }

  // 7. Runtime dependencies — copy local node_modules or install fresh (npx hoists deps)
  const localNM = join(__dirname, 'node_modules');
  if (existsSync(localNM)) {
    copyDir(localNM, join(RUNTIME_DIR, 'node_modules'), 'runtime/node_modules (copied)');
  } else if (!DRY_RUN) {
    log('  ⧗ Installing runtime dependencies...');
    const lockFile = join(RUNTIME_DIR, 'package-lock.json');
    const hasLockFile = existsSync(lockFile);
    // --ignore-scripts: the runtime install only needs node_modules. Skipping
    // lifecycle scripts avoids running the dev-only POSIX `prepare` git-hook
    // setup, which fails under cmd.exe on Windows (issue #2).
    const installCmd = hasLockFile
      ? 'npm ci --omit=dev --ignore-scripts'
      : 'npm install --omit=dev --no-fund --no-audit --ignore-scripts';
    try {
      execSync(installCmd, { cwd: RUNTIME_DIR, stdio: 'pipe' });
      log('  ✓ runtime dependencies installed');
    } catch (err) {
      log(`  ✗ Failed to install runtime dependencies: ${err.message}`);
      process.exit(1);
    }
  } else {
    log('  [dry-run] Would install runtime dependencies');
  }

  // 8. Register MCP server + hooks in settings.json
  //    When installed as a plugin, the plugin system handles MCP via .mcp.json,
  //    so we skip manual MCP registration to avoid name collisions.
  if (!DRY_RUN) {
    // Fresh read: this is the copy that gets written back, so it has to reflect
    // whatever landed in the file while the install was running. A parse failure
    // that appeared in the meantime aborts here rather than clobbering.
    const settings = readSettingsOrExit(settingsPath);

    if (!settings.mcpServers) settings.mcpServers = {};
    // Remove legacy "gsd-lite" server entry from older versions
    delete settings.mcpServers['gsd-lite'];

    if (isPluginInstall) {
      // Plugin system handles MCP via .mcp.json — remove stale manual entry
      if (settings.mcpServers.gsd) {
        delete settings.mcpServers.gsd;
        log('  ✓ Removed manual MCP entry (plugin .mcp.json handles registration)');
      }
    } else {
      settings.mcpServers.gsd = {
        command: 'node',
        args: [join(RUNTIME_DIR, 'src', 'server.js')],
      };
      log('  ✓ MCP server registered in settings.json');
    }

    // StatusLine is a top-level setting that the plugin system (hooks.json)
    // cannot manage. Always register, regardless of install method.
    const statuslinePath = join(CLAUDE_DIR, 'hooks', 'gsd-statusline.cjs');
    let statusLineRegistered = registerStatusLine(settings, statuslinePath);

    // Hooks are registered in exactly one place, chosen by install method.
    // Plugin installs are served by hooks/hooks.json inside the plugin cache, so
    // writing them here too would fire every hook twice per event; npx/manual
    // installs have no plugin cache, so settings.json is the only route. Either
    // way, deregister the other path's leftovers — a user who moves between
    // install methods otherwise accumulates one live copy and one stale one.
    let hooksRegistered = false;
    let hooksUnregistered = 0;
    if (!settings.hooks) settings.hooks = {};
    for (const config of HOOK_REGISTRY) {
      if (isPluginInstall) {
        if (unregisterHookEntry(settings.hooks, config)) hooksUnregistered += 1;
      } else if (registerHookEntry(settings.hooks, config)) {
        hooksRegistered = true;
      }
    }
    if (hooksUnregistered > 0) {
      log(`  ✓ Removed ${hooksUnregistered} settings.json hook entr${hooksUnregistered === 1 ? 'y' : 'ies'} (plugin hooks.json handles registration)`);
    }

    const tmpSettings = settingsPath + `.${process.pid}-${Date.now()}.tmp`;
    writeFileSync(tmpSettings, JSON.stringify(settings, null, 2) + '\n');
    renameSync(tmpSettings, settingsPath);
    // Say which of the two actually landed. "hooks registered" printed after a
    // plugin install — where hooksRegistered is false by design — would be the
    // installer asserting work it did not do.
    const wrote = [hooksRegistered && 'hooks', statusLineRegistered && 'statusLine'].filter(Boolean);
    if (wrote.length > 0) {
      log(`  ✓ GSD-Lite ${wrote.join(' + ')} registered in settings.json`);
    }

    // Record install mode so SessionStart's Phase 0 orphan-cleanup can
    // distinguish "plugin uninstalled" from "npx install". Without this marker
    // the hook falls back to the .orphaned_at cache heuristic, which is fine
    // for pre-marker users but more guess-y.
    try {
      const installModeMarker = join(RUNTIME_DIR, '.install-mode');
      writeFileSync(installModeMarker, (isPluginInstall ? 'plugin' : 'manual') + '\n');
    } catch { /* best effort — marker missing falls back to heuristic */ }

    // Clear stale .orphaned_at from the current plugin cache version, in case
    // the user previously uninstalled (Claude Code stamps it) and is now
    // reinstalling via /plugin. Leaving it would make orphan-cleanup mis-fire
    // on the next session.
    if (isPluginInstall) {
      try {
        const currentVersion = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8')).version;
        const orphanMarker = join(CLAUDE_DIR, 'plugins', 'cache', 'gsd', 'gsd', currentVersion, '.orphaned_at');
        if (existsSync(orphanMarker)) rmSync(orphanMarker, { force: true });
      } catch { /* best effort */ }
    }
  } else {
    log('  [dry-run] Would register MCP server in settings.json');
  }

  // 9. Prune old plugin cache versions (keep latest 3)
  if (!DRY_RUN && isPluginInstall) {
    const cacheBase = join(CLAUDE_DIR, 'plugins', 'cache', 'gsd', 'gsd');
    if (existsSync(cacheBase)) {
      try {
        const entries = readdirSync(cacheBase, { withFileTypes: true })
          .filter(e => e.isDirectory() && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(e.name)).map(e => e.name);
        if (entries.length > 3) {
          const sorted = entries.slice().sort(semverSortComparator);
          // Detect versions with active processes to avoid disrupting running sessions
          let activeVersions;
          try {
            const psOut = execSync('ps aux', { stdio: 'pipe', timeout: 5000 }).toString();
            activeVersions = new Set(entries.filter(v => psOut.includes(`/cache/gsd/gsd/${v}/`)));
          } catch { activeVersions = new Set(); }

          const toRemove = sorted.slice(0, sorted.length - 3);
          let pruned = 0;
          for (const ver of toRemove) {
            if (activeVersions.has(ver)) continue; // skip versions with running processes
            rmSync(join(cacheBase, ver), { recursive: true, force: true });
            pruned++;
          }
          if (pruned > 0) log(`  ✓ Pruned ${pruned} old cache version(s), kept latest 3`);
        }
      } catch { /* best effort */ }
    }
  }

  log('\n✓ GSD-Lite installed successfully!');
  log('  Use /gsd:start to begin a new project');
  log('  Use /gsd:resume to continue an existing project');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
