#!/usr/bin/env node
// Auto-install dependencies and start MCP server
// Used by plugin system where npm install is not run during /plugin install

import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!existsSync(join(__dirname, 'node_modules', '@modelcontextprotocol'))) {
  try {
    execSync('npm install --omit=dev --ignore-scripts', {
      cwd: __dirname,
      stdio: 'pipe',
      timeout: 60000,
    });
  } catch (err) {
    console.error('Failed to install dependencies:', err.stderr?.toString() || err.message);
    process.exit(1);
  }
}

const { main } = await import('./src/server.js');
await main();
