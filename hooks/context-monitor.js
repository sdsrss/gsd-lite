// hooks/context-monitor.js
// This file exports TWO hook handlers used by Claude Code's hooks system.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * StatusLine hook — called after each tool use.
 * Reads remaining_percentage and writes to .gsd/.context-health
 */
export function statusLine(data) {
  try {
    const remaining = data?.context_window?.remaining_percentage;
    if (remaining == null) return;

    // Find .gsd/ in cwd
    const gsdDir = join(process.cwd(), '.gsd');
    mkdirSync(gsdDir, { recursive: true });
    writeFileSync(join(gsdDir, '.context-health'), String(remaining));
  } catch {}
}

/**
 * PostToolUse hook — called after each tool use.
 * Reads .context-health and returns warning/stop text if threshold breached.
 */
export function postToolUse() {
  try {
    const gsdDir = join(process.cwd(), '.gsd');
    const health = parseInt(readFileSync(join(gsdDir, '.context-health'), 'utf-8'), 10);

    if (health < 20) {
      return `🛑 CONTEXT EMERGENCY (${health}% remaining): Save state NOW. Set workflow_mode = awaiting_clear. Tell user to /clear then /gsd:resume.`;
    }
    if (health < 40) {
      return `⚠️ CONTEXT LOW (${health}% remaining): Complete current task, save state, set workflow_mode = awaiting_clear. Tell user to /clear then /gsd:resume.`;
    }
  } catch {}
  return null;
}
