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

const os = require('node:os');
const path = require('node:path');
const { atomicWrite, readJsonOwned } = require('./lib/atomic-write.cjs');

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// Stand down when the plugin's own copy of this hook is the live registration —
// which means installed, enabled, AND actually declaring PostToolUse in its
// hooks/hooks.json. Both copies are registered on purpose; see pluginServesHooks
// in lib/hook-registry.cjs for why removing one is the wrong fix. Guarded: if
// the helper is missing we run, because running twice is visible and running
// never is not.
try {
  const { pluginServesHooks } = require('./lib/hook-registry.cjs');
  if (pluginServesHooks(claudeDir, __dirname, 'PostToolUse')) process.exit(0);
} catch { /* helper absent — carry on */ }

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

    // readJsonOwned folds all four ways this can go wrong — missing, not a regular
    // file, unparseable, or parsed to a non-object — into a single null. Absence
    // has to be a return value and not an exception here: JSON.parse(null) yields
    // null instead of raising, so a try/catch written for readFileSync's ENOENT
    // would sail straight past it.
    const metrics = readJsonOwned(metricsPath);
    if (metrics === null) process.exit(0); // No usable bridge file — fresh session or subagent
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

    // Non-GSD sessions: don't interfere — let Claude's auto-compaction handle it
    const isGsdActive = metrics.has_gsd === true;
    if (!isGsdActive) {
      process.exit(0);
    }

    // Debounce logic
    const warnPath = path.join(tmpDir, `gsd-ctx-${sessionId}-warned.json`);
    let warnData = { callsSinceWarn: 0, lastLevel: null };

    // Only a plain object is adopted. An array passed the old `typeof` check and
    // then silently refused to carry the counter through JSON.stringify, which
    // made a single planted `[]` suppress the warning for the rest of the session.
    const parsedWarn = readJsonOwned(warnPath);
    if (parsedWarn) warnData = parsedWarn;

    warnData.callsSinceWarn = (warnData.callsSinceWarn || 0) + 1;

    const isCritical = remaining <= CRITICAL_THRESHOLD;
    const currentLevel = isCritical ? 'critical' : 'warning';

    // Atomic debounce state write helper. warnPath sits in os.tmpdir(), which is
    // world-writable on a shared host, and both halves of the old temp name were
    // derivable — same planted-symlink exposure as the statusline bridge this
    // file reads from. atomicWrite opens the temp O_EXCL under a random name,
    // and its rename evicts a planted link instead of being stopped by one.
    //
    // Best effort, and that is the whole point: this file is bookkeeping, the
    // warning below is the product. A throw here used to reach the outer catch
    // and exit 0 with empty stdout, so planting a symlink at a path anyone can
    // derive from `ls /tmp/gsd-ctx-*` silently suppressed every context-exhaustion
    // warning for that session. Failing to debounce means the warning may repeat —
    // noisy, and noticed. Losing the warning is silent, and is not.
    const writeWarnData = (data) => {
      try {
        atomicWrite(warnPath, JSON.stringify(data));
      } catch (e) {
        if (process.env.GSD_DEBUG) process.stderr.write(`gsd-context-monitor: debounce write skipped: ${e.message}\n`);
      }
    };

    // Severity escalation bypasses debounce (lastLevel null = first warning, always fire)
    const severityEscalated = currentLevel === 'critical' && warnData.lastLevel === 'warning';
    if (warnData.lastLevel !== null && warnData.callsSinceWarn < DEBOUNCE_CALLS && !severityEscalated) {
      writeWarnData(warnData);
      process.exit(0);
    }

    // Reset debounce
    warnData.callsSinceWarn = 0;
    warnData.lastLevel = currentLevel;
    writeWarnData(warnData);

    let message;
    if (isCritical) {
      message = `CONTEXT CRITICAL: Usage at ${usedPct}%. Remaining: ${remaining}%. `
        + 'Context is nearly exhausted. Complete current task checkpoint immediately, '
        + 'set workflow_mode = awaiting_clear via state-update, and tell user to /clear then /gsd:resume.';
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
