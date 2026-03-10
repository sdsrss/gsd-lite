#!/usr/bin/env node
// Plugin installer for GSD-Lite

import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = join(homedir(), '.claude');
const DRY_RUN = process.argv.includes('--dry-run');

function log(msg) { console.log(msg); }

function copyDir(src, dest, label) {
  if (DRY_RUN) {
    log(`  [dry-run] Would copy ${src} → ${dest}`);
    return;
  }
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  log(`  ✓ ${label}`);
}

function main() {
  log('GSD-Lite Installer\n');

  if (!existsSync(CLAUDE_DIR)) {
    log(`Error: ${CLAUDE_DIR} not found. Is Claude Code installed?`);
    process.exit(1);
  }

  log('Installing files...');

  // 1. Commands
  copyDir(join(__dirname, 'commands'), join(CLAUDE_DIR, 'commands', 'gsd'), 'commands → ~/.claude/commands/gsd/');

  // 2. Agents
  copyDir(join(__dirname, 'agents'), join(CLAUDE_DIR, 'agents'), 'agents → ~/.claude/agents/');

  // 3. Workflows
  copyDir(join(__dirname, 'workflows'), join(CLAUDE_DIR, 'workflows', 'gsd'), 'workflows → ~/.claude/workflows/gsd/');

  // 4. References
  copyDir(join(__dirname, 'references'), join(CLAUDE_DIR, 'references', 'gsd'), 'references → ~/.claude/references/gsd/');

  // 5. Hooks
  copyDir(join(__dirname, 'hooks'), join(CLAUDE_DIR, 'hooks'), 'hooks → ~/.claude/hooks/');

  // 6. Register MCP server in settings.json
  const settingsPath = join(CLAUDE_DIR, 'settings.json');
  if (!DRY_RUN) {
    let settings = {};
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {}

    if (!settings.mcpServers) settings.mcpServers = {};
    settings.mcpServers['gsd-lite'] = {
      command: 'node',
      args: [join(__dirname, 'src', 'server.js')],
    };

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    log('  ✓ MCP server registered in settings.json');
  } else {
    log('  [dry-run] Would register MCP server in settings.json');
  }

  log('\n✓ GSD-Lite installed successfully!');
  log('  Use /gsd:start to begin a new project');
  log('  Use /gsd:resume to continue an existing project');
}

main();
