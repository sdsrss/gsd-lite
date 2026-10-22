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
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    worktrees() {
      return git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '));
    },
    replay(file, extraEnv = {}) {
      const run = spawnSync(process.execPath, [join(root, 'scripts', 'gate-replay.js'), file], { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 120_000 });
      return { code: run.status, out: `${run.stdout || ''}${run.stderr || ''}` };
    },
    start(file, extraEnv = {}) {
      return spawn(process.execPath, [join(root, 'scripts', 'gate-replay.js'), file], { cwd: root, env: { ...env, ...extraEnv }, stdio: 'ignore' });
    },
  };
}

const HEADER = `import { describe, it, before, after, afterEach } from 'node:test';
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
    assert.match(out, /INCONCLUSIVE — 2 of 2 tests have no result of their own/);
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

  // Node counts a test that timed out under `# cancelled`, next to the ones
  // that never ran — and a hang is a red, the shape of the bug half the
  // fixes here are about. The hang holds a live timer: a promise with nothing
  // pending lets the event loop drain first, which Node 20 and 22 report as
  // cancelled (not run) rather than as a timeout.
  it('counts a test that timed out on the base tree as a failure', (t) => {
    const repo = fixtureRepo(t);
    repo.commit({
      'src.cjs': 'module.exports = 2;\n',
      'tests/hang.test.js': `${HEADER}
it('answers', { timeout: 300 }, () => (require('../src.cjs') === 2 ? undefined : new Promise((resolve) => setTimeout(resolve, 2000))));
`,
    });
    const { code, out } = repo.replay('tests/hang.test.js');
    assert.equal(code, 0, out);
    assert.match(out, /DISCRIMINATIVE — 1\/1 failed/);
  });

  // A failing top-level before() makes Node report every test as failed
  // (hookFailed), though none of them ran.
  it('does not credit tests whose top-level setup failed', (t) => {
    const repo = fixtureRepo(t);
    repo.commit({
      'src.cjs': 'module.exports = 2;\n',
      'tests/toplevel.test.js': `${HEADER}
before(() => { if (require('../src.cjs') !== 2) throw new Error('setup needs the fix'); });
it('a', () => {});
it('b', () => {});
`,
    });
    const { code, out } = repo.replay('tests/toplevel.test.js');
    assert.equal(code, 2, out);
    assert.match(out, /INCONCLUSIVE — 2 of 2 tests have no result of their own/);
    assert.match(out, /setup needs the fix/);
  });

  // Second pre-tag review: each of these was read as something it is not.
  it('does not count a failing todo test as a red', (t) => {
    const repo = fixtureRepo(t);
    repo.commit({ 'src.cjs': 'module.exports = 2;\n', 'tests/todo.test.js': `${HEADER}
it('passes', () => {});
it('known bug', { todo: true }, () => { throw new Error('expected to fail'); });
` });
    const { code, out } = repo.replay('tests/todo.test.js');
    assert.equal(code, 1, out);
    assert.match(out, /VACUOUS — 1\/2 passed/);
  });

  it('reports a failing afterEach as a hook failure, not as a test that never ran', (t) => {
    const repo = fixtureRepo(t);
    repo.commit({ 'src.cjs': 'module.exports = 2;\n', 'tests/teardown.test.js': `${HEADER}
afterEach(() => { if (require('../src.cjs') !== 2) throw new Error('teardown needs the fix'); });
it('x', () => {});
` });
    const { code, out } = repo.replay('tests/teardown.test.js');
    assert.equal(code, 2, out);
    assert.match(out, /a hook failed before or after "x": .*teardown needs the fix/);
    assert.doesNotMatch(out, /never ran/);
  });

  it('counts a suite that timed out on the base tree as a failure', (t) => {
    const repo = fixtureRepo(t);
    repo.commit({ 'src.cjs': 'module.exports = 2;\n', 'tests/slowsuite.test.js': `${HEADER}
describe('slow suite', { timeout: 300 }, () => {
  it('waits', () => (require('../src.cjs') === 2 ? undefined : new Promise((resolve) => setTimeout(resolve, 2000))));
});
` });
    const { code, out } = repo.replay('tests/slowsuite.test.js');
    assert.equal(code, 0, out);
    // Not "1/1 failed": that was the suite counted as one of its own tests.
    assert.match(out, /DISCRIMINATIVE — 1 suite timed out/);
    assert.match(out, /✖ slow suite/);
  });

  it('does not call a file vacuous when a describe threw before registering its tests', (t) => {
    const repo = fixtureRepo(t);
    repo.commit({ 'src.cjs': 'module.exports = 2;\n', 'tests/collect.test.js': `${HEADER}
describe('needs the fix to collect', () => {
  if (require('../src.cjs') !== 2) throw new Error('collection needs the fix');
  it('a', () => {});
});
it('other', () => {});
` });
    const { code, out } = repo.replay('tests/collect.test.js');
    assert.equal(code, 2, out);
    assert.match(out, /INCONCLUSIVE — 1 suite threw while declaring its tests/);
    assert.doesNotMatch(out, /\b0 of \d+ tests/, 'no test lacks a result; the suite does');
    assert.match(out, /needs the fix to collect/);
  });

  // Third pre-tag review of 0.17.2 (left open then, fixed in 0.19.0).
  it('reports a failing suite-level after() as a hook failure, not as a vacuous pass', (t) => {
    const repo = fixtureRepo(t);
    repo.commit({ 'src.cjs': 'module.exports = 2;\n', 'tests/suite-teardown.test.js': `${HEADER}
describe('suite', () => {
  after(() => { if (require('../src.cjs') !== 2) throw new Error('teardown needs the fix'); });
  it('x', () => {});
});
` });
    const { code, out } = repo.replay('tests/suite-teardown.test.js');
    assert.equal(code, 2, out);
    assert.match(out, /INCONCLUSIVE/);
    assert.match(out, /a hook failed in "suite": .*teardown needs the fix/);
  });

  it('says a describe threw, rather than "0 of 1 tests have no result", when that is all that happened', (t) => {
    const repo = fixtureRepo(t);
    repo.commit({ 'src.cjs': 'module.exports = 2;\n', 'tests/only-collect.test.js': `${HEADER}
describe('needs the fix to collect', () => {
  if (require('../src.cjs') !== 2) throw new Error('collection needs the fix');
  it('a', () => {});
});
` });
    const { code, out } = repo.replay('tests/only-collect.test.js');
    assert.equal(code, 2, out);
    assert.match(out, /INCONCLUSIVE — 1 suite threw while declaring its tests/);
    assert.doesNotMatch(out, /\b0 of \d+ tests/);
    assert.match(out, /"needs the fix to collect" threw while declaring its tests: .*collection needs the fix/);
  });

  it('counts a suite that timed out apart from the tests it holds', (t) => {
    const repo = fixtureRepo(t);
    repo.commit({ 'src.cjs': 'module.exports = 2;\n', 'tests/slow-three.test.js': `${HEADER}
describe('slow suite', { timeout: 300 }, () => {
  it('waits', () => (require('../src.cjs') === 2 ? undefined : new Promise((resolve) => setTimeout(resolve, 2000))));
  it('b', () => {});
  it('c', () => {});
});
` });
    const { code, out } = repo.replay('tests/slow-three.test.js');
    assert.equal(code, 0, out);
    assert.match(out, /DISCRIMINATIVE — 1 suite timed out/);
    assert.doesNotMatch(out, /\b1\/3 failed/, 'a suite counted as one of the three tests');
    assert.match(out, /✖ slow suite/);
  });

  // A hang with nothing pending lets the event loop drain before the timeout:
  // Node 20 and 22 then report every test still pending or not yet started as
  // cancelled with this error, and do not say which one hung, so the replay
  // cannot tell a red from a test that never ran: INCONCLUSIVE, saying why.
  // 24 and later report the hang as the timeout it is. Counting every drained
  // test as a failure (the first version of this) listed tests that never ran
  // as red, and called a hanging before() DISCRIMINATIVE (pre-tag review).
  const DRAINS = Number(process.versions.node.split('.')[0]) < 24;

  it('a test that hangs on the base tree is red where Node can say so, and never names a test that did not run', (t) => {
    const repo = fixtureRepo(t);
    repo.commit({ 'src.cjs': 'module.exports = 2;\n', 'tests/drained.test.js': `${HEADER}
it('hangs', { timeout: 500 }, () => (require('../src.cjs') === 2 ? undefined : new Promise(() => {})));
it('after it', () => {});
` });
    const { code, out } = repo.replay('tests/drained.test.js');
    assert.doesNotMatch(out, /✖ after it/, 'a test that never ran is listed as failing');
    if (DRAINS) {
      assert.equal(code, 2, out);
      assert.match(out, /INCONCLUSIVE — .*still pending when the event loop ran dry/);
    } else {
      assert.equal(code, 0, out);
      assert.match(out, /DISCRIMINATIVE — 1\/2 failed/);
      assert.match(out, /✖ hangs/);
    }
  });

  it('a before() that never finishes on the base tree is no red', (t) => {
    const repo = fixtureRepo(t);
    repo.commit({ 'src.cjs': 'module.exports = 2;\n', 'tests/stuck-setup.test.js': `${HEADER}
describe('suite', () => {
  before(() => (require('../src.cjs') === 2 ? undefined : new Promise(() => {})), { timeout: 500 });
  it('a', () => {});
  it('b', () => {});
});
` });
    const { code, out } = repo.replay('tests/stuck-setup.test.js');
    assert.equal(code, 2, out);
    assert.match(out, /INCONCLUSIVE/);
  });

  // With no timeout of its own, a hang held the runner, and the replay with
  // it, forever; killed by hand, it left its worktree behind (pre-tag review,
  // as old as the script). The run has a bound, past which nothing is judged.
  it('a run that does not finish is stopped, judged INCONCLUSIVE, and its worktree removed', (t) => {
    const repo = fixtureRepo(t);
    repo.commit({ 'src.cjs': 'module.exports = 2;\n', 'tests/forever.test.js': `${HEADER}
it('waits', () => (require('../src.cjs') === 2 ? undefined : new Promise((resolve) => setTimeout(resolve, 20_000))));
` });
    const { code, out } = repo.replay('tests/forever.test.js', { GATE_REPLAY_RUN_TIMEOUT_MS: '3000' });
    assert.equal(code, 2, out);
    assert.match(out, /INCONCLUSIVE — the replay did not finish in 3 s/);
    assert.equal(repo.worktrees().length, 1, `a worktree was left: ${repo.worktrees().join(', ')}`);
  });

  // Stopped at the bound, the runner alone was killed: the file process it
  // started kept running (forever, with a handle open), and what the tests
  // made in the temp directory stayed there (delta review).
  const HANGS = `${HEADER}import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('hangs', () => {
  if (require('../src.cjs') === 2) return undefined;
  const dir = mkdtempSync(join(tmpdir(), 'gsd-replay-leftover-'));
  writeFileSync(process.env.REPLAY_PROBE, JSON.stringify({ pid: process.pid, dir }));
  setInterval(() => {}, 1000);
  return new Promise(() => {});
});
`;
  // Where the hanging test says what it made, in a directory of its own, so
  // this cleans up after a replay that did not, whatever else is removed first.
  function probed(t) {
    const home = mkdtempSync(join(tmpdir(), 'gsd-replay-probe-'));
    const file = join(home, 'probe.json');
    t.after(() => {
      if (existsSync(file)) {
        const { pid, dir } = JSON.parse(readFileSync(file, 'utf8'));
        try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
        rmSync(dir, { recursive: true, force: true });
      }
      rmSync(home, { recursive: true, force: true });
    });
    return file;
  }
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  async function gone(pid) {
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    return !alive(pid);
  }

  it('a run stopped at its bound leaves no process and nothing in the temp directory', async (t) => {
    const repo = fixtureRepo(t);
    repo.commit({ 'src.cjs': 'module.exports = 2;\n', 'tests/hangs.test.js': HANGS });
    const probe = probed(t);
    const { code, out } = repo.replay('tests/hangs.test.js', { GATE_REPLAY_RUN_TIMEOUT_MS: '3000', REPLAY_PROBE: probe });
    assert.equal(code, 2, out);
    assert.match(out, /did not finish in 3 s/);
    const { pid, dir } = JSON.parse(readFileSync(probe, 'utf8'));
    assert.ok(await gone(pid), 'the test file\'s process is still running');
    assert.equal(existsSync(dir), false, `${dir} was left`);
  });

  it('a replay stopped by a signal stops its run and removes its worktree', async (t) => {
    const repo = fixtureRepo(t);
    repo.commit({ 'src.cjs': 'module.exports = 2;\n', 'tests/hangs.test.js': HANGS });
    const probe = probed(t);
    const child = repo.start('tests/hangs.test.js', { REPLAY_PROBE: probe });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    t.after(() => child.kill('SIGKILL'));
    for (let i = 0; i < 200 && !existsSync(probe); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(existsSync(probe), 'premise: the test started');
    child.kill('SIGTERM');
    assert.deepEqual(await exited, { code: 143, signal: null });
    const { pid, dir } = JSON.parse(readFileSync(probe, 'utf8'));
    assert.ok(await gone(pid), 'the test file\'s process is still running');
    assert.equal(existsSync(dir), false, `${dir} was left`);
    assert.equal(repo.worktrees().length, 1, `a worktree was left: ${repo.worktrees().join(', ')}`);
  });

  for (const value of ['-1', '0', '1.5', 'thirty']) {
    it(`refuses a run bound of ${value}`, (t) => {
      const repo = fixtureRepo(t);
      repo.commit({ 'src.cjs': 'module.exports = 2;\n', 'tests/a.test.js': `${HEADER}it('a', () => { assert.equal(require('../src.cjs'), 2); });\n` });
      const { code, out } = repo.replay('tests/a.test.js', { GATE_REPLAY_RUN_TIMEOUT_MS: value });
      assert.equal(code, 2, out);
      assert.match(out, /^REFUSED — GATE_REPLAY_RUN_TIMEOUT_MS/m);
      assert.equal(repo.worktrees().length, 1);
    });
  }

  it('does not count a todo suite that timed out as a red', (t) => {
    const repo = fixtureRepo(t);
    repo.commit({ 'src.cjs': 'module.exports = 2;\n', 'tests/todo-suite.test.js': `${HEADER}
describe('later', { todo: true, timeout: 300 }, () => {
  it('waits', () => (require('../src.cjs') === 2 ? undefined : new Promise((resolve) => setTimeout(resolve, 2000))));
});
it('passes', () => {});
` });
    const { code, out } = repo.replay('tests/todo-suite.test.js');
    assert.equal(code, 1, out);
    assert.match(out, /VACUOUS — 1\/\d+ passed/);
  });

  it('does not call a file whose every test was skipped vacuous', (t) => {
    const repo = fixtureRepo(t);
    repo.commit({ 'src.cjs': 'module.exports = 2;\n', 'tests/skipped.test.js': `${HEADER}\nit.skip('later', () => {});\n` });
    const { code, out } = repo.replay('tests/skipped.test.js');
    assert.equal(code, 2, out);
    assert.match(out, /INCONCLUSIVE — every test in the file was skipped/);
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
