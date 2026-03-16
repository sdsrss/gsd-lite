#!/usr/bin/env node
// GSD-Lite SessionStart hook
// 1. Cleans up stale temp files (throttled to once/day).
// 2. Auto-registers statusLine in settings.json if not already configured.
// 3. Shows notification if a previous background update completed or found a new version.
// 4. Spawns background auto-update (detached, non-blocking).
// Idempotent: skips if statusLine already points to gsd-statusline, preserves
// third-party statuslines.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const pluginRoot = path.resolve(__dirname, '..');
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const settingsPath = path.join(claudeDir, 'settings.json');
const statuslineScript = path.join(pluginRoot, 'hooks', 'gsd-statusline.cjs');

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
  try {
    if (fs.existsSync(statuslineScript)) {
      let settings = {};
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch { /* Can't read settings — skip registration */ }

      if (settings && !settings.statusLine?.command) {
        settings.statusLine = {
          type: 'command',
          command: `node ${JSON.stringify(statuslineScript)}`
        };
        const tmpPath = settingsPath + `.gsd-tmp-${process.pid}`;
        fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n');
        fs.renameSync(tmpPath, settingsPath);
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
})().catch(() => {});
