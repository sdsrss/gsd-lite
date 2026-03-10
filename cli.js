#!/usr/bin/env node

import { main as install } from './install.js';
import { main as uninstall } from './uninstall.js';

function printHelp() {
  console.log(`GSD-Lite CLI

Usage:
  gsd-lite install [--dry-run]
  gsd-lite uninstall
  gsd-lite help

Default command:
  gsd-lite            # same as install
`);
}

const [command = 'install'] = process.argv.slice(2);

switch (command) {
  case 'install':
    install();
    break;
  case 'uninstall':
    uninstall();
    break;
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exitCode = 1;
}