'use strict';
// Detect and register with composite statusline systems (e.g., code-graph).
// Used by install.js, gsd-session-init.cjs, and uninstall.js.
//
// Preferred path (code-graph ≥ shipping statusline-chain.js): invoke that CLI
// with `register gsd <cmd> --stdin` / `unregister gsd`. The CLI owns both the
// primary cache registry and the ~/.claude/statusline-providers.json backup
// mirror, so we do not have to know their layout.
// Fallback path (older code-graph without the CLI): write the cache registry
// directly, same as the original behavior.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { semverSortComparator } = require('./semver-sort.cjs');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// Known composite statusline registry paths (fallback-only — chain CLI is preferred).
const REGISTRY_PATHS = [
  path.join(os.homedir(), '.cache', 'code-graph', 'statusline-registry.json'),
  path.join(CLAUDE_DIR, 'statusline-providers.json'),
];

function isCompositeStatusLine(command) {
  return typeof command === 'string' && command.includes('statusline-composite');
}

function findCompositeRegistry() {
  for (const p of REGISTRY_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Find code-graph's statusline-chain.js in the plugin cache (newest semver).
 * Returns absolute path or null if the CLI hasn't shipped yet.
 */
function findChainScript() {
  const base = path.join(CLAUDE_DIR, 'plugins', 'cache', 'code-graph-mcp', 'code-graph-mcp');
  if (!fs.existsSync(base)) return null;
  let versions;
  try {
    versions = fs.readdirSync(base).filter(v => /^\d+\.\d+\.\d+/.test(v));
  } catch { return null; }
  versions.sort(semverSortComparator).reverse();
  for (const v of versions) {
    const p = path.join(base, v, 'scripts', 'statusline-chain.js');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function runChainCLI(args) {
  const chainScript = findChainScript();
  if (!chainScript) return false;
  try {
    execFileSync(process.execPath, [chainScript, ...args], { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch { return false; }
}

/**
 * Rewrite a single registry file to its desired state: exactly one canonical
 * `{id: 'gsd', ...}` entry with the given command, dropping every other entry
 * whose command references gsd-statusline (e.g. ghost `_previous` entries
 * left by code-graph's composite-takeover). Canonical entry is placed before
 * `code-graph` for display priority.
 *
 * Returns true if the registry is now in the desired state (including
 * idempotent no-op), false if the file can't be parsed as an array.
 */
function normalizeRegistryFile(registryPath, canonicalCommand) {
  const canonical = { id: 'gsd', command: canonicalCommand, needsStdin: true };
  try {
    let registry;
    try {
      registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch {
      registry = []; // File missing or corrupt — start fresh
    }
    if (!Array.isArray(registry)) return false;

    // Drop every entry pointing at gsd-statusline, regardless of id. This
    // catches the canonical `gsd` slot AND ghosts like `_previous` that
    // code-graph's id-scoped chain CLI `register` can't see.
    const nonGsd = registry.filter(
      e => !(e.command || '').includes('gsd-statusline'),
    );

    const cgIdx = nonGsd.findIndex(e => e.id === 'code-graph');
    if (cgIdx >= 0) nonGsd.splice(cgIdx, 0, canonical);
    else nonGsd.unshift(canonical);

    // Skip write if already in desired state (idempotent re-install).
    const before = JSON.stringify(registry);
    const after = JSON.stringify(nonGsd);
    if (before === after) return true;

    const tmp = registryPath + `.${process.pid}-${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(nonGsd, null, 2) + '\n');
    fs.renameSync(tmp, registryPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Register GSD as a provider in the composite statusline registry.
 *
 * Calls code-graph's statusline-chain.js CLI when available, THEN post-scrubs
 * every known registry path. The CLI's `register gsd <cmd>` is id-scoped and
 * silently leaves ghost entries (e.g. `_previous` whose command is our
 * gsd-statusline but whose id isn't `gsd`) in place — that caused
 * double-rendering after upgrades where code-graph had previously promoted a
 * top-level GSD statusLine to `_previous`. Post-normalization guarantees
 * exactly one canonical `gsd` entry per registry regardless of which path
 * succeeded.
 *
 * @param {string} statuslineScriptPath - Absolute path to gsd-statusline.cjs
 * @returns {boolean} true if registered or normalized in at least one registry
 */
function registerProvider(statuslineScriptPath) {
  const command = `node ${JSON.stringify(statuslineScriptPath)}`;
  const cliOk = runChainCLI(['register', 'gsd', command, '--stdin']);

  let anyNormalized = false;
  for (const candidate of REGISTRY_PATHS) {
    // Only touch paths whose parent dir exists — don't create arbitrary
    // ~/.cache/ subtrees on machines without code-graph.
    const dir = path.dirname(candidate);
    if (!fs.existsSync(dir)) continue;
    if (normalizeRegistryFile(candidate, command)) anyNormalized = true;
  }

  return cliOk || anyNormalized;
}

/**
 * Remove GSD entry from composite statusline registry.
 * Prefers code-graph's statusline-chain.js CLI when available; falls back to
 * rewriting the cache registry directly for older code-graph versions.
 * @returns {boolean} true if an entry was removed
 */
function removeProvider() {
  if (runChainCLI(['unregister', 'gsd'])) return true;

  const registryPath = findCompositeRegistry();
  if (!registryPath) return false;

  try {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    if (!Array.isArray(registry)) return false;

    const idx = registry.findIndex(p =>
      p.id === 'gsd' || p.command?.includes('gsd-statusline'));
    if (idx < 0) return false;

    registry.splice(idx, 1);

    const tmp = registryPath + `.${process.pid}-${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n');
    fs.renameSync(tmp, registryPath);
    return true;
  } catch {
    return false;
  }
}

module.exports = { isCompositeStatusLine, findCompositeRegistry, registerProvider, removeProvider };
