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

// R-11 (audit M9): drive the REAL module (not a copy) so integrity + install
// paths get genuine coverage. GSD_TEST_PLUGIN_ROOT + CLAUDE_CONFIG_DIR redirect
// all writes into temp dirs; a cache-busting require gives each test a fresh
// module bound to those temp paths.
describe('auto-update — R-11 integrity verification (real-module E2E)', () => {
  const req = createRequire(import.meta.url);
  const { createHash } = req('node:crypto');
  const { spawnSync } = req('node:child_process');

  const INSTALL_MARKER = 'require("node:fs").writeFileSync(process.env.GSD_TEST_MARKER, "installed");\n';
  const TARBALL_URL = 'https://codeload.github.com/sdsrss/gsd-lite/tar.gz/refs/tags/v9.9.9';

  async function buildFixtureTarball(rootDir, version = '9.9.9') {
    const pkgDirName = `gsd-lite-${version}`;
    const pkgDir = join(rootDir, pkgDirName);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: 'gsd-lite', version }) + '\n');
    await writeFile(join(pkgDir, 'install.js'), INSTALL_MARKER);
    const tarballPath = join(rootDir, 'release.tar.gz');
    const r = spawnSync('tar', ['czf', tarballPath, '-C', rootDir, pkgDirName]);
    assert.equal(r.status, 0, `tar create failed: ${r.stderr}`);
    const bytes = await readFile(tarballPath);
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  const makeFetchImpl = (bytes, over = {}) => async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ...over,
  });

  const markerWritten = async (p) => readFile(p, 'utf8').then(() => true).catch(() => false);

  async function withRealModule(fn) {
    const root = await mkdtemp(join(tmpdir(), 'gsd-r11-'));
    const claude = join(root, '.claude');
    const plugin = join(root, 'plugin');
    await mkdir(join(claude, 'gsd', 'runtime'), { recursive: true });
    await mkdir(plugin, { recursive: true });
    await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'gsd-lite', version: '0.3.0' }) + '\n');
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'gsd-fixture-'));
    const marker = join(fixtureRoot, 'MARKER');
    const saved = {
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      GSD_TEST_PLUGIN_ROOT: process.env.GSD_TEST_PLUGIN_ROOT,
      GSD_TEST_MARKER: process.env.GSD_TEST_MARKER,
      PLUGIN_AUTO_UPDATE: process.env.PLUGIN_AUTO_UPDATE,
    };
    process.env.CLAUDE_CONFIG_DIR = claude;
    process.env.GSD_TEST_PLUGIN_ROOT = plugin;
    process.env.GSD_TEST_MARKER = marker;
    delete process.env.PLUGIN_AUTO_UPDATE;
    delete req.cache[req.resolve(SOURCE)];
    try {
      const mod = req(SOURCE);
      await fn(mod, fixtureRoot, marker, { claudeDir: claude });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      delete req.cache[req.resolve(SOURCE)];
      await rm(root, { recursive: true, force: true });
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }

  // R-11b: Ed25519 signing. Sign with a TEST keypair and inject its public key
  // (the module's embedded RELEASE_PUBLIC_KEY pairs with the CI-only secret).
  const { generateKeyPairSync, sign: edSign } = req('node:crypto');
  const { publicKey: testPub, privateKey: testPriv } = generateKeyPairSync('ed25519');
  const testPubPem = testPub.export({ type: 'spki', format: 'pem' });
  const signSha = (shaHex) => edSign(null, Buffer.from(shaHex, 'utf8'), testPriv).toString('base64');

  it('installs when a required Ed25519 signature is valid (R-11b)', async () => {
    await withRealModule(async (mod, root, marker) => {
      const { bytes, sha256 } = await buildFixtureTarball(root);
      const ok = await mod.downloadAndInstall(TARBALL_URL, true, null, {
        expectedChecksum: sha256,
        expectedSignature: signSha(sha256),
        requireSignature: true,
        publicKey: testPubPem,
        fetchImpl: makeFetchImpl(bytes),
      });
      assert.equal(ok, true, 'valid signature must install');
      assert.equal(await readFile(marker, 'utf8'), 'installed');
    });
  });

  it('rejects an invalid signature and does NOT run install.js (R-11b)', async () => {
    await withRealModule(async (mod, root, marker) => {
      const { bytes, sha256 } = await buildFixtureTarball(root);
      const ok = await mod.downloadAndInstall(TARBALL_URL, true, null, {
        expectedChecksum: sha256,
        expectedSignature: signSha('0'.repeat(64)), // signature over a DIFFERENT hash
        requireSignature: true,
        publicKey: testPubPem,
        fetchImpl: makeFetchImpl(bytes),
      });
      assert.equal(ok, false, 'invalid signature must be rejected');
      assert.equal(await markerWritten(marker), false);
    });
  });

  it('fails closed when a signature is required but absent (anti-downgrade, R-11b)', async () => {
    await withRealModule(async (mod, root, marker) => {
      const { bytes, sha256 } = await buildFixtureTarball(root);
      const ok = await mod.downloadAndInstall(TARBALL_URL, true, null, {
        expectedChecksum: sha256,
        expectedSignature: null,
        requireSignature: true,
        publicKey: testPubPem,
        fetchImpl: makeFetchImpl(bytes),
      });
      assert.equal(ok, false, 'a required-but-missing signature must abort');
      assert.equal(await markerWritten(marker), false);
    });
  });

  it('verifyReleaseSignature accepts good, rejects bad/missing/malformed (R-11b)', async () => {
    await withRealModule(async (mod) => {
      const sha = 'a'.repeat(64);
      assert.equal(mod.verifyReleaseSignature(sha, signSha(sha), testPubPem), true);
      assert.equal(mod.verifyReleaseSignature(sha, signSha('b'.repeat(64)), testPubPem), false, 'wrong-message signature');
      assert.equal(mod.verifyReleaseSignature(sha, null, testPubPem), false, 'missing signature');
      assert.equal(mod.verifyReleaseSignature(sha, 'not!base64', testPubPem), false, 'malformed signature');
      assert.equal(mod.verifyReleaseSignature('', signSha(sha), testPubPem), false, 'missing hash');
    });
  });

  it('MIN_SIGNED_VERSION gates the anti-downgrade signature requirement (R-11b)', async () => {
    await withRealModule(async (mod) => {
      // checkForUpdate derives requireSignature = compareVersions(latest, MIN) >= 0,
      // so any release at/after MIN_SIGNED_VERSION must verify a signature (a
      // stripped/absent one then fails closed — see the required-but-absent test).
      assert.ok(mod.compareVersions(mod.MIN_SIGNED_VERSION, mod.MIN_SIGNED_VERSION) >= 0, 'MIN itself requires a signature');
      assert.ok(mod.compareVersions('99.0.0', mod.MIN_SIGNED_VERSION) >= 0, 'a newer version requires a signature');
      assert.ok(mod.compareVersions('0.8.2', mod.MIN_SIGNED_VERSION) < 0, 'a pre-signing version does not');
    });
  });

  it('requiresSignature gates on the prerelease-stripped core, blocking a prerelease-strip downgrade (R-11b)', async () => {
    await withRealModule(async (mod) => {
      // A prerelease of MIN (e.g. 0.8.3-rc.1) sorts BELOW 0.8.3 per semver, so a
      // raw `compareVersions(latest, MIN) >= 0` gate would leave it UNSIGNED-OK.
      // Since 0.8.3-rc.1 is still a valid "update" for any pre-0.8.3 client, a
      // MITM forging the API JSON could present an unsigned 0.8.3-rc.1 and bypass
      // verification. Gating on the core (0.8.3) closes that window.
      assert.equal(mod.requiresSignature('0.8.3'), true, 'MIN itself requires a signature');
      assert.equal(mod.requiresSignature('0.8.3-rc.1'), true, 'a prerelease of MIN still requires a signature');
      assert.equal(mod.requiresSignature('0.8.3-0'), true, 'any prerelease tag of MIN requires a signature');
      assert.equal(mod.requiresSignature('v0.8.3-rc.1'), true, 'a v-prefixed prerelease of MIN requires a signature');
      assert.equal(mod.requiresSignature('0.9.0-rc.1'), true, 'a prerelease above MIN requires a signature');
      assert.equal(mod.requiresSignature('0.8.2'), false, 'a pre-signing version does not');
      assert.equal(mod.requiresSignature('0.8.2-rc.9'), false, 'a prerelease below MIN does not');
    });
  });

  it('installs a legitimate tarball whose checksum matches, running install.js', async () => {
    await withRealModule(async (mod, root, marker) => {
      const { bytes, sha256 } = await buildFixtureTarball(root);
      const ok = await mod.downloadAndInstall(TARBALL_URL, true, null, {
        expectedChecksum: sha256,
        fetchImpl: makeFetchImpl(bytes),
      });
      assert.equal(ok, true, 'legit install should succeed');
      assert.equal(await readFile(marker, 'utf8'), 'installed', 'install.js must have run');
    });
  });

  it('rejects a tampered checksum and does NOT run install.js', async () => {
    await withRealModule(async (mod, root, marker) => {
      const { bytes } = await buildFixtureTarball(root);
      const ok = await mod.downloadAndInstall(TARBALL_URL, true, null, {
        expectedChecksum: 'f'.repeat(64),
        fetchImpl: makeFetchImpl(bytes),
      });
      assert.equal(ok, false, 'tampered checksum must be rejected');
      assert.equal(await markerWritten(marker), false, 'install.js must NOT run on mismatch');
    });
  });

  it('rejects a truncated tarball (checksum over full bytes)', async () => {
    await withRealModule(async (mod, root, marker) => {
      const { bytes, sha256 } = await buildFixtureTarball(root);
      const truncated = bytes.subarray(0, Math.floor(bytes.length / 2));
      const ok = await mod.downloadAndInstall(TARBALL_URL, false, null, {
        expectedChecksum: sha256,
        fetchImpl: makeFetchImpl(truncated),
      });
      assert.equal(ok, false, 'truncated tarball must be rejected');
      assert.equal(await markerWritten(marker), false);
    });
  });

  it('proceeds without a checksum (legacy release) and still installs', async () => {
    await withRealModule(async (mod, root, marker) => {
      const { bytes } = await buildFixtureTarball(root);
      const ok = await mod.downloadAndInstall(TARBALL_URL, false, null, {
        expectedChecksum: null,
        fetchImpl: makeFetchImpl(bytes),
      });
      assert.equal(ok, true, 'legacy (no checksum) install should still succeed');
      assert.equal(await readFile(marker, 'utf8'), 'installed');
    });
  });

  it('rejects a non-allowlisted tarball host before downloading', async () => {
    await withRealModule(async (mod, root, marker) => {
      const { bytes, sha256 } = await buildFixtureTarball(root);
      let fetched = false;
      const ok = await mod.downloadAndInstall('https://evil.example.com/x.tar.gz', false, null, {
        expectedChecksum: sha256,
        fetchImpl: async () => { fetched = true; return makeFetchImpl(bytes)(); },
      });
      assert.equal(ok, false, 'bad host must be rejected');
      assert.equal(fetched, false, 'must not fetch from a non-allowlisted host');
      assert.equal(await markerWritten(marker), false);
    });
  });

  it('rejects an HTTP error response without running install.js', async () => {
    await withRealModule(async (mod, _root, marker) => {
      const ok = await mod.downloadAndInstall(TARBALL_URL, true, null, {
        expectedChecksum: null,
        fetchImpl: async () => ({ ok: false, status: 500, headers: { get: () => null } }),
      });
      assert.equal(ok, false, 'HTTP 500 must abort');
      assert.equal(await markerWritten(marker), false);
    });
  });

  it('rejects a tarball whose extracted package fails validation', async () => {
    await withRealModule(async (mod, root, marker) => {
      // Fixture with the wrong package name → validateExtractedPackage fails.
      const pkgDir = join(root, 'gsd-lite-9.9.9');
      await mkdir(pkgDir, { recursive: true });
      await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: 'not-gsd', version: '9.9.9' }) + '\n');
      await writeFile(join(pkgDir, 'install.js'), INSTALL_MARKER);
      const tarballPath = join(root, 'release.tar.gz');
      spawnSync('tar', ['czf', tarballPath, '-C', root, 'gsd-lite-9.9.9']);
      const bytes = await readFile(tarballPath);
      const ok = await mod.downloadAndInstall(TARBALL_URL, true, null, {
        expectedChecksum: null,
        fetchImpl: makeFetchImpl(bytes),
      });
      assert.equal(ok, false, 'invalid package must be rejected');
      assert.equal(await markerWritten(marker), false, 'install.js must NOT run for an invalid package');
    });
  });

  it('fetchLatestRelease parses a sha256 from the release body', async () => {
    await withRealModule(async (mod) => {
      const hash = 'a'.repeat(64);
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: true, status: 200,
        json: async () => ({
          tag_name: 'v9.9.9',
          tarball_url: TARBALL_URL,
          html_url: 'https://github.com/sdsrss/gsd-lite/releases/tag/v9.9.9',
          body: `Release notes\n\nsha256: ${hash}\n`,
        }),
      });
      try {
        const latest = await mod.fetchLatestRelease(null);
        assert.equal(latest.checksum, hash);
        assert.equal(latest.version, '9.9.9');
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  it('fetchLatestRelease returns null checksum when the body has none', async () => {
    await withRealModule(async (mod) => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: true, status: 200,
        json: async () => ({ tag_name: 'v9.9.9', tarball_url: TARBALL_URL, html_url: 'x', body: 'no checksum here' }),
      });
      try {
        const latest = await mod.fetchLatestRelease(null);
        assert.equal(latest.checksum, null);
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  it('fetchLatestRelease parses the Ed25519 signature from the release body (R-11b)', async () => {
    await withRealModule(async (mod) => {
      const hash = 'a'.repeat(64);
      const sig = 'A'.repeat(88);
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: true, status: 200,
        json: async () => ({ tag_name: 'v9.9.9', tarball_url: TARBALL_URL, html_url: 'x', body: `sha256: ${hash}\nsig: ${sig}\n`, assets: [] }),
      });
      try {
        const latest = await mod.fetchLatestRelease(null);
        assert.equal(latest.checksum, hash);
        assert.equal(latest.signature, sig);
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  it('fetchLatestRelease takes the LAST integrity block when a re-run appended a second (R-11b)', async () => {
    await withRealModule(async (mod) => {
      // action-gh-release appends on a workflow re-run, so a stale first block can
      // precede the fresh one that matches the re-packed asset. The client must
      // enforce the LAST pair, or the stale hash fails closed and breaks updates.
      const staleHash = 'a'.repeat(64);
      const staleSig = 'A'.repeat(88);
      const freshHash = 'b'.repeat(64);
      const freshSig = 'B'.repeat(88);
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: true, status: 200,
        json: async () => ({
          tag_name: 'v9.9.9', tarball_url: TARBALL_URL, html_url: 'x', assets: [],
          body: `notes\n\nsha256: ${staleHash}\nsig: ${staleSig}\n\n---\nsha256: ${freshHash}\nsig: ${freshSig}\n`,
        }),
      });
      try {
        const latest = await mod.fetchLatestRelease(null);
        assert.equal(latest.checksum, freshHash, 'must use the fresh (last) checksum');
        assert.equal(latest.signature, freshSig, 'must use the fresh (last) signature');
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  it('fetchLatestRelease rejects an over-long signature blob (bounded sig regex, R-11b)', async () => {
    await withRealModule(async (mod) => {
      const hash = 'c'.repeat(64);
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: true, status: 200,
        json: async () => ({
          tag_name: 'v9.9.9', tarball_url: TARBALL_URL, html_url: 'x', assets: [],
          body: `sha256: ${hash}\nsig: ${'A'.repeat(500)}\n`,
        }),
      });
      try {
        const latest = await mod.fetchLatestRelease(null);
        assert.equal(latest.signature, null, 'a 500-char blob exceeds the Ed25519 bound and is not captured');
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  it('fetchLatestRelease prefers the npm-pack asset over the source tarball (R-11)', async () => {
    await withRealModule(async (mod) => {
      const hash = 'b'.repeat(64);
      const assetUrl = 'https://github.com/sdsrss/gsd-lite/releases/download/v9.9.9/gsd-lite-9.9.9.tgz';
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: true, status: 200,
        json: async () => ({
          tag_name: 'v9.9.9',
          tarball_url: TARBALL_URL,
          html_url: 'x',
          body: `Release notes\n\nsha256: ${hash}\n`,
          assets: [
            { name: 'notes.txt', browser_download_url: 'https://github.com/sdsrss/gsd-lite/releases/download/v9.9.9/notes.txt' },
            { name: 'gsd-lite-9.9.9.tgz', browser_download_url: assetUrl },
          ],
        }),
      });
      try {
        const latest = await mod.fetchLatestRelease(null);
        assert.equal(latest.tarballUrl, assetUrl, 'must download the deterministic asset, not the source tarball');
        assert.equal(latest.checksum, hash);
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  it('fetchLatestRelease falls back to the source tarball for legacy releases without an asset (R-11)', async () => {
    await withRealModule(async (mod) => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: true, status: 200,
        json: async () => ({ tag_name: 'v9.9.9', tarball_url: TARBALL_URL, html_url: 'x', body: 'no asset', assets: [] }),
      });
      try {
        const latest = await mod.fetchLatestRelease(null);
        assert.equal(latest.tarballUrl, TARBALL_URL, 'legacy release falls back to source tarball');
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  const latestStub = (version = '9.9.9', checksum = null) => async () => ({
    version, tarballUrl: TARBALL_URL, releaseUrl: 'x', checksum,
  });

  it('checkForUpdate (check-only) reports an available update without installing', async () => {
    await withRealModule(async (mod) => {
      const res = await mod.checkForUpdate({
        force: true,
        install: false,
        fetchLatestRelease: latestStub('9.9.9'),
        getCurrentVersion: () => '0.3.0',
      });
      assert.equal(res.updateAvailable, true);
      assert.equal(res.to, '9.9.9');
    });
  });

  it('checkForUpdate returns null when already up to date', async () => {
    await withRealModule(async (mod) => {
      const res = await mod.checkForUpdate({
        force: true,
        install: false,
        fetchLatestRelease: latestStub('0.1.0'),
        getCurrentVersion: () => '0.3.0',
      });
      assert.equal(res, null);
    });
  });

  it('checkForUpdate in plugin mode surfaces a plugin_update action (no auto-download)', async () => {
    await withRealModule(async (mod) => {
      let downloaded = false;
      const res = await mod.checkForUpdate({
        force: true,
        install: true,
        fetchLatestRelease: latestStub('9.9.9'),
        getCurrentVersion: () => '0.3.0',
        downloadAndInstall: async () => { downloaded = true; return true; },
      });
      // Default temp layout resolves to plugin mode → manual install action, not auto-download.
      assert.equal(res.updateAvailable, true);
      assert.equal(res.action, 'plugin_update');
      assert.equal(downloaded, false, 'plugin mode must not auto-download');
    });
  });

  it('checkForUpdate handles a fetch failure gracefully (returns null)', async () => {
    await withRealModule(async (mod) => {
      const res = await mod.checkForUpdate({
        force: true,
        install: false,
        fetchLatestRelease: async () => null,
        getCurrentVersion: () => '0.3.0',
      });
      assert.equal(res, null);
    });
  });
});
