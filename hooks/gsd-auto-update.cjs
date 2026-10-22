#!/usr/bin/env node
// GSD-Lite Auto-Update Module
// Checks GitHub Releases for new versions and auto-installs updates.
// CJS format to match other hook modules.

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./lib/atomic-write.cjs');
const os = require('node:os');
const crypto = require('node:crypto');
const { execSync, spawnSync } = require('node:child_process');
const { semverSortComparator } = require('./lib/semver-sort.cjs');
const { pluginInstalledForUser, realish } = require('./lib/hook-registry.cjs');

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

// A failed check is announced from the third in a row, then once every seven
// (checks run at most daily): one failure is a blip, a streak is a stopped
// updater, and a daily notice would be noise the user learns to skip.
const CHECK_FAILURES_BEFORE_NOTICE = 3;
const CHECK_FAILURE_NOTICE_EVERY = 7;

// ── Proxy ──────────────────────────────────────────────────
// Node's built-in fetch ignores HTTPS_PROXY unless the process opts in, so on a
// network that reaches GitHub only through a proxy every check failed after
// FETCH_TIMEOUT_MS and said nothing — an install stopped updating for good
// (measured 2026-10-21). Two ways in, per the Node docs: NODE_USE_ENV_PROXY=1
// read at startup (fetch: v22.21.0+, v24.0.0+), which gsd-session-init.cjs sets
// on the child it spawns; and http.setGlobalProxyFromEnv() at runtime
// (v24.14.0+, v25.4.0+), for `gsd update`, which nobody started that way.
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

function nodeReadsProxyEnvAtStartup(version = process.versions.node) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  return major >= 24 || (major === 22 && minor >= 21);
}

/**
 * How fetch in this process reaches the network, turning the runtime switch on
 * when that is the only way to the proxy the environment names. Never throws.
 * @returns {'direct'|'startup'|'runtime'|'opted-out'|'unsupported'|'unusable'}
 */
function envProxyRoute({ env = process.env, version = process.versions.node, http = require('node:http') } = {}) {
  if (!PROXY_VARS.some((key) => env[key])) return 'direct';
  // session-init asked Node and Node refused the value (updaterEnv).
  if (env.GSD_PROXY_ENV_REFUSED === '1') return 'unusable';
  // Any value but 1 is the user's own choice, and Node reads it as off.
  if (env.NODE_USE_ENV_PROXY !== undefined && env.NODE_USE_ENV_PROXY !== '1') return 'opted-out';
  if (env.NODE_USE_ENV_PROXY === '1' && nodeReadsProxyEnvAtStartup(version)) return 'startup';
  if (typeof http.setGlobalProxyFromEnv === 'function') {
    // Its error message is the proxy value; this function's callers must not
    // be handed it.
    try {
      http.setGlobalProxyFromEnv(env);
    } catch {
      return 'unusable';
    }
    return 'runtime';
  }
  return 'unsupported';
}

/**
 * The environment the SessionStart hook starts this updater with. Node reads
 * NODE_USE_ENV_PROXY only at startup, and when it refuses a proxy value it
 * exits before running a line — nothing recorded, every session. Which values
 * it refuses (a path, a raw %, a query, no scheme, socks5h://, and which of
 * the upper- and lower-case variables it reads at all) is Node's to say; two
 * restatements of its parser here were each wrong. So ask it: start an empty
 * Node with the switch on and see whether it starts. Only when the answer is
 * used — a proxy is set, the user has not set the switch, this Node reads it,
 * and a check is due (otherwise the updater exits at once). A refusal is
 * passed on, so the failure reason can say so.
 */
function updaterEnv(env = process.env, { version = process.versions.node, due = checkDue, probe = nodeAcceptsProxyEnv } = {}) {
  if (!PROXY_VARS.some((key) => env[key]) || env.NODE_USE_ENV_PROXY !== undefined || !nodeReadsProxyEnvAtStartup(version) || !due()) {
    return env;
  }
  const accepted = probe(env);
  if (accepted === null) return env;
  return accepted ? { ...env, NODE_USE_ENV_PROXY: '1' } : { ...env, GSD_PROXY_ENV_REFUSED: '1' };
}

// true: Node starts with the switch on; false: it exits with an error;
// null: no answer in time. Node refuses a value only after its preloads have
// run, so a slow start is not a refusal, and is not read as one.
function nodeAcceptsProxyEnv(env, { timeout = 3000 } = {}) {
  const started = spawnSync(process.execPath, ['-e', ''], { env: { ...env, NODE_USE_ENV_PROXY: '1' }, stdio: 'ignore', timeout });
  return started.status === null ? null : started.status === 0;
}

/** Would the updater check now, rather than exit at once? */
function checkDue() {
  try {
    return !isOrphan() && !shouldSkipUpdateCheck() && shouldCheck(readState());
  } catch {
    return false;
  }
}

