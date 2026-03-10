#!/usr/bin/env node
// Plugin uninstaller for GSD-Lite

import { existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const CLAUDE_DIR = join(homedir(), '.claude');
const RUNTIME_DIR = join(CLAUDE_DIR, 'gsd-lite');

function log(msg) { console.log(msg); }

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
  removeDir(RUNTIME_DIR, 'gsd-lite runtime/');

  // Remove hook file
  const hookFile = join(CLAUDE_DIR, 'hooks', 'context-monitor.js');
  if (existsSync(hookFile)) {
    rmSync(hookFile);
    log('  ✓ Removed hooks/context-monitor.js');
  }

  // Clean up plugin system directories (from /plugin install)
  removeDir(join(CLAUDE_DIR, 'plugins', 'marketplaces', 'gsd-lite'), 'plugins/marketplaces/gsd-lite/');
  removeDir(join(CLAUDE_DIR, 'plugins', 'cache', 'gsd-lite'), 'plugins/cache/gsd-lite/');

  // Deregister from plugin registry files
  const pluginsDir = join(CLAUDE_DIR, 'plugins');
  function removeJsonEntry(filePath, key, label) {
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (key in data) {
        delete data[key];
        writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
        log(`  ✓ Removed '${key}' from ${label}`);
      }
    } catch {}
  }
  function removeNestedEntry(filePath, parentKey, key, label) {
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (data[parentKey] && key in data[parentKey]) {
        delete data[parentKey][key];
        writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
        log(`  ✓ Removed '${key}' from ${label}`);
      }
    } catch {}
  }
  removeJsonEntry(join(pluginsDir, 'known_marketplaces.json'), 'gsd-lite', 'known_marketplaces.json');
  removeNestedEntry(join(pluginsDir, 'installed_plugins.json'), 'plugins', 'gsd-lite@gsd-lite', 'installed_plugins.json');

  // Deregister MCP server, hooks, and plugin entries from settings.json
  const settingsPath = join(CLAUDE_DIR, 'settings.json');
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    let changed = false;
    if (settings.mcpServers && settings.mcpServers['gsd-lite']) {
      delete settings.mcpServers['gsd-lite'];
      changed = true;
    }
    // Remove plugin system entries
    if (settings.enabledPlugins && 'gsd-lite@gsd-lite' in settings.enabledPlugins) {
      delete settings.enabledPlugins['gsd-lite@gsd-lite'];
      changed = true;
    }
    if (settings.extraKnownMarketplaces && settings.extraKnownMarketplaces['gsd-lite']) {
      delete settings.extraKnownMarketplaces['gsd-lite'];
      if (Object.keys(settings.extraKnownMarketplaces).length === 0) {
        delete settings.extraKnownMarketplaces;
      }
      changed = true;
    }
    // Remove top-level statusLine if GSD's
    if (settings.statusLine?.command?.includes('context-monitor.js')) {
      delete settings.statusLine;
      changed = true;
    }
    if (settings.hooks) {
      // Remove legacy StatusLine string entry
      if (typeof settings.hooks.StatusLine === 'string'
          && settings.hooks.StatusLine.includes('context-monitor.js')) {
        delete settings.hooks.StatusLine;
        changed = true;
      }
      // Remove GSD PostToolUse entry from array
      if (Array.isArray(settings.hooks.PostToolUse)) {
        const len = settings.hooks.PostToolUse.length;
        settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(e =>
          !e.hooks?.some(h => h.command?.includes('context-monitor.js')));
        if (settings.hooks.PostToolUse.length < len) changed = true;
        if (settings.hooks.PostToolUse.length === 0) delete settings.hooks.PostToolUse;
      } else if (typeof settings.hooks.PostToolUse === 'string'
          && settings.hooks.PostToolUse.includes('context-monitor.js')) {
        delete settings.hooks.PostToolUse;
        changed = true;
      }
    }
    if (changed) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      log('  ✓ MCP server + hooks + plugin entries deregistered from settings.json');
    }
  } catch {}

  log('\n✓ GSD-Lite uninstalled.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
