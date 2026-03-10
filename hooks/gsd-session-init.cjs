#!/usr/bin/env node
// GSD-Lite SessionStart hook
// Auto-registers statusLine in settings.json if not already configured.
// This bridges the gap for plugin marketplace installs (which don't run install.js).
// Idempotent: skips if statusLine already points to gsd-statusline, preserves
// third-party statuslines.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const pluginRoot = path.resolve(__dirname, '..');
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const settingsPath = path.join(claudeDir, 'settings.json');
const statuslineScript = path.join(pluginRoot, 'hooks', 'gsd-statusline.cjs');

try {
  // Verify the statusline script exists (sanity check)
  if (!fs.existsSync(statuslineScript)) {
    process.exit(0);
  }

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    process.exit(0); // Can't read settings — don't risk writing a broken file
  }

  // Already has a statusLine configured (ours or third-party) — don't overwrite
  if (settings.statusLine?.command) {
    process.exit(0);
  }

  // Register our statusLine
  settings.statusLine = {
    type: 'command',
    command: `node ${JSON.stringify(statuslineScript)}`
  };

  // Atomic write to avoid corruption
  const tmpPath = settingsPath + '.gsd-tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmpPath, settingsPath);
} catch {
  // Silent fail — never block session start
}
