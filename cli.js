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
    const { checkForUpdate, describeUpdateOutcome } = await import('./hooks/gsd-auto-update.cjs');
    const force = process.argv.includes('--force');
    console.log('Checking for updates...');
    // verbose: true means checkForUpdate prints the outcome of the check itself
    // ("Already up to date", "Could not fetch latest release", "Throttled — …").
    // Only add a line for what that output does not cover.
    const result = await checkForUpdate({ force, verbose: true, install: true });
    const line = describeUpdateOutcome(result);
    if (line) console.log(line);
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
