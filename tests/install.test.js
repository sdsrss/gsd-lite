import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function makeClaudeHome(prefix) {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const claudeDir = join(home, '.claude');
  await mkdir(claudeDir, { recursive: true });
  return { home, claudeDir };
}

function runScript(script, home) {
  execFileSync('node', [script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
  });
}

describe('install and uninstall scripts', () => {
  it('registers hooks against the copied hook file', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-install-');
    try {
      runScript('install.js', home);
      const settings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf-8'));
      const hookPath = join(claudeDir, 'hooks', 'context-monitor.js');
      const serverPath = join(claudeDir, 'gsd-lite', 'src', 'server.js');
      const sdkPath = join(claudeDir, 'gsd-lite', 'node_modules', '@modelcontextprotocol', 'sdk');
      assert.equal(settings.hooks.StatusLine, `node ${JSON.stringify(hookPath)} statusLine`);
      assert.equal(settings.hooks.PostToolUse, `node ${JSON.stringify(hookPath)} postToolUse`);
      assert.ok(settings.mcpServers['gsd-lite']);
      assert.equal(settings.mcpServers['gsd-lite'].args[0], serverPath);
      const hookStat = await stat(hookPath);
      const serverStat = await stat(serverPath);
      const sdkStat = await stat(sdkPath);
      assert.ok(hookStat.isFile());
      assert.ok(serverStat.isFile());
      assert.ok(sdkStat.isDirectory());
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('preserves existing non-gsd hooks during install', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-install-existing-');
    try {
      await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({
        hooks: {
          StatusLine: 'node /custom/status.js',
          PostToolUse: 'node /custom/post.js',
        },
      }, null, 2));
      runScript('install.js', home);
      const settings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf-8'));
      assert.equal(settings.hooks.StatusLine, 'node /custom/status.js');
      assert.equal(settings.hooks.PostToolUse, 'node /custom/post.js');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('removes managed hooks during uninstall', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-uninstall-');
    try {
      runScript('install.js', home);
      runScript('uninstall.js', home);
      const settings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf-8'));
      assert.equal(settings.mcpServers?.['gsd-lite'], undefined);
      assert.equal(settings.hooks?.StatusLine, undefined);
      assert.equal(settings.hooks?.PostToolUse, undefined);
      await assert.rejects(stat(join(claudeDir, 'gsd-lite')));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});