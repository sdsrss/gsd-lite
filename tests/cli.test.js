import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runCli(args, home) {
  return execFileSync('node', ['cli.js', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
  });
}

describe('cli', () => {
  it('prints help', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gsd-cli-help-'));
    try {
      const output = runCli(['help'], home);
      assert.match(output, /Usage:/);
      assert.match(output, /gsd uninstall/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('installs and uninstalls through the cli', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gsd-cli-'));
    const claudeDir = join(home, '.claude');
    try {
      await mkdir(claudeDir, { recursive: true });
      runCli(['install'], home);
      const settings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf-8'));
      assert.ok(settings.mcpServers.gsd);
      await stat(join(claudeDir, 'gsd', 'src', 'server.js'));

      runCli(['uninstall'], home);
      const after = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf-8'));
      assert.equal(after.mcpServers?.gsd, undefined);
      await assert.rejects(stat(join(claudeDir, 'gsd')));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  // R-26: cover the remaining dispatch arms (--help/-h aliases, unknown, update, serve).
  it('--help and -h are aliases for help', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gsd-cli-h-'));
    try {
      for (const flag of ['--help', '-h']) {
        assert.match(runCli([flag], home), /Usage:/, `${flag} should print usage`);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('an unknown command prints an error, usage, and exits 1', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gsd-cli-bad-'));
    try {
      const r = spawnSync('node', ['cli.js', 'bogus-command'], {
        cwd: process.cwd(), env: { ...process.env, HOME: home }, encoding: 'utf-8',
      });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Unknown command: bogus-command/);
      assert.match(r.stdout, /Usage:/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('update runs the update check and exits 0 (dev-mode short-circuits)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gsd-cli-upd-'));
    try {
      const r = spawnSync('node', ['cli.js', 'update'], {
        cwd: process.cwd(), env: { ...process.env, HOME: home }, encoding: 'utf-8', timeout: 20000,
      });
      assert.equal(r.status, 0, `update should exit 0: ${r.stderr}`);
      assert.match(r.stdout, /Checking for updates/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('serve starts the MCP stdio server (spawn + terminate)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gsd-cli-serve-'));
    const child = spawn('node', ['cli.js', 'serve'], {
      cwd: process.cwd(), env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const state = await new Promise((resolve) => {
        let settled = false;
        child.on('exit', () => { settled = true; resolve('exited'); });
        setTimeout(() => { if (!settled) resolve('running'); }, 800);
      });
      assert.equal(state, 'running', 'serve should stay up, not exit immediately');
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.on('exit', resolve));
      await rm(home, { recursive: true, force: true });
    }
  });
});