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
      const runtimePackagePath = join(claudeDir, 'gsd-lite', 'package.json');
      // StatusLine is registered as top-level statusLine setting
      assert.deepEqual(settings.statusLine, {
        type: 'command',
        command: `node ${JSON.stringify(hookPath)} statusLine`,
      });
      assert.equal(settings.hooks.StatusLine, undefined);
      // PostToolUse is registered as array entry in hooks
      assert.ok(Array.isArray(settings.hooks.PostToolUse));
      const gsdHook = settings.hooks.PostToolUse.find(e =>
        e.hooks?.some(h => h.command?.includes('context-monitor.js')));
      assert.ok(gsdHook);
      assert.equal(gsdHook.hooks[0].command, `node ${JSON.stringify(hookPath)} postToolUse`);
      assert.ok(settings.mcpServers['gsd-lite']);
      assert.equal(settings.mcpServers['gsd-lite'].args[0], serverPath);
      const hookStat = await stat(hookPath);
      const serverStat = await stat(serverPath);
      const sdkStat = await stat(sdkPath);
      const runtimePackageStat = await stat(runtimePackagePath);
      assert.ok(hookStat.isFile());
      assert.ok(serverStat.isFile());
      assert.ok(sdkStat.isDirectory());
      assert.ok(runtimePackageStat.isFile());
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('preserves existing non-gsd hooks during install', async () => {
    const { home, claudeDir } = await makeClaudeHome('gsd-install-existing-');
    try {
      await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({
        statusLine: { type: 'command', command: 'node /custom/status.js' },
        hooks: {
          PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node /custom/post.js' }] }],
        },
      }, null, 2));
      runScript('install.js', home);
      const settings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf-8'));
      // Non-GSD statusLine preserved
      assert.equal(settings.statusLine.command, 'node /custom/status.js');
      // Non-GSD PostToolUse entry preserved, GSD entry added
      const customHook = settings.hooks.PostToolUse.find(e =>
        e.hooks?.some(h => h.command === 'node /custom/post.js'));
      assert.ok(customHook);
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
      assert.equal(settings.statusLine, undefined);
      const gsdHook = settings.hooks?.PostToolUse?.find(e =>
        e.hooks?.some(h => h.command?.includes('context-monitor.js')));
      assert.equal(gsdHook, undefined);
      await assert.rejects(stat(join(claudeDir, 'gsd-lite')));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});