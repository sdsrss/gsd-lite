import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('utils', () => {
  let tempDir;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-test-'));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('slugify', () => {
    it('converts spaces to hyphens', async () => {
      const { slugify } = await import('../src/utils.js');
      assert.equal(slugify('My Cool Project'), 'my-cool-project');
    });

    it('removes special characters', async () => {
      const { slugify } = await import('../src/utils.js');
      assert.equal(slugify('hello@world!'), 'helloworld');
    });

    it('handles empty string', async () => {
      const { slugify } = await import('../src/utils.js');
      assert.equal(slugify(''), '');
    });
  });

  describe('readJson / writeJson', () => {
    it('round-trips JSON data atomically', async () => {
      const { readJson, writeJson } = await import('../src/utils.js');
      const filePath = join(tempDir, 'test.json');
      const data = { key: 'value', nested: { a: 1 } };
      await writeJson(filePath, data);
      const result = await readJson(filePath);
      assert.deepEqual(result, data);
    });

    it('returns error for missing file', async () => {
      const { readJson } = await import('../src/utils.js');
      const result = await readJson(join(tempDir, 'nope.json'));
      assert.equal(result.error, true);
    });

    it('returns error for corrupted JSON', async () => {
      const { readJson } = await import('../src/utils.js');
      const filePath = join(tempDir, 'bad.json');
      await writeFile(filePath, '{broken json!!!');
      const result = await readJson(filePath);
      assert.equal(result.error, true);
    });
  });

  describe('ensureDir', () => {
    it('creates nested directories', async () => {
      const { ensureDir } = await import('../src/utils.js');
      const nested = join(tempDir, 'a', 'b', 'c');
      await ensureDir(nested);
      const s = await stat(nested);
      assert.ok(s.isDirectory());
    });
  });

  describe('getGsdDir', () => {
    it('finds .gsd directory from cwd', async () => {
      const { getGsdDir } = await import('../src/utils.js');
      const gsdDir = join(tempDir, '.gsd');
      await mkdir(gsdDir);
      const result = getGsdDir(tempDir);
      assert.equal(result, gsdDir);
    });

    it('returns null when no .gsd found', async () => {
      const { getGsdDir } = await import('../src/utils.js');
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
    it('returns a commit hash or null', async () => {
      const { getGitHead } = await import('../src/utils.js');
      const head = getGitHead();
      if (head !== null) {
        assert.match(head, /^[0-9a-f]{7,40}$/);
      }
    });
  });
});
