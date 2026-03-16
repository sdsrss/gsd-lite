import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPackageManager, runAll, runLint, runTypeCheck, runTests } from '../src/tools/verify.js';

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
      const dir = join(tempDir, 'pnpm-proj');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'pnpm-lock.yaml'), '');
      const pm = await detectPackageManager(dir);
      assert.equal(pm, 'pnpm');
    });

    it('detects npm from package-lock.json', async () => {
      const dir = join(tempDir, 'npm-proj');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'package-lock.json'), '{}');
      const pm = await detectPackageManager(dir);
      assert.equal(pm, 'npm');
    });

    it('detects yarn from yarn.lock', async () => {
      const dir = join(tempDir, 'yarn-proj');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'yarn.lock'), '');
      const pm = await detectPackageManager(dir);
      assert.equal(pm, 'yarn');
    });

    it('returns null when no lockfile found', async () => {
      const dir = join(tempDir, 'empty-proj');
      await mkdir(dir, { recursive: true });
      const pm = await detectPackageManager(dir);
      assert.equal(pm, null);
    });
  });

  describe('runAll', () => {
    it('returns structured results with error when no package manager', async () => {
      const dir = join(tempDir, 'no-pm-proj');
      await mkdir(dir, { recursive: true });
      const result = await runAll(dir);
      assert.ok(result.lint);
      assert.ok(result.typecheck);
      assert.ok(result.test);
      assert.equal(result.lint.exit_code, -1);
    });

    it('skips lint when no lint script is defined', async () => {
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

  describe('detectPackageManager — bun lockfile', () => {
    it('detects bun from bun.lockb', async () => {
      const dir = join(tempDir, 'bun-proj');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'bun.lockb'), '');
      const pm = await detectPackageManager(dir);
      assert.equal(pm, 'bun');
    });

    it('prefers pnpm over bun when both exist', async () => {
      const dir = join(tempDir, 'pnpm-bun-proj');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'pnpm-lock.yaml'), '');
      await writeFile(join(dir, 'bun.lockb'), '');
      const pm = await detectPackageManager(dir);
      assert.equal(pm, 'pnpm');
    });
  });

  describe('runLint', () => {
    it('skips lint when no lint script is found', async () => {
      const dir = join(tempDir, 'lint-no-script');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'test', scripts: {} }));
      const result = await runLint('npm', dir);
      assert.equal(result.exit_code, 0);
      assert.match(result.summary, /no lint script found/);
    });

    it('runs lint when lint script exists', async () => {
      const dir = join(tempDir, 'lint-has-script');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({
        name: 'test',
        scripts: { lint: 'node --eval "console.log(\'lint ok\')"' },
      }));
      const result = await runLint('node', dir);
      // `node run lint` is invalid (node doesn't have 'run'), so it fails
      assert.ok(result.exit_code !== 0);
      assert.ok(typeof result.summary === 'string');
      assert.ok(result.summary.length > 0);
    });

    it('handles missing package.json gracefully', async () => {
      const dir = join(tempDir, 'lint-no-pkg');
      await mkdir(dir, { recursive: true });
      const result = await runLint('npm', dir);
      assert.equal(result.exit_code, 0);
      assert.match(result.summary, /no lint script found/);
    });
  });

  describe('runTypeCheck', () => {
    it('skips typecheck when no tsconfig.json', async () => {
      const dir = join(tempDir, 'tc-no-tsconfig');
      await mkdir(dir, { recursive: true });
      const result = await runTypeCheck(dir);
      assert.equal(result.exit_code, 0);
      assert.match(result.summary, /no tsconfig.json found/);
    });

    it('runs typecheck when tsconfig.json exists and local tsc is available', async () => {
      const dir = join(tempDir, 'tc-has-tsconfig');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'tsconfig.json'), '{}');
      // Create a fake node_modules/.bin/tsc so local-first detection finds it
      await mkdir(join(dir, 'node_modules', '.bin'), { recursive: true });
      await writeFile(join(dir, 'node_modules', '.bin', 'tsc'), '#!/bin/sh\necho "tsc mock"\nexit 0');
      const { chmod } = await import('node:fs/promises');
      await chmod(join(dir, 'node_modules', '.bin', 'tsc'), 0o755);
      const result = await runTypeCheck('npm', dir);
      // Should use the local tsc binary and succeed
      assert.equal(result.exit_code, 0);
      assert.ok(typeof result.summary === 'string');
    });

    it('skips typecheck when npm and no local tsc found', async () => {
      const dir = join(tempDir, 'tc-npm-no-local-tsc');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'tsconfig.json'), '{}');
      // No node_modules/.bin/tsc exists
      const result = await runTypeCheck('npm', dir);
      assert.equal(result.skipped, true);
      assert.match(result.reason, /no local typescript found/);
    });

    it('skips typecheck when pm is null and no local tsc found', async () => {
      const dir = join(tempDir, 'tc-null-pm-no-tsc');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'tsconfig.json'), '{}');
      const result = await runTypeCheck(null, dir);
      assert.equal(result.skipped, true);
      assert.match(result.reason, /no local typescript found/);
    });
  });

  describe('runTests', () => {
    it('runs tests with a pattern argument', async () => {
      const dir = join(tempDir, 'test-pattern');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({
        name: 'test',
        scripts: { test: 'node --eval "process.exit(0)"' },
      }));
      // `node test -- some-pattern` fails because node doesn't have a 'test' subcommand
      const result = await runTests('node', dir, 'some-pattern');
      assert.ok(result.exit_code !== 0);
      assert.ok(typeof result.summary === 'string');
    });
  });

  describe('runCommand error handling', () => {
    it('handles command that writes to stderr on failure', async () => {
      const dir = join(tempDir, 'cmd-stderr');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({
        name: 'test',
        scripts: { test: 'node --eval "process.stderr.write(\'error output\'); process.exit(1)"' },
      }));
      await writeFile(join(dir, 'package-lock.json'), '{}');
      const result = await runAll(dir);
      assert.ok(result.test.exit_code !== 0);
      assert.ok(typeof result.test.summary === 'string');
    });

    it('handles command that produces no output', async () => {
      const dir = join(tempDir, 'cmd-no-output');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({
        name: 'test',
        scripts: { test: 'node --eval "process.exit(1)"' },
      }));
      await writeFile(join(dir, 'package-lock.json'), '{}');
      const result = await runAll(dir);
      assert.ok(result.test.exit_code !== 0);
    });
  });
});
