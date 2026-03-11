#!/usr/bin/env node
// GSD-Lite Context Monitor — PostToolUse hook
// Reads context metrics from the statusline bridge file and injects
// warnings when context usage is high.
//
// Architecture:
// 1. StatusLine hook writes metrics to /tmp/gsd-ctx-{session_id}.json
// 2. This hook reads those metrics after each tool use
// 3. When remaining context drops below thresholds, injects a warning
//    via hookSpecificOutput.additionalContext
//
// Only active when GSD project is running (has_gsd = true in bridge file).
// Non-GSD sessions exit early — Claude's auto-compaction handles context.
//
// Thresholds (GSD sessions only):
//   WARNING  (remaining <= 35%): Agent should wrap up current task
//   CRITICAL (remaining <= 25%): Agent must stop and save state
//
// Debounce: 5 tool uses between warnings to avoid spam
// Severity escalation bypasses debounce (WARNING -> CRITICAL fires immediately)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WARNING_THRESHOLD = 35;
const CRITICAL_THRESHOLD = 25;
const STALE_SECONDS = 60;
const DEBOUNCE_CALLS = 5;

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const rawSessionId = data.session_id;

    if (!rawSessionId) {
      process.exit(0);
    }
    const sessionId = String(rawSessionId).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!sessionId) process.exit(0);

    const tmpDir = os.tmpdir();
    const metricsPath = path.join(tmpDir, `gsd-ctx-${sessionId}.json`);

    let metrics;
    try {
      metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
    } catch {
      process.exit(0); // No bridge file — fresh session or subagent
    }
    const remaining = metrics.remaining_percentage;
    const usedPct = metrics.used_pct;

    // Cheapest check first — most calls exit here
    if (remaining > WARNING_THRESHOLD) {
      process.exit(0);
    }

    // Ignore stale metrics (treat missing timestamp as stale)
    const now = Math.floor(Date.now() / 1000);
    const metricAge = now - (metrics.timestamp || 0);
    if (metricAge > STALE_SECONDS) {
      process.exit(0);
    }

    // Debounce logic
    const warnPath = path.join(tmpDir, `gsd-ctx-${sessionId}-warned.json`);
    let warnData = { callsSinceWarn: 0, lastLevel: null };
    let firstWarn = true;

    try {
      warnData = JSON.parse(fs.readFileSync(warnPath, 'utf8'));
      firstWarn = false;
    } catch {
      // No prior warning state — first warning this session
    }

    warnData.callsSinceWarn = (warnData.callsSinceWarn || 0) + 1;

    const isCritical = remaining <= CRITICAL_THRESHOLD;
    const currentLevel = isCritical ? 'critical' : 'warning';

    // Severity escalation bypasses debounce
    const severityEscalated = currentLevel === 'critical' && warnData.lastLevel === 'warning';
    if (!firstWarn && warnData.callsSinceWarn < DEBOUNCE_CALLS && !severityEscalated) {
      fs.writeFileSync(warnPath, JSON.stringify(warnData));
      process.exit(0);
    }

    // Reset debounce
    warnData.callsSinceWarn = 0;
    warnData.lastLevel = currentLevel;
    fs.writeFileSync(warnPath, JSON.stringify(warnData));

    // Use bridge data to avoid extra filesystem check
    const isGsdActive = metrics.has_gsd === true;

    // Non-GSD sessions: don't interfere — let Claude's auto-compaction handle it
    if (!isGsdActive) {
      process.exit(0);
    }

    let message;
    if (isCritical) {
      message = `CONTEXT CRITICAL: Usage at ${usedPct}%. Remaining: ${remaining}%. `
        + 'Context is nearly exhausted. Complete current task checkpoint immediately, '
        + 'set workflow_mode = awaiting_clear via gsd-state-update, and tell user to /clear then /gsd:resume.';
    } else {
      message = `CONTEXT WARNING: Usage at ${usedPct}%. Remaining: ${remaining}%. `
        + 'Context is getting limited. Avoid starting new complex work. Complete current task then save state.';
    }

    const output = {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: message,
      },
    };

    process.stdout.write(JSON.stringify(output));
  } catch (e) {
    if (process.env.GSD_DEBUG) process.stderr.write(`gsd-context-monitor: ${e.message}\n`);
    process.exit(0);
  }
});
