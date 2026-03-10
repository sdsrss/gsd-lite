#!/usr/bin/env node
// Plugin uninstaller for GSD-Lite

import { existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CLAUDE_DIR = join(homedir(), '.claude');

function log(msg) { console.log(msg); }

function removeDir(path, label) {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
    log(`  ✓ Removed ${label}`);
  }
}

function main() {
  log('GSD-Lite Uninstaller\n');

  log('Removing files...');

  removeDir(join(CLAUDE_DIR, 'commands', 'gsd'), 'commands/gsd/');
  // Note: don't remove agents/ entirely — other tools may have agents there
  // Remove only gsd-specific agent files
  const agentFiles = ['gsd-executor.md', 'gsd-reviewer.md', 'gsd-researcher.md', 'gsd-debugger.md'];
  for (const f of agentFiles) {
    const p = join(CLAUDE_DIR, 'agents', f);
    if (existsSync(p)) {
      rmSync(p);
      log(`  ✓ Removed agents/${f}`);
    }
  }
  removeDir(join(CLAUDE_DIR, 'workflows', 'gsd'), 'workflows/gsd/');
  removeDir(join(CLAUDE_DIR, 'references', 'gsd'), 'references/gsd/');

  // Remove hook file
  const hookFile = join(CLAUDE_DIR, 'hooks', 'context-monitor.js');
  if (existsSync(hookFile)) {
    rmSync(hookFile);
    log('  ✓ Removed hooks/context-monitor.js');
  }

  // Deregister MCP server
  const settingsPath = join(CLAUDE_DIR, 'settings.json');
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    if (settings.mcpServers && settings.mcpServers['gsd-lite']) {
      delete settings.mcpServers['gsd-lite'];
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      log('  ✓ MCP server deregistered from settings.json');
    }
  } catch {}

  log('\n✓ GSD-Lite uninstalled.');
}

main();
