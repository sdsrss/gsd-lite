#!/usr/bin/env node
// GSD-Lite Auto-Update Module
// Checks GitHub Releases for new versions and auto-installs updates.
// CJS format to match other hook modules.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execSync, spawnSync } = require('node:child_process');
const { semverSortComparator } = require('./lib/semver-sort.cjs');

// ── Configuration ──────────────────────────────────────────
const GITHUB_REPO = 'sdsrss/gsd-lite';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RATE_LIMIT_INTERVAL_MS = 48 * 60 * 60 * 1000; // 48h back-off if rate-limited
const FETCH_TIMEOUT_MS = 3000; // 3s network timeout

// ── Release signing (R-11b: tamper-proofing) ───────────────
// Ed25519 public key. The matching private key lives ONLY in the CI secret
// RELEASE_SIGNING_KEY and signs each release's SHA-256. Releases at or after
// MIN_SIGNED_VERSION MUST carry a valid signature over their checksum — this
// blocks tampering AND signature-stripping/downgrade, because an attacker
// cannot forge a signature without the private key. Unlike the checksum alone
// (which only detects transit corruption), this establishes authenticity.
const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAMTCfaIW82bCERaG7MuuQWbevfrTLkp0l/tNYN7kmQ/o=
-----END PUBLIC KEY-----
`;
const MIN_SIGNED_VERSION = '0.8.3';

// Verify an Ed25519 signature over the ASCII SHA-256 hex string. Returns false
// on any error (missing signature, malformed key, bad signature) — fails closed.
function verifyReleaseSignature(sha256Hex, signatureB64, publicKeyPem = RELEASE_PUBLIC_KEY) {
  if (!sha256Hex || !signatureB64) return false;
  try {
    const pub = crypto.createPublicKey(publicKeyPem);
    return crypto.verify(null, Buffer.from(String(sha256Hex), 'utf8'), pub, Buffer.from(String(signatureB64), 'base64'));
  } catch {
    return false;
  }
}

// ── Paths ──────────────────────────────────────────────────
const claudeDir =
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const runtimeDir = path.join(claudeDir, 'gsd');
const stateDir = path.join(runtimeDir, 'runtime');
const STATE_FILE = path.join(stateDir, 'update-state.json');
const STATE_LOCK_FILE = path.join(stateDir, 'update-state.lock');
const NOTIFICATION_FILE = path.join(stateDir, 'update-notification.json');
// pluginRoot is normally derived from this file's location. GSD_TEST_PLUGIN_ROOT
// lets tests run the *real* module against a temp plugin root (so integrity /
// install paths get real coverage without writing to the actual repo).
const pluginRoot = process.env.GSD_TEST_PLUGIN_ROOT || path.resolve(__dirname, '..');

const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;

// ── Orphan Detection ───────────────────────────────────────
// Mirrors gsd-session-init.cjs Phase 0. When the plugin was removed via
// /plugin uninstall but install.js-written state (hook files, runtime dir,
// settings.json) survives, getInstallMode() falls through to 'manual' and a
// new GitHub release would re-trigger install.js — resurrecting the plugin.
// Guard here so checkForUpdate is a no-op until the orphan is cleaned up
// (session-init Phase 0 handles the cleanup itself).
function isOrphan() {
  const installModeMarker = path.join(claudeDir, 'gsd', '.install-mode');
  let mode = null;
  try { mode = fs.readFileSync(installModeMarker, 'utf8').trim(); } catch { /* missing → fall through */ }
  if (mode === 'manual') return false;
  if (mode === 'plugin') {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8'));
      return !data.plugins?.['gsd@gsd'];
    } catch { return false; }
  }
  // Pre-marker fallback: orphan iff every cached version has .orphaned_at.
  const cacheBase = path.join(claudeDir, 'plugins', 'cache', 'gsd', 'gsd');
  if (!fs.existsSync(cacheBase)) return false;
  try {
    const dirs = fs.readdirSync(cacheBase, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\d+\.\d+\.\d+/.test(e.name));
    if (dirs.length === 0) return false;
    return dirs.every(d => fs.existsSync(path.join(cacheBase, d.name, '.orphaned_at')));
  } catch { return false; }
}

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
    if (isOrphan()) {
      if (verbose) console.log('Skipping update check (plugin uninstalled — orphan state)');
      return null;
    }
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
        const success = await downloadAndInstallImpl(latest.tarballUrl, verbose, token, {
          expectedChecksum: latest.checksum,
          expectedSignature: latest.signature,
          // Releases at/after MIN_SIGNED_VERSION MUST verify — a stripped or
          // absent signature on such a release aborts the update (anti-downgrade).
          // Gate on the core version so a `0.8.3-rc.1` prerelease of MIN can't be
          // used to slip an unsigned "update" past a pre-MIN client.
          requireSignature: requiresSignature(latest.version),
        });

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

  if (!acquired) {
    return null;
  }
  try {
    return await fn();
  } finally {
    try { fs.rmSync(STATE_LOCK_FILE, { force: true }); } catch {}
  }
}

// ── Skip Check Detection ──────────────────────────────────
// Returns true when update checks should be skipped:
// 1. PLUGIN_AUTO_UPDATE env set → recursive guard (auto-update already in progress)
// 2. Running from a git clone → dev mode (developer working on source)
function shouldSkipUpdateCheck() {
  if (process.env.PLUGIN_AUTO_UPDATE === '1') return true;
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
    if (!data.tag_name) return null;
    // R-11: prefer the CI-published deterministic npm-pack asset (gsd-lite-X.Y.Z.tgz).
    // Its bytes — and therefore its SHA-256 — are fixed at publish time, so the
    // `sha256:` in the release body is enforceable. GitHub's source tarball_url has
    // NO stable-checksum guarantee, so we fall back to it only for legacy releases
    // that shipped no asset (those verify nothing, as before).
    const asset = Array.isArray(data.assets)
      ? data.assets.find(a => a && typeof a.name === 'string'
          && /^gsd-lite-\d+\.\d+\.\d+(-[\w.]+)?\.tgz$/.test(a.name)
          && typeof a.browser_download_url === 'string')
      : null;
    const downloadUrl = asset ? asset.browser_download_url : data.tarball_url;
    if (!downloadUrl) return null;
    // The published SHA-256 (a line `sha256: <64 hex>` in the release body) is the
    // hash of the asset; when present the updater enforces it before running
    // install.js; when absent it proceeds (legacy releases). Take the LAST match:
    // on a workflow re-run action-gh-release appends a fresh integrity block, and
    // only the last `sha256:`/`sig:` pair matches the (re-packed) current asset —
    // an earlier stale hash would otherwise fail closed and break the update.
    const bodyStr = typeof data.body === 'string' ? data.body : '';
    const lastMatch = (re) => {
      const all = [...bodyStr.matchAll(re)];
      return all.length ? all[all.length - 1] : null;
    };
    const checksumMatch = lastMatch(/sha256[:=]\s*([a-f0-9]{64})/gi);
    // R-11b: the Ed25519 signature over the checksum (a line `sig: <base64>`).
    // 64-byte Ed25519 signature → 88 base64 chars; bound the length AND anchor to
    // end-of-line (multiline) so an over-long blob is rejected outright rather than
    // silently truncated to a wrong-length capture.
    const sigMatch = lastMatch(/\bsig[:=]\s*([A-Za-z0-9+/=]{80,120})\s*$/gim);
    return {
      version: data.tag_name.replace(/^v/, ''),
      tarballUrl: downloadUrl,
      releaseUrl: data.html_url,
      checksum: checksumMatch ? checksumMatch[1].toLowerCase() : null,
      signature: sigMatch ? sigMatch[1] : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Version Comparison (semver) ────────────────────────────
// Reuse shared comparator; callers only check sign (> 0, < 0, === 0)
const compareVersions = semverSortComparator;

// A release requires a valid signature when its RELEASE CORE (major.minor.patch,
// ignoring any prerelease/build suffix) is at or above MIN_SIGNED_VERSION.
// Gating on the core — not the full semver — closes an anti-downgrade gap:
// `0.8.3-rc.1` sorts BELOW `0.8.3`, so a raw `compareVersions(latest, MIN) >= 0`
// gate would treat an unsigned `0.8.3-rc.1` as legacy-OK. Since that prerelease
// is still a valid "update" for any pre-MIN client, a MITM forging the GitHub
// API JSON could present it with no `sig:` and bypass verification. The core of
// any 0.8.3 prerelease is 0.8.3, so it is correctly treated as signed-era.
function requiresSignature(version) {
  const core = String(version).replace(/^v/, '').split('-')[0].split('+')[0];
  return compareVersions(core, MIN_SIGNED_VERSION) >= 0;
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
    if (!pkg.version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(pkg.version)) return false;
    // Verify install.js exists and is a regular file (lstat rejects symlinks)
    const installPath = path.join(extractDir, 'install.js');
    const lstat = fs.lstatSync(installPath);
    if (!lstat.isFile()) return false;
    return true;
  } catch {
    return false;
  }
}

// ── Tarball URL Validation ─────────────────────────────────
const ALLOWED_TARBALL_HOSTS = [
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
];

function validateTarballUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_TARBALL_HOSTS.some(
      allowed => parsed.hostname === allowed || parsed.hostname.endsWith('.' + allowed),
    );
  } catch {
    return false;
  }
}

// ── Download & Install ─────────────────────────────────────
async function downloadAndInstall(tarballUrl, verbose = false, token = null, opts = {}) {
  const {
    expectedChecksum = null,
    expectedSignature = null,
    requireSignature = false,
    publicKey = RELEASE_PUBLIC_KEY,
    fetchImpl = fetch,
  } = opts;
  const tmpDir = path.join(os.tmpdir(), `gsd-update-${Date.now()}`);
  const backupPath = path.join(runtimeDir, 'package.json.bak');
  let backedUp = false;
  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    // Download tarball via fetch (no shell interpolation)
    if (verbose) console.log('  Downloading tarball...');
    if (!validateTarballUrl(tarballUrl)) {
      throw new Error(`Tarball URL failed host validation: ${(() => { try { return new URL(tarballUrl).hostname; } catch { return tarballUrl; } })()}`);
    }
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'gsd-lite-auto-update/1.0' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const controller = new AbortController();
    const dlTimeout = setTimeout(() => controller.abort(), 30000);
    let tarData;
    try {
      let res = await fetchImpl(tarballUrl, { signal: controller.signal, headers, redirect: 'manual' });
      // Handle redirect manually to prevent Authorization header leakage
      if (res.status === 301 || res.status === 302) {
        const location = res.headers.get('location');
        if (!location || !validateTarballUrl(location)) {
          throw new Error(`Redirect URL failed host validation: ${location || '(empty)'}`);
        }
        // Follow redirect WITHOUT Authorization header (prevent token leakage to CDN)
        // Use redirect: 'manual' to validate any further redirects in the chain
        const redirectHeaders = { Accept: 'application/vnd.github+json', 'User-Agent': 'gsd-lite-auto-update/1.0' };
        res = await fetchImpl(location, { signal: controller.signal, headers: redirectHeaders, redirect: 'manual' });
        // Handle one more potential redirect from CDN (e.g., 303/307/308)
        if (res.status >= 300 && res.status < 400) {
          const loc2 = res.headers.get('location');
          if (!loc2 || !validateTarballUrl(loc2)) {
            throw new Error(`Secondary redirect URL failed host validation: ${loc2 || '(empty)'}`);
          }
          res = await fetchImpl(loc2, { signal: controller.signal, headers: redirectHeaders, redirect: 'error' });
        }
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      tarData = Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(dlTimeout);
    }

    // R-11 (audit M9): verify tarball integrity BEFORE extracting or executing
    // anything. A published SHA-256 must match the downloaded bytes; a mismatch
    // (tampering or truncation in transit) aborts here — install.js is never run.
    // Fails closed: a bad checksum means no auto-update, not a bad install.
    const actualSha = crypto.createHash('sha256').update(tarData).digest('hex');
    if (expectedChecksum) {
      const expected = String(expectedChecksum).trim().toLowerCase().replace(/^sha256:/, '');
      if (actualSha !== expected) {
        throw new Error(`Tarball checksum mismatch — expected ${expected.slice(0, 12)}…, got ${actualSha.slice(0, 12)}… (aborting before install)`);
      }
      if (verbose) console.log('  Checksum verified ✓');
    } else if (verbose) {
      console.log('  No published checksum for this release — skipping integrity verification');
    }

    // R-11b: Ed25519 signature verification — tamper-proofing / authenticity.
    // A release at or after MIN_SIGNED_VERSION must carry a valid signature over
    // its checksum; a missing or invalid signature aborts before install (fails
    // closed). This also defends against stripping the signature off a signed
    // release. `actualSha` is the hash of the bytes we actually downloaded, so a
    // valid signature over it authenticates those exact bytes.
    if (requireSignature || expectedSignature) {
      if (!verifyReleaseSignature(actualSha, expectedSignature, publicKey)) {
        throw new Error('Release signature verification failed — aborting before install');
      }
      if (verbose) console.log('  Signature verified ✓');
    }

    // Write tarball to file, then extract with spawnSync (no shell)
    const tarPath = path.join(tmpDir, 'release.tar.gz');
    fs.writeFileSync(tarPath, tarData);
    const stripFlag = process.platform === 'win32' ? [] : ['--strip-components=1'];
    const tar = spawnSync('tar', ['xzf', tarPath, '-C', tmpDir, ...stripFlag], { timeout: 30000 });
    if (tar.status !== 0) {
      const errMsg = (tar.stderr || '').toString().slice(0, 200);
      if (process.platform === 'win32') {
        console.error('[gsd] Auto-update: tar extraction failed on Windows — manual update may be required');
      }
      throw new Error(`tar extract failed: ${errMsg}`);
    }
    // On Windows without --strip-components, the content is nested in a subdirectory
    if (process.platform === 'win32') {
      const entries = fs.readdirSync(tmpDir).filter(e => e !== 'release.tar.gz');
      if (entries.length === 1 && fs.statSync(path.join(tmpDir, entries[0])).isDirectory()) {
        const nested = path.join(tmpDir, entries[0]);
        for (const f of fs.readdirSync(nested)) {
          fs.renameSync(path.join(nested, f), path.join(tmpDir, f));
        }
        fs.rmdirSync(nested);
      }
    }

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

// ── Cache Cleanup ─────────────────────────────────────────
// Remove old plugin cache versions, keeping the N most recent.
function pruneOldCacheVersions(cacheBase, keepCount = 3, verbose = false) {
  try {
    if (!fs.existsSync(cacheBase)) return;
    const entries = fs.readdirSync(cacheBase, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(e.name))
      .map(e => e.name);
    if (entries.length <= keepCount) return;

    // Sort by semver using shared comparator
    const sorted = entries.slice().sort(semverSortComparator);

    // Detect versions with active processes to avoid disrupting running sessions
    let activeVersions;
    try {
      const psOutput = spawnSync('ps', ['aux'], { stdio: 'pipe', timeout: 5000 });
      const lines = (psOutput.stdout || '').toString();
      activeVersions = new Set(
        entries.filter(ver => lines.includes(`/cache/gsd/gsd/${ver}/`))
      );
    } catch { activeVersions = new Set(); }

    const toRemove = sorted.slice(0, sorted.length - keepCount);
    for (const ver of toRemove) {
      if (activeVersions.has(ver)) {
        if (verbose) console.log(`  Skipped ${ver} (active process detected)`);
        continue;
      }
      const verPath = path.join(cacheBase, ver);
      fs.rmSync(verPath, { recursive: true, force: true });
      if (verbose) console.log(`  Pruned old cache: ${ver}`);
    }
  } catch { /* best effort */ }
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
    if (!newVersion || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(newVersion)) return;

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
      const npmResult = spawnSync('npm', ['install', '--omit=dev', '--ignore-scripts'], {
        cwd: newCachePath,
        stdio: 'pipe',
        timeout: 60000,
      });
      if (npmResult.status !== 0) {
        // npm install failed — don't update registry to point to broken cache
        if (verbose) console.error('  npm install failed in cache dir, aborting cache sync');
        fs.rmSync(newCachePath, { recursive: true, force: true });
        return;
      }
    }

    // Update installed_plugins.json to point to new cache path
    gsdEntry.installPath = newCachePath;
    gsdEntry.version = newVersion;
    gsdEntry.lastUpdated = new Date().toISOString();
    const tmpPlugins = pluginsFile + `.${process.pid}.tmp`;
    fs.writeFileSync(tmpPlugins, JSON.stringify(plugins, null, 2) + '\n');
    fs.renameSync(tmpPlugins, pluginsFile);

    // Update settings.json statusLine if it points to the old cache path
    try {
      const settingsPath = path.join(claudeDir, 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settings.statusLine?.command?.includes('/plugins/cache/gsd/gsd/')) {
        const oldCmd = settings.statusLine.command;
        const updated = oldCmd.replace(/\/plugins\/cache\/gsd\/gsd\/[^/]+\//g, `/plugins/cache/gsd/gsd/${newVersion}/`);
        if (updated !== oldCmd) {
          settings.statusLine.command = updated;
          const tmpSettings = settingsPath + `.${process.pid}.tmp`;
          fs.writeFileSync(tmpSettings, JSON.stringify(settings, null, 2) + '\n');
          fs.renameSync(tmpSettings, settingsPath);
          if (verbose) console.log('  StatusLine path updated to new version');
        }
      }
    } catch {}

    // Prune old cache versions — keep only the 3 most recent
    pruneOldCacheVersions(cacheBase, 3, verbose);

    if (verbose) console.log(`  Plugin cache synced to v${newVersion}`);
  } catch (err) {
    // Best effort — don't fail the update if cache sync fails
    if (verbose) console.error('  Plugin cache sync failed:', err.message);
  }
}

module.exports = {
  checkForUpdate,
  downloadAndInstall,
  fetchLatestRelease,
  getCurrentVersion,
  compareVersions,
  requiresSignature,
  getInstallMode,
  isDevMode,
  isOrphan,
  shouldCheck,
  shouldSkipUpdateCheck,
  validateExtractedPackage,
  validateTarballUrl,
  verifyReleaseSignature,
  RELEASE_PUBLIC_KEY,
  MIN_SIGNED_VERSION,
};

// ── CLI Entry Point (for background auto-install) ─────────
if (require.main === module) {
  checkForUpdate({ install: true, verbose: false, notify: true })
    .catch(() => {})
    .finally(() => process.exit(0));
}
