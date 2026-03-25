'use strict';
// Detect and register with composite statusline systems (e.g., code-graph).
// Used by install.js, gsd-session-init.cjs, and uninstall.js.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Known composite statusline registry paths
const REGISTRY_PATHS = [
  path.join(os.homedir(), '.cache', 'code-graph', 'statusline-registry.json'),
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
 * Register GSD as a provider in the composite statusline registry.
 * Idempotent: updates existing entry or inserts before code-graph.
 * @param {string} statuslineScriptPath - Absolute path to gsd-statusline.cjs
 * @returns {boolean} true if registered/updated
 */
function registerProvider(statuslineScriptPath) {
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

    const command = `node ${JSON.stringify(statuslineScriptPath)}`;
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
 * @returns {boolean} true if an entry was removed
 */
function removeProvider() {
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
