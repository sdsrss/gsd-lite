import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJson, writeAtomic, ensureDir, getGsdDir, getGitHead, clearGsdDirCache } from '../src/utils.js';

describe('utils', () => {
  let tempDir;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-test-'));
  });

  after(async () => {
    clearGsdDirCache();
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

  it('concurrent writeJson calls produce unique tmp paths (no collision)', async () => {
    const filePath = join(tempDir, 'concurrent.json');
    // Run multiple writes in parallel — should not collide
    await Promise.all([
      writeJson(filePath, { a: 1 }),
      writeJson(filePath, { b: 2 }),
      writeJson(filePath, { c: 3 }),
    ]);
    const result = await readJson(filePath);
    assert.equal(result.ok, true);
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
      const result = await getGsdDir(tempDir);
      assert.equal(result, gsdDir);
    });

    it('caches result and returns same value on second call', async () => {
      clearGsdDirCache();
      const gsdDir = join(tempDir, '.gsd');
      await mkdir(gsdDir, { recursive: true });
      const first = await getGsdDir(tempDir);
      const second = await getGsdDir(tempDir);
      assert.equal(first, second);
      assert.equal(first, gsdDir);
    });

    it('clearGsdDirCache invalidates positive cache', async () => {
      clearGsdDirCache();
      const isolatedDir = await mkdtemp('/tmp/gsd-cache-test-');
      try {
        // First call: no .gsd → null (H-9: negative results NOT cached)
        const first = await getGsdDir(isolatedDir);
        assert.equal(first, null);
        // Create .gsd
        await mkdir(join(isolatedDir, '.gsd'));
        // H-9: Finds .gsd immediately — no clearGsdDirCache needed
        const found = await getGsdDir(isolatedDir);
        assert.equal(found, join(isolatedDir, '.gsd'));
        // Positive result IS cached — verify by removing .gsd
        await rm(join(isolatedDir, '.gsd'), { recursive: true, force: true });
        const cached = await getGsdDir(isolatedDir);
        assert.equal(cached, join(isolatedDir, '.gsd')); // still cached
        // Clear cache → now sees .gsd is gone
        clearGsdDirCache();
        const fresh = await getGsdDir(isolatedDir);
        assert.equal(fresh, null);
      } finally {
        await rm(isolatedDir, { recursive: true, force: true });
      }
    });

    it('returns null when no .gsd found', async () => {
      // Use /tmp directly to avoid ancestor .gsd dirs (tmpdir() may be under $HOME)
      const isolatedDir = await mkdtemp('/tmp/gsd-no-gsd-');
      try {
        const result = await getGsdDir(isolatedDir);
        assert.equal(result, null);
      } finally {
        await rm(isolatedDir, { recursive: true, force: true });
      }
    });
  });

  describe('getGitHead', () => {
    it('returns a commit hash or null', async () => {
      const head = await getGitHead();
      if (head !== null) {
        assert.match(head, /^[0-9a-f]{7,40}$/);
      }
    });

    it('returns null for non-git directory', async () => {
      const isolatedDir = await mkdtemp('/tmp/gsd-no-git-');
      try {
        const head = await getGitHead(isolatedDir);
        assert.equal(head, null);
      } finally {
        await rm(isolatedDir, { recursive: true, force: true });
      }
    });
  });
});
