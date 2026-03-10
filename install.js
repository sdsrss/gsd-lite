#!/usr/bin/env node
// Plugin installer for GSD-Lite

import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = join(homedir(), '.claude');
const RUNTIME_DIR = join(CLAUDE_DIR, 'gsd-lite');
const DRY_RUN = process.argv.includes('--dry-run');

function log(msg) { console.log(msg); }


function registerStatusLine(settings, statuslineScriptPath) {
  const command = `node ${JSON.stringify(statuslineScriptPath)}`;
  // Don't overwrite non-GSD statusLine
  if (settings.statusLine && typeof settings.statusLine === 'object'
      && !settings.statusLine.command?.includes('gsd-statusline')) {
    log('  ! Preserved existing statusLine');
    return false;
  }
  settings.statusLine = { type: 'command', command };
  // Clean up legacy format (was incorrectly placed in hooks)
  if (settings.hooks?.StatusLine) delete settings.hooks.StatusLine;
  return true;
}

function registerPostToolUseHook(hooks, contextMonitorPath) {
  const command = `node ${JSON.stringify(contextMonitorPath)}`;
  const entry = { matcher: '*', hooks: [{ type: 'command', command }] };
  if (!hooks.PostToolUse) {
    hooks.PostToolUse = [entry];
    return true;
  }
  // Handle legacy string format
  if (typeof hooks.PostToolUse === 'string') {
    if (!hooks.PostToolUse.includes('gsd-context-monitor')) {
      log('  ! Preserved existing PostToolUse hook');
      return false;
    }
    hooks.PostToolUse = [entry];
    return true;
  }
  if (Array.isArray(hooks.PostToolUse)) {
    const idx = hooks.PostToolUse.findIndex(e =>
      e.hooks?.some(h => h.command?.includes('gsd-context-monitor')));
    if (idx >= 0) hooks.PostToolUse[idx] = entry;
    else hooks.PostToolUse.push(entry);
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
  copyFile(join(__dirname, 'package.json'), join(RUNTIME_DIR, 'package.json'), 'runtime/package.json → ~/.claude/gsd-lite/package.json');

  // 7. Runtime dependencies — copy local node_modules or install fresh (npx hoists deps)
  const localNM = join(__dirname, 'node_modules');
  if (existsSync(localNM)) {
    copyDir(localNM, join(RUNTIME_DIR, 'node_modules'), 'runtime/node_modules (copied)');
  } else if (!DRY_RUN) {
    log('  ⧗ Installing runtime dependencies...');
    execSync('npm install --omit=dev', { cwd: RUNTIME_DIR, stdio: 'pipe' });
    log('  ✓ runtime dependencies installed');
  } else {
    log('  [dry-run] Would install runtime dependencies');
  }

  // 8. Register MCP server in settings.json
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

    // Register statusLine (top-level setting) and PostToolUse hook
    if (!settings.hooks) settings.hooks = {};
    const statuslinePath = join(CLAUDE_DIR, 'hooks', 'gsd-statusline.cjs');
    const contextMonitorPath = join(CLAUDE_DIR, 'hooks', 'gsd-context-monitor.cjs');
    const statusLineRegistered = registerStatusLine(settings, statuslinePath);
    const postToolUseRegistered = registerPostToolUseHook(settings.hooks, contextMonitorPath);

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
