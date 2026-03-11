import { readFile, writeFile, rename, mkdir, unlink, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

export async function getGsdDir(startDir = process.cwd()) {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, '.gsd');
    try {
      const s = await stat(candidate);
      if (s.isDirectory()) return candidate;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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
