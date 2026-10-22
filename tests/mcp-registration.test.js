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
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_CLAUDE_DIR = join(PROJECT_ROOT, 'tests', 'fake-claude');
const { userConfigPath } = createRequire(import.meta.url)('../hooks/lib/mcp-registration.cjs');

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

// The PATH without every directory that holds a `claude` (this machine keeps
// node beside it, so node is linked in on its own), so `claude` is not found
// while tar and the rest still are.
async function pathWithoutClaude(t) {
  const bin = await mkdtemp(join(tmpdir(), 'gsd-mcp-nobin-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await symlink(process.execPath, join(bin, 'node'));
  const rest = (process.env.PATH || '').split(delimiter).filter((dir) => dir && !existsSync(join(dir, 'claude')));
  return [bin, ...rest].join(delimiter);
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
    assert.match(result.stdout, /MCP server NOT registered: a user-scope MCP server named "gsd" already exists .* it is left as it is/);
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
    // One command per step: PowerShell 5.1 has no `&&`.
    assert.match(result.stdout, /to replace it, run claude mcp remove gsd -s user first/);
    assert.ok(result.stdout.includes(`    claude mcp add -s user gsd -- node ${ctx.serverPath}`), result.stdout);
  });

  it('a dry run calls nothing and says what it would run', async (t) => {
    const ctx = await claudeHome(t);
    const result = run('install.js', ctx, { args: ['--dry-run'] });
    assert.equal(result.status, 0, result.output);
    assert.ok(result.stdout.includes(`Would register the MCP server with Claude Code: claude mcp add -s user gsd -- node ${ctx.serverPath}`), result.stdout);
    assert.match(result.stdout, /\[dry-run\] Nothing was changed\./);
    assert.doesNotMatch(result.stdout, /installed successfully/);
    assert.deepEqual(await claudeCalls(ctx.claudeDir), []);
  });

  // A dry run predicts the real run, which fails here.
  it('a dry run over a user-scope gsd that is not ours says the install would fail, and exits 1', async (t) => {
    const ctx = await claudeHome(t);
    await writeFile(join(ctx.claudeDir, '.claude.json'), JSON.stringify({ mcpServers: { gsd: FOREIGN } }));
    await writeFile(join(ctx.claudeDir, 'settings.json'), JSON.stringify({ mcpServers: { gsd: { command: 'node', args: [ctx.serverPath] } } }));
    const result = run('install.js', ctx, { args: ['--dry-run'] });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stdout, /\[dry-run\] ✗ MCP server would NOT be registered: a user-scope MCP server named "gsd" already exists/);
    assert.match(result.stdout, /\[dry-run\] Would remove the settings\.json MCP entry/);
    assert.doesNotMatch(result.stdout, /installed successfully/);
    assert.deepEqual(await claudeCalls(ctx.claudeDir), []);
  });

  // Claude Code keeps its config in <config dir>/.config.json when that file
  // is non-empty (a layout older installs still have), and `claude mcp add`
  // writes there. Read from .claude.json alone, every install after the first
  // failed with "already exists" while the server was connected, and every
  // session said it was not registered (pre-tag review).
  it('a config kept in the legacy .config.json is read where the CLI writes it', async (t) => {
    const ctx = await claudeHome(t);
    await writeFile(join(ctx.claudeDir, '.config.json'), JSON.stringify({ numStartups: 4 }));
    assert.equal(run('install.js', ctx).status, 0);
    assert.deepEqual(JSON.parse(await readFile(join(ctx.claudeDir, '.config.json'), 'utf8')).mcpServers?.gsd?.args, [ctx.serverPath], 'premise: the CLI wrote the legacy file');
    const second = run('install.js', ctx, { env: { PATH: await pathWithoutClaude(t) } });
    assert.equal(second.status, 0, second.output);
    assert.match(second.stdout, /MCP server already registered/);
    assert.doesNotMatch(sessionStart(ctx), NOT_REGISTERED);
    const removed = run('uninstall.js', ctx);
    assert.equal(removed.status, 0, removed.output);
    assert.deepEqual(JSON.parse(await readFile(join(ctx.claudeDir, '.config.json'), 'utf8')).mcpServers, {});
  });

  // `claude mcp add` resets a config it cannot parse (backing it up), and one
  // it cannot read it overwrites with only the new server, the user's other
  // servers and settings gone (Claude Code 2.1.308, delta review). The
  // installer does not know whose registration is in there either, so it
  // leaves the file to the user, as uninstall does.
  const UNREADABLE = [
    ['not JSON', (file) => writeFile(file, '{ not json')],
    ['empty', (file) => writeFile(file, '')],
    ['unreadable', async (file) => {
      await writeFile(file, JSON.stringify({ mcpServers: { other: FOREIGN }, oauthAccount: { id: 'x' } }));
      await chmod(file, 0);
    }],
  ];
  for (const [label, prepare] of UNREADABLE) {
    it(`a config it cannot read (${label}) is left as it is, with no claude call, and the install fails saying so`, async (t) => {
      if (label === 'unreadable' && process.getuid?.() === 0) {
        t.skip('root reads a file whatever its mode');
        return;
      }
      const ctx = await claudeHome(t);
      const file = join(ctx.claudeDir, '.claude.json');
      await prepare(file);
      const result = run('install.js', ctx);
      const dry = run('install.js', ctx, { args: ['--dry-run'] });
      await chmod(file, 0o600);
      const after = await readFile(file, 'utf8');
      assert.equal(result.status, 1, result.output);
      assert.ok(result.stdout.includes(`MCP server NOT registered: ${file} could not be read or parsed`), result.stdout);
      assert.ok(result.stdout.includes(`    claude mcp add -s user gsd -- node ${ctx.serverPath}`), result.stdout);
      assert.deepEqual(await claudeCalls(ctx.claudeDir), [], 'claude was called over a config the installer could not read');
      await prepare(join(ctx.home, 'expected'));
      await chmod(join(ctx.home, 'expected'), 0o600);
      assert.equal(after, await readFile(join(ctx.home, 'expected'), 'utf8'), 'the config changed');
      assert.equal(dry.status, 1, dry.output);
      assert.match(dry.stdout, /\[dry-run\] ✗ MCP server would NOT be registered: .* could not be read or parsed/);
    });
  }

  it('beside the plugin, a dry run over a config it cannot read says so, as the install does', async (t) => {
    const ctx = await claudeHome(t);
    await installAsPlugin(ctx.claudeDir);
    await writeFile(join(ctx.claudeDir, '.claude.json'), '{ not json');
    const real = run('install.js', ctx);
    assert.match(real.stdout, /! Could not read .*\.claude\.json/, 'premise: the install says so');
    const dry = run('install.js', ctx, { args: ['--dry-run'] });
    assert.match(dry.stdout, /\[dry-run\] ! Could not read .*\.claude\.json/);
  });

  // The CLI names its config .claude-custom-oauth.json while
  // CLAUDE_CODE_CUSTOM_OAUTH_URL is set. Read from .claude.json, every install
  // after the first failed with "already exists", every session said the
  // server was missing while it was connected, and uninstall left it
  // registered (delta review, with the real CLI).
  it('with CLAUDE_CODE_CUSTOM_OAUTH_URL set, the registration is read where the CLI writes it', async (t) => {
    const ctx = await claudeHome(t);
    const env = { CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://oauth.invalid' };
    assert.equal(run('install.js', ctx, { env }).status, 0);
    const file = join(ctx.claudeDir, '.claude-custom-oauth.json');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).mcpServers?.gsd?.args, [ctx.serverPath], 'premise: the CLI wrote the suffixed file');
    const second = run('install.js', ctx, { env });
    assert.equal(second.status, 0, second.output);
    assert.match(second.stdout, /MCP server already registered/);
    assert.doesNotMatch(sessionStart(ctx, env), NOT_REGISTERED);
    assert.equal(run('uninstall.js', ctx, { env }).status, 0);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).mcpServers, {});
  });

  // The CLI normalizes the config directory's name to NFC for the legacy
  // file only. On a filesystem that keeps names as written (Linux), a
  // directory named in NFD then has no legacy file the CLI can see.
  it('reads the legacy file under the NFC spelling of the config directory, as the CLI does', { skip: process.platform !== 'linux' && 'needs a filesystem that keeps NFD names apart' }, async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'gsd-mcp-nfd-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const claudeDir = join(home, 'cafe\u0301');
    await mkdir(claudeDir);
    await writeFile(join(claudeDir, '.config.json'), JSON.stringify({ numStartups: 4 }));
    assert.equal(userConfigPath({ CLAUDE_CONFIG_DIR: claudeDir }), join(claudeDir, '.claude.json'));
    const nfc = join(home, 'caf\u00e9');
    await mkdir(nfc);
    await writeFile(join(nfc, '.config.json'), JSON.stringify({ numStartups: 4 }));
    assert.equal(userConfigPath({ CLAUDE_CONFIG_DIR: claudeDir }), join(nfc, '.config.json'), 'the CLI reads the NFC spelling');
  });

  it('the stand-in claude refuses a config outside the temp dir', () => {
    const result = spawnSync(join(FAKE_CLAUDE_DIR, 'claude'), ['mcp', 'add', '-s', 'user', 'gsd', '--', 'node', '/x'], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: '/nonexistent-gsd-fake-claude-check', HOME: '/nonexistent-gsd-fake-claude-check' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /refusing a config outside/);
  });
});

