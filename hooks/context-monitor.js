// hooks/context-monitor.js
// ESM wrapper — exports functions for unit tests.
// Production hooks use gsd-statusline.js (CJS) and gsd-context-monitor.js (CJS) directly.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * StatusLine hook — reads context_window data and writes bridge file.
 * Used by unit tests; production uses gsd-statusline.js (CJS).
 */
export function statusLine(data, basePath) {
  try {
    const remaining = data?.context_window?.remaining_percentage;
    if (remaining == null) return;

    const gsdDir = join(basePath || process.cwd(), '.gsd');
    mkdirSync(gsdDir, { recursive: true });
    writeFileSync(join(gsdDir, '.context-health'), String(remaining));
  } catch (err) {
    if (process.env.GSD_DEBUG) console.error('[context-monitor:statusLine]', err);
  }
}

/**
 * PostToolUse hook — reads .context-health and returns warning text.
 * Used by unit tests; production uses gsd-context-monitor.js (CJS).
 */
export function postToolUse(basePath) {
  try {
    const gsdDir = join(basePath || process.cwd(), '.gsd');
    const health = parseInt(readFileSync(join(gsdDir, '.context-health'), 'utf-8'), 10);

    if (health <= 25) {
      return `🛑 CONTEXT EMERGENCY (${health}% remaining): Save state NOW. Set workflow_mode = awaiting_clear. Tell user to /clear then /gsd:resume.`;
    }
    if (health <= 35) {
      return `⚠️ CONTEXT LOW (${health}% remaining): Complete current task, save state, set workflow_mode = awaiting_clear. Tell user to /clear then /gsd:resume.`;
    }
  } catch (err) {
    if (process.env.GSD_DEBUG) console.error('[context-monitor:postToolUse]', err);
  }
  return null;
}
