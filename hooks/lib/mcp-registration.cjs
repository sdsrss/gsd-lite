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
// session rewrites, so writing it here would race every session.
//
// It is READ here, only to tell whose registration is there: "this install's
// server is already registered" saves a CLI call (the updater runs install.js
// on every release, often with no `claude` on its PATH), and "a server of that
// name starts something else" keeps install and uninstall off it. The file is
// the one the CLI writes (userConfigPath). Read from anywhere else, every
// install after the first failed with "already exists" and every session said
// the server was not registered while it was connected (pre-tag review).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVER_NAME = 'gsd';

/**
 * The file `claude mcp add -s user` writes, as Claude Code 2.1.308 picks it:
 * <config dir>/.config.json (the legacy name; the directory's name normalized
 * to NFC) when that is a non-empty file, or an empty writable one with no
 * .claude.json to go with it; otherwise `${CLAUDE_CONFIG_DIR || home}/.claude.json`,
 * the one the docs name, which is .claude-custom-oauth.json while
 * CLAUDE_CODE_CUSTOM_OAUTH_URL is set. Read off its binary and checked against
 * its writes, with and without CLAUDE_CONFIG_DIR; tests/mcp-registration.test.js
 * holds it against the real CLI in each layout. The CLI has no command that
 * says which file it uses.
 */
function userConfigPath(env = process.env) {
  const name = `.claude${env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? '-custom-oauth' : ''}.json`;
  const modern = path.join(env.CLAUDE_CONFIG_DIR || os.homedir(), name);
  const legacy = path.join((env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')).normalize('NFC'), '.config.json');
  try {
    const stat = fs.statSync(legacy);
    if (stat.isFile() && (stat.size > 0 || ((stat.mode & 0o222) !== 0 && !fs.existsSync(modern)))) return legacy;
  } catch { /* no legacy file */ }
  return modern;
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
 * The user-scope registration named `gsd`, as the CLI's config file shows it:
 * 'ours' when it starts this install's server, 'other' when a server of that
 * name starts something else, 'absent' when there is none by that name (or no
 * file yet), 'unknown' when the file is there and cannot be read or parsed.
 */
function userRegistration(serverPath, env = process.env) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(userConfigPath(env), 'utf8'));
  } catch (err) {
    return err.code === 'ENOENT' ? 'absent' : 'unknown';
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
    // Inside the updater's 60 s budget for the whole install.
    timeout: 20000,
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
 * What registerMcpServer does, as far as the config file says without running
 * anything: 'already', 'failed' when it leaves the registration to the user,
 * or 'add' when it asks the CLI. A dry run reports this.
 *
 * @returns {{ status: 'already'|'failed'|'add', reason?: string, command: string }}
 */
function registrationPlan(serverPath, env = process.env) {
  const command = shellCommand(addArgs(serverPath));
  const found = userRegistration(serverPath, env);
  if (found === 'ours') return { status: 'already', command };
  // Replacing someone else's server is the user's decision: the reason says
  // how (one command per step, as PowerShell 5.1 has no `&&`).
  if (found === 'other') {
    return {
      status: 'failed',
      reason: `a user-scope MCP server named "${SERVER_NAME}" already exists in ${userConfigPath(env)} and it does not start ${serverPath}; it is left as it is (to replace it, run ${shellCommand(removeArgs())} first)`,
      command,
    };
  }
  // Nor is a config this cannot read: whose registration is in it is unknown,
  // and `claude mcp add` resets one it cannot parse and overwrites one it
  // cannot read with only the new server (2.1.308, delta review).
  if (found === 'unknown') {
    return { status: 'failed', reason: `${userConfigPath(env)} could not be read or parsed, so it is left as it is`, command };
  }
  return { status: 'add', command };
}

/**
 * Make sure user scope has this install's server registered.
 *
 * @returns {{ status: 'already'|'registered'|'failed', reason?: string, command: string }}
 *   command is what the user can run by hand when status is 'failed'.
 */
function registerMcpServer(serverPath, env = process.env) {
  const plan = registrationPlan(serverPath, env);
  if (plan.status !== 'add') return plan;
  const { command } = plan;
  const run = runClaude(addArgs(serverPath), env);
  if (run.ok) return { status: 'registered', command };
  if (/already exists/i.test(run.output)) {
    return {
      status: 'failed',
      reason: `\`claude mcp add\` says a user-scope server named "${SERVER_NAME}" already exists, in a config this installer did not read; it was left as it is (\`claude mcp get ${SERVER_NAME}\` shows what it starts; to replace it, run ${shellCommand(removeArgs())} first)`,
      command,
    };
  }
  return { status: 'failed', reason: run.missing ? run.output : `\`claude mcp add\` failed: ${run.output || 'no output'}`, command };
}

/**
 * Remove this install's user-scope registration, and nothing that is not
 * this install's.
 *
 * @returns {{ status: 'removed'|'absent'|'other'|'unknown'|'failed', reason?: string, command: string, file: string }}
 *   file is the config file read, for an 'unknown' to name.
 */
function unregisterMcpServer(serverPath, env = process.env) {
  const command = shellCommand(removeArgs());
  const file = userConfigPath(env);
  const found = userRegistration(serverPath, env);
  if (found !== 'ours') return { status: found, command, file };
  const run = runClaude(removeArgs(), env);
  if (run.ok) return { status: 'removed', command, file };
  return { status: 'failed', reason: run.missing ? run.output : `\`claude mcp remove\` failed: ${run.output || 'no output'}`, command, file };
}

/**
 * Where a registration that failed is recorded, so the npx install's
 * SessionStart hook can say so every session until it is fixed. An install
 * the updater runs cannot report it through its exit code: the updater reads
 * any non-zero exit as "update failed, still on the old version" while the
 * new version is already in place, and its next check finds it up to date.
 */
function unregisteredMarkerPath(runtimeDir) {
  return path.join(runtimeDir, '.mcp-unregistered.json');
}

function recordFailedRegistration(runtimeDir, failure) {
  fs.writeFileSync(unregisteredMarkerPath(runtimeDir), `${JSON.stringify({ reason: failure.reason, command: failure.command }, null, 2)}\n`);
}

/** The command that registers this install's server, for a user to run. */
function registerCommand(serverPath) {
  return shellCommand(addArgs(serverPath));
}

/** The command that removes the user-scope server named gsd, for a user to run. */
function removeCommand() {
  return shellCommand(removeArgs());
}

module.exports = { SERVER_NAME, recordFailedRegistration, registerCommand, registerMcpServer, registrationPlan, removeCommand, unregisterMcpServer, unregisteredMarkerPath, userConfigPath, userRegistration };
