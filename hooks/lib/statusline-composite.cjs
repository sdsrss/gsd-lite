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
 * Register GSD as a provider in the composite statusline registry.
 * Prefers code-graph's statusline-chain.js CLI when available; falls back to
 * writing the cache registry directly for older code-graph versions.
 * Idempotent: updates existing entry or inserts before code-graph.
 * @param {string} statuslineScriptPath - Absolute path to gsd-statusline.cjs
 * @returns {boolean} true if registered/updated
 */
function registerProvider(statuslineScriptPath) {
  const command = `node ${JSON.stringify(statuslineScriptPath)}`;
  if (runChainCLI(['register', 'gsd', command, '--stdin'])) return true;

  let registryPath = findCompositeRegistry();

  // If composite statusLine is configured but registry file is missing,
  // create it if the parent directory exists (e.g., code-graph installed
  // but registry was deleted or not yet created).
  if (!registryPath) {
    for (const candidate of REGISTRY_PATHS) {
      const dir = path.dirname(candidate);
      if (fs.existsSync(dir)) {
        registryPath = candidate;
        break;
      }
    }
    if (!registryPath) return false;
  }

  try {
    let registry;
    try {
      registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch {
      registry = []; // File missing or corrupt — start fresh
    }
    if (!Array.isArray(registry)) return false;

    const provider = { id: 'gsd', command, needsStdin: true };

    // Find existing GSD entry (by id or command)
    const idx = registry.findIndex(p =>
      p.id === 'gsd' || p.command?.includes('gsd-statusline'));

    if (idx >= 0) {
      registry[idx] = provider;
    } else {
      // Insert before code-graph for display priority
      const cgIdx = registry.findIndex(p => p.id === 'code-graph');
      if (cgIdx >= 0) registry.splice(cgIdx, 0, provider);
      else registry.unshift(provider);
    }

    // Atomic write
    const tmp = registryPath + `.${process.pid}-${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n');
    fs.renameSync(tmp, registryPath);
    return true;
  } catch {
    return false;
  }
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
