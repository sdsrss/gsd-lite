#!/usr/bin/env node

/**
 * Sync version from package.json to plugin.json and marketplace.json.
 * Run automatically via `prepublishOnly` or manually: `node scripts/sync-versions.js`
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
