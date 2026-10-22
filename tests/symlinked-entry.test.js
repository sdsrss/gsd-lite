// The three entry points (src/server.js, install.js, uninstall.js) decide
// whether they were run directly by comparing process.argv[1] with
// import.meta.url. Node resolves the main module through symlinks and leaves
// argv[1] as given, so a script started through a symlinked path — a symlinked
// ~/.claude, a dotfiles checkout, macOS's /var → /private/var under
// os.tmpdir() — compared unequal and did nothing, exit 0. Each test here starts
// one of them through a symlink and checks that it did its job.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function withLinkedRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-symlinked-entry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const link = join(dir, 'link');
  await symlink(PROJECT_ROOT, link, 'dir');
  const claudeDir = join(dir, 'home', '.claude');
  await mkdir(claudeDir, { recursive: true });
  const env = { ...process.env, HOME: join(dir, 'home'), CLAUDE_CONFIG_DIR: claudeDir };
  return { dir, link, claudeDir, env };
}

function initialize(serverPath, env, cwd) {
  const child = spawn(process.execPath, [serverPath], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolvePromise, reject) => {
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('no answer to initialize within 10s')); }, 10000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      for (const line of out.split('\n')) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) { clearTimeout(timer); child.kill(); resolvePromise(msg); return; }
        } catch { /* partial line */ }
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the server exited (code ${code}) without answering initialize`));
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'symlinked-entry', version: '1' } },
    })}\n`);
  });
}

describe('entry points started through a symlinked path', { timeout: 120000 }, () => {
  // The tests below start the three entry points there are. A fourth written
  // the old way would not be among them, so the comparison itself is pinned:
  // process.argv[1] in shipped code is only ever read through realpathSync.
  it('shipped code reads process.argv[1] only through realpathSync', async () => {
    const { files } = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8'));
    const sources = [];
    for (const entry of files) {
      const full = join(PROJECT_ROOT, entry);
      if (/\.(c|m)?js$/.test(entry)) sources.push(full);
      else if (existsSync(full)) {
        for (const name of readdirSync(full, { recursive: true })) {
          if (/\.(c|m)?js$/.test(name)) sources.push(join(full, name));
        }
      }
    }
    assert.ok(sources.some((file) => file.endsWith(join('src', 'server.js'))), 'premise: the shipped sources were listed');
    const offenders = [];
    for (const file of sources) {
      const code = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      for (const match of code.matchAll(/process\.argv\[1\]/g)) {
        if (!code.slice(Math.max(0, match.index - 'realpathSync('.length), match.index).endsWith('realpathSync(')) {
          offenders.push(`${file.slice(PROJECT_ROOT.length + 1)}:${code.slice(0, match.index).split('\n').length}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('the MCP server answers initialize', async (t) => {
    const { dir, link, env } = await withLinkedRoot(t);
    const msg = await initialize(join(link, 'src', 'server.js'), env, dir);
    assert.equal(msg.result?.serverInfo?.name, 'gsd');
  });

  it('install.js installs', async (t) => {
    const { dir, link, claudeDir, env } = await withLinkedRoot(t);
    const out = execFileSync(process.execPath, [join(link, 'install.js')], { cwd: dir, env, encoding: 'utf8', timeout: 90000 });
    assert.match(out, /GSD-Lite Installer/, 'premise: main() ran');
    assert.ok(existsSync(join(claudeDir, 'gsd', 'src', 'server.js')), 'the runtime was not installed');
  });

  it('uninstall.js uninstalls', async (t) => {
    const { dir, link, claudeDir, env } = await withLinkedRoot(t);
    execFileSync(process.execPath, [join(PROJECT_ROOT, 'install.js')], { cwd: dir, env, encoding: 'utf8', timeout: 90000 });
    assert.ok(existsSync(join(claudeDir, 'gsd')), 'premise: installed');
    execFileSync(process.execPath, [join(link, 'uninstall.js')], { cwd: dir, env, encoding: 'utf8', timeout: 60000 });
    assert.equal(existsSync(join(claudeDir, 'gsd')), false, 'the runtime is still there');
  });

  // The updater extracts a release under os.tmpdir() and runs its install.js
  // from there. On macOS that directory is under /var, a symlink to
  // /private/var, so this is every npx install's update there.
  it('the updater installs a release it extracted under a symlinked TMPDIR', async (t) => {
    const { dir, claudeDir } = await withLinkedRoot(t);
    const realTmp = join(dir, 'real-tmp');
    const linkedTmp = join(dir, 'tmp-link');
    await mkdir(realTmp);
    await symlink(realTmp, linkedTmp, 'dir');
    assert.notEqual(realpathSync(linkedTmp), linkedTmp, 'premise: the TMPDIR is a symlink');

    // A release tarball as GitHub serves one: a single top-level directory
    // holding the package. node_modules is present and empty so install.js
    // copies it rather than running npm.
    const pkg = join(dir, 'pkg', 'gsd-lite-9.9.9');
    for (const entry of ['install.js', 'uninstall.js', 'package.json', 'package-lock.json', 'src', 'hooks', 'commands', 'agents', 'workflows', 'references']) {
      await cp(join(PROJECT_ROOT, entry), join(pkg, entry), { recursive: true });
    }
    await mkdir(join(pkg, 'node_modules'));
    const tarball = join(dir, 'release.tar.gz');
    const tar = spawnSync('tar', ['czf', tarball, '-C', join(dir, 'pkg'), 'gsd-lite-9.9.9']);
    assert.equal(tar.status, 0, `tar: ${tar.stderr}`);
    const bytes = await readFile(tarball);

    const saved = { TMPDIR: process.env.TMPDIR, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, HOME: process.env.HOME };
    t.after(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
    process.env.TMPDIR = linkedTmp;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    process.env.HOME = join(dir, 'home');
    const req = createRequire(import.meta.url);
    const source = join(PROJECT_ROOT, 'hooks', 'gsd-auto-update.cjs');
    delete req.cache[req.resolve(source)];
    const updater = req(source);
    t.after(() => { delete req.cache[req.resolve(source)]; });

    const ok = await updater.downloadAndInstall('https://codeload.github.com/sdsrss/gsd-lite/tar.gz/refs/tags/v9.9.9', false, null, {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      }),
    });
    assert.equal(ok, true, 'premise: the updater reports an install');
    assert.ok(existsSync(join(claudeDir, 'gsd', 'src', 'server.js')), 'the updater reported success and installed nothing');
  });
});
