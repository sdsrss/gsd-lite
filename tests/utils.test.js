import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJson, writeAtomic, ensureDir, getGsdDir, getGitHead } from '../src/utils.js';

describe('utils', () => {
  let tempDir;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-test-'));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('readJson / writeJson', () => {
    it('round-trips JSON data atomically', async () => {
      const filePath = join(tempDir, 'test.json');
      const data = { key: 'value', nested: { a: 1 } };
      await writeJson(filePath, data);
      const result = await readJson(filePath);
      assert.equal(result.ok, true);
      assert.deepEqual(result.data, data);
    });

    it('returns error for missing file', async () => {
      const result = await readJson(join(tempDir, 'nope.json'));
      assert.equal(result.ok, false);
      assert.ok(typeof result.error === 'string');
    });

    it('returns error for corrupted JSON', async () => {
      const filePath = join(tempDir, 'bad.json');
      await writeFile(filePath, '{broken json!!!');
      const result = await readJson(filePath);
      assert.equal(result.ok, false);
    });
  });

  describe('writeAtomic', () => {
    it('atomically writes text content', async () => {
      const filePath = join(tempDir, 'atomic.txt');
      await writeAtomic(filePath, 'hello world');
      const content = await readFile(filePath, 'utf-8');
      assert.equal(content, 'hello world');
    });
  });

  describe('ensureDir', () => {
    it('creates nested directories', async () => {
      const nested = join(tempDir, 'a', 'b', 'c');
      await ensureDir(nested);
      const s = await stat(nested);
      assert.ok(s.isDirectory());
    });
  });

  describe('getGsdDir', () => {
    it('finds .gsd directory from cwd', async () => {
      const gsdDir = join(tempDir, '.gsd');
      await mkdir(gsdDir);
      const result = getGsdDir(tempDir);
      assert.equal(result, gsdDir);
    });

    it('returns null when no .gsd found', async () => {
      // Use /tmp directly to avoid ancestor .gsd dirs (tmpdir() may be under $HOME)
      const isolatedDir = await mkdtemp('/tmp/gsd-no-gsd-');
      try {
        const result = getGsdDir(isolatedDir);
        assert.equal(result, null);
      } finally {
        await rm(isolatedDir, { recursive: true, force: true });
      }
    });
  });

  describe('getGitHead', () => {
    it('returns a commit hash or null', () => {
      const head = getGitHead();
      if (head !== null) {
        assert.match(head, /^[0-9a-f]{7,40}$/);
      }
    });

    it('returns null for non-git directory', async () => {
      const isolatedDir = await mkdtemp('/tmp/gsd-no-git-');
      try {
        const head = getGitHead(isolatedDir);
        assert.equal(head, null);
      } finally {
        await rm(isolatedDir, { recursive: true, force: true });
      }
    });
  });
});
