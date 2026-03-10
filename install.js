#!/usr/bin/env node
// Plugin installer for GSD-Lite

import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = join(homedir(), '.claude');
const RUNTIME_DIR = join(CLAUDE_DIR, 'gsd-lite');
const DRY_RUN = process.argv.includes('--dry-run');

function log(msg) { console.log(msg); }

function formatHookCommand(scriptPath, hookName) {
  return `node ${JSON.stringify(scriptPath)} ${hookName}`;
}

function registerManagedHook(hooks, key, value) {
  const existing = hooks[key];
  if (!existing || existing.includes('context-monitor.js')) {
    hooks[key] = value;
    return true;
  }
  log(`  ! Preserved existing ${key} hook`);
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

function main() {
  log('GSD-Lite Installer\n');

  if (!existsSync(CLAUDE_DIR)) {
    log(`Error: ${CLAUDE_DIR} not found. Is Claude Code installed?`);
    process.exit(1);
  }

  log('Installing files...');

  // Reset managed runtime directory to avoid stale files on reinstall
  if (!DRY_RUN && existsSync(RUNTIME_DIR)) {
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
  }

  // 1. Commands
  copyDir(join(__dirname, 'commands'), join(CLAUDE_DIR, 'commands', 'gsd'), 'commands → ~/.claude/commands/gsd/');

  // 2. Agents (namespaced under gsd/ to avoid collisions) [I-5]
  copyDir(join(__dirname, 'agents'), join(CLAUDE_DIR, 'agents', 'gsd'), 'agents → ~/.claude/agents/gsd/');

  // 3. Workflows
  copyDir(join(__dirname, 'workflows'), join(CLAUDE_DIR, 'workflows', 'gsd'), 'workflows → ~/.claude/workflows/gsd/');

  // 4. References
  copyDir(join(__dirname, 'references'), join(CLAUDE_DIR, 'references', 'gsd'), 'references → ~/.claude/references/gsd/');

  // 5. Hooks
  copyDir(join(__dirname, 'hooks'), join(CLAUDE_DIR, 'hooks'), 'hooks → ~/.claude/hooks/');

  // 6. Stable runtime for MCP server
  copyDir(join(__dirname, 'src'), join(RUNTIME_DIR, 'src'), 'runtime/src → ~/.claude/gsd-lite/src/');
  copyDir(join(__dirname, 'node_modules'), join(RUNTIME_DIR, 'node_modules'), 'runtime/node_modules → ~/.claude/gsd-lite/node_modules/');

  // 7. Register MCP server in settings.json
  const settingsPath = join(CLAUDE_DIR, 'settings.json');
  if (!DRY_RUN) {
    let settings = {};
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {}

    if (!settings.mcpServers) settings.mcpServers = {};
    settings.mcpServers['gsd-lite'] = {
      command: 'node',
      args: [join(RUNTIME_DIR, 'src', 'server.js')],
    };

    // Register hooks
    if (!settings.hooks) settings.hooks = {};
    const hookPath = join(CLAUDE_DIR, 'hooks', 'context-monitor.js');
    const statusLineRegistered = registerManagedHook(
      settings.hooks,
      'StatusLine',
      formatHookCommand(hookPath, 'statusLine'),
    );
    const postToolUseRegistered = registerManagedHook(
      settings.hooks,
      'PostToolUse',
      formatHookCommand(hookPath, 'postToolUse'),
    );

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    log('  ✓ MCP server registered in settings.json');
    if (statusLineRegistered || postToolUseRegistered) {
      log('  ✓ GSD-Lite hooks registered in settings.json');
    }
  } else {
    log('  [dry-run] Would register MCP server in settings.json');
  }

  log('\n✓ GSD-Lite installed successfully!');
  log('  Use /gsd:start to begin a new project');
  log('  Use /gsd:resume to continue an existing project');
}

main();
