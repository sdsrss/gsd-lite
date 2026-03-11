import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
});