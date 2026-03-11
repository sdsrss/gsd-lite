#!/usr/bin/env node

function printHelp() {
  console.log(`GSD-Lite — AI orchestration tool for Claude Code

Usage:
  gsd              # Start MCP stdio server (default)
  gsd serve        # Start MCP stdio server (explicit)
  gsd install      # Install hooks/commands into Claude Code
  gsd uninstall    # Remove hooks/commands from Claude Code
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
