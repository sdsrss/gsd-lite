#!/usr/bin/env node
// GSD-Lite SessionStart hook
// 0. Orphan self-cleanup: if /plugin uninstall removed the plugin but left
//    install.js-written state behind, run inline cleanup and exit.
// 1. Cleans up stale temp files (throttled to once/day).
// 2. Auto-registers statusLine in settings.json if not already configured.
// 3. (removed — the MCP server is declared inline in plugin.json)
// 4. Shows notification if a previous background update completed or found a new version.
// 5. Spawns background auto-update (detached, non-blocking).
// 6. Injects GSD project progress into stdout + CLAUDE.md (if active project found).
// Idempotent: skips if statusLine already points to gsd-statusline, preserves
// third-party statuslines.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  atomicWrite,
  atomicWriteJson,
  atomicWriteThroughLink,
} = require('./lib/atomic-write.cjs');

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
// Shared with install.js and uninstall.js: edits settings.json hook entries at
// hook granularity, so a matcher group GSD shares with another tool survives.
//
// Loaded lazily and guarded. A require at module scope kills the whole hook
// when hooks/lib is missing — a partial install, or this file copied on its
// own — and a SessionStart hook that throws on every session is worse than the
// duplicate registration it exists to clean up. Callers handle null.
function loadRemoveHookEntry() {
  try {
    return require('./lib/hook-registry.cjs').removeHookEntry;
  } catch {
    return null;
  }
}
const settingsPath = path.join(claudeDir, 'settings.json');

// Stand down when the plugin's own copy of this hook is the live registration —
// which means installed, enabled, AND actually declaring SessionStart in its
// hooks/hooks.json. Both copies are registered on purpose; see pluginServesHooks
// in lib/hook-registry.cjs for why removing one is the wrong fix. Guarded: if
// the helper is missing we run, because running twice is visible and running
// never is not.
try {
  const { pluginServesHooks } = require('./lib/hook-registry.cjs');
  if (pluginServesHooks(claudeDir, __dirname, 'SessionStart')) process.exit(0);
} catch { /* helper absent — carry on */ }

// ── Phase 0: Orphan self-cleanup ──
// /plugin uninstall only touches installed_plugins.json + enabledPlugins; it
// leaves hook scripts, settings.json registrations, the runtime dir, and the
// composite statusline registry in place — so hooks keep firing and Phases
// 2/5 below will self-heal the stale state on every session. Detect that case
// here and remove our footprint before any other phase runs.
function isOrphan() {
  // .install-mode marker (written by install.js ≥ 0.7.7) is authoritative.
  const installModeMarker = path.join(claudeDir, 'gsd', '.install-mode');
  let mode = null;
  try { mode = fs.readFileSync(installModeMarker, 'utf8').trim(); } catch { /* missing → fall through */ }
  if (mode === 'manual') return false; // npx install never enters /plugin uninstall path
  if (mode === 'plugin') {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8'));
      return !data.plugins?.['gsd@gsd'];
    } catch { return false; } // registry unreadable → don't assume orphan
  }
  // Pre-marker installs: fallback heuristic. Claude Code stamps
  // .orphaned_at inside cache version dirs when the entry is removed from
  // installed_plugins.json. Orphan iff every cached version has the marker.
  const cacheBase = path.join(claudeDir, 'plugins', 'cache', 'gsd', 'gsd');
  if (!fs.existsSync(cacheBase)) return false;
  try {
    const dirs = fs.readdirSync(cacheBase, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\d+\.\d+\.\d+/.test(e.name));
    if (dirs.length === 0) return false;
    return dirs.every(d => fs.existsSync(path.join(cacheBase, d.name, '.orphaned_at')));
  } catch { return false; }
}

const BEGIN_MARKER = '<!-- GSD-STATUS-BEGIN -->';
const END_MARKER = '<!-- GSD-STATUS-END -->';

/**
 * Locate the injected status block in a CLAUDE.md.
 *
 * Returns the first BEGIN…END pair that contains no further BEGIN, so the
 * markers behave like a properly nested pair rather than "first BEGIN, first
 * END anywhere". Matching them independently mis-splices any file that also
 * mentions a marker in prose or carries an orphan left by a hand-edit: the
 * head and tail slices then overlap (duplicating text on every session) or
 * span unrelated content (deleting it).
 *
 * @returns {{begin: number, end: number}} -1/-1 when no complete block exists.
 */