let proxyRoute = null;
function useEnvProxy() {
  proxyRoute ??= envProxyRoute();
  return proxyRoute;
}

/**
 * The reason a release could not be fetched, for update-state.json, `gsd
 * update` and a SessionStart notice that reaches the model. Built only from
 * values this module chose — a status number, an error code of the usual
 * shape, the route — never from error text: a proxy URL can carry credentials.
 */
function describeFetchFailure({ status, err } = {}, { route = proxyRoute ?? 'direct', version = process.versions.node } = {}) {
  let what;
  if (Number.isInteger(status)) what = `HTTP ${status}`;
  else if (err?.name === 'AbortError' || err?.name === 'TimeoutError') what = `no response within ${FETCH_TIMEOUT_MS / 1000}s`;
  else if (err instanceof SyntaxError) what = 'unreadable response';
  else {
    const code = err?.cause?.code ?? err?.code;
    what = typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : 'network error';
  }
  const set = 'a proxy is set in the environment';
  switch (route) {
    case 'startup':
    case 'runtime':
      return `${what} (through the proxy set in the environment)`;
    case 'opted-out':
      return `${what} (${set}, but NODE_USE_ENV_PROXY keeps Node from using it)`;
    case 'unusable':
      return `${what} (${set} that Node refused to use)`;
    case 'unsupported':
      return nodeReadsProxyEnvAtStartup(version)
        ? `${what} (${set}, but Node v${version} uses it only when started with NODE_USE_ENV_PROXY=1)`
        : `${what} (${set}, and Node v${version}'s fetch cannot use one: it needs v22.21+ or v24+)`;
    default:
      return what;
  }
}

function recordCheckFailure(previous, reason, now) {
  const count = Number.isInteger(previous?.count) && previous.count > 0 ? previous.count + 1 : 1;
  const since = count > 1 && typeof previous?.since === 'string' ? previous.since : now;
  const failure = { since, count, reason };
  if (count > 1 && Number.isInteger(previous?.announced)) failure.announced = previous.announced;
  return failure;
}

