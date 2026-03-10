import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('verify tools', () => {
  let tempDir;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-verify-'));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('detectPackageManager', () => {
    it('detects pnpm from pnpm-lock.yaml', async () => {
      const { detectPackageManager } = await import('../src/tools/verify.js');
      const dir = join(tempDir, 'pnpm-proj');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'pnpm-lock.yaml'), '');
      const pm = await detectPackageManager(dir);
      assert.equal(pm, 'pnpm');
    });

    it('detects npm from package-lock.json', async () => {
      const { detectPackageManager } = await import('../src/tools/verify.js');
      const dir = join(tempDir, 'npm-proj');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'package-lock.json'), '{}');
      const pm = await detectPackageManager(dir);
      assert.equal(pm, 'npm');
    });

    it('detects yarn from yarn.lock', async () => {
      const { detectPackageManager } = await import('../src/tools/verify.js');
      const dir = join(tempDir, 'yarn-proj');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'yarn.lock'), '');
      const pm = await detectPackageManager(dir);
      assert.equal(pm, 'yarn');
    });

    it('returns null when no lockfile found', async () => {
      const { detectPackageManager } = await import('../src/tools/verify.js');
      const dir = join(tempDir, 'empty-proj');
      await mkdir(dir, { recursive: true });
      const pm = await detectPackageManager(dir);
      assert.equal(pm, null);
    });
  });

  describe('runAll', () => {
    it('returns structured results with error when no package manager', async () => {
      const { runAll } = await import('../src/tools/verify.js');
      const dir = join(tempDir, 'no-pm-proj');
      await mkdir(dir, { recursive: true });
      const result = await runAll(dir);
      assert.ok(result.lint);
      assert.ok(result.typecheck);
      assert.ok(result.test);
      assert.equal(result.lint.exit_code, -1);
    });

    it('skips lint when no lint script is defined', async () => {
      const { runAll } = await import('../src/tools/verify.js');
      const dir = join(tempDir, 'npm-no-lint');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'package-lock.json'), '{}');
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'npm-no-lint',
          scripts: { test: 'node --eval "process.exit(0)"' },
        }, null, 2),
      );
      const result = await runAll(dir);
      assert.equal(result.lint.exit_code, 0);
      assert.match(result.lint.summary, /no lint script found/);
      assert.equal(result.test.exit_code, 0);
    });
  });
});
