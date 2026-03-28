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
const HOOK_REGISTRY = [
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

  log('Installing files...');

  // Clean up legacy "gsd-lite" runtime directory from older versions
  const LEGACY_RUNTIME_DIR = join(CLAUDE_DIR, 'gsd-lite');
  if (!DRY_RUN && existsSync(LEGACY_RUNTIME_DIR)) {
    rmSync(LEGACY_RUNTIME_DIR, { recursive: true, force: true });
    log('  ✓ Removed legacy gsd-lite runtime');
  }

  // Reset managed runtime directory to avoid stale files on reinstall
  // Preserve runtime/ subdirectory (update-state.json, update-notification.json)
  if (!DRY_RUN && existsSync(RUNTIME_DIR)) {
    const runtimeSubdir = join(RUNTIME_DIR, 'runtime');
    const preserveRuntime = existsSync(runtimeSubdir);
    let runtimeBackup;
    if (preserveRuntime) {
      runtimeBackup = join(RUNTIME_DIR, '..', '.gsd-runtime-backup');
      try { cpSync(runtimeSubdir, runtimeBackup, { recursive: true }); } catch { runtimeBackup = null; }
    }
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
    if (runtimeBackup) {
      try {
        mkdirSync(join(RUNTIME_DIR, 'runtime'), { recursive: true });
        cpSync(runtimeBackup, join(RUNTIME_DIR, 'runtime'), { recursive: true });
        rmSync(runtimeBackup, { recursive: true, force: true });
      } catch { /* best effort */ }
    }
  }

  // 1. Commands
  copyDir(join(__dirname, 'commands'), join(CLAUDE_DIR, 'commands', 'gsd'), 'commands → ~/.claude/commands/gsd/');

  // 2. Agents (namespaced under gsd/ to avoid collisions) [I-5]
  copyDir(join(__dirname, 'agents'), join(CLAUDE_DIR, 'agents', 'gsd'), 'agents → ~/.claude/agents/gsd/');

  // 3. Workflows
  copyDir(join(__dirname, 'workflows'), join(CLAUDE_DIR, 'workflows', 'gsd'), 'workflows → ~/.claude/workflows/gsd/');

  // 4. References
  copyDir(join(__dirname, 'references'), join(CLAUDE_DIR, 'references', 'gsd'), 'references → ~/.claude/references/gsd/');

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
  copyFile(join(__dirname, 'package.json'), join(RUNTIME_DIR, 'package.json'), 'runtime/package.json → ~/.claude/gsd/package.json');

  // 7. Runtime dependencies — copy local node_modules or install fresh (npx hoists deps)
  const localNM = join(__dirname, 'node_modules');
  if (existsSync(localNM)) {
    copyDir(localNM, join(RUNTIME_DIR, 'node_modules'), 'runtime/node_modules (copied)');
  } else if (!DRY_RUN) {
    log('  ⧗ Installing runtime dependencies...');
    try {
      execSync('npm ci --omit=dev', { cwd: RUNTIME_DIR, stdio: 'pipe' });
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
  const settingsPath = join(CLAUDE_DIR, 'settings.json');
  const isPluginInstall = isInstalledAsPlugin(CLAUDE_DIR);
  if (!DRY_RUN) {
    let settings = {};
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log(`  ! Warning: Could not parse ${settingsPath}: ${err.message}`);
      }
    }

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

    // Always register hooks in settings.json regardless of install method.
    // The plugin system's hooks.json auto-loading is unreliable — settings.json
    // is the only reliable hook registration path (consistent with claude-mem-lite).
    let hooksRegistered = false;
    if (!settings.hooks) settings.hooks = {};
    for (const config of HOOK_REGISTRY) {
      if (registerHookEntry(settings.hooks, config)) hooksRegistered = true;
    }

    const tmpSettings = settingsPath + `.${process.pid}-${Date.now()}.tmp`;
    writeFileSync(tmpSettings, JSON.stringify(settings, null, 2) + '\n');
    renameSync(tmpSettings, settingsPath);
    if (statusLineRegistered || hooksRegistered) {
      log('  ✓ GSD-Lite hooks registered in settings.json');
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
          .filter(e => e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name)).map(e => e.name);
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
