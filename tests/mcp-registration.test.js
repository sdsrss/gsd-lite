// The npx/manual install registers its MCP server with Claude Code
// (`claude mcp add -s user`). Before 0.19.0 it wrote only settings.json, which
// Claude Code does not read MCP servers from, so an npx-only install never had
// the gsd tools. These tests run install.js and uninstall.js against the
// stand-in CLI the preload puts first on PATH (tests/fake-claude/claude), and
// the last one holds that stand-in against the real CLI where one is installed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_CLAUDE_DIR = join(PROJECT_ROOT, 'tests', 'fake-claude');

async function claudeHome(t, prefix = 'gsd-mcp-reg-') {
  const home = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(home, { recursive: true, force: true }));
  const claudeDir = join(home, '.claude');
  await mkdir(claudeDir, { recursive: true });
  return { home, claudeDir, serverPath: join(claudeDir, 'gsd', 'src', 'server.js') };
}

function run(script, { home, claudeDir }, { env = {}, args = [] } = {}) {
  const result = spawnSync(process.execPath, [join(PROJECT_ROOT, script), ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeDir, ...env },
    encoding: 'utf8',
    timeout: 90000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: `${result.stdout}${result.stderr}` };
}

async function userConfig(claudeDir) {
  try {
    return JSON.parse(await readFile(join(claudeDir, '.claude.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function claudeCalls(claudeDir) {
  try {
    return (await readFile(join(claudeDir, 'fake-claude-calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).argv);
  } catch {
    return [];
  }
}

async function settingsOf(claudeDir) {
  return JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'));
}

async function installAsPlugin(claudeDir) {
  await mkdir(join(claudeDir, 'plugins'), { recursive: true });
  await writeFile(join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'gsd@gsd': [{ version: '0.19.0' }] } }));
}

const FOREIGN = { type: 'stdio', command: 'npx', args: ['some-other-gsd'], env: {} };

// A PATH holding node and nothing else, so `claude` is not found anywhere.
async function pathWithoutClaude(t) {
  const bin = await mkdtemp(join(tmpdir(), 'gsd-mcp-nobin-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await symlink(process.execPath, join(bin, 'node'));
  return bin;
}

describe('npx/manual install: MCP server registration', { timeout: 180000 }, () => {
  it('registers the server at user scope, once', async (t) => {
    const ctx = await claudeHome(t);
    const first = run('install.js', ctx);
    assert.equal(first.status, 0, first.output);
    assert.match(first.stdout, /MCP server registered with Claude Code \(user scope\)/);
    assert.deepEqual(await claudeCalls(ctx.claudeDir), [['mcp', 'add', '-s', 'user', 'gsd', '--', 'node', ctx.serverPath]]);
    assert.deepEqual((await userConfig(ctx.claudeDir)).mcpServers, { gsd: { type: 'stdio', command: 'node', args: [ctx.serverPath], env: {} } });
    assert.match(first.stdout, /installed successfully/);

    // Every update runs install.js again, often from a session with no
    // `claude` on PATH: a registration already there needs no call.
    const second = run('install.js', ctx, { env: { PATH: await pathWithoutClaude(t) } });
    assert.equal(second.status, 0, second.output);
    assert.match(second.stdout, /MCP server already registered with Claude Code/);
    assert.equal((await claudeCalls(ctx.claudeDir)).length, 1, 'the second install called claude');
  });

  it('removes the settings.json registrations earlier installs wrote, and keeps everything else there', async (t) => {
    const ctx = await claudeHome(t);
    await writeFile(join(ctx.claudeDir, 'settings.json'), JSON.stringify({
      model: 'opus',
      mcpServers: {
        gsd: { command: 'node', args: [ctx.serverPath] },
        'gsd-lite': { command: 'node', args: ['/old/gsd-lite/server.js'] },
        other: { command: 'other-server' },
      },
    }));
    assert.equal(run('install.js', ctx).status, 0);
    const settings = await settingsOf(ctx.claudeDir);
    assert.deepEqual(settings.mcpServers, { other: { command: 'other-server' } });
    assert.equal(settings.model, 'opus');

    const alone = await claudeHome(t);
    await writeFile(join(alone.claudeDir, 'settings.json'), JSON.stringify({ mcpServers: { gsd: { command: 'node', args: [alone.serverPath] } } }));
    assert.equal(run('install.js', alone).status, 0);
    assert.equal('mcpServers' in await settingsOf(alone.claudeDir), false, 'an mcpServers object left empty is removed');
  });

  it('leaves a user-scope server named gsd that starts something else, and fails saying so', async (t) => {
    const ctx = await claudeHome(t);
    await writeFile(join(ctx.claudeDir, '.claude.json'), JSON.stringify({ mcpServers: { gsd: FOREIGN } }));
    const result = run('install.js', ctx);
    assert.equal(result.status, 1, result.output);
    assert.match(result.stdout, /MCP server NOT registered: a user-scope MCP server named "gsd" already exists .* it was left as it is/);
    assert.doesNotMatch(result.stdout, /installed successfully/);
    assert.deepEqual((await userConfig(ctx.claudeDir)).mcpServers, { gsd: FOREIGN });
    assert.deepEqual(await claudeCalls(ctx.claudeDir), [], 'claude was called over a registration that is not ours');
    // Everything else is installed: hooks keep working without the tools.
    assert.ok(existsSync(ctx.serverPath));
    assert.ok((await settingsOf(ctx.claudeDir)).hooks?.SessionStart, 'hooks were not registered');
  });

  it('with no claude on PATH: installs the rest, prints the command, says the server is not registered, exits 1', async (t) => {
    const ctx = await claudeHome(t);
    const result = run('install.js', ctx, { env: { PATH: await pathWithoutClaude(t) } });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stdout, /✗ MCP server NOT registered: `claude` was not found on PATH/);
    assert.match(result.stdout, /GSD-Lite is installed except for its MCP server/);
    assert.ok(result.stdout.includes(`claude mcp add -s user gsd -- node ${ctx.serverPath}`), result.stdout);
    assert.doesNotMatch(result.stdout, /installed successfully/);
    // stderr is what the updater reports for an install that failed.
    assert.match(result.stderr, /MCP server not registered: `claude` was not found on PATH/);
    assert.ok(existsSync(ctx.serverPath), 'the runtime was not installed');
    assert.ok((await settingsOf(ctx.claudeDir)).hooks?.SessionStart, 'hooks were not registered');
    assert.equal((await userConfig(ctx.claudeDir)).mcpServers, undefined);
  });

  it('reports a failing `claude mcp add` the same way', async (t) => {
    const ctx = await claudeHome(t);
    const result = run('install.js', ctx, { env: { GSD_FAKE_CLAUDE_FAIL: 'add' } });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stdout, /✗ MCP server NOT registered: `claude mcp add` failed: fake claude: add failed on purpose/);
    assert.doesNotMatch(result.stdout, /installed successfully/);
  });

  // The installer reads the registration where the docs put it. Claude Code
  // can keep its config elsewhere (a legacy .config.json): then add refuses,
  // and that must be said rather than read as success.
  it('reports an add refused as "already exists" for a registration it did not see', async (t) => {
    const ctx = await claudeHome(t);
    const result = run('install.js', ctx, { env: { GSD_FAKE_CLAUDE_FAIL: 'add:exists' } });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stdout, /already exists, in a config this installer did not read; it was left as it is/);
    assert.ok(result.stdout.includes('claude mcp remove gsd -s user && claude mcp add -s user gsd -- node'), result.stdout);
  });

  it('a dry run calls nothing and says what it would run', async (t) => {
    const ctx = await claudeHome(t);
    const result = run('install.js', ctx, { args: ['--dry-run'] });
    assert.equal(result.status, 0, result.output);
    assert.ok(result.stdout.includes(`Would register the MCP server with Claude Code: claude mcp add -s user gsd -- node ${ctx.serverPath}`), result.stdout);
    assert.deepEqual(await claudeCalls(ctx.claudeDir), []);
  });
});

describe('plugin install and uninstall: the registration goes', { timeout: 180000 }, () => {
  it('beside the plugin, this install\'s registration is removed and nothing is added', async (t) => {
    const ctx = await claudeHome(t);
    assert.equal(run('install.js', ctx).status, 0, 'premise: an npx install registered the server');
    await installAsPlugin(ctx.claudeDir);
    const result = run('install.js', ctx);
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /Removed the user-scope MCP registration \(the plugin serves the MCP server\)/);
    assert.deepEqual((await userConfig(ctx.claudeDir)).mcpServers, {});
    assert.deepEqual((await claudeCalls(ctx.claudeDir)).map((argv) => argv[1]), ['add', 'remove']);
  });

  it('beside the plugin, a registration that is not this install\'s stays', async (t) => {
    const ctx = await claudeHome(t);
    await installAsPlugin(ctx.claudeDir);
    await writeFile(join(ctx.claudeDir, '.claude.json'), JSON.stringify({ mcpServers: { gsd: FOREIGN } }));
    const result = run('install.js', ctx);
    assert.equal(result.status, 0, result.output);
    assert.deepEqual((await userConfig(ctx.claudeDir)).mcpServers, { gsd: FOREIGN });
    assert.deepEqual(await claudeCalls(ctx.claudeDir), []);
  });

  it('uninstall removes this install\'s registration', async (t) => {
    const ctx = await claudeHome(t);
    assert.equal(run('install.js', ctx).status, 0);
    const result = run('uninstall.js', ctx);
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /MCP server deregistered from Claude Code \(user scope\)/);
    assert.deepEqual((await userConfig(ctx.claudeDir)).mcpServers, {});
  });

  it('uninstall leaves a registration that is not this install\'s', async (t) => {
    const ctx = await claudeHome(t);
    await writeFile(join(ctx.claudeDir, '.claude.json'), JSON.stringify({ mcpServers: { gsd: FOREIGN } }));
    run('install.js', ctx);
    const result = run('uninstall.js', ctx);
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /A user-scope MCP server named gsd starts something else; left as it is/);
    assert.deepEqual((await userConfig(ctx.claudeDir)).mcpServers, { gsd: FOREIGN });
    assert.deepEqual(await claudeCalls(ctx.claudeDir), []);
  });

  it('uninstall with no claude on PATH says the registration is left and how to remove it, exit 1', async (t) => {
    const ctx = await claudeHome(t);
    assert.equal(run('install.js', ctx).status, 0);
    const result = run('uninstall.js', ctx, { env: { PATH: await pathWithoutClaude(t) } });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stdout, /Could not deregister the MCP server: `claude` was not found on PATH/);
    assert.match(result.stdout, /Remove it by running: claude mcp remove gsd -s user/);
    assert.doesNotMatch(result.stdout, /✓ GSD-Lite uninstalled/);
  });
});

