#!/usr/bin/env node
// M-8: Pre-release version sync check
// Verifies that version strings in package.json, plugin.json, and marketplace.json match.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const sources = [
  { file: 'package.json', path: ['version'] },
  { file: '.claude-plugin/plugin.json', path: ['version'] },
  { file: '.claude-plugin/marketplace.json', path: ['plugins', 0, 'version'] },
];

const versions = [];

for (const { file, path } of sources) {
  try {
    const data = JSON.parse(readFileSync(join(root, file), 'utf-8'));
    let value = data;
    for (const key of path) {
      value = value[key];
    }
    versions.push({ file, version: value });
  } catch (err) {
    console.error(`ERROR: Cannot read ${file}: ${err.message}`);
    process.exit(1);
  }
}

const unique = new Set(versions.map(v => v.version));

if (unique.size === 1) {
  console.log(`OK: All versions match (${[...unique][0]})`);
  for (const { file, version } of versions) {
    console.log(`  ${file}: ${version}`);
  }
} else {
  console.error('MISMATCH: Version strings differ across files:');
  for (const { file, version } of versions) {
    console.error(`  ${file}: ${version}`);
  }
  process.exit(1);
}