function findStatusBlock(content) {
  let begin = content.indexOf(BEGIN_MARKER);
  while (begin !== -1) {
    const end = content.indexOf(END_MARKER, begin + BEGIN_MARKER.length);
    if (end === -1) break; // unterminated — treat as absent, append a fresh block
    const nextBegin = content.indexOf(BEGIN_MARKER, begin + BEGIN_MARKER.length);
    if (nextBegin === -1 || nextBegin > end) return { begin, end };
    begin = nextBegin; // a nested BEGIN means the outer one never opened a block
  }
  return { begin: -1, end: -1 };
}

function cleanupOrphan() {
  // 1. Composite statusLine registry — call removeProvider BEFORE deleting
  //    the lib file it lives in.
  try {
    const compositeLib = path.join(claudeDir, 'hooks', 'lib', 'statusline-composite.cjs');
    if (fs.existsSync(compositeLib)) {
      const { removeProvider } = require(compositeLib);
      removeProvider();
    }
  } catch { /* best effort */ }

  // 2. settings.json — mirror uninstall.js logic.
  const removeHookEntry = loadRemoveHookEntry();
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    let changed = false;
    for (const name of ['gsd', 'gsd-lite']) {
      if (settings.mcpServers?.[name]) { delete settings.mcpServers[name]; changed = true; }
      const pluginKey = `${name}@${name}`;
      if (settings.enabledPlugins?.[pluginKey]) { delete settings.enabledPlugins[pluginKey]; changed = true; }
      if (settings.extraKnownMarketplaces?.[name]) { delete settings.extraKnownMarketplaces[name]; changed = true; }
    }
    if (settings.extraKnownMarketplaces && Object.keys(settings.extraKnownMarketplaces).length === 0) {
      delete settings.extraKnownMarketplaces;
    }
    if (settings.statusLine?.command?.includes('gsd-statusline')
        || settings.statusLine?.command?.includes('context-monitor.js')) {
      delete settings.statusLine;
      changed = true;
    }
    if (settings.hooks) {
      if (typeof settings.hooks.StatusLine === 'string'
          && (settings.hooks.StatusLine.includes('gsd-statusline')
              || settings.hooks.StatusLine.includes('context-monitor.js'))) {
        delete settings.hooks.StatusLine;
        changed = true;
      }
      for (const [hookType, identifier] of [
        ['PostToolUse', 'gsd-context-monitor'],
        ['PostToolUse', 'context-monitor.js'],
        ['SessionStart', 'gsd-session-init'],
        ['Stop', 'gsd-session-stop'],
      ]) {
        // Fourth call site of the same removal. It edits at hook granularity
        // through the shared helper for the same reason as the other three: a
        // matcher group GSD shares with another tool is that tool's group too.
        if (removeHookEntry?.(settings.hooks, hookType, identifier)) changed = true;
      }
    }
    if (changed) atomicWriteJson(settingsPath, settings);
  } catch { /* best effort */ }

  // 3. plugins/known_marketplaces.json
  try {
    const known = path.join(claudeDir, 'plugins', 'known_marketplaces.json');
    const data = JSON.parse(fs.readFileSync(known, 'utf8'));
    let dirty = false;
    for (const n of ['gsd', 'gsd-lite']) {
      if (n in data) { delete data[n]; dirty = true; }
    }
    if (dirty) atomicWriteJson(known, data);
  } catch { /* best effort */ }

  // 4. Hook script files
  for (const name of ['context-monitor.js', 'gsd-statusline.cjs', 'gsd-context-monitor.cjs', 'gsd-auto-update.cjs', 'gsd-session-stop.cjs']) {
    try { fs.rmSync(path.join(claudeDir, 'hooks', name), { force: true }); } catch { /* best effort */ }
  }
  // 5. Hook lib files (GSD-owned only — don't touch other plugins' libs)
  for (const lib of ['gsd-finder.cjs', 'statusline-composite.cjs', 'semver-sort.cjs', 'hook-registry.cjs', 'atomic-write.cjs']) {
    try { fs.rmSync(path.join(claudeDir, 'hooks', 'lib', lib), { force: true }); } catch { /* best effort */ }
  }
  // 6. Runtime dir + plugin marketplace + cache dirs (current + legacy names)
  for (const dir of [
    path.join(claudeDir, 'gsd'),
    path.join(claudeDir, 'gsd-lite'),
    path.join(claudeDir, 'plugins', 'marketplaces', 'gsd'),
    path.join(claudeDir, 'plugins', 'marketplaces', 'gsd-lite'),
    path.join(claudeDir, 'plugins', 'cache', 'gsd'),
    path.join(claudeDir, 'plugins', 'cache', 'gsd-lite'),
  ]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  // 7. Self-removal — delete this script last. The running process keeps the
  //    file handle until exit (POSIX); on Windows this may fail silently and
  //    Phase 0's next-session check will retry.
  try { fs.rmSync(path.join(claudeDir, 'hooks', 'gsd-session-init.cjs'), { force: true }); } catch { /* best effort */ }
}

