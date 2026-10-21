// scripts/gate-replay.js on fixture histories: a throwaway repository holding
// a copy of the script, so the commits it replays can be built to the shape a
// case needs. tests/gate-replay-changed.test.js pins the range rule against
// this repository's real history; this file pins the verdict itself.
//
// Two ways the verdict was wrong, both found replaying tests/e2e-install.test.js
// for 0.17.1, which printed "VACUOUS — 35/35 passed" with 21 tests cancelled:
//
//   1. A test cancelled because a hook or its parent failed was never
//      evaluated, and TAP reports it under `# cancelled` with `# fail 0`. The
//      script read only `# fail`, so cancelled counted as passed.
//   2. The replay tree's node_modules was one symlink to the checkout's, and
//      install.js copies node_modules with mkdir + cpSync, which on a symlink
//      source throws EEXIST — so every Layer A suite was cancelled by (1).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');

function fixtureRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'gsd-replay-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Same reason as gate-replay-changed.test.js: a GIT_* variable from a
  // pre-commit hook would point every git below at the real repository.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST') || key.startsWith('GIT_')) delete env[key];
  }
  env.GIT_CONFIG_GLOBAL = join(repoRoot, 'tests', 'gitconfig');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'fixture');
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'tests'));
  cpSync(join(repoRoot, 'scripts', 'gate-replay.js'), join(root, 'scripts', 'gate-replay.js'));
  cpSync(join(repoRoot, 'tests', 'git-sandbox.cjs'), join(root, 'tests', 'git-sandbox.cjs'));
  cpSync(join(repoRoot, 'tests', 'gitconfig'), join(root, 'tests', 'gitconfig'));
  mkdirSync(join(root, 'node_modules', 'fixture-dep'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'fixture-dep', 'package.json'), '{"name":"fixture-dep","version":"1.0.0","main":"index.js"}\n');
  writeFileSync(join(root, 'node_modules', 'fixture-dep', 'index.js'), 'module.exports = "dep";\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(root, 'src.cjs'), 'module.exports = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return {
    commit(files) {
      for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
      git('add', '-A');
      git('commit', '-q', '-m', 'fix');
    },
    replay(file) {
      const run = spawnSync(process.execPath, [join(root, 'scripts', 'gate-replay.js'), file], { cwd: root, env, encoding: 'utf8', timeout: 120_000 });
      return { code: run.status, out: `${run.stdout || ''}${run.stderr || ''}` };
    },
  };
}

const HEADER = `import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
`;

describe('gate-replay', () => {
  it('does not call a file vacuous when its tests were cancelled rather than run', (t) => {
    const repo = fixtureRepo(t);
    repo.commit({
      'src.cjs': 'module.exports = 2;\n',
      'tests/setup.test.js': `${HEADER}
describe('needs the fix to set up', () => {
  before(() => { if (require('../src.cjs') !== 2) throw new Error('setup needs the fix'); });
  it('a', () => {});
  it('b', () => {});
});
`,
    });
    const { code, out } = repo.replay('tests/setup.test.js');
    assert.doesNotMatch(out, /VACUOUS/, out);
    assert.equal(code, 2, `INCONCLUSIVE exits 2:\n${out}`);
    assert.match(out, /INCONCLUSIVE — 2 of 2 tests were cancelled/);
    assert.match(out, /needs the fix to set up/, 'and it names the suite whose hook failed');
  });

  it('still calls a file discriminative when one test failed and others were cancelled', (t) => {
    const repo = fixtureRepo(t);
    repo.commit({
      'src.cjs': 'module.exports = 2;\n',
      'tests/mixed.test.js': `${HEADER}
it('fixed value', () => { assert.equal(require('../src.cjs'), 2); });
describe('needs the fix to set up', () => {
  before(() => { if (require('../src.cjs') !== 2) throw new Error('setup needs the fix'); });
  it('a', () => {});
});
`,
    });
    const { code, out } = repo.replay('tests/mixed.test.js');
    assert.equal(code, 0, out);
    assert.match(out, /DISCRIMINATIVE — 1\/2 failed/);
    assert.match(out, /✖ fixed value/);
    assert.doesNotMatch(out, /✖ a$/m, 'a cancelled test is not listed as a failure');
  });

  it('gives the replay tree a node_modules that install.js can copy', (t) => {
    const repo = fixtureRepo(t);
    repo.commit({
      'src.cjs': 'module.exports = 2;\n',
      // The copy install.js makes of a checkout's node_modules (copyDir).
      'tests/install-copy.test.js': `${HEADER}
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
describe('a copied runtime', () => {
  let dest;
  before(() => {
    dest = join(mkdtempSync(join(tmpdir(), 'gsd-replay-copy-')), 'node_modules');
    mkdirSync(dest, { recursive: true });
    cpSync(join(import.meta.dirname, '..', 'node_modules'), dest, { recursive: true });
  });
  after(() => rmSync(join(dest, '..'), { recursive: true, force: true }));
  it('resolves its dependencies', () => { assert.equal(require(join(dest, 'fixture-dep')), 'dep'); });
  it('runs the fixed code', () => { assert.equal(require('../src.cjs'), 2); });
});
`,
    });
    const { code, out } = repo.replay('tests/install-copy.test.js');
    assert.equal(code, 0, out);
    assert.match(out, /DISCRIMINATIVE — 1\/2 failed/, 'the copy works on the base tree, and only the fixed assertion is red');
    assert.match(out, /✖ runs the fixed code/);
  });
});
