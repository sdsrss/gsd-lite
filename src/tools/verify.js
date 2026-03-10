import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const LOCKFILE_MAP = {
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'package-lock.json': 'npm',
  'bun.lockb': 'bun',
};

export async function detectPackageManager(cwd = process.cwd()) {
  for (const [file, pm] of Object.entries(LOCKFILE_MAP)) {
    try {
      await stat(join(cwd, file));
      return pm;
    } catch {}
  }
  return null;
}

function runCommand(cmd, cwd) {
  try {
    const output = execSync(cmd, { cwd, encoding: 'utf-8', timeout: 120000, stdio: 'pipe' });
    return { exit_code: 0, summary: output.trim().split('\n').slice(-3).join('\n') };
  } catch (err) {
    return {
      exit_code: err.status || 1,
      summary: (err.stderr || err.stdout || err.message || '').trim().split('\n').slice(-5).join('\n'),
    };
  }
}

export function runTests(pm, cwd, pattern) {
  const cmd = pattern ? `${pm} test -- ${pattern}` : `${pm} test`;
  return runCommand(cmd, cwd);
}

export function runLint(pm, cwd) {
  return runCommand(`${pm} run lint`, cwd);
}

export function runTypeCheck(cwd) {
  return runCommand('npx tsc --noEmit', cwd);
}

export async function runAll(cwd = process.cwd()) {
  const pm = await detectPackageManager(cwd);
  if (!pm) {
    const errResult = { exit_code: -1, summary: 'No package manager detected' };
    return { lint: errResult, typecheck: errResult, test: errResult };
  }
  return {
    lint: runLint(pm, cwd),
    typecheck: runTypeCheck(cwd),
    test: runTests(pm, cwd),
  };
}
