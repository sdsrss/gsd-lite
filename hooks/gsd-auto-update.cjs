#!/usr/bin/env node
// GSD-Lite Auto-Update Module
// Checks GitHub Releases for new versions and auto-installs updates.
// CJS format to match other hook modules.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync, spawnSync } = require('node:child_process');

// ── Configuration ──────────────────────────────────────────
const GITHUB_REPO = 'sdsrss/gsd-lite';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RATE_LIMIT_INTERVAL_MS = 48 * 60 * 60 * 1000; // 48h back-off if rate-limited
const FETCH_TIMEOUT_MS = 3000; // 3s network timeout

// ── Paths ──────────────────────────────────────────────────
const claudeDir =
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const runtimeDir = path.join(claudeDir, 'gsd');
const stateDir = path.join(runtimeDir, 'runtime');
const STATE_FILE = path.join(stateDir, 'update-state.json');
const STATE_LOCK_FILE = path.join(stateDir, 'update-state.lock');
const NOTIFICATION_FILE = path.join(stateDir, 'update-notification.json');
const pluginRoot = path.resolve(__dirname, '..');

const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;

// ── Main Entry ─────────────────────────────────────────────
async function checkForUpdate(options = {}) {
  const {
    force = false,
    verbose = false,
    install = true,
    notify = false,
    fetchLatestRelease: fetchLatestReleaseImpl = fetchLatestRelease,
    downloadAndInstall: downloadAndInstallImpl = downloadAndInstall,
    getCurrentVersion: getCurrentVersionImpl = getCurrentVersion,
  } = options;
  const installMode = getInstallMode();

  try {
    if (!force && shouldSkipUpdateCheck()) {
      if (verbose) console.log('Skipping update check (dev mode or auto-update in progress)');
      return null;
    }
    return await withFileLock(async () => {
      const state = readState();
      if (!force && !shouldCheck(state)) {
        if (state.updateAvailable && state.latestVersion) {
          return {
            updateAvailable: true,
            from: getCurrentVersionImpl(installMode),
            to: state.latestVersion,
            installMode,
          };
        }
        if (verbose) console.log('Throttled — last check:', state.lastCheck);
        return null;
      }

      if (verbose) console.log('Checking GitHub for latest release...');
      const token = getGitHubToken();
      const latest = await fetchLatestReleaseImpl(token);
      if (!latest) {
        if (latest === false) state.rateLimited = true; // 403 rate-limited
        saveState({ ...state, lastCheck: new Date().toISOString() });
        if (verbose) console.log('Could not fetch latest release');
        return null;
      }

      // Successful fetch — clear rate-limit back-off
      state.rateLimited = false;
      const currentVersion = getCurrentVersionImpl(installMode);
      if (verbose) console.log(`Current: v${currentVersion} — Latest: v${latest.version}`);

      const hasUpdate = compareVersions(latest.version, currentVersion) > 0;

      if (hasUpdate) {
        if (installMode === 'plugin' && install) {
          saveState({
            ...state,
            lastCheck: new Date().toISOString(),
            latestVersion: latest.version,
            updateAvailable: true,
          });
          if (notify) {
            writeNotification({
              kind: 'available',
              from: currentVersion,
              to: latest.version,
              action: 'plugin_update',
            });
          }
          return {
            updateAvailable: true,
            from: currentVersion,
            to: latest.version,
            action: 'plugin_update',
            autoInstallSupported: false,
            installMode,
          };
        }

        if (!install) {
          // Check-only mode (used by SessionStart hook)
          saveState({
            ...state,
            lastCheck: new Date().toISOString(),
            latestVersion: latest.version,
            updateAvailable: true,
          });
          return {
            updateAvailable: true,
            from: currentVersion,
            to: latest.version,
            installMode,
          };
        }

        if (verbose) console.log(`Downloading v${latest.version}...`);
        const success = await downloadAndInstallImpl(latest.tarballUrl, verbose, token);

        saveState({
          ...state,
          lastCheck: new Date().toISOString(),
          latestVersion: latest.version,
          updateAvailable: !success,
          lastUpdate: success ? new Date().toISOString() : state.lastUpdate,
        });

        if (success && notify) {
          writeNotification({
            kind: 'updated',
            from: currentVersion,
            to: latest.version,
          });
        }

        return {
          updateAvailable: !success,
          updated: success,
          from: currentVersion,
          to: latest.version,
          installMode,
        };
      }

      // No update needed
      saveState({
        ...state,
        lastCheck: new Date().toISOString(),
        latestVersion: latest.version,
        updateAvailable: false,
      });
      if (verbose) console.log('Already up to date');
      return null;
    });
  } catch (err) {
    if (verbose) console.error('Update check failed:', err.message);
    return null;
  }
}

async function withFileLock(fn) {
  let acquired = false;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
  } catch {
    /* best effort */
  }

  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      fs.writeFileSync(STATE_LOCK_FILE, String(process.pid), { flag: 'wx' });
      acquired = true;
      break;
    } catch (err) {
      if (err.code === 'EEXIST') {
        try {
          const stats = fs.statSync(STATE_LOCK_FILE);
          if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
            try { fs.rmSync(STATE_LOCK_FILE, { force: true }); } catch {}
            continue;
          }
        } catch {
          continue;
        }
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
      } else {
        break;
      }
    }
  }

  try {
    return await fn();
  } finally {
    if (acquired) {
      try { fs.rmSync(STATE_LOCK_FILE, { force: true }); } catch {}
    }
  }
}

// ── Skip Check Detection ──────────────────────────────────
// Returns true when update checks should be skipped:
// 1. PLUGIN_AUTO_UPDATE env set → recursive guard (auto-update already in progress)
// 2. Running from a git clone → dev mode (developer working on source)
function shouldSkipUpdateCheck() {
  if (process.env.PLUGIN_AUTO_UPDATE) return true;
  return isDevMode();
}

function isDevMode() {
  try {
    if (!fs.existsSync(path.join(pluginRoot, '.git'))) return false;
    const pkg = JSON.parse(
      fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'),
    );
    return pkg.name === 'gsd-lite';
  } catch {
    return false;
  }
}

function getInstallMode() {
  if (isDevMode()) return 'dev';
  // Check if installed as a Claude Code plugin (installed_plugins.json has gsd entry)
  // Hook files live at ~/.claude/hooks/ so pluginRoot (=__dirname/..) equals claudeDir,
  // but that doesn't mean it's a manual install — check the plugin registry first.
  try {
    const pluginsFile = path.join(claudeDir, 'plugins', 'installed_plugins.json');
    const plugins = JSON.parse(fs.readFileSync(pluginsFile, 'utf8'));
    if (plugins.plugins?.['gsd@gsd']?.[0]) return 'plugin';
  } catch { /* fall through */ }
  return path.resolve(pluginRoot) === path.resolve(claudeDir)
    ? 'manual'
    : 'plugin';
}

// ── Throttle ───────────────────────────────────────────────
function shouldCheck(state) {
  if (!state.lastCheck) return true;
  const elapsed = Date.now() - new Date(state.lastCheck).getTime();
  const interval = state.rateLimited
    ? RATE_LIMIT_INTERVAL_MS
    : CHECK_INTERVAL_MS;
  return elapsed >= interval;
}

// ── GitHub Auth ─────────────────────────────────────────────
function getGitHubToken() {
  // Try gh CLI token first (5000 req/hour vs 60 unauthenticated)
  try {
    return execSync('gh auth token', { timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

// ── GitHub API ─────────────────────────────────────────────
async function fetchLatestRelease(token) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'gsd-lite-auto-update/1.0',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(url, {
      signal: controller.signal,
      headers,
    });

    if (res.status === 403) return false; // rate-limited — caller sets flag
    if (!res.ok) return null;

    const data = await res.json();
    return {
      version: data.tag_name.replace(/^v/, ''),
      tarballUrl: data.tarball_url,
      releaseUrl: data.html_url,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Version Comparison (semver) ────────────────────────────
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function getCurrentVersion(mode = getInstallMode()) {
  const candidates = mode === 'manual'
    ? [path.join(runtimeDir, 'package.json'), path.join(pluginRoot, 'package.json')]
    : [path.join(pluginRoot, 'package.json'), path.join(runtimeDir, 'package.json')];
  for (const p of candidates) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')).version;
    } catch {
      /* try next */
    }
  }
  return '0.0.0';
}

// ── Package Validation ──────────────────────────────────────
function validateExtractedPackage(extractDir) {
  try {
    const pkgPath = path.join(extractDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.name !== 'gsd-lite') return false;
    if (!pkg.version || !/^\d+\.\d+\.\d+/.test(pkg.version)) return false;
    return true;
  } catch {
    return false;
  }
}

// ── Download & Install ─────────────────────────────────────
async function downloadAndInstall(tarballUrl, verbose = false, token = null) {
  const tmpDir = path.join(os.tmpdir(), `gsd-update-${Date.now()}`);
  const backupPath = path.join(pluginRoot, 'package.json.bak');
  let backedUp = false;
  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    // Download tarball via fetch (no shell interpolation)
    if (verbose) console.log('  Downloading tarball...');
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'gsd-lite-auto-update/1.0' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const controller = new AbortController();
    const dlTimeout = setTimeout(() => controller.abort(), 30000);
    let tarData;
    try {
      const res = await fetch(tarballUrl, { signal: controller.signal, headers, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      tarData = Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(dlTimeout);
    }

    // Write tarball to file, then extract with spawnSync (no shell)
    const tarPath = path.join(tmpDir, 'release.tar.gz');
    fs.writeFileSync(tarPath, tarData);
    const tar = spawnSync('tar', ['xzf', tarPath, '-C', tmpDir, '--strip-components=1'], { timeout: 30000 });
    if (tar.status !== 0) throw new Error(`tar extract failed: ${(tar.stderr || '').toString().slice(0, 200)}`);

    // Validate extracted package before installing
    if (!validateExtractedPackage(tmpDir)) {
      if (verbose) console.error('  Package validation failed — aborting install');
      return false;
    }

    // Backup current package.json before install
    const currentPkgPath = path.join(pluginRoot, 'package.json');
    try {
      if (fs.existsSync(currentPkgPath)) {
        fs.copyFileSync(currentPkgPath, backupPath);
        backedUp = true;
      }
    } catch {
      /* best effort — proceed without backup */
    }

    // Run installer with spawnSync (no shell)
    if (verbose) console.log('  Running installer...');
    const install = spawnSync(process.execPath, [path.join(tmpDir, 'install.js')], {
      timeout: 60000,
      stdio: verbose ? 'inherit' : 'pipe',
      env: { ...process.env, PLUGIN_AUTO_UPDATE: '1' },
    });
    if (install.status !== 0) {
      // Restore backup on install failure
      if (backedUp) {
        try { fs.copyFileSync(backupPath, currentPkgPath); } catch { /* best effort */ }
      }
      throw new Error(`Installer failed: ${(install.stderr || '').toString().slice(0, 200)}`);
    }

    // Success — remove backup
    if (backedUp) {
      try { fs.rmSync(backupPath, { force: true }); } catch { /* ignore */ }
    }

    // Sync to plugin cache if installed as plugin
    // The MCP server loads from plugins/cache, not the runtime dir,
    // so we must update the cache for version changes to take effect.
    syncPluginCache(tmpDir, verbose);

    return true;
  } catch (err) {
    if (verbose) console.error('  Install failed:', err.message);
    return false;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ── State Persistence ──────────────────────────────────────
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmpPath = STATE_FILE + `.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(tmpPath, STATE_FILE);
  } catch {
    /* silent */
  }
}

function writeNotification(notification) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmpPath = NOTIFICATION_FILE + `.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(notification, null, 2) + '\n');
    fs.renameSync(tmpPath, NOTIFICATION_FILE);
  } catch {
    /* silent */
  }
}

// ── Plugin Cache Sync ─────────────────────────────────────
// When installed as a plugin, the MCP server runs from plugins/cache/gsd/gsd/<version>/
// The auto-update installs to ~/.claude/gsd/ (runtime dir) via install.js,
// but must ALSO update the cache directory for the MCP server to pick up changes.
function syncPluginCache(extractedDir, verbose = false) {
  try {
    const pluginsFile = path.join(claudeDir, 'plugins', 'installed_plugins.json');
    if (!fs.existsSync(pluginsFile)) return;

    const plugins = JSON.parse(fs.readFileSync(pluginsFile, 'utf8'));
    const gsdEntry = plugins.plugins?.['gsd@gsd']?.[0];
    if (!gsdEntry?.installPath) return;

    // Read new version from extracted package
    const newPkgPath = path.join(extractedDir, 'package.json');
    if (!fs.existsSync(newPkgPath)) return;
    const newVersion = JSON.parse(fs.readFileSync(newPkgPath, 'utf8')).version;
    if (!newVersion) return;

    // Determine new cache path
    const cacheBase = path.join(claudeDir, 'plugins', 'cache', 'gsd', 'gsd');
    const newCachePath = path.join(cacheBase, newVersion);

    // Skip if already up to date
    if (gsdEntry.installPath === newCachePath && fs.existsSync(newCachePath)) {
      const existingVersion = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(newCachePath, 'package.json'), 'utf8')).version; }
        catch { return null; }
      })();
      if (existingVersion === newVersion) {
        if (verbose) console.log('  Plugin cache already up to date');
        return;
      }
    }

    // Copy extracted files to new cache directory
    if (verbose) console.log(`  Syncing plugin cache → ${newCachePath}`);
    fs.mkdirSync(newCachePath, { recursive: true });
    fs.cpSync(extractedDir, newCachePath, { recursive: true });

    // Install dependencies in cache dir
    if (!fs.existsSync(path.join(newCachePath, 'node_modules', '@modelcontextprotocol'))) {
      spawnSync('npm', ['install', '--omit=dev', '--ignore-scripts'], {
        cwd: newCachePath,
        stdio: 'pipe',
        timeout: 60000,
      });
    }

    // Update installed_plugins.json to point to new cache path
    gsdEntry.installPath = newCachePath;
    gsdEntry.version = newVersion;
    gsdEntry.lastUpdated = new Date().toISOString();
    const tmpPlugins = pluginsFile + `.${process.pid}.tmp`;
    fs.writeFileSync(tmpPlugins, JSON.stringify(plugins, null, 2) + '\n');
    fs.renameSync(tmpPlugins, pluginsFile);

    if (verbose) console.log(`  Plugin cache synced to v${newVersion}`);
  } catch (err) {
    // Best effort — don't fail the update if cache sync fails
    if (verbose) console.error('  Plugin cache sync failed:', err.message);
  }
}

module.exports = {
  checkForUpdate,
  getCurrentVersion,
  compareVersions,
  getInstallMode,
  isDevMode,
  shouldCheck,
  shouldSkipUpdateCheck,
  validateExtractedPackage,
};

// ── CLI Entry Point (for background auto-install) ─────────
if (require.main === module) {
  checkForUpdate({ install: true, verbose: false, notify: true })
    .catch(() => {})
    .finally(() => process.exit(0));
}
