#!/usr/bin/env node
// GSD-Lite StatusLine hook
// Shows: model | current task | directory | context usage progress bar
// Reads JSON from stdin, writes bridge file for context-monitor PostToolUse hook.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

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
    const session = data.session_id || '';
    const remaining = data.context_window?.remaining_percentage;

    // Current GSD task from state.json
    let task = '';
    let hasGsd = false;
    const gsdDir = path.join(cwd, '.gsd');
    try {
      const state = JSON.parse(fs.readFileSync(path.join(gsdDir, 'state.json'), 'utf8'));
      hasGsd = true;
      if (state.current_task && state.current_phase) {
        const phase = (state.phases || []).find(p => p.id === state.current_phase);
        const t = phase?.todo?.find(t => t.id === state.current_task);
        if (t) task = `${t.id} ${t.name}`;
      }
    } catch {
      // No state.json or parse error — skip task display
    }

    // Context window display (USED percentage scaled to usable context)
    // Claude Code reserves ~16.5% for autocompact buffer
    const AUTO_COMPACT_BUFFER_PCT = 16.5;
    let ctx = '';
    if (remaining != null) {
      const usableRemaining = Math.max(0, ((remaining - AUTO_COMPACT_BUFFER_PCT) / (100 - AUTO_COMPACT_BUFFER_PCT)) * 100);
      const used = Math.max(0, Math.min(100, Math.round(100 - usableRemaining)));

      // Write bridge file for context-monitor PostToolUse hook (skip if remaining unchanged)
      if (session) {
        try {
          const bridgePath = path.join(os.tmpdir(), `gsd-ctx-${session}.json`);
          let needsWrite = true;
          try {
            const existing = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
            if (existing.remaining_percentage === remaining) needsWrite = false;
          } catch { /* no existing file */ }
          if (needsWrite) {
            const tmpBridge = bridgePath + '.tmp';
            fs.writeFileSync(tmpBridge, JSON.stringify({
              session_id: session,
              remaining_percentage: remaining,
              used_pct: used,
              has_gsd: hasGsd,
              timestamp: Math.floor(Date.now() / 1000),
            }));
            fs.renameSync(tmpBridge, bridgePath);
          }
        } catch {
          // Silent fail — bridge is best-effort
        }
      }

      // Also write to .gsd/.context-health for MCP server reads (skip if unchanged)
      try {
        const healthPath = path.join(gsdDir, '.context-health');
        const current = fs.readFileSync(healthPath, 'utf8').trim();
        if (current !== String(remaining)) {
          fs.writeFileSync(healthPath, String(remaining));
        }
      } catch {
        // File doesn't exist yet or .gsd/ missing — ensure dir exists then atomic write
        try {
          fs.mkdirSync(gsdDir, { recursive: true });
          const tmpHealth = path.join(gsdDir, `.context-health.${process.pid}.tmp`);
          fs.writeFileSync(tmpHealth, String(remaining));
          fs.renameSync(tmpHealth, path.join(gsdDir, '.context-health'));
        } catch { /* silent */ }
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
  } catch {
    // Silent fail
  }
});
