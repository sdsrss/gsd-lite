#!/usr/bin/env node
// Plugin uninstaller for GSD-Lite

import { existsSync, rmSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const RUNTIME_DIR = join(CLAUDE_DIR, 'gsd');

function log(msg) { console.log(msg); }

function atomicWriteSync(filePath, content) {
  const tmp = filePath + `.${process.pid}-${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, filePath);
}

function removeDir(path, label) {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
    log(`  ✓ Removed ${label}`);
  }
}

export function main() {
  log('GSD-Lite Uninstaller\n');

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
      log(`  ✓ Removed hooks/${name}`);
    }
  }
  // Remove hook library dependencies
  const hookLibDir = join(CLAUDE_DIR, 'hooks', 'lib');
  if (existsSync(hookLibDir)) {
    // Only remove GSD-owned files, not other plugins' libs
    const gsdLibFile = join(hookLibDir, 'gsd-finder.cjs');
    if (existsSync(gsdLibFile)) {
      rmSync(gsdLibFile);
      log('  ✓ Removed hooks/lib/gsd-finder.cjs');
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
        log(`  ✓ Removed '${key}' from ${label}`);
      }
    } catch {}
  }
  function removeNestedEntry(filePath, parentKey, key, label) {
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (data[parentKey] && key in data[parentKey]) {
        delete data[parentKey][key];
        atomicWriteSync(filePath, JSON.stringify(data, null, 2) + '\n');
        log(`  ✓ Removed '${key}' from ${label}`);
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
      // Remove GSD entries from hook arrays
      for (const [hookType, identifier] of [
        ['PostToolUse', 'gsd-context-monitor'],
        ['PostToolUse', 'context-monitor.js'],
        ['SessionStart', 'gsd-session-init'],
        ['Stop', 'gsd-session-stop'],
      ]) {
        if (Array.isArray(settings.hooks[hookType])) {
          const len = settings.hooks[hookType].length;
          settings.hooks[hookType] = settings.hooks[hookType].filter(e =>
            !e.hooks?.some(h => h.command?.includes(identifier)));
          if (settings.hooks[hookType].length < len) changed = true;
          if (settings.hooks[hookType].length === 0) delete settings.hooks[hookType];
        } else if (typeof settings.hooks[hookType] === 'string'
            && settings.hooks[hookType].includes(identifier)) {
          delete settings.hooks[hookType];
          changed = true;
        }
      }
    }
    if (changed) {
      atomicWriteSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      log('  ✓ MCP server + hooks + plugin entries deregistered from settings.json');
    }
  } catch {}

  log('\n✓ GSD-Lite uninstalled.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
