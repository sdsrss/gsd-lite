#!/usr/bin/env node
// GSD-Lite Stop hook — Crash Protection
//
// Runs when Claude Code session ends (exit, /clear, crash).
// If an active GSD project is found, writes a .session-end marker file
// so that /gsd:resume can detect the non-graceful exit and inform the user.
//
// Design decisions:
// - Does NOT modify state.json directly (avoids bypassing schema validation)
// - Uses a marker file (.gsd/.session-end) that resume preflight checks
// - Only acts on active sessions (not completed/failed/paused)
// - Timeout guard: exits after 4s (hook timeout is 5s)

'use strict';

const path = require('node:path');
const { findGsdDir, readState } = require('./lib/gsd-finder.cjs');
const { atomicWriteJson } = require('./lib/atomic-write.cjs');
const os = require('node:os');
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// Stand down when the plugin's own copy of this hook is the live registration —
// which means installed, enabled, AND actually declaring Stop in its
// hooks/hooks.json. Both copies are registered on purpose; see pluginServesHooks
// in lib/hook-registry.cjs for why removing one is the wrong fix. Guarded: if
// the helper is missing we run, because running twice is visible and running
// never is not.
try {
  const { pluginServesHooks } = require('./lib/hook-registry.cjs');
  if (pluginServesHooks(claudeDir, __dirname, 'Stop')) process.exit(0);
} catch { /* helper absent — carry on */ }

// Safety: exit after 4s regardless
setTimeout(() => process.exit(0), 4000).unref();

const TERMINAL_MODES = ['completed', 'failed', 'paused_by_user'];

(async () => {
  const cwd = process.cwd();
  const gsdDir = findGsdDir(cwd);
  if (!gsdDir) process.exit(0);

  const state = readState(gsdDir);
  if (!state) process.exit(0);

  // Only write marker for active (non-terminal, non-paused) sessions
  if (TERMINAL_MODES.includes(state.workflow_mode)) process.exit(0);

  // Get current git HEAD
  let gitHead = state.git_head || '';
  try {
    const { execSync } = require('node:child_process');
    gitHead = execSync('git rev-parse HEAD', {
      cwd: path.dirname(gsdDir),
      timeout: 2000,
      encoding: 'utf8',
    }).trim();
  } catch { /* keep existing git_head */ }

  // Write .session-end marker
  const marker = {
    ended_at: new Date().toISOString(),
    workflow_mode_was: state.workflow_mode,
    current_phase: state.current_phase,
    current_task: state.current_task,
    git_head: gitHead,
    reason: 'session_stop',
  };

  // `.gsd/` belongs to the repository, so a clone controls every path under it.
  // The old temp name was `.session-end.<pid>.tmp` — no random component — which
  // a hostile checkout could pre-create as a symlink and have writeFileSync
  // follow. atomicWriteJson opens the temp O_EXCL under a random name, and its
  // rename replaces a link planted at the marker path instead of following it;
  // see lib/atomic-write.cjs.
  const markerPath = path.join(gsdDir, '.session-end');
  try {
    atomicWriteJson(markerPath, marker);
  } catch (e) {
    if (process.env.GSD_DEBUG) {
      process.stderr.write(`gsd-session-stop: ${e.message}\n`);
    }
  }
})().catch(() => {});