// The stand-in above models the real CLI: where it writes, the entry's shape,
// the exit codes. This holds the model against the real thing, through a
// symlinked config directory, and has Claude Code itself start the server
// (`claude mcp list` health-checks every server it lists). CI has no claude,
// so it runs where one is installed.
function realClaude() {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir || resolve(dir) === FAKE_CLAUDE_DIR) continue;
    const candidate = join(dir, 'claude');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* next */ }
  }
  return null;
}

describe('against the real claude CLI', { timeout: 180000 }, () => {
  it('install registers a server Claude Code connects to, a second install sees it, uninstall removes it', async (t) => {
    const claude = realClaude();
    if (!claude) {
      t.skip('no claude CLI on PATH');
      return;
    }
    const root = await mkdtemp(join(tmpdir(), 'gsd-mcp-real-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'real-home', '.claude'), { recursive: true });
    await symlink(join(root, 'real-home'), join(root, 'home'), 'dir');
    const ctx = { home: join(root, 'home'), claudeDir: join(root, 'home', '.claude') };
    assert.ok(realpathSync(ctx.claudeDir).startsWith(realpathSync(tmpdir())), 'premise: a throwaway config, never the real one');
    const PATH = (process.env.PATH || '').split(delimiter).filter((dir) => resolve(dir) !== FAKE_CLAUDE_DIR).join(delimiter);
    const env = { PATH };
    const list = () => spawnSync(claude, ['mcp', 'list'], {
      cwd: root,
      env: { ...process.env, PATH, HOME: ctx.home, CLAUDE_CONFIG_DIR: ctx.claudeDir },
      encoding: 'utf8',
      timeout: 60000,
    }).stdout;

    const first = run('install.js', ctx, { env });
    assert.equal(first.status, 0, first.output);
    assert.match(first.stdout, /MCP server registered with Claude Code \(user scope\)/);
    const serverPath = join(ctx.claudeDir, 'gsd', 'src', 'server.js');
    assert.ok(list().includes(`gsd: node ${serverPath} - ✔ Connected`), 'claude mcp list does not show the server connected');

    const second = run('install.js', ctx, { env });
    assert.equal(second.status, 0, second.output);
    assert.match(second.stdout, /MCP server already registered/, 'the installer did not read the registration the real CLI wrote');

    const removed = run('uninstall.js', ctx, { env });
    assert.equal(removed.status, 0, removed.output);
    assert.doesNotMatch(list(), /^gsd:/m);
  });
});