if (isOrphan()) {
  console.log('⚠ GSD-Lite plugin uninstalled — cleaning up orphaned hooks and runtime.');
  try { cleanupOrphan(); } catch { /* best effort — never block session start */ }
  process.exit(0);
}

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
      let settingsParseError = false;
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch (e) {
        if (e.code === 'ENOENT') {
          settings = {}; // File doesn't exist — create fresh
        } else {
          // Parse error or other — skip write to avoid overwriting corrupted file
          if (process.env.GSD_DEBUG) console.error('[gsd-session-init] settings.json read error:', e.message);
          settingsParseError = true;
        }
      }

      if (!settingsParseError && settings) {
        const current = settings.statusLine?.command || '';

        if (current.includes('gsd-statusline')) {
          // Already registered — nothing to do
        } else if (!current) {
          // No statusLine — register directly
          settings.statusLine = {
            type: 'command',
            command: `node ${JSON.stringify(stableStatuslinePath)}`
          };
          atomicWrite(settingsPath, JSON.stringify(settings, null, 2) + '\n');
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

  // ── Phase 3: removed ──
  // This used to regenerate a missing .mcp.json in the marketplace and cache
  // directories. The MCP server is now declared inline in plugin.json instead,
  // for the reason in that file: a .mcp.json at the repo root is also read as
  // project-scope MCP config by anyone who opens the repo, and ${CLAUDE_PLUGIN_ROOT}
  // does not expand there. Writing one back now would declare the server twice.
  // plugin.json cannot go missing on its own — without it the plugin does not
  // load at all — so there is nothing left here to self-heal.

  // ── Phase 4: Show notification from previous background auto-update ──
  try {
    const notifPath = path.join(claudeDir, 'gsd', 'runtime', 'update-notification.json');
    if (fs.existsSync(notifPath)) {
      const notif = JSON.parse(fs.readFileSync(notifPath, 'utf8'));
      const safeSemver = (s) => /^\d+\.\d+\.\d+/.test(String(s || '')) ? String(s) : '?.?.?';
      if (notif.kind === 'updated') {
        console.log(`✅ GSD-Lite auto-updated: v${safeSemver(notif.from)} → v${safeSemver(notif.to)}`);
      } else if (notif.kind === 'available' && notif.action === 'plugin_update') {
        console.log(`📦 GSD-Lite update available: v${safeSemver(notif.from)} → v${safeSemver(notif.to)}. Run /plugin update gsd`);
      } else if (notif.kind === 'available') {
        console.log(`📦 GSD-Lite update available: v${safeSemver(notif.from)} → v${safeSemver(notif.to)}. Run gsd update`);
      } else if (notif.kind === 'failed') {
        // A failed background update used to be entirely silent: the notification
        // was only ever written on success. The runtime is intact either way now,
        // so this is informational rather than an emergency — but a user whose
        // updates have been failing for a month should get to know.
        console.log(`⚠️  GSD-Lite update to v${safeSemver(notif.to)} failed; still on v${safeSemver(notif.from)}. Run gsd update to see why.`);
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

        // Everything rendered below comes verbatim from the repo's own
        // .gsd/state.json and .gsd/.session-end. The status block lands in
        // CLAUDE.md and this hook's stdout reaches the model as
        // additionalContext, so both are places a cloned repo would like to put
        // a line of its own.
        //
        // Wrapping fields one call at a time is how three of them stayed raw
        // through two rounds of this fix. Sanitize once, up front, into `safe`,
        // and render only from `safe` — a field that is not in this object
        // cannot reach the template, and adding one to the template without
        // adding it here is a visible mistake rather than a silent hole.
        //
        // Strips: control characters (\p{Cc}), format/bidi controls (\p{Cf}),
        // the U+2028/U+2029 line separators that \p{Cc} does not cover, and the
        // HTML comment markers that delimit the block itself.
        const safeName = (s) => String(s ?? '')
          .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
          .replace(/<!--|-->/g, '')
          .slice(0, 200);
        const safeNum = (n) => (Number.isFinite(Number(n)) ? Number(n) : '?');

        const safe = {
          project: safeName(progress.project),
          currentPhase: safeNum(progress.currentPhase),
          totalPhases: safeNum(progress.totalPhases),
          phaseName: safeName(progress.phaseName),
          currentTask: safeName(progress.currentTask) || 'none',
          taskName: safeName(progress.taskName),
          workflowMode: safeName(progress.workflowMode),
          acceptedTasks: safeNum(progress.acceptedTasks),
          totalTasks: safeNum(progress.totalTasks),
          shortHead: safeName(progress.gitHead ? String(progress.gitHead).substring(0, 7) : 'n/a'),
          endedAt: sessionEndInfo ? safeName(sessionEndInfo.ended_at) : null,
          modeWas: sessionEndInfo ? safeName(sessionEndInfo.workflow_mode_was) : null,
        };

        // Stdout: only output session-end warning (crash recovery), skip routine progress
        // Routine progress is handled by CLAUDE.md injection below — avoids noise
        if (sessionEndInfo) {
          console.log(`⚠️ GSD: Previous session ended unexpectedly at ${safe.endedAt} (was: ${safe.modeWas}). Run /gsd:resume to recover.`);
        }

        // Write status block to CLAUDE.md
        const projectRoot = path.dirname(gsdDir);
        const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');

        // Renders from `safe` only — never from `progress` or `sessionEndInfo`.
        const statusBlock = [
          BEGIN_MARKER,
          `### GSD Project: ${safe.project}`,
          `- Phase: ${safe.currentPhase}/${safe.totalPhases} (${safe.phaseName})`,
          `- Task: ${safe.currentTask}${safe.taskName ? ` (${safe.taskName})` : ''}`,
          `- Mode: ${safe.workflowMode}`,
          `- Progress: ${safe.acceptedTasks}/${safe.totalTasks} tasks done`,
          `- Last checkpoint: ${safe.shortHead}`,
          sessionEndInfo ? `- ⚠️ Previous session ended unexpectedly (${safe.endedAt})` : null,
          END_MARKER,
        ].filter(Boolean).join('\n');

        // R-24 (audit L12): the SessionStart hook injects a
        // <!-- GSD-STATUS-BEGIN -->…<!-- GSD-STATUS-END --> block into the
        // project's CLAUDE.md so the model sees live progress. This modifies a
        // user-owned file; set GSD_NO_CLAUDEMD_STATUS=1 to opt out (documented in
        // README). The block is idempotent (marker-delimited replace).
        if (!process.env.GSD_NO_CLAUDEMD_STATUS) {
          try {
            let content = '';
            try {
              content = fs.readFileSync(claudeMdPath, 'utf8');
            } catch { /* file doesn't exist yet — will create */ }

            const { begin: beginIdx, end: endIdx } = findStatusBlock(content);

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
              atomicWriteThroughLink(claudeMdPath, newContent, projectRoot);
            }
          } catch (e) {
            if (process.env.GSD_DEBUG) process.stderr.write(`gsd-session-init: CLAUDE.md write failed: ${e.message}\n`);
          }
        }
      }
    } else {
      // No active GSD project — clean up stale CLAUDE.md block if it exists
      try {
        const claudeMdPath = path.join(cwd, 'CLAUDE.md');
        const content = fs.readFileSync(claudeMdPath, 'utf8');
        const { begin: beginIdx, end: endIdx } = findStatusBlock(content);
        if (beginIdx !== -1 && endIdx !== -1) {
          // Remove the block, collapsing only the blank lines the removal itself
          // left behind at the splice point — blank runs elsewhere in the file
          // are the user's own formatting and must survive untouched.
          const head = content.substring(0, beginIdx).replace(/\n{3,}$/, '\n\n');
          const tail = content.substring(endIdx + END_MARKER.length).replace(/^\n+/, '');
          // With the block at EOF there is no tail to separate from, so head's
          // own trailing blank line would survive as a gratuitous extra one.
          let newContent = tail === '' ? head.replace(/\n{2,}$/, '\n') : head + tail;
          if (!newContent.endsWith('\n')) newContent += '\n';
          if (newContent !== content) {
            atomicWriteThroughLink(claudeMdPath, newContent, cwd);
          }
        }
      } catch { /* no CLAUDE.md or no block to clean — skip */ }
    }
  } catch (e) {
    if (process.env.GSD_DEBUG) process.stderr.write(`gsd-session-init phase 6: ${e.message}\n`);
  }
})().catch(() => {});
