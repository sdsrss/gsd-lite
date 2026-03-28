import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cpSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SOURCE = join(import.meta.dirname, '..', 'hooks', 'gsd-auto-update.cjs');
const LIB_DIR = join(import.meta.dirname, '..', 'hooks', 'lib');
const require = createRequire(import.meta.url);

async function loadAutoUpdate(mode, version = '0.3.0') {
  const root = await mkdtemp(join(tmpdir(), 'gsd-auto-update-'));
  const home = join(root, 'home');
  const claudeDir = join(home, '.claude');
  await mkdir(claudeDir, { recursive: true });

  let modulePath;
  if (mode === 'plugin') {
    const pluginRoot = join(root, 'plugin-root');
    await mkdir(join(pluginRoot, 'hooks', 'lib'), { recursive: true });
    cpSync(SOURCE, join(pluginRoot, 'hooks', 'gsd-auto-update.cjs'));
    cpSync(LIB_DIR, join(pluginRoot, 'hooks', 'lib'), { recursive: true });
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: 'gsd-lite', version }) + '\n');
    modulePath = join(pluginRoot, 'hooks', 'gsd-auto-update.cjs');
  } else {
    await mkdir(join(claudeDir, 'hooks', 'lib'), { recursive: true });
    await mkdir(join(claudeDir, 'gsd'), { recursive: true });
    cpSync(SOURCE, join(claudeDir, 'hooks', 'gsd-auto-update.cjs'));
    cpSync(LIB_DIR, join(claudeDir, 'hooks', 'lib'), { recursive: true });
    await writeFile(join(claudeDir, 'gsd', 'package.json'), JSON.stringify({ name: 'gsd-lite', version }) + '\n');
    modulePath = join(claudeDir, 'hooks', 'gsd-auto-update.cjs');
  }

  const prevHome = process.env.HOME;
  const prevClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  const prevAuto = process.env.PLUGIN_AUTO_UPDATE;
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.PLUGIN_AUTO_UPDATE;

  return {
    claudeDir,
    mod: require(modulePath),
    async cleanup() {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevClaudeDir;
      if (prevAuto === undefined) delete process.env.PLUGIN_AUTO_UPDATE; else process.env.PLUGIN_AUTO_UPDATE = prevAuto;
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function writeState(claudeDir, state) {
  const statePath = join(claudeDir, 'gsd', 'runtime', 'update-state.json');
  await mkdir(join(claudeDir, 'gsd', 'runtime'), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
}

async function readState(claudeDir) {
  return JSON.parse(await readFile(join(claudeDir, 'gsd', 'runtime', 'update-state.json'), 'utf8'));
}

describe('auto update install modes', () => {
  it('plugin mode reports update availability without auto-installing', async () => {
    const ctx = await loadAutoUpdate('plugin');
    let installCalled = false;
    try {
      const result = await ctx.mod.checkForUpdate({
        force: true,
        install: true,
        notify: true,
        fetchLatestRelease: async () => ({ version: '0.3.1', tarballUrl: 'https://example.test/release.tgz' }),
        downloadAndInstall: async () => { installCalled = true; return true; },
      });

      assert.equal(ctx.mod.getInstallMode(), 'plugin');
      assert.equal(installCalled, false);
      assert.equal(result.updateAvailable, true);
      assert.equal(result.autoInstallSupported, false);
      assert.equal(result.action, 'plugin_update');

      const notification = JSON.parse(await readFile(join(ctx.claudeDir, 'gsd', 'runtime', 'update-notification.json'), 'utf8'));
      assert.equal(notification.kind, 'available');
      assert.equal(notification.action, 'plugin_update');
    } finally {
      await ctx.cleanup();
    }
  });

  it('manual mode still auto-installs and writes success notification', async () => {
    const ctx = await loadAutoUpdate('manual');
    let installCalled = false;
    try {
      const result = await ctx.mod.checkForUpdate({
        force: true,
        install: true,
        notify: true,
        fetchLatestRelease: async () => ({ version: '0.3.1', tarballUrl: 'https://example.test/release.tgz' }),
        downloadAndInstall: async () => { installCalled = true; return true; },
      });

      assert.equal(ctx.mod.getInstallMode(), 'manual');
      assert.equal(installCalled, true);
      assert.equal(result.updated, true);

      const notification = JSON.parse(await readFile(join(ctx.claudeDir, 'gsd', 'runtime', 'update-notification.json'), 'utf8'));
      assert.equal(notification.kind, 'updated');
      assert.equal(notification.to, '0.3.1');
    } finally {
      await ctx.cleanup();
    }
  });

  it('returns cached update result when throttled', async () => {
    const ctx = await loadAutoUpdate('manual');
    let fetchCalls = 0;
    try {
      await writeState(ctx.claudeDir, {
        lastCheck: new Date().toISOString(),
        latestVersion: '0.3.2',
        updateAvailable: true,
      });

      const result = await ctx.mod.checkForUpdate({
        install: false,
        fetchLatestRelease: async () => { fetchCalls += 1; return null; },
      });

      assert.equal(fetchCalls, 0);
      assert.equal(result.updateAvailable, true);
      assert.equal(result.to, '0.3.2');
      assert.equal(result.from, '0.3.0');
    } finally {
      await ctx.cleanup();
    }
  });

  it('clears stale updateAvailable flag when already up to date', async () => {
    const ctx = await loadAutoUpdate('manual');
    try {
      await writeState(ctx.claudeDir, {
        lastCheck: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        latestVersion: '0.3.2',
        updateAvailable: true,
      });

      const result = await ctx.mod.checkForUpdate({
        install: false,
        fetchLatestRelease: async () => ({ version: '0.3.0', tarballUrl: 'https://example.test/release.tgz' }),
      });

      assert.equal(result, null);
      const state = await readState(ctx.claudeDir);
      assert.equal(state.latestVersion, '0.3.0');
      assert.equal(state.updateAvailable, false);
    } finally {
      await ctx.cleanup();
    }
  });

  it('uses longer throttle window after rate limit', async () => {
    const ctx = await loadAutoUpdate('manual');
    try {
      assert.equal(ctx.mod.shouldCheck({
        lastCheck: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        rateLimited: false,
      }), false);
      assert.equal(ctx.mod.shouldCheck({
        lastCheck: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        rateLimited: false,
      }), true);
      assert.equal(ctx.mod.shouldCheck({
        lastCheck: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        rateLimited: true,
      }), false);
      assert.equal(ctx.mod.shouldCheck({
        lastCheck: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
        rateLimited: true,
      }), true);
    } finally {
      await ctx.cleanup();
    }
  });

  it('serializes concurrent update checks with a lock', async () => {
    const ctx = await loadAutoUpdate('manual');
    let fetchCalls = 0;
    try {
      const fetchLatestRelease = async () => {
        fetchCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { version: '0.3.1', tarballUrl: 'https://example.test/release.tgz' };
      };

      const [first, second] = await Promise.all([
        ctx.mod.checkForUpdate({ install: false, notify: false, fetchLatestRelease }),
        ctx.mod.checkForUpdate({ install: false, notify: false, fetchLatestRelease }),
      ]);

      assert.equal(fetchCalls, 1);
      assert.equal(first?.to, '0.3.1');
      assert.equal(second?.to, '0.3.1');
      const state = await readState(ctx.claudeDir);
      assert.equal(state.updateAvailable, true);
      assert.equal(state.latestVersion, '0.3.1');
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('validateExtractedPackage', () => {
  it('accepts valid gsd-lite package.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gsd-validate-'));
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'gsd-lite', version: '0.4.0' }));
      await writeFile(join(dir, 'install.js'), '// installer stub');
      const ctx = await loadAutoUpdate('manual');
      try {
        const result = ctx.mod.validateExtractedPackage(dir);
        assert.equal(result, true);
      } finally {
        await ctx.cleanup();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects package with wrong name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gsd-validate-'));
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'malicious-pkg', version: '0.4.0' }));
      const ctx = await loadAutoUpdate('manual');
      try {
        const result = ctx.mod.validateExtractedPackage(dir);
        assert.equal(result, false);
      } finally {
        await ctx.cleanup();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects package with missing version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gsd-validate-'));
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'gsd-lite' }));
      const ctx = await loadAutoUpdate('manual');
      try {
        const result = ctx.mod.validateExtractedPackage(dir);
        assert.equal(result, false);
      } finally {
        await ctx.cleanup();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects package with invalid version format', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gsd-validate-'));
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'gsd-lite', version: 'not-a-version' }));
      const ctx = await loadAutoUpdate('manual');
      try {
        const result = ctx.mod.validateExtractedPackage(dir);
        assert.equal(result, false);
      } finally {
        await ctx.cleanup();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects when package.json is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gsd-validate-'));
    try {
      const ctx = await loadAutoUpdate('manual');
      try {
        const result = ctx.mod.validateExtractedPackage(dir);
        assert.equal(result, false);
      } finally {
        await ctx.cleanup();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts version with prerelease suffix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gsd-validate-'));
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'gsd-lite', version: '1.0.0-beta.1' }));
      await writeFile(join(dir, 'install.js'), '// installer stub');
      const ctx = await loadAutoUpdate('manual');
      try {
        const result = ctx.mod.validateExtractedPackage(dir);
        assert.equal(result, true);
      } finally {
        await ctx.cleanup();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects when install.js is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gsd-validate-'));
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'gsd-lite', version: '0.4.0' }));
      const ctx = await loadAutoUpdate('manual');
      try {
        const result = ctx.mod.validateExtractedPackage(dir);
        assert.equal(result, false);
      } finally {
        await ctx.cleanup();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('validateTarballUrl', () => {
  it('accepts valid github.com tarball URL', async () => {
    const ctx = await loadAutoUpdate('manual');
    try {
      assert.equal(ctx.mod.validateTarballUrl('https://github.com/sdsrss/gsd-lite/archive/refs/tags/v0.6.0.tar.gz'), true);
    } finally {
      await ctx.cleanup();
    }
  });

  it('accepts valid codeload.github.com URL', async () => {
    const ctx = await loadAutoUpdate('manual');
    try {
      assert.equal(ctx.mod.validateTarballUrl('https://codeload.github.com/sdsrss/gsd-lite/tar.gz/v0.6.0'), true);
    } finally {
      await ctx.cleanup();
    }
  });

  it('accepts valid objects.githubusercontent.com URL', async () => {
    const ctx = await loadAutoUpdate('manual');
    try {
      assert.equal(ctx.mod.validateTarballUrl('https://objects.githubusercontent.com/github-production-release-asset/12345'), true);
    } finally {
      await ctx.cleanup();
    }
  });

  it('accepts valid api.github.com URL', async () => {
    const ctx = await loadAutoUpdate('manual');
    try {
      assert.equal(ctx.mod.validateTarballUrl('https://api.github.com/repos/sdsrss/gsd-lite/tarball/v0.6.0'), true);
    } finally {
      await ctx.cleanup();
    }
  });

  it('rejects non-https protocol', async () => {
    const ctx = await loadAutoUpdate('manual');
    try {
      assert.equal(ctx.mod.validateTarballUrl('http://github.com/sdsrss/gsd-lite/archive/v0.6.0.tar.gz'), false);
    } finally {
      await ctx.cleanup();
    }
  });

  it('rejects unknown hostname', async () => {
    const ctx = await loadAutoUpdate('manual');
    try {
      assert.equal(ctx.mod.validateTarballUrl('https://evil.com/malicious.tar.gz'), false);
    } finally {
      await ctx.cleanup();
    }
  });

  it('rejects hostname that contains github.com as substring', async () => {
    const ctx = await loadAutoUpdate('manual');
    try {
      assert.equal(ctx.mod.validateTarballUrl('https://notgithub.com/path'), false);
    } finally {
      await ctx.cleanup();
    }
  });

  it('rejects invalid URL', async () => {
    const ctx = await loadAutoUpdate('manual');
    try {
      assert.equal(ctx.mod.validateTarballUrl('not-a-url'), false);
    } finally {
      await ctx.cleanup();
    }
  });

  it('rejects null/undefined/empty', async () => {
    const ctx = await loadAutoUpdate('manual');
    try {
      assert.equal(ctx.mod.validateTarballUrl(null), false);
      assert.equal(ctx.mod.validateTarballUrl(undefined), false);
      assert.equal(ctx.mod.validateTarballUrl(''), false);
    } finally {
      await ctx.cleanup();
    }
  });
});