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
const pluginRoot = path.resolve(__dirname, '..');

// ── Main Entry ─────────────────────────────────────────────
async function checkForUpdate(options = {}) {
  const { force = false, verbose = false, install = true } = options;

  try {
    if (!force && shouldSkipUpdateCheck()) {
      if (verbose) console.log('Skipping update check (dev mode or auto-update in progress)');
      return null;
    }

    const state = readState();
    if (!force && !shouldCheck(state)) {
      if (state.updateAvailable && state.latestVersion) {
        return {
          updateAvailable: true,
          from: getCurrentVersion(),
          to: state.latestVersion,
        };
      }
      if (verbose) console.log('Throttled — last check:', state.lastCheck);
      return null;
    }

    if (verbose) console.log('Checking GitHub for latest release...');
    const token = getGitHubToken();
    const latest = await fetchLatestRelease(token);
    if (!latest) {
      if (latest === false) state.rateLimited = true; // 403 rate-limited
      saveState({ ...state, lastCheck: new Date().toISOString() });
      if (verbose) console.log('Could not fetch latest release');
      return null;
    }

    // Successful fetch — clear rate-limit back-off
    state.rateLimited = false;
    const currentVersion = getCurrentVersion();
    if (verbose) console.log(`Current: v${currentVersion} — Latest: v${latest.version}`);

    const hasUpdate = compareVersions(latest.version, currentVersion) > 0;

    if (hasUpdate) {
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
        };
      }

      if (verbose) console.log(`Downloading v${latest.version}...`);
      const success = await downloadAndInstall(latest.tarballUrl, verbose, token);

      saveState({
        ...state,
        lastCheck: new Date().toISOString(),
        latestVersion: latest.version,
        updateAvailable: !success,
        lastUpdate: success ? new Date().toISOString() : state.lastUpdate,
      });

      return {
        updateAvailable: !success,
        updated: success,
        from: currentVersion,
        to: latest.version,
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
  } catch (err) {
    if (verbose) console.error('Update check failed:', err.message);
    return null;
  }
}

// ── Skip Check Detection ──────────────────────────────────
// Returns true when update checks should be skipped:
// 1. PLUGIN_AUTO_UPDATE env set → recursive guard (auto-update already in progress)
// 2. Running from a git clone → dev mode (developer working on source)
function shouldSkipUpdateCheck() {
  if (process.env.PLUGIN_AUTO_UPDATE) return true;
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

function getCurrentVersion() {
  for (const p of [
    path.join(pluginRoot, 'package.json'),
    path.join(runtimeDir, 'package.json'),
  ]) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')).version;
    } catch {
      /* try next */
    }
  }
  return '0.0.0';
}

// ── Download & Install ─────────────────────────────────────
async function downloadAndInstall(tarballUrl, verbose = false, token = null) {
  const tmpDir = path.join(os.tmpdir(), `gsd-update-${Date.now()}`);
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

    // Run installer with spawnSync (no shell)
    if (verbose) console.log('  Running installer...');
    const install = spawnSync(process.execPath, [path.join(tmpDir, 'install.js')], {
      timeout: 60000,
      stdio: verbose ? 'inherit' : 'pipe',
      env: { ...process.env, PLUGIN_AUTO_UPDATE: '1' },
    });
    if (install.status !== 0) throw new Error(`Installer failed: ${(install.stderr || '').toString().slice(0, 200)}`);

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

module.exports = {
  checkForUpdate,
  getCurrentVersion,
  compareVersions,
  shouldSkipUpdateCheck,
};

// ── CLI Entry Point (for background auto-install) ─────────
if (require.main === module) {
  checkForUpdate({ install: true, verbose: false })
    .then((result) => {
      if (result?.updated) {
        const notifPath = path.join(stateDir, 'update-notification.json');
        fs.mkdirSync(stateDir, { recursive: true });
        const tmpPath = notifPath + `.${process.pid}.tmp`;
        fs.writeFileSync(
          tmpPath,
          JSON.stringify({
            from: result.from,
            to: result.to,
            at: new Date().toISOString(),
          }) + '\n',
        );
        fs.renameSync(tmpPath, notifPath);
      }
    })
    .catch(() => {})
    .finally(() => process.exit(0));
}
