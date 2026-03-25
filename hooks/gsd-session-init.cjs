#!/usr/bin/env node
// GSD-Lite SessionStart hook
// 1. Cleans up stale temp files (throttled to once/day).
// 2. Auto-registers statusLine in settings.json if not already configured.
// 3. Self-heals .mcp.json if missing.
// 4. Shows notification if a previous background update completed or found a new version.
// 5. Spawns background auto-update (detached, non-blocking).
// 6. Injects GSD project progress into stdout + CLAUDE.md (if active project found).
// Idempotent: skips if statusLine already points to gsd-statusline, preserves
// third-party statuslines.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const settingsPath = path.join(claudeDir, 'settings.json');

// Safety: exit after 4s regardless (hook timeout is 5s)
setTimeout(() => process.exit(0), 4000).unref();

(async () => {
  // ── Phase 1: Clean up stale bridge/debounce files (throttled to once/day) ──
  try {
    const cleanupMarker = path.join(claudeDir, 'gsd', 'runtime', 'last-cleanup');
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    let shouldClean = true;
    try {
      shouldClean = now - fs.statSync(cleanupMarker).mtimeMs > DAY_MS;
    } catch { /* no marker = first run */ }

    if (shouldClean) {
      const tmpDir = os.tmpdir();
      for (const entry of fs.readdirSync(tmpDir)) {
        if (!entry.startsWith('gsd-ctx-')) continue;
        try {
          const fullPath = path.join(tmpDir, entry);
          if (now - fs.statSync(fullPath).mtimeMs > DAY_MS) fs.unlinkSync(fullPath);
        } catch { /* skip */ }
      }
      try {
        fs.mkdirSync(path.dirname(cleanupMarker), { recursive: true });
        fs.writeFileSync(cleanupMarker, String(now));
      } catch { /* skip */ }
    }
  } catch { /* silent */ }

  // ── Phase 2: StatusLine auto-registration ──
  // StatusLine is a top-level settings.json config that the plugin system
  // (hooks.json) cannot manage. Self-heal if not registered.
  try {
    const stableStatuslinePath = path.join(claudeDir, 'hooks', 'gsd-statusline.cjs');
    if (fs.existsSync(stableStatuslinePath)) {
      let settings = {};
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch { /* Can't read settings — skip registration */ }

      if (settings) {
        const current = settings.statusLine?.command || '';

        if (current.includes('gsd-statusline')) {
          // Already registered — nothing to do
        } else if (!current) {
          // No statusLine — register directly
          settings.statusLine = {
            type: 'command',
            command: `node ${JSON.stringify(stableStatuslinePath)}`
          };
          const tmpPath = settingsPath + `.gsd-tmp-${process.pid}`;
          fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n');
          fs.renameSync(tmpPath, settingsPath);
        } else if (current.includes('statusline-composite')) {
          // Composite system (e.g., code-graph) — register as provider
          try {
            const { registerProvider } = require('./lib/statusline-composite.cjs');
            registerProvider(stableStatuslinePath);
          } catch { /* composite helper not available */ }
        }
        // else: some other statusLine, don't overwrite
      }
    }
  } catch { /* silent */ }

  // ── Phase 3: Self-heal .mcp.json in plugin directories ──
  // If .mcp.json is missing (e.g. git operations deleted it), regenerate it
  // so the plugin system can register the GSD MCP server.
  try {
    const pluginsPath = path.join(claudeDir, 'plugins', 'installed_plugins.json');
    if (fs.existsSync(pluginsPath)) {
      const plugins = JSON.parse(fs.readFileSync(pluginsPath, 'utf8'));
      const gsdEntry = plugins.plugins?.['gsd@gsd']?.[0];
      if (gsdEntry) {
        const mcpContent = JSON.stringify({
          mcpServers: {
            gsd: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/launcher.js'] },
          },
        }, null, 2) + '\n';
        // Check marketplace dir
        const marketplaceDir = path.join(claudeDir, 'plugins', 'marketplaces', 'gsd');
        const marketplaceMcp = path.join(marketplaceDir, '.mcp.json');
        if (fs.existsSync(marketplaceDir) && !fs.existsSync(marketplaceMcp)) {
          fs.writeFileSync(marketplaceMcp, mcpContent);
        }
        // Check plugin cache dir
        if (gsdEntry.installPath) {
          const cacheMcp = path.join(gsdEntry.installPath, '.mcp.json');
          if (fs.existsSync(gsdEntry.installPath) && !fs.existsSync(cacheMcp)) {
            fs.writeFileSync(cacheMcp, mcpContent);
          }
        }
      }
    }
  } catch { /* silent */ }

  // ── Phase 4: Show notification from previous background auto-update ──
  try {
    const notifPath = path.join(claudeDir, 'gsd', 'runtime', 'update-notification.json');
    if (fs.existsSync(notifPath)) {
      const notif = JSON.parse(fs.readFileSync(notifPath, 'utf8'));
      if (notif.kind === 'updated') {
        console.log(`✅ GSD-Lite auto-updated: v${notif.from} → v${notif.to}`);
      } else if (notif.kind === 'available' && notif.action === 'plugin_update') {
        console.log(`📦 GSD-Lite update available: v${notif.from} → v${notif.to}. Run /plugin update gsd`);
      } else if (notif.kind === 'available') {
        console.log(`📦 GSD-Lite update available: v${notif.from} → v${notif.to}. Run gsd update`);
      }
      fs.unlinkSync(notifPath);
    }
  } catch { /* silent */ }

  // ── Phase 5: Spawn background auto-update (non-blocking) ──
  // Detached child handles check + download + install; throttled by shouldCheck()
  try {
    const { spawn } = require('node:child_process');
    const child = spawn(
      process.execPath,
      [path.join(__dirname, 'gsd-auto-update.cjs')],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
  } catch { /* silent — never block session start */ }

  // ── Phase 6: GSD Project Progress Injection ──
  // If an active GSD project exists, inject progress into stdout (additionalContext)
  // and write a status block into CLAUDE.md for persistent visibility.
  try {
    const { findGsdDir, readState, getProgress } = require('./lib/gsd-finder.cjs');
    const cwd = process.cwd();
    const gsdDir = findGsdDir(cwd);
    if (gsdDir) {
      const state = readState(gsdDir);
      const progress = getProgress(state);
      if (progress) {
        // Check for .session-end marker (previous non-graceful exit)
        const markerPath = path.join(gsdDir, '.session-end');
        let sessionEndInfo = null;
        try {
          if (fs.existsSync(markerPath)) {
            sessionEndInfo = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
          }
        } catch { /* skip */ }

        // Stdout: only output session-end warning (crash recovery), skip routine progress
        // Routine progress is handled by CLAUDE.md injection below — avoids noise
        const shortHead = progress.gitHead ? progress.gitHead.substring(0, 7) : 'n/a';
        if (sessionEndInfo) {
          console.log(`⚠️ GSD: Previous session ended unexpectedly at ${sessionEndInfo.ended_at} (was: ${sessionEndInfo.workflow_mode_was}). Run /gsd:resume to recover.`);
        }

        // Write status block to CLAUDE.md
        const projectRoot = path.dirname(gsdDir);
        const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
        const BEGIN_MARKER = '<!-- GSD-STATUS-BEGIN -->';
        const END_MARKER = '<!-- GSD-STATUS-END -->';

        const statusBlock = [
          BEGIN_MARKER,
          `### GSD Project: ${progress.project}`,
          `- Phase: ${progress.currentPhase || '?'}/${progress.totalPhases} (${progress.phaseName})`,
          `- Task: ${progress.currentTask || 'none'}${progress.taskName ? ` (${progress.taskName})` : ''}`,
          `- Mode: ${progress.workflowMode}`,
          `- Progress: ${progress.acceptedTasks}/${progress.totalTasks} tasks done`,
          `- Last checkpoint: ${shortHead}`,
          sessionEndInfo ? `- ⚠️ Previous session ended unexpectedly (${sessionEndInfo.ended_at})` : null,
          END_MARKER,
        ].filter(Boolean).join('\n');

        try {
          let content = '';
          try {
            content = fs.readFileSync(claudeMdPath, 'utf8');
          } catch { /* file doesn't exist yet — will create */ }

          const beginIdx = content.indexOf(BEGIN_MARKER);
          const endIdx = content.indexOf(END_MARKER);

          let newContent;
          if (beginIdx !== -1 && endIdx !== -1) {
            // Replace existing block
            newContent = content.substring(0, beginIdx) + statusBlock + content.substring(endIdx + END_MARKER.length);
          } else {
            // Append to end (with blank line separator)
            const separator = content.length > 0 && !content.endsWith('\n\n') ? (content.endsWith('\n') ? '\n' : '\n\n') : '';
            newContent = content + separator + statusBlock + '\n';
          }

          // Only write if content changed
          if (newContent !== content) {
            const tmpClaude = claudeMdPath + `.gsd-tmp-${process.pid}`;
            fs.writeFileSync(tmpClaude, newContent);
            fs.renameSync(tmpClaude, claudeMdPath);
          }
        } catch (e) {
          if (process.env.GSD_DEBUG) process.stderr.write(`gsd-session-init: CLAUDE.md write failed: ${e.message}\n`);
        }
      }
    } else {
      // No active GSD project — clean up stale CLAUDE.md block if it exists
      try {
        const claudeMdPath = path.join(cwd, 'CLAUDE.md');
        const BEGIN_MARKER = '<!-- GSD-STATUS-BEGIN -->';
        const END_MARKER = '<!-- GSD-STATUS-END -->';
        const content = fs.readFileSync(claudeMdPath, 'utf8');
        const beginIdx = content.indexOf(BEGIN_MARKER);
        const endIdx = content.indexOf(END_MARKER);
        if (beginIdx !== -1 && endIdx !== -1) {
          // Remove the block and any trailing newline
          let newContent = content.substring(0, beginIdx) + content.substring(endIdx + END_MARKER.length);
          // Clean up extra blank lines left behind
          newContent = newContent.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
          if (newContent !== content) {
            const tmpClaude = claudeMdPath + `.gsd-tmp-${process.pid}`;
            fs.writeFileSync(tmpClaude, newContent);
            fs.renameSync(tmpClaude, claudeMdPath);
          }
        }
      } catch { /* no CLAUDE.md or no block to clean — skip */ }
    }
  } catch (e) {
    if (process.env.GSD_DEBUG) process.stderr.write(`gsd-session-init phase 6: ${e.message}\n`);
  }
})().catch(() => {});