// Counted from the last notice actually shown (`announced`), not from the
// count alone: only the SessionStart child notifies, and a `gsd update
// --force` failure landing on count 3 used to push the first notice to 10.
function shouldAnnounceCheckFailure(failure) {
  if (failure.count < CHECK_FAILURES_BEFORE_NOTICE) return false;
  return !Number.isInteger(failure.announced) || failure.count - failure.announced >= CHECK_FAILURE_NOTICE_EVERY;
}

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
        // Before either return: a cached "update available" from an earlier
        // check is still followed by checks that fail.
        const failure = state.checkFailure;
        if (verbose && Number.isInteger(failure?.count) && typeof failure.reason === 'string') {
          console.log(`The last check failed (${failure.count} in a row): ${failure.reason}`);
        }
        if (state.updateAvailable && state.latestVersion) {
          return {
            updateAvailable: true,
            from: getCurrentVersionImpl(installMode),
            to: state.latestVersion,
            // Nothing was fetched and nothing was installed — this is last
            // check's answer, replayed. Labelled so a caller does not report it
            // as an install that failed.
            action: 'cached',
            installMode,
          };
        }
        if (verbose) console.log('Throttled — last check:', state.lastCheck);
        return null;
      }

      if (verbose) console.log('Checking GitHub for latest release...');
      const token = getGitHubToken();
      const latest = await fetchLatestReleaseImpl(token);
      if (!latest || latest.error) {
        if (latest === false) state.rateLimited = true; // 403 rate-limited
        const reason = latest === false
          ? 'GitHub API rate limit (HTTP 403)'
          : (typeof latest?.error === 'string' && latest.error) || 'no release information';
        // Recording only lastCheck is what made a stopped updater invisible:
        // the next check was throttled a day out and nothing said why.
        const now = new Date().toISOString();
        const checkFailure = recordCheckFailure(state.checkFailure, reason, now);
        const announce = notify && shouldAnnounceCheckFailure(checkFailure);
        if (announce) checkFailure.announced = checkFailure.count;
        saveState({ ...state, lastCheck: now, checkFailure });
        if (announce) {
          writeNotification({ kind: 'check_failed', since: checkFailure.since, count: checkFailure.count, reason });
        }
        if (verbose) console.log(`Could not fetch latest release: ${reason}`);
        return null;
      }

      // Successful fetch — clear rate-limit back-off and any failure streak
      state.rateLimited = false;
      delete state.checkFailure;
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

        // Both outcomes are reported. Only success used to be, so a runtime that
        // failed to update said nothing — and because the old installer wrote the
        // new package.json before `npm ci`, getCurrentVersion then read the new
        // number and every later check concluded "already latest". Silent, and
        // permanent. install.js stages and swaps now, so a failure leaves the old
        // version on disk and the next check retries on its own; this just makes
        // sure the user finds out it happened.
        if (notify) {
          writeNotification(success
            ? { kind: 'updated', from: currentVersion, to: latest.version }
            : { kind: 'failed', from: currentVersion, to: latest.version });
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
  // Check if installed as a Claude Code plugin (installed_plugins.json has gsd entry)
  // Hook files live at ~/.claude/hooks/ so pluginRoot (=__dirname/..) equals claudeDir,
  // but that doesn't mean it's a manual install — check the plugin registry first.
  //
  // First of all, and with install.js's own test (pluginInstalledForUser): a
  // plugin install is updated by `claude plugin update`, and install.js —
  // which this runs for every other mode — prunes plugins/cache/gsd and
  // clears .orphaned_at whenever it finds the plugin. Checked after dev mode,
  // or as `?.[0]`, the two disagreed and the updater ran install.js against
  // an installed plugin's cache.
  if (pluginInstalledForUser(claudeDir)) return 'plugin';
  if (isDevMode()) return 'dev';
  // Real paths on both sides: pluginRoot comes from __dirname, which Node
  // resolves through symlinks, and claudeDir is as given. Under a symlinked
  // ~/.claude the npx install read as a plugin install and was never updated.
  return realish(pluginRoot) === realish(claudeDir)
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
// Returns the release, false for a 403 (rate limit), or { error } naming why
// nothing came back (describeFetchFailure).
async function fetchLatestRelease(token) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
  useEnvProxy();
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
    if (!res.ok) return { error: describeFetchFailure({ status: res.status }) };

    const data = await res.json();
    if (!data.tag_name) return { error: 'the latest release has no tag' };
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
    if (!downloadUrl) return { error: 'the latest release has nothing to download' };
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
  } catch (err) {
    return { error: describeFetchFailure({ err }) };
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
  if (fetchImpl === fetch) useEnvProxy();

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

    // No backup/restore here any more. It never worked: the source was
    // pluginRoot/package.json (for the ~/.claude/hooks copy that is
    // ~/.claude/package.json, which does not exist, so backedUp stayed false)
    // and the destination sat inside the directory install.js wiped. install.js
    // now builds into a staging dir and swaps at the end, so a failed install
    // cannot damage the runtime and there is nothing to roll back.

    // Run installer with spawnSync (no shell)
    if (verbose) console.log('  Running installer...');
    const install = spawnSync(process.execPath, [path.join(tmpDir, 'install.js')], {
      timeout: 60000,
      stdio: verbose ? 'inherit' : 'pipe',
      env: { ...process.env, PLUGIN_AUTO_UPDATE: '1' },
    });
    if (install.status !== 0) {
      throw new Error(`Installer failed: ${(install.stderr || '').toString().slice(0, 200)}`);
    }

    // Nothing here touches plugins/cache or installed_plugins.json: both
    // belong to Claude Code, and a plugin install is told to run `claude
    // plugin update` (checkForUpdate) rather than updated from here.
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
    atomicWriteJson(STATE_FILE, state);
  } catch {
    /* silent */
  }
}

function writeNotification(notification) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    atomicWriteJson(NOTIFICATION_FILE, notification);
  } catch {
    /* silent */
  }
}

/**
 * The one line a CLI should add on top of checkForUpdate's own verbose output.
 *
 * checkForUpdate returns null from six different outcomes — orphan state, dev
 * mode, throttled, fetch failure, 403 rate limit, and genuinely up to date — so
 * null carries no verdict and the caller must not invent one. In verbose mode
 * checkForUpdate has already printed which of the six it was; anything this
 * function added would at best repeat it and at worst contradict it.
 *
 * Returns null when there is nothing to add.
 */
function describeUpdateOutcome(result) {
  if (!result) return null;
  if (result.updated) return `\n✓ Updated: v${result.from} → v${result.to}`;
  if (!result.updateAvailable) return null;
  if (result.action === 'plugin_update') {
    return `\n! Update available: v${result.to}. Run: claude plugin update gsd@gsd`;
  }
  if (result.action === 'cached') {
    // A plugin install cannot self-update anyway, so sending it through another
    // check first would cost a round trip to reach the same sentence.
    if (result.installMode === 'plugin') {
      return `\n! Update available: v${result.to} (from an earlier check). Run: claude plugin update gsd@gsd`;
    }
    return `\n! Update available: v${result.to} (from an earlier check — this run was throttled).`
      + '\n  Run `gsd update --force` to check again now.';
  }
  return `\n! Update available v${result.to} but the install did not complete. Try manually.`;
}

module.exports = {
  checkForUpdate,
  describeUpdateOutcome,
  downloadAndInstall,
  fetchLatestRelease,
  getCurrentVersion,
  compareVersions,
  describeFetchFailure,
  envProxyRoute,
  nodeAcceptsProxyEnv,
  nodeReadsProxyEnvAtStartup,
  updaterEnv,
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
