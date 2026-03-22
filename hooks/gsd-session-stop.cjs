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

const fs = require('node:fs');
const path = require('node:path');
const { findGsdDir, readState } = require('./lib/gsd-finder.cjs');

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

  const markerPath = path.join(gsdDir, '.session-end');
  const tmpPath = markerPath + `.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(marker, null, 2) + '\n');
    fs.renameSync(tmpPath, markerPath);
  } catch (e) {
    // Clean up tmp if rename failed
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    if (process.env.GSD_DEBUG) {
      process.stderr.write(`gsd-session-stop: ${e.message}\n`);
    }
  }
})().catch(() => {});
