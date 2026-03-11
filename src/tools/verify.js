import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

// M-2: Detection priority — first lockfile match wins (pnpm > yarn > npm > bun)
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

function summarizeOutput(output, lines) {
  return String(output || '').trim().split('\n').slice(-lines).join('\n');
}

async function runCommand(command, args, cwd) {
  try {
    const { stdout } = await execFile(command, args, {
      cwd,
      encoding: 'utf-8',
      timeout: 120000,
    });
    return { exit_code: 0, summary: summarizeOutput(stdout, 3) };
  } catch (err) {
    return {
      exit_code: err.status ?? (typeof err.code === 'number' ? err.code : 1),
      summary: summarizeOutput(err.stderr || err.stdout || err.message || '', 5),
    };
  }
}

export async function runTests(pm, cwd, pattern) {
  const args = ['test'];
  if (pattern) args.push('--', pattern);
  return runCommand(pm, args, cwd);
}

async function hasPackageScript(cwd, scriptName) {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8'));
    return typeof pkg.scripts?.[scriptName] === 'string';
  } catch {
    return false;
  }
}

export async function runLint(pm, cwd) {
  if (!await hasPackageScript(cwd, 'lint')) {
    return { exit_code: 0, summary: 'skipped: no lint script found' };
  }
  return runCommand(pm, ['run', 'lint'], cwd);
}

export async function runTypeCheck(pm, cwd) {
  // M-8: Only run tsc if tsconfig.json exists
  try {
    await stat(join(cwd, 'tsconfig.json'));
  } catch {
    return { exit_code: 0, summary: 'skipped: no tsconfig.json found' };
  }
  if (pm === 'pnpm') return runCommand('pnpm', ['exec', 'tsc', '--noEmit'], cwd);
  if (pm === 'yarn') return runCommand('yarn', ['tsc', '--noEmit'], cwd);
  if (pm === 'bun') return runCommand('bun', ['run', 'tsc', '--noEmit'], cwd);
  return runCommand('npx', ['tsc', '--noEmit'], cwd);
}

export async function runAll(cwd = process.cwd()) {
  const pm = await detectPackageManager(cwd);
  if (!pm) {
    const errResult = { exit_code: -1, summary: 'No package manager detected' };
    return { lint: errResult, typecheck: errResult, test: errResult };
  }
  const [lint, typecheck, test] = await Promise.all([
    runLint(pm, cwd),
    runTypeCheck(pm, cwd),
    runTests(pm, cwd),
  ]);
  return { lint, typecheck, test };
}
