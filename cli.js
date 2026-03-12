#!/usr/bin/env node

function printHelp() {
  console.log(`GSD-Lite — AI orchestration tool for Claude Code

Usage:
  gsd              # Start MCP stdio server (default)
  gsd serve        # Start MCP stdio server (explicit)
  gsd install      # Install hooks/commands into Claude Code
  gsd uninstall    # Remove hooks/commands from Claude Code
  gsd update       # Check for updates and install if available
  gsd help         # Show this help
`);
}

const [command] = process.argv.slice(2);

switch (command) {
  case undefined:
  case 'serve': {
    const { main } = await import('./src/server.js');
    main().catch(console.error);
    break;
  }
  case 'install': {
    const { main: install } = await import('./install.js');
    install();
    break;
  }
  case 'uninstall': {
    const { main: uninstall } = await import('./uninstall.js');
    uninstall();
    break;
  }
  case 'update': {
    const { checkForUpdate } = await import('./hooks/gsd-auto-update.cjs');
    const force = process.argv.includes('--force');
    console.log('Checking for updates...');
    const result = await checkForUpdate({ force, verbose: true, install: true });
    if (result?.updated) {
      console.log(`\n✓ Updated: v${result.from} → v${result.to}`);
    } else if (result?.updateAvailable) {
      console.log(`\n! Update available v${result.to} but install failed. Try manually.`);
    } else if (!result) {
      console.log('✓ Already up to date');
    }
    break;
  }
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
