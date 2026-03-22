import { readFile, writeFile, rename, mkdir, unlink, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

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
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100; // 5 seconds total

/**
 * Execute fn while holding an advisory file lock.
 * Uses O_CREAT|O_EXCL (via 'wx' flag) for atomic lock acquisition.
 * Stale locks (>10s) are automatically broken.
 * Falls through without locking on non-EEXIST errors (e.g., read-only fs).
 */
export async function withFileLock(lockPath, fn) {
  let acquired = false;
  let nonLockError = false;
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: 'wx' });
      acquired = true;
      break;
    } catch (err) {
      if (err.code === 'EEXIST') {
        try {
          const s = await stat(lockPath);
          if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
            try { await unlink(lockPath); } catch {}
            continue;
          }
        } catch {
          // stat failed — lock may have been released between checks
          continue;
        }
        await new Promise(r => setTimeout(r, LOCK_RETRY_MS));
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
    throw new Error(`Lock acquisition timeout: could not acquire ${lockPath} after ${LOCK_MAX_RETRIES} retries (${LOCK_MAX_RETRIES * LOCK_RETRY_MS}ms)`);
  }

  try {
    return await fn();
  } finally {
    if (acquired) {
      try { await unlink(lockPath); } catch {}
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
 * Atomically write JSON data (write to .tmp then rename).
 */
export async function writeJson(filePath, data) {
  const tmp = tmpPath(filePath);
  await ensureDir(dirname(filePath));
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    await rename(tmp, filePath);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

/**
 * Atomically write text content (write to .tmp then rename). [I-3]
 */
export async function writeAtomic(filePath, content) {
  const tmp = tmpPath(filePath);
  await ensureDir(dirname(filePath));
  try {
    await writeFile(tmp, content, 'utf-8');
    await rename(tmp, filePath);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}
