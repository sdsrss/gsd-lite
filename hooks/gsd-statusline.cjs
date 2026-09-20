#!/usr/bin/env node
// GSD-Lite StatusLine hook
// Shows: model | current task | directory | context usage progress bar
// Reads JSON from stdin, writes bridge file for context-monitor PostToolUse hook.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { findGsdDir } = require('./lib/gsd-finder.cjs');
const { atomicWrite, readMarker, readJsonOwned } = require('./lib/atomic-write.cjs');

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const model = data.model?.display_name || 'Claude';
    const cwd = data.workspace?.current_dir || process.cwd();
    const session = String(data.session_id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!session) process.exit(0); // Reject empty session ID to avoid bridge file collision
    // Must resolve to a real number: a non-numeric value propagates through the
    // arithmetic below as NaN, which renders an empty bar labelled "NaN%" and —
    // because every `used < N` comparison is false for NaN — dresses it in the
    // blinking-red critical style. Treat it as absent instead.
    // A numeric string is accepted, but only by coercing strings: Number('') and
    // Number(null) are both 0, so coercing everything would turn an ABSENT value
    // into "100% used" plus that same false critical alarm.
    const rawRemaining = data.context_window?.remaining_percentage;
    const coerced = typeof rawRemaining === 'string' && rawRemaining.trim() !== ''
      ? Number(rawRemaining)
      : rawRemaining;
    const remaining = Number.isFinite(coerced) ? coerced : null;

    // Current GSD task from state.json
    let task = '';
    let hasGsd = false;
    const gsdDir = findGsdDir(cwd);
    // `.gsd/state.json` is as repo-controlled as `.gsd/.context-health`, and it is
    // read on every render. A bare readFileSync here meant a FIFO planted at this
    // path hung the statusline forever — the same failure the marker guard fixed
    // one path over, which is why it goes through the same guard now. Absent or
    // unusable is a null to branch on, not an exception to catch: the old catch
    // could not have caught a blocking read anyway.
    const state = gsdDir ? readJsonOwned(path.join(gsdDir, 'state.json')) : null;
    if (state) {
      hasGsd = true;
      if (state.current_task && state.current_phase) {
        // Every field here is repo-controlled, and this block no longer sits in a
        // try/catch — so a `phases` that is present but not an array must not
        // throw. It used to, and the outer handler caught it: the statusline went
        // blank AND the bridge and .context-health writes below were skipped,
        // which takes out the exhaustion warning and the awaiting_clear resume
        // gate with no sign that anything happened.
        const phases = Array.isArray(state.phases) ? state.phases : [];
        const phase = phases.find(p => p?.id === state.current_phase);
        const todo = Array.isArray(phase?.todo) ? phase.todo : [];
        const t = todo.find(x => x?.id === state.current_task);
        if (typeof t?.name === 'string') {
          const name = t.name.length > 40 ? t.name.substring(0, 40) + '...' : t.name;
          task = `${t.id} ${name}`;
        }
      }
    }

    // Context window display (USED percentage scaled to usable context)
    // Claude Code reserves ~16.5% for autocompact buffer (configurable via env)
    const AUTO_COMPACT_BUFFER_PCT = Math.min(99, Math.max(0, Number(process.env.GSD_AUTOCOMPACT_BUFFER) || 16.5));
    let ctx = '';
    if (remaining != null) {
      const divisor = 100 - AUTO_COMPACT_BUFFER_PCT;
      const usableRemaining = divisor > 0 ? Math.max(0, ((remaining - AUTO_COMPACT_BUFFER_PCT) / divisor) * 100) : 0;
      const used = Math.max(0, Math.min(100, Math.round(100 - usableRemaining)));

      // Write bridge file for context-monitor PostToolUse hook (skip if remaining unchanged)
      if (session) {
        try {
          const bridgePath = path.join(os.tmpdir(), `gsd-ctx-${session}.json`);
          let needsWrite = true;
          // Anything unreadable, unparseable or not object-shaped comes back null
          // and leaves needsWrite true, so the obstruction is rewritten rather
          // than treated as a matching value.
          const existing = readJsonOwned(bridgePath);
          if (existing && existing.remaining_percentage === remaining && existing.has_gsd === hasGsd) needsWrite = false;
          if (needsWrite) {
            // R-23 made the tmp name unique (pid+timestamp) so concurrent
            // statusline processes would not race on a shared `.tmp`. Unique is
            // not the same as unguessable: os.tmpdir() is world-writable on a
            // shared host, and both components are derivable, so another local
            // user could plant a symlink and have writeFileSync follow it.
            // atomicWrite adds the random suffix and the O_EXCL open, and its
            // rename evicts a planted link rather than being blocked by it.
            atomicWrite(bridgePath, JSON.stringify({
              session_id: session,
              remaining_percentage: remaining,
              used_pct: used,
              has_gsd: hasGsd,
              timestamp: Math.floor(Date.now() / 1000),
            }));
          }
        } catch (e) {
          if (process.env.GSD_DEBUG) process.stderr.write(`gsd-statusline: bridge write failed: ${e.message}\n`);
        }
      }

      // Also write to .gsd/.context-health for MCP server reads (atomic, skip if unchanged)
      // Only write if a .gsd directory was found — never create .gsd from the hook
      if (gsdDir) {
        try {
          const healthPath = path.join(gsdDir, '.context-health');
          let needsHealthWrite = true;
          const healthRaw = readMarker(healthPath);
          if (healthRaw !== null && healthRaw.trim() === String(remaining)) needsHealthWrite = false;
          if (needsHealthWrite) {
            // Same predictable-temp problem as the bridge above, but inside
            // `.gsd/`, which a cloned repository controls outright.
            fs.mkdirSync(gsdDir, { recursive: true });
            atomicWrite(healthPath, String(remaining));
          }
        } catch (e) {
          if (process.env.GSD_DEBUG) process.stderr.write(`gsd-statusline: context-health write failed: ${e.message}\n`);
        }
      }

      // Progress bar (10 segments)
      const filled = Math.floor(used / 10);
      const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);

      if (used < 50) {
        ctx = ` \x1b[32m${bar} ${used}%\x1b[0m`;
      } else if (used < 65) {
        ctx = ` \x1b[33m${bar} ${used}%\x1b[0m`;
      } else if (used < 80) {
        ctx = ` \x1b[38;5;208m${bar} ${used}%\x1b[0m`;
      } else {
        ctx = ` \x1b[5;31m\uD83D\uDC80 ${bar} ${used}%\x1b[0m`;
      }
    }

    // Output
    const dirname = path.basename(cwd);
    if (task) {
      process.stdout.write(`\x1b[2m${model}\x1b[0m \u2502 \x1b[1m${task}\x1b[0m \u2502 \x1b[2m${dirname}\x1b[0m${ctx}`);
    } else {
      process.stdout.write(`\x1b[2m${model}\x1b[0m \u2502 \x1b[2m${dirname}\x1b[0m${ctx}`);
    }
  } catch (e) {
    if (process.env.GSD_DEBUG) process.stderr.write(`gsd-statusline: ${e.message}\n`);
  }
});
