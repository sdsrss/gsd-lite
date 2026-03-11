import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

export function getGsdDir(startDir = process.cwd()) {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, '.gsd');
    try {
      const s = statSync(candidate);
      if (s.isDirectory()) return candidate;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function getStatePath(startDir = process.cwd()) {
  const gsdDir = getGsdDir(startDir);
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

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  const tmpPath = `${filePath}.${process.pid}-${Date.now()}.tmp`;
  await ensureDir(dirname(filePath));
  try {
    await writeFile(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    await rename(tmpPath, filePath);
  } catch (err) {
    try { await unlink(tmpPath); } catch {}
    throw err;
  }
}

/**
 * Atomically write text content (write to .tmp then rename). [I-3]
 */
export async function writeAtomic(filePath, content) {
  const tmpPath = `${filePath}.${process.pid}-${Date.now()}.tmp`;
  await ensureDir(dirname(filePath));
  try {
    await writeFile(tmpPath, content, 'utf-8');
    await rename(tmpPath, filePath);
  } catch (err) {
    try { await unlink(tmpPath); } catch {}
    throw err;
  }
}