// The npx install's SessionStart hook, as Claude Code runs it after install.js
// copied it into <config>/hooks. PLUGIN_AUTO_UPDATE=1 keeps it from starting
// the updater, which would write under the temp home while it is removed.
function sessionStart({ home, claudeDir }, env = {}) {
  const result = spawnSync(process.execPath, [join(claudeDir, 'hooks', 'gsd-session-init.cjs')], {
    cwd: home,
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeDir, PLUGIN_AUTO_UPDATE: '1', ...env },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result.stdout;
}

const NOT_REGISTERED = /GSD-Lite \(tell the user\): its MCP server is not registered with Claude Code/;

// An install the updater runs cannot report a failed registration through its
// exit code: the updater reads any failure as "update failed, still on the old
// version", while the new version is already in place, and its next check
// finds it up to date. So that install exits 0 and the SessionStart hook says
// it, every session, until the server is registered.
describe('a registration the install could not make is reported every session', { timeout: 180000 }, () => {
  it('run by the updater, the install exits 0, and each session start names the reason and the command', async (t) => {
    const ctx = await claudeHome(t);
    const result = run('install.js', ctx, { env: { PATH: await pathWithoutClaude(t), PLUGIN_AUTO_UPDATE: '1' } });
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /✗ MCP server NOT registered/);
    for (let session = 0; session < 2; session++) {
      const said = sessionStart(ctx);
      assert.match(said, NOT_REGISTERED);
      assert.match(said, /`claude` was not found on PATH/);
      assert.ok(said.includes(`claude mcp add -s user gsd -- node ${ctx.serverPath}`), said);
    }
  });

  it('an install that registers the server stops the report', async (t) => {
    const ctx = await claudeHome(t);
    run('install.js', ctx, { env: { GSD_FAKE_CLAUDE_FAIL: 'add' } });
    assert.match(sessionStart(ctx), NOT_REGISTERED, 'premise: reported');
    assert.equal(run('install.js', ctx).status, 0);
    assert.doesNotMatch(sessionStart(ctx), NOT_REGISTERED);
  });

  it('a registration made by hand since stops the report, and its record is cleared', async (t) => {
    const ctx = await claudeHome(t);
    run('install.js', ctx, { env: { GSD_FAKE_CLAUDE_FAIL: 'add' } });
    const marker = join(ctx.claudeDir, 'gsd', '.mcp-unregistered.json');
    assert.ok(existsSync(marker), 'premise: the failure was recorded');
    // The printed command, run by the user.
    spawnSync('claude', ['mcp', 'add', '-s', 'user', 'gsd', '--', 'node', ctx.serverPath], { env: { ...process.env, HOME: ctx.home, CLAUDE_CONFIG_DIR: ctx.claudeDir } });
    assert.doesNotMatch(sessionStart(ctx), NOT_REGISTERED);
    assert.equal(existsSync(marker), false);
  });

  // Checked every session, not only after a failure the install saw: a
  // registration removed since, or one an install cut off before it got there.
  it('a registration missing for any reason is reported, with the command', async (t) => {
    const ctx = await claudeHome(t);
    assert.equal(run('install.js', ctx).status, 0);
    assert.doesNotMatch(sessionStart(ctx), NOT_REGISTERED, 'premise: registered');
    spawnSync('claude', ['mcp', 'remove', 'gsd', '-s', 'user'], { env: { ...process.env, HOME: ctx.home, CLAUDE_CONFIG_DIR: ctx.claudeDir } });
    const said = sessionStart(ctx);
    assert.match(said, NOT_REGISTERED);
    assert.match(said, /has no registration of it/);
    assert.ok(said.includes(`claude mcp add -s user gsd -- node ${ctx.serverPath}`), said);
  });

  it('the reported command keeps a path in any letters', async (t) => {
    const ctx = await claudeHome(t, 'gsd-mcp-josé-');
    run('install.js', ctx, { env: { GSD_FAKE_CLAUDE_FAIL: 'add' } });
    const said = sessionStart(ctx);
    assert.ok(said.includes(ctx.serverPath), said);
  });

  // Pasted into a shell, the command registers this install's server. The
  // line's sanitizer dropped # $ [ ] ! and the rest from it: the command then
  // registered another path, which the installer refused to replace.
  it('the reported command, run in a shell, registers this install\'s server whatever its path holds', async (t) => {
    const ctx = await claudeHome(t, "gsd-mcp-a#b $x [1] !c 'q' ü-");
    run('install.js', ctx, { env: { GSD_FAKE_CLAUDE_FAIL: 'add' } });
    const command = sessionStart(ctx).match(/To register it, run `(.+)` in a shell, then restart/)?.[1];
    assert.ok(command, 'premise: the line names a command');
    const ran = spawnSync('sh', ['-c', command], { env: { ...process.env, HOME: ctx.home, CLAUDE_CONFIG_DIR: ctx.claudeDir }, encoding: 'utf8' });
    assert.equal(ran.status, 0, `${command}\n${ran.stderr}`);
    assert.deepEqual((await userConfig(ctx.claudeDir)).mcpServers?.gsd?.args, [ctx.serverPath]);
    assert.doesNotMatch(sessionStart(ctx), NOT_REGISTERED);
  });

  // An empty or unparseable config says nothing about the registration, but
  // an install that recorded its failure has: silent there, the one install
  // that knew it failed was never reported (delta review).
  it('a failure the install recorded is reported even while the config cannot be read', async (t) => {
    const ctx = await claudeHome(t);
    await writeFile(join(ctx.claudeDir, '.config.json'), '');
    const result = run('install.js', ctx, { env: { PATH: await pathWithoutClaude(t), PLUGIN_AUTO_UPDATE: '1' } });
    assert.match(result.stdout, /✗ MCP server NOT registered/, 'premise: the install failed');
    assert.match(sessionStart(ctx), NOT_REGISTERED);
  });

  // The reason is what is wrong now: a reason recorded before a server of
  // that name started something else sent the user to a command that fails.
  it('a server named gsd that starts something else is reported as that, over an older recorded reason', async (t) => {
    const ctx = await claudeHome(t);
    run('install.js', ctx, { env: { PATH: await pathWithoutClaude(t), PLUGIN_AUTO_UPDATE: '1' } });
    assert.match(sessionStart(ctx), /`claude` was not found on PATH/, 'premise: the recorded reason');
    await writeFile(join(ctx.claudeDir, '.claude.json'), JSON.stringify({ mcpServers: { gsd: FOREIGN } }));
    const said = sessionStart(ctx);
    assert.match(said, NOT_REGISTERED);
    assert.match(said, /starts something else/);
    assert.match(said, /claude mcp remove gsd -s user/);
    assert.doesNotMatch(said, /was not found on PATH/);
  });

  it('beside the plugin nothing is reported: the plugin serves the server', async (t) => {
    const ctx = await claudeHome(t);
    run('install.js', ctx, { env: { GSD_FAKE_CLAUDE_FAIL: 'add' } });
    await installAsPlugin(ctx.claudeDir);
    assert.equal(run('install.js', ctx).status, 0);
    assert.equal(existsSync(join(ctx.claudeDir, 'gsd', '.mcp-unregistered.json')), false);
  });

  // The whole path: the real updater installing a release where no `claude`
  // is on PATH. It used to read the install's exit 1 as a failed update.
  it('the updater counts such an install as installed, and the next session reports the registration', async (t) => {
    const ctx = await claudeHome(t);
    const pkg = join(ctx.home, 'release', 'gsd-lite-9.9.9');
    for (const entry of ['install.js', 'uninstall.js', 'package.json', 'package-lock.json', 'src', 'hooks', 'commands', 'agents', 'workflows', 'references']) {
      await cp(join(PROJECT_ROOT, entry), join(pkg, entry), { recursive: true });
    }
    await mkdir(join(pkg, 'node_modules'));
    const tarball = join(ctx.home, 'release.tar.gz');
    assert.equal(spawnSync('tar', ['czf', tarball, '-C', join(ctx.home, 'release'), 'gsd-lite-9.9.9']).status, 0);
    const bytes = await readFile(tarball);

    const saved = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, HOME: process.env.HOME };
    t.after(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
    Object.assign(process.env, { PATH: await pathWithoutClaude(t), CLAUDE_CONFIG_DIR: ctx.claudeDir, HOME: ctx.home });
    const req = createRequire(import.meta.url);
    const source = join(PROJECT_ROOT, 'hooks', 'gsd-auto-update.cjs');
    delete req.cache[req.resolve(source)];
    t.after(() => { delete req.cache[req.resolve(source)]; });
    const ok = await req(source).downloadAndInstall('https://codeload.github.com/sdsrss/gsd-lite/tar.gz/refs/tags/v9.9.9', false, null, {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      }),
    });
    Object.assign(process.env, saved);
    assert.equal(ok, true, 'the updater read an installed release as a failed update');
    assert.ok(existsSync(ctx.serverPath), 'premise: the release was installed');
    assert.match(sessionStart(ctx), NOT_REGISTERED);
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

  // Whose registration it is was decided after the runtime was deleted, when
  // a path registered through a symlinked spelling no longer resolves to it.
  it('uninstall removes a registration made through a symlinked spelling of the config dir', async (t) => {
    const ctx = await claudeHome(t);
    const linked = join(ctx.home, 'linked-home');
    await symlink(ctx.home, linked, 'dir');
    const viaLink = { home: linked, claudeDir: join(linked, '.claude') };
    assert.equal(run('install.js', viaLink).status, 0);
    assert.match(run('install.js', ctx).stdout, /MCP server already registered/, 'premise: the same server under either spelling');
    const result = run('uninstall.js', ctx);
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /MCP server deregistered from Claude Code/);
    assert.deepEqual((await userConfig(ctx.claudeDir)).mcpServers, {});
  });

  it('uninstall that cannot read the config says so, and exits 1', async (t) => {
    const ctx = await claudeHome(t);
    assert.equal(run('install.js', ctx).status, 0);
    await writeFile(join(ctx.claudeDir, '.claude.json'), '{ not json');
    const result = run('uninstall.js', ctx);
    assert.equal(result.status, 1, result.output);
    assert.match(result.stdout, /Could not read .*\.claude\.json to check for the MCP server registration/);
    assert.match(result.stdout, /If `claude mcp list` still shows gsd, remove it with: claude mcp remove gsd -s user/);
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

describe('against the real claude CLI', { timeout: 360000 }, () => {
  // The config layouts the CLI writes user scope to: .claude.json, the legacy
  // <config dir>/.config.json when that is non-empty, .claude-custom-oauth.json
  // while CLAUDE_CODE_CUSTOM_OAUTH_URL is set, and .claude.json again beside a
  // legacy file in a directory named in NFD, which the CLI does not see.
  const LAYOUTS = ['.claude.json', 'legacy .config.json', 'custom OAuth', ...(process.platform === 'linux' ? ['legacy .config.json, NFD name'] : [])];
  for (const layout of LAYOUTS) {
    it(`install registers a server Claude Code connects to, a second install sees it, no session reports it missing, uninstall removes it (${layout})`, async (t) => {
      const claude = realClaude();
      if (!claude) {
        t.skip('no claude CLI on PATH');
        return;
      }
      const root = await mkdtemp(join(tmpdir(), 'gsd-mcp-real-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const configName = layout.includes('NFD') ? '.claude\u0301' : '.claude';
      await mkdir(join(root, 'real-home', configName), { recursive: true });
      await symlink(join(root, 'real-home'), join(root, 'home'), 'dir');
      const ctx = { home: join(root, 'home'), claudeDir: join(root, 'home', configName) };
      assert.ok(realpathSync(ctx.claudeDir).startsWith(realpathSync(tmpdir())), 'premise: a throwaway config, never the real one');
      if (layout.startsWith('legacy')) await writeFile(join(ctx.claudeDir, '.config.json'), JSON.stringify({ numStartups: 4 }));
      const PATH = (process.env.PATH || '').split(delimiter).filter((dir) => resolve(dir) !== FAKE_CLAUDE_DIR).join(delimiter);
      const env = { PATH, ...(layout === 'custom OAuth' ? { CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://oauth.invalid' } : {}) };
      const list = () => spawnSync(claude, ['mcp', 'list'], {
        cwd: root,
        env: { ...process.env, ...env, HOME: ctx.home, CLAUDE_CONFIG_DIR: ctx.claudeDir },
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
      assert.doesNotMatch(sessionStart(ctx, env), NOT_REGISTERED);

      const removed = run('uninstall.js', ctx, { env });
      assert.equal(removed.status, 0, removed.output);
      assert.doesNotMatch(list(), /^gsd:/m);
    });
  }
});
