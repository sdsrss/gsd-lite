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
const { upsertHookEntry } = _require('./hooks/lib/hook-registry.cjs');
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const RUNTIME_DIR = join(CLAUDE_DIR, 'gsd');
const DRY_RUN = process.argv.includes('--dry-run');

// Single source of truth for hook files (used by copy loop and registration)
const HOOK_FILES = ['gsd-session-init.cjs', 'gsd-auto-update.cjs', 'gsd-context-monitor.cjs', 'gsd-statusline.cjs', 'gsd-session-stop.cjs'];

// Hook registration config: hookType → { file identifier, matcher, timeout? }
//
// hooks/hooks.json declares the same three hooks for plugin installs and must
// stay in sync with this list — tests/plugin-manifest.test.js pins matcher and
// timeout across the two. Both registrations can be live at once: the copies
// under ~/.claude/hooks stand down while the plugin's are serving, so nothing
// fires twice and nothing has to be deleted to achieve that.
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

  // Clean up GSD's own legacy format (a StatusLine key under hooks, which was
  // this project's mistake). Ownership-checked: the two sibling call sites in
  // uninstall.js and gsd-session-init.cjs both match on the command before
  // deleting, and this one used to delete any StatusLine key it found — the
  // same shape as removing a whole matcher group for one hook in it.
  const legacyStatusLine = settings.hooks?.StatusLine;
  if (typeof legacyStatusLine === 'string'
      && (legacyStatusLine.includes('gsd-statusline') || legacyStatusLine.includes('context-monitor.js'))) {
    delete settings.hooks.StatusLine;
  }

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
  const registered = upsertHookEntry(hooks, {
    hookType,
    identifier,
    matcher,
    timeout,
    command: `node ${JSON.stringify(scriptPath)}`,
  });
  if (!registered) log(`  ! Preserved existing ${hookType} hook`);
  return registered;
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

/**
 * Is a pid still running?
 *
 * `kill(pid, 0)` sends no signal; it only asks. ESRCH means gone. EPERM means
 * alive but owned by someone else — still alive, so still hands off. Anything
 * unparseable (a directory name we did not write) is treated as alive, because
 * the cost of skipping a sweep is litter and the cost of a wrong delete is a
 * corrupted install.
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
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

  // The managed runtime is built in a staging directory and swapped in at the
  // end (see STAGING_DIR below), so nothing here removes the live one. It used
  // to: the reset ran first and `npm ci` ran ~100 lines later, so any dependency
  // install that could not complete — no npm on PATH, no network, a registry
  // 500 — left ~/.claude/gsd holding new src/ with no node_modules, and the MCP
  // server threw ERR_MODULE_NOT_FOUND on every start after that. The background
  // updater runs this path on session start, unattended.
  //
  // Sweep staging and backup dirs stranded by an interrupted earlier run — but
  // never one another install is still building into.
  //
  // Both names carry the owning pid. A second install.js is a reachable state,
  // not a theoretical one: the auto-updater's lock goes stale after 10s
  // (LOCK_STALE_MS in gsd-auto-update.cjs) while an install holding it can run
  // for 60s, so a second session takes the lock and spawns its own installer.
  // Deleting a live run's tree mid-copy is not a tidy failure — cpSync aborts
  // the process with an uncatchable std::filesystem error, or worse, returns
  // normally having copied only part of the tree, and that truncated tree then
  // gets renamed over ~/.claude/gsd under a success message.
  if (!DRY_RUN) {
    for (const entry of readdirSync(CLAUDE_DIR)) {
      const prefix = ['.gsd-runtime-backup-', '.gsd-staging-'].find(p => entry.startsWith(p));
      if (!prefix) continue;
      if (isPidAlive(Number(entry.slice(prefix.length)))) continue;
      rmSync(join(CLAUDE_DIR, entry), { recursive: true, force: true });
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

  // 6. Stable runtime for MCP server — built beside the live one, swapped in at
  // the end. Everything from here to the swap writes only to STAGING_DIR, so a
  // failure at any point leaves the working runtime exactly as it was.
  const STAGING_DIR = join(CLAUDE_DIR, `.gsd-staging-${process.pid}`);
  const abandonStaging = () => {
    try { rmSync(STAGING_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  // Belt and braces for every throw between here and the swap — a failed
  // copyFile, a full disk, anything not already handled below. 'exit' fires on
  // normal exit and after an uncaught exception, and rmSync is synchronous, so
  // the staging tree does not outlive the process that owns it. A hard kill
  // (SIGKILL, or the uncatchable filesystem abort) escapes this, which is what
  // the pid-aware sweep above is for: by the next run the owner is gone.
  let stagingSwapped = false;
  process.on('exit', () => { if (!stagingSwapped) abandonStaging(); });

  copyDir(join(__dirname, 'src'), join(STAGING_DIR, 'src'), 'runtime/src → ~/.claude/gsd/src/');
  // Write a sanitized package.json: strip dev-only npm lifecycle scripts
  // (prepare/prepublishOnly/version use POSIX shell + dev tooling absent from
  // the runtime). Leaving them in means a later manual `npm install` in
  // ~/.claude/gsd fails under cmd.exe on Windows (issue #2).
  if (DRY_RUN) {
    log('  [dry-run] Would write runtime/package.json (dev scripts stripped)');
  } else {
    const runtimePkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
    delete runtimePkg.scripts;
    mkdirSync(STAGING_DIR, { recursive: true });
    writeFileSync(join(STAGING_DIR, 'package.json'), JSON.stringify(runtimePkg, null, 2) + '\n');
    log('  ✓ runtime/package.json → ~/.claude/gsd/package.json (scripts stripped)');
  }
  // Copy uninstall.js so the SessionStart hook's Phase 0 orphan-cleanup can
  // spawn it when /plugin uninstall has removed the plugin without running our
  // uninstaller. Without this, hooks/runtime/settings.json entries written by
  // install.js outlive the plugin and keep firing.
  copyFile(join(__dirname, 'uninstall.js'), join(STAGING_DIR, 'uninstall.js'), 'runtime/uninstall.js → ~/.claude/gsd/uninstall.js');
  // Copy lock file so `npm ci` works when node_modules are not present (npx scenario)
  const lockFile = join(__dirname, 'package-lock.json');
  if (existsSync(lockFile)) {
    copyFile(lockFile, join(STAGING_DIR, 'package-lock.json'), 'runtime/package-lock.json → ~/.claude/gsd/package-lock.json');
  }

  // 7. Runtime dependencies — copy local node_modules or install fresh (npx hoists deps)
  const localNM = join(__dirname, 'node_modules');
  if (existsSync(localNM)) {
    copyDir(localNM, join(STAGING_DIR, 'node_modules'), 'runtime/node_modules (copied)');
  } else if (!DRY_RUN) {
    log('  ⧗ Installing runtime dependencies...');
    const lockFile = join(STAGING_DIR, 'package-lock.json');
    const hasLockFile = existsSync(lockFile);
    // --ignore-scripts: the runtime install only needs node_modules. Skipping
    // lifecycle scripts avoids running the dev-only POSIX `prepare` git-hook
    // setup, which fails under cmd.exe on Windows (issue #2).
    const installCmd = hasLockFile
      ? 'npm ci --omit=dev --ignore-scripts'
      : 'npm install --omit=dev --no-fund --no-audit --ignore-scripts';
    try {
      execSync(installCmd, { cwd: STAGING_DIR, stdio: 'pipe' });
      log('  ✓ runtime dependencies installed');
    } catch (err) {
      log(`  ✗ Failed to install runtime dependencies: ${err.message}`);
      log('  The previous runtime is untouched and still works.');
      abandonStaging();
      process.exit(1);
    }
  } else {
    log('  [dry-run] Would install runtime dependencies');
  }

  // 7b. Swap the staged runtime into place.
  //
  // Everything that can fail has now happened, and none of it touched the live
  // directory. What is left is two renames within CLAUDE_DIR — same filesystem,
  // so each is atomic and the window where ~/.claude/gsd does not exist is
  // microseconds rather than the length of an `npm ci`.
  //
  // runtime/ (update-state.json, update-notification.json) belongs to the
  // updater, not to any released version, so it is carried across rather than
  // replaced. Losing it resets the update-check throttle and drops a pending
  // notification.
  if (!DRY_RUN) {
    const backupDir = join(CLAUDE_DIR, `.gsd-runtime-backup-${process.pid}`);
    const hadRuntime = existsSync(RUNTIME_DIR);
    try {
      if (hadRuntime) renameSync(RUNTIME_DIR, backupDir);
      try {
        renameSync(STAGING_DIR, RUNTIME_DIR);
      } catch (err) {
        // Put the working runtime back before giving up — a missing
        // ~/.claude/gsd is worse than a stale one.
        if (hadRuntime && !existsSync(RUNTIME_DIR)) renameSync(backupDir, RUNTIME_DIR);
        throw err;
      }
      stagingSwapped = true;
      log('  ✓ runtime swapped into ~/.claude/gsd');
    } catch (err) {
      log(`  ✗ Failed to install the new runtime: ${err.message}`);
      log('  The previous runtime is untouched and still works.');
      abandonStaging();
      process.exit(1);
    }

    // Carry runtime/ across by renaming the directory, not by copying its
    // contents: a file in there the installer cannot read (a root-owned or
    // chmod-000 update-state.json) must not cost the user the directory, and a
    // rename never opens what it moves. Best effort by design — the update-check
    // throttle and a pending notification are worth preserving, but not worth
    // failing an otherwise complete install over.
    const carried = join(backupDir, 'runtime');
    if (hadRuntime && existsSync(carried)) {
      try {
        renameSync(carried, join(RUNTIME_DIR, 'runtime'));
      } catch (err) {
        log(`  ! Could not carry over gsd/runtime/: ${err.message}`);
      }
    }
    if (hadRuntime) {
      // force:true swallows ENOENT but not EACCES, and the install is already
      // complete at this point — a backup we cannot delete is litter, not a
      // failure. The next run's sweep tries again.
      try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* swept next run */ }
    }
  } else {
    log('  [dry-run] Would swap the staged runtime into ~/.claude/gsd');
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

    // Register hooks here whatever the install method, including when the
    // plugin is also present. That looks like it would double-fire, and the
    // hooks themselves are what prevent it: the copies under ~/.claude/hooks
    // stand down while the plugin's own registration is live (pluginServesHooks
    // in hooks/lib/hook-registry.cjs).
    //
    // Deregistering here instead — which this installer did briefly — strands
    // the user. The settings.json registration is the only GSD code that still
    // runs after `/plugin uninstall`, since the plugin's hooks stop loading with
    // it. Remove that and a complete npx install sits on disk with nothing
    // registered anywhere, nothing able to notice, and no message saying so.
    let hooksRegistered = false;
    if (!settings.hooks) settings.hooks = {};
    for (const config of HOOK_REGISTRY) {
      if (registerHookEntry(settings.hooks, config)) hooksRegistered = true;
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
