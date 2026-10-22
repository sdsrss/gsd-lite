#!/usr/bin/env node
// The npx/manual install's MCP server registration, shared by install.js and
// uninstall.js.
//
// Claude Code reads MCP servers from its own config (`claude mcp add` writes
// user scope to the top-level `mcpServers` of ~/.claude.json), not from
// settings.json — its docs say settings.json carries no MCP server
// definitions. Every install before 0.19.0 registered the server only in
// settings.json, so an npx-only install never had the gsd tools.
//
// Only Claude Code's own CLI writes that file. It is live state every running
// session rewrites, and where it lives is Claude Code's decision: 2.1.308
// reads <config dir>/.config.json first when that is a non-empty file, and
// otherwise `${CLAUDE_CONFIG_DIR || home}/.claude<suffix>.json`. Writing it here
// would mean re-implementing that resolution and racing every session.
//
// It is READ here, at the location the docs give, and only as a hint: "this
// install's server is already registered" saves a CLI call (the updater runs
// install.js on every release, often with no `claude` on its PATH). A wrong
// read errs loudly: `claude mcp add` then refuses with "already exists" and
// the installer says so, instead of something being changed silently.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVER_NAME = 'gsd';

function userConfigPath(env = process.env) {
  return env.CLAUDE_CONFIG_DIR
    ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(os.homedir(), '.claude.json');
}

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a === b) return true;
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * The user-scope registration named `gsd`, as far as the documented config
 * file shows it: 'ours' when it starts this install's server, 'other' when a
 * server of that name starts something else, 'absent' when the file has none
 * by that name, 'unknown' when the file cannot be read or parsed.
 */
function userRegistration(serverPath, env = process.env) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(userConfigPath(env), 'utf8'));
  } catch {
    return 'unknown';
  }
  const entry = config?.mcpServers?.[SERVER_NAME];
  if (entry === undefined) return 'absent';
  return Array.isArray(entry?.args) && samePath(entry.args[0], serverPath) ? 'ours' : 'other';
}

/**
 * The command a user can paste to do by hand what `args` would have done.
 * POSIX quoting; on Windows a path holds no double quote, so double quotes do.
 */
function shellCommand(args) {
  const quote = process.platform === 'win32'
    ? (arg) => (/^[\w./:@=-]+$/.test(arg) ? arg : `"${arg}"`)
    : (arg) => (/^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
  return ['claude', ...args].map(quote).join(' ');
}

function addArgs(serverPath) {
  return ['mcp', 'add', '-s', 'user', SERVER_NAME, '--', 'node', serverPath];
}

function removeArgs() {
  return ['mcp', 'remove', SERVER_NAME, '-s', 'user'];
}

/**
 * Run the `claude` CLI found on PATH. On Windows it may be claude.cmd (an npm
 * global install), which only a shell can start; each argument is quoted for
 * cmd.exe then. Never throws.
 */
function runClaude(args, env = process.env) {
  const win = process.platform === 'win32';
  const run = spawnSync('claude', win ? args.map((arg) => `"${arg}"`) : args, {
    env,
    encoding: 'utf8',
    timeout: 30000,
    shell: win,
    windowsHide: true,
  });
  const output = `${run.stderr || ''}${run.stdout || ''}`.trim();
  if (run.error?.code === 'ENOENT') return { ok: false, missing: true, output: '`claude` was not found on PATH' };
  if (run.error) return { ok: false, missing: false, output: run.error.message };
  // A shell reports a missing command as an exit status, not as ENOENT.
  if (win && run.status === 1 && /not recognized as an internal or external command/i.test(output)) {
    return { ok: false, missing: true, output: '`claude` was not found on PATH' };
  }
  return { ok: run.status === 0, missing: false, output };
}

/**
 * Make sure user scope has this install's server registered.
 *
 * @returns {{ status: 'already'|'registered'|'failed', reason?: string, command: string }}
 *   command is what the user can run by hand when status is 'failed'.
 */
function registerMcpServer(serverPath, env = process.env) {
  const command = shellCommand(addArgs(serverPath));
  const found = userRegistration(serverPath, env);
  if (found === 'ours') return { status: 'already', command };
  if (found === 'other') {
    return {
      status: 'failed',
      reason: `a user-scope MCP server named "${SERVER_NAME}" already exists in ${userConfigPath(env)} and it does not start ${serverPath}; it was left as it is`,
      command: `${shellCommand(removeArgs())} && ${command}`,
    };
  }
  const run = runClaude(addArgs(serverPath), env);
  if (run.ok) return { status: 'registered', command };
  if (/already exists/i.test(run.output)) {
    return {
      status: 'failed',
      reason: `\`claude mcp add\` says a user-scope server named "${SERVER_NAME}" already exists, in a config this installer did not read; it was left as it is (\`claude mcp get ${SERVER_NAME}\` shows what it starts)`,
      command: `${shellCommand(removeArgs())} && ${command}`,
    };
  }
  return { status: 'failed', reason: run.missing ? run.output : `\`claude mcp add\` failed: ${run.output || 'no output'}`, command };
}

/**
 * Remove this install's user-scope registration, and nothing that is not
 * this install's.
 *
 * @returns {{ status: 'removed'|'absent'|'other'|'unknown'|'failed', reason?: string, command: string }}
 */
function unregisterMcpServer(serverPath, env = process.env) {
  const command = shellCommand(removeArgs());
  const found = userRegistration(serverPath, env);
  if (found !== 'ours') return { status: found, command };
  const run = runClaude(removeArgs(), env);
  if (run.ok) return { status: 'removed', command };
  return { status: 'failed', reason: run.missing ? run.output : `\`claude mcp remove\` failed: ${run.output || 'no output'}`, command };
}

module.exports = { SERVER_NAME, registerMcpServer, unregisterMcpServer, userConfigPath, userRegistration };
