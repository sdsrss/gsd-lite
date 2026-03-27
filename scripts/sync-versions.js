#!/usr/bin/env node

/**
 * Sync version from package.json to plugin.json, marketplace.json,
 * and the local plugin cache (if installed as a Claude Code plugin).
 * Run automatically via `prepublishOnly` or manually: `node scripts/sync-versions.js`
 */

import { readFileSync, writeFileSync, renameSync, existsSync, cpSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;

const targets = [
  join(root, '.claude-plugin', 'plugin.json'),
  join(root, '.claude-plugin', 'marketplace.json'),
];

let changed = false;

for (const file of targets) {
  const content = readFileSync(file, 'utf8');
  const json = JSON.parse(content);
  let fileChanged = false;

  if (file.endsWith('plugin.json')) {
    if (json.version !== version) {
      json.version = version;
      fileChanged = true;
    }
  } else if (file.endsWith('marketplace.json')) {
    for (const plugin of json.plugins || []) {
      if (plugin.version !== version) {
        plugin.version = version;
        fileChanged = true;
      }
    }
  }

  if (fileChanged) {
    const tmpPath = `${file}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(json, null, 2) + '\n');
    renameSync(tmpPath, file);
    changed = true;
  }
}

if (changed) {
  console.log(`Synced version to ${version}`);
} else {
  console.log(`Versions already at ${version}`);
}

// ── CLAUDE.md test count sync (local file, gitignored) ───
// Keep test count accurate in CLAUDE.md for context.
try {
  const claudeMdPath = join(root, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    const { execSync: exec } = await import('node:child_process');
    const testOutput = exec('npm test --silent 2>&1', { cwd: root, timeout: 120000 }).toString();
    const countMatch = testOutput.match(/# tests (\d+)/);
    if (countMatch) {
      const actualCount = countMatch[1];
      let claudeContent = readFileSync(claudeMdPath, 'utf8');
      const oldMatch = claudeContent.match(/(\d+) 个测试/);
      if (oldMatch && oldMatch[1] !== actualCount) {
        claudeContent = claudeContent.replace(new RegExp(oldMatch[1] + ' 个测试', 'g'), actualCount + ' 个测试');
        claudeContent = claudeContent.replace(new RegExp('运行全部 ' + oldMatch[1], 'g'), '运行全部 ' + actualCount);
        writeFileSync(claudeMdPath, claudeContent);
        console.log(`CLAUDE.md test count synced: ${oldMatch[1]} → ${actualCount}`);
      }
    }
  }
} catch { /* CLAUDE.md sync is best-effort */ }

// ── Plugin cache sync (dev workflow) ─────────────────────
// When developing locally, the MCP server runs from the plugin cache
// at ~/.claude/plugins/cache/gsd/gsd/<version>/.
// After version bumps, sync source → cache so the running server picks up changes.
const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const pluginsFile = join(claudeDir, 'plugins', 'installed_plugins.json');

if (existsSync(pluginsFile)) {
  try {
    const plugins = JSON.parse(readFileSync(pluginsFile, 'utf8'));
    const gsdEntry = plugins.plugins?.['gsd@gsd']?.[0];
    if (gsdEntry?.installPath) {
      const cacheBase = join(claudeDir, 'plugins', 'cache', 'gsd', 'gsd');
      const newCachePath = join(cacheBase, version);

      // Copy source files to cache
      mkdirSync(newCachePath, { recursive: true });
      const syncDirs = ['src', 'commands', 'agents', 'workflows', 'references', 'hooks', 'scripts', '.claude-plugin'];
      const syncFiles = ['package.json', 'launcher.js', '.mcp.json'];

      for (const dir of syncDirs) {
        const srcDir = join(root, dir);
        if (existsSync(srcDir)) {
          cpSync(srcDir, join(newCachePath, dir), { recursive: true });
        }
      }
      for (const file of syncFiles) {
        const srcFile = join(root, file);
        if (existsSync(srcFile)) {
          writeFileSync(join(newCachePath, file), readFileSync(srcFile));
        }
      }

      // Install deps in cache if needed
      if (!existsSync(join(newCachePath, 'node_modules', '@modelcontextprotocol'))) {
        try {
          execSync('npm install --omit=dev --ignore-scripts', {
            cwd: newCachePath,
            stdio: 'pipe',
            timeout: 60000,
          });
        } catch { /* best effort */ }
      }

      // Update installed_plugins.json
      if (gsdEntry.installPath !== newCachePath || gsdEntry.version !== version) {
        gsdEntry.installPath = newCachePath;
        gsdEntry.version = version;
        gsdEntry.lastUpdated = new Date().toISOString();
        const tmpPlugins = `${pluginsFile}.${process.pid}.tmp`;
        writeFileSync(tmpPlugins, JSON.stringify(plugins, null, 2) + '\n');
        renameSync(tmpPlugins, pluginsFile);
        console.log(`Plugin cache synced → ${newCachePath}`);
      } else {
        console.log('Plugin cache already up to date');
      }
    }
  } catch (err) {
    console.warn(`Plugin cache sync skipped: ${err.message}`);
  }
}

// ── Runtime dir sync ──────────────────────────────────────
// Keep ~/.claude/gsd/package.json version in sync so auto-update
// knows the correct current version and doesn't report stale data.
const runtimePkg = join(claudeDir, 'gsd', 'package.json');
if (existsSync(runtimePkg)) {
  try {
    const runtimeJson = JSON.parse(readFileSync(runtimePkg, 'utf8'));
    if (runtimeJson.version !== version) {
      runtimeJson.version = version;
      const tmpPath = `${runtimePkg}.${process.pid}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(runtimeJson, null, 2) + '\n');
      renameSync(tmpPath, runtimePkg);
      console.log(`Runtime dir version synced → ${version}`);
    }
  } catch (err) {
    console.warn(`Runtime dir sync skipped: ${err.message}`);
  }
}

// ── Auto-update state reset ───────────────────────────────
// Clear stale auto-update state so it reflects the current version.
const updateStatePath = join(claudeDir, 'gsd', 'runtime', 'update-state.json');
if (existsSync(updateStatePath)) {
  try {
    const state = JSON.parse(readFileSync(updateStatePath, 'utf8'));
    if (state.latestVersion && state.latestVersion !== version) {
      state.latestVersion = version;
      state.updateAvailable = false;
      const tmpPath = `${updateStatePath}.${process.pid}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n');
      renameSync(tmpPath, updateStatePath);
      console.log(`Auto-update state synced → ${version}`);
    }
  } catch { /* best effort */ }
}
