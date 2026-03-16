import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SESSION_INIT = join(import.meta.dirname, '..', 'hooks', 'gsd-session-init.cjs');
const STATUSLINE = join(import.meta.dirname, '..', 'hooks', 'gsd-statusline.cjs');
const AUTO_UPDATE = join(import.meta.dirname, '..', 'hooks', 'gsd-auto-update.cjs');

describe('session init update notifications', () => {
  it('shows plugin update notification and clears it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-session-init-'));
    const home = join(root, 'home');
    const claudeDir = join(home, '.claude');
    const pluginRoot = join(root, 'plugin-root');
    const notifPath = join(claudeDir, 'gsd', 'runtime', 'update-notification.json');

    try {
      await mkdir(join(pluginRoot, 'hooks'), { recursive: true });
      await mkdir(join(claudeDir, 'gsd', 'runtime'), { recursive: true });
      cpSync(SESSION_INIT, join(pluginRoot, 'hooks', 'gsd-session-init.cjs'));
      cpSync(STATUSLINE, join(pluginRoot, 'hooks', 'gsd-statusline.cjs'));
      cpSync(AUTO_UPDATE, join(pluginRoot, 'hooks', 'gsd-auto-update.cjs'));
      await writeFile(notifPath, JSON.stringify({
        kind: 'available',
        from: '0.3.0',
        to: '0.3.1',
        action: 'plugin_update',
      }) + '\n');

      const output = execFileSync(process.execPath, [join(pluginRoot, 'hooks', 'gsd-session-init.cjs')], {
        env: { ...process.env, HOME: home, PLUGIN_AUTO_UPDATE: '1' },
        encoding: 'utf8',
        timeout: 5000,
      });

      assert.match(output, /Run \/plugin update gsd/);
      assert.equal(existsSync(notifPath), false);

      const settings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'));
      assert.deepEqual(settings.statusLine, {
        type: 'command',
        command: `node ${JSON.stringify(join(pluginRoot, 'hooks', 'gsd-statusline.cjs'))}`,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});