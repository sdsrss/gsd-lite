import { readFile, writeFile, rename, mkdir, unlink, stat, open } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

const execFileAsync = promisify(execFileCb);

const _gsdDirCache = new Map();

export async function getGsdDir(startDir = process.cwd()) {
  const resolved = resolve(startDir);
  if (_gsdDirCache.has(resolved)) return _gsdDirCache.get(resolved);

  let dir = resolved;
  while (true) {
    const candidate = join(dir, '.gsd');
    try {
      const s = await stat(candidate);
      if (s.isDirectory()) {
        _gsdDirCache.set(resolved, candidate);
        return candidate;
      }
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) {
      // H-9: Don't cache negative results — .gsd may be created later by init()
      return null;
    }
    dir = parent;
  }
}

export function clearGsdDirCache() {
  _gsdDirCache.clear();
}

export async function getStatePath(startDir = process.cwd()) {
  const gsdDir = await getGsdDir(startDir);
  if (!gsdDir) return null;
  return join(gsdDir, 'state.json');
}

export async function getGitHead(cwd = process.cwd()) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      timeout: 5000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

// C-2: Advisory file lock for cross-process serialization
export const LOCK_STALE_MS = 10_000;
export const LOCK_RETRY_MS = 50;
// Retry budget must be >= LOCK_STALE_MS so a waiter never times out during the
// window in which a legitimately-held lock has not yet aged into staleness (R-09).
export const LOCK_MAX_RETRIES = 240; // 12s total (> LOCK_STALE_MS)

/**
 * Execute fn while holding an advisory file lock.
 * Uses O_CREAT|O_EXCL (via 'wx' flag) for atomic lock acquisition.
 * The lock file carries a unique per-acquisition token (pid + time + random) so
 * release and stale-breaking are compare-and-delete: a process only ever removes
 * a lock it still owns, closing the steal race where A's finally-unlink deletes
 * B's freshly-acquired lock (R-01, audit H1).
 * Stale locks (older than staleMs) are broken only if their content is unchanged
 * across a re-read, so a lock re-acquired between observation and unlink survives.
 * Falls through without locking on non-EEXIST errors (e.g., read-only fs).
 *
 * @param {string} lockPath
 * @param {() => Promise<any>} fn
 * @param {{staleMs?: number, retryMs?: number, maxRetries?: number}} [opts]
 *   Timing overrides for tests; production uses the module defaults.
 */
export async function withFileLock(lockPath, fn, opts = {}) {
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const retryMs = opts.retryMs ?? LOCK_RETRY_MS;
  const maxRetries = opts.maxRetries ?? LOCK_MAX_RETRIES;
  const token = `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;

  let acquired = false;
  let nonLockError = false;
  for (let i = 0; i < maxRetries; i++) {
    try {
      await writeFile(lockPath, token, { flag: 'wx' });
      acquired = true;
      break;
    } catch (err) {
      if (err.code === 'EEXIST') {
        try {
          const s = await stat(lockPath);
          if (Date.now() - s.mtimeMs > staleMs) {
            // Compare-and-delete: break the stale lock only if it still holds the
            // same content we observed. If another process re-acquired it between
            // reads, the token differs and we back off instead of stealing it.
            const observed = await readFile(lockPath, 'utf-8');
            let current;
            try {
              current = await readFile(lockPath, 'utf-8');
            } catch {
              continue; // lock vanished — retry acquisition immediately
            }
            const s2 = await stat(lockPath).catch(() => null);
            if (current === observed && s2 && Date.now() - s2.mtimeMs > staleMs) {
              try { await unlink(lockPath); } catch {}
            }
            continue;
          }
        } catch {
          // stat failed — lock may have been released between checks
          continue;
        }
        await new Promise(r => setTimeout(r, retryMs));
      } else {
        // Non-EEXIST error (e.g., read-only fs) — proceed without lock
        nonLockError = true;
        break;
      }
    }
  }

  // Lock exhaustion (retries depleted while another process held the lock):
  // throw to prevent concurrent unlocked writes that cause data corruption.
  // Non-EEXIST errors (read-only fs, permission denied) still proceed without lock
  // since locking is physically impossible in those environments.
  if (!acquired && !nonLockError) {
    throw new Error(`Lock acquisition timeout: could not acquire ${lockPath} after ${maxRetries} retries (${maxRetries * retryMs}ms)`);
  }

  try {
    return await fn();
  } finally {
    if (acquired) {
      // Compare-and-delete on release: only remove the lock if it still carries
      // our token. If a stale-breaker stole it, the token differs and we leave
      // the new owner's lock intact.
      try {
        const current = await readFile(lockPath, 'utf-8');
        if (current === token) await unlink(lockPath);
      } catch {}
    }
  }
}

let _tmpCounter = 0;
function tmpPath(filePath) {
  return `${filePath}.${process.pid}-${Date.now()}-${_tmpCounter++}.tmp`;
}

export function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

/**
 * Read and parse a JSON file.
 * Returns { ok: true, data } on success, { ok: false, error } on failure.
 */
export async function readJson(filePath) {
  try {
    const content = await readFile(filePath, 'utf-8');
    return { ok: true, data: JSON.parse(content) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * fsync a directory so a completed rename survives a power loss. Best-effort:
 * some platforms (notably Windows) reject opening/fsync-ing a directory — the
 * rename is still atomic there, we just can't force the metadata flush.
 */
export async function fsyncDir(dirPath) {
  let dh;
  try {
    dh = await open(dirPath, 'r');
    await dh.sync();
  } catch {
    /* directory fsync unsupported / not permitted — best effort */
  } finally {
    if (dh) await dh.close().catch(() => {});
  }
}

/**
 * R-13 (audit M5): crash-safe atomic write. Write to a temp file, fsync its data
 * to disk BEFORE the rename, atomically rename into place, then fsync the parent
 * directory so the rename itself is durable. Order matters: file first, dir after
 * — otherwise a power loss between rename and file-flush can leave a truncated or
 * zero-length target.
 */
async function writeFileDurable(filePath, content) {
  const tmp = tmpPath(filePath);
  const dir = dirname(filePath);
  await ensureDir(dir);
  let fh;
  try {
    fh = await open(tmp, 'w');
    await fh.writeFile(content, 'utf-8');
    await fh.sync();
  } catch (err) {
    if (fh) { await fh.close().catch(() => {}); fh = null; }
    try { await unlink(tmp); } catch {}
    throw err;
  }
  await fh.close();
  try {
    await rename(tmp, filePath);
    await fsyncDir(dir);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

/**
 * Atomically write JSON data (write to .tmp, fsync, then rename).
 */
export async function writeJson(filePath, data) {
  await writeFileDurable(filePath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Atomically write text content (write to .tmp, fsync, then rename). [I-3]
 */
export async function writeAtomic(filePath, content) {
  await writeFileDurable(filePath, content);
}
