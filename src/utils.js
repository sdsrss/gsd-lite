import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';

export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

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

export function getGitHead(cwd = process.cwd()) {
  try {
    return execSync('git rev-parse --short HEAD', { cwd, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

export async function readJson(filePath) {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    return { error: true, message: err.message };
  }
}

export async function writeJson(filePath, data) {
  const tmpPath = filePath + '.tmp';
  await ensureDir(dirname(filePath));
  await writeFile(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  await rename(tmpPath, filePath);
}
