import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmodSync, lstatSync, readFileSync, statSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  atomicWrite,
  atomicWriteJson,
  atomicWriteMarker,
  atomicWriteMarkerJson,
  atomicWriteThroughLink,
} = require('../hooks/lib/atomic-write.cjs');

async function withTmp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'gsd-atomic-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('atomicWrite', () => {
  it('creates a file with the given content', async () => {
    await withTmp(root => {
      const p = join(root, 'new.txt');
      atomicWrite(p, 'hello');
      assert.equal(readFileSync(p, 'utf8'), 'hello');
    });
  });

  it('replaces existing content', async () => {
    await withTmp(root => {
      const p = join(root, 'existing.txt');
      writeFileSync(p, 'old');
      atomicWrite(p, 'new');
      assert.equal(readFileSync(p, 'utf8'), 'new');
    });
  });

  it('carries the destination permissions across the rename', async () => {
    // renameSync is atomic but takes the temp file's mode with it, so a 0600
    // temp would silently tighten a user's 0644 settings.json on first write.
    await withTmp(root => {
      const p = join(root, 'perms.txt');
      writeFileSync(p, 'old');
      chmodSync(p, 0o644);
      atomicWrite(p, 'new');
      assert.equal(statSync(p).mode & 0o777, 0o644);
    });
  });

  it('leaves a new file at 0600', async () => {
    await withTmp(root => {
      const p = join(root, 'fresh.txt');
      atomicWrite(p, 'x');
      assert.equal(statSync(p).mode & 0o777, 0o600);
    });
  });

  it('leaves no temp files behind', async () => {
    await withTmp(root => {
      const p = join(root, 'clean.txt');
      atomicWrite(p, 'x');
      const { readdirSync } = require('node:fs');
      assert.deepEqual(readdirSync(root), ['clean.txt']);
    });
  });

  it('writes JSON with a trailing newline', async () => {
    await withTmp(root => {
      const p = join(root, 'obj.json');
      atomicWriteJson(p, { a: 1 });
      assert.equal(readFileSync(p, 'utf8'), '{\n  "a": 1\n}\n');
    });
  });

  it('throws rather than writing when the directory does not exist', async () => {
    await withTmp(root => {
      assert.throws(() => atomicWrite(join(root, 'missing', 'f.txt'), 'x'), { code: 'ENOENT' });
    });
  });
});

describe('atomicWriteMarker', () => {
  it('refuses a symlinked destination instead of replacing it', async () => {
    await withTmp(root => {
      const secret = join(root, 'secret.txt');
      writeFileSync(secret, 'untouched');
      const marker = join(root, '.marker');
      symlinkSync(secret, marker);

      assert.throws(() => atomicWriteMarker(marker, 'payload'), { code: 'GSD_SYMLINK_REFUSED' });
      assert.equal(readFileSync(secret, 'utf8'), 'untouched');
      assert.equal(lstatSync(marker).isSymbolicLink(), true);
    });
  });

  it('refuses a dangling symlink too', async () => {
    // A link to a path that does not exist yet is the interesting case: the
    // write would create the target, which is how a plant turns into a file
    // somewhere the hook was never meant to touch.
    await withTmp(root => {
      const marker = join(root, '.marker');
      symlinkSync(join(root, 'does-not-exist'), marker);
      assert.throws(() => atomicWriteMarker(marker, 'payload'), { code: 'GSD_SYMLINK_REFUSED' });
      assert.equal(lstatSync(marker).isSymbolicLink(), true);
    });
  });

  it('writes normally when the destination is absent', async () => {
    await withTmp(root => {
      const p = join(root, '.marker');
      atomicWriteMarker(p, 'ok');
      assert.equal(readFileSync(p, 'utf8'), 'ok');
    });
  });

  it('writes normally when the destination is a regular file', async () => {
    await withTmp(root => {
      const p = join(root, '.marker');
      writeFileSync(p, 'old');
      atomicWriteMarkerJson(p, { ok: true });
      assert.equal(readFileSync(p, 'utf8'), '{\n  "ok": true\n}\n');
    });
  });
});

describe('atomicWriteThroughLink', () => {
  it('writes through a link that stays inside the root', async () => {
    await withTmp(root => {
      mkdirSync(join(root, 'real'));
      const target = join(root, 'real', 'CLAUDE.md');
      writeFileSync(target, 'old');
      const link = join(root, 'CLAUDE.md');
      symlinkSync(target, link);

      assert.equal(atomicWriteThroughLink(link, 'new', root), true);
      assert.equal(readFileSync(target, 'utf8'), 'new');
      // The link survives — that is the point of writing through it.
      assert.equal(lstatSync(link).isSymbolicLink(), true);
    });
  });

  it('declines a link that resolves outside the root', async () => {
    await withTmp(root => {
      const outside = join(root, 'outside.txt');
      writeFileSync(outside, 'untouched');
      const projectRoot = join(root, 'project');
      mkdirSync(projectRoot);
      const link = join(projectRoot, 'CLAUDE.md');
      symlinkSync(outside, link);

      assert.equal(atomicWriteThroughLink(link, 'payload', projectRoot), false);
      assert.equal(readFileSync(outside, 'utf8'), 'untouched');
    });
  });

  it('writes a file that does not exist yet', async () => {
    await withTmp(root => {
      const p = join(root, 'CLAUDE.md');
      assert.equal(atomicWriteThroughLink(p, 'fresh', root), true);
      assert.equal(readFileSync(p, 'utf8'), 'fresh');
    });
  });
});
