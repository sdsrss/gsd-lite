import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// Not import.meta.dirname: that landed in 20.11 and package.json says >=20.0.0.
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Issue #9: a fixture's teardown raced a background git process and failed with
 * ENOTEMPTY on .git/objects/pack — in whichever of the nine git fixtures
 * happened to lose, never the same one twice. `git commit` forks
 * `git maintenance run --auto --detach`, which is still writing when the
 * finally-block rm walks the repo.
 *
 * The fix is one global config for the whole suite (tests/gitconfig, wired by
 * tests/git-sandbox.cjs). These tests assert the *property* that fix depends
 * on — the writer does not get forked — rather than re-running one fixture and
 * hoping. They go red if the preload stops being wired into the npm scripts, if
 * the fixture config loses the setting, or if git stops honouring it.
 */
describe('git sandbox: no background writer races fixture teardown (#9)', () => {
  function gitRepo(fn) {
    const dir = mkdtempSync(join(tmpdir(), 'gsd-gitsandbox-'));
    try {
      const init = spawnSync('git', ['init', '-q', '.'], { cwd: dir, encoding: 'utf-8' });
      assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('the suite runs under a fixture GIT_CONFIG_GLOBAL', () => {
    // Without this the other two assertions would be testing the developer's
    // own ~/.gitconfig and would pass or fail for reasons that have nothing to
    // do with this repo.
    const cfg = process.env.GIT_CONFIG_GLOBAL;
    assert.ok(cfg, 'GIT_CONFIG_GLOBAL is not set — is --require ./tests/git-sandbox.cjs still in the npm test script?');
    assert.equal(cfg, join(HERE, 'gitconfig'), 'GIT_CONFIG_GLOBAL points somewhere other than the suite fixture');
    assert.ok(existsSync(cfg), `GIT_CONFIG_GLOBAL points at a file that does not exist: ${cfg}`);
  });

  it('git actually reads gc.auto = 0 from it', () => {
    // Asserting on git's own answer, not on the bytes we wrote: a config file
    // git declines to read (wrong path, bad syntax) is worth nothing here.
    gitRepo((dir) => {
      const read = (key) => spawnSync('git', ['config', '--get', key], { cwd: dir, encoding: 'utf-8' }).stdout.trim();
      assert.equal(read('gc.auto'), '0', 'git does not see gc.auto=0');
      assert.equal(read('gc.autoDetach'), 'false', 'git does not see gc.autoDetach=false');
      assert.equal(read('maintenance.auto'), 'false', 'git does not see maintenance.auto=false');
    });
  });

  it('git commit forks no background gc or maintenance process', () => {
    // The narrowest artifact that can be wrong: git's own trace of what it
    // spawned. Under the default config this trace carries three
    // `git maintenance run --auto --detach` lines.
    gitRepo((dir) => {
      writeFileSync(join(dir, 'README.md'), 'init\n');
      assert.equal(spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf-8' }).status, 0);
      const commit = spawnSync('git', ['commit', '-q', '-m', 'init'], {
        cwd: dir,
        encoding: 'utf-8',
        env: { ...process.env, GIT_TRACE: '1' },
      });
      assert.equal(commit.status, 0, `git commit failed: ${commit.stderr}`);

      const trace = commit.stderr || '';
      // Vacuity guard: an empty trace would satisfy the real assertion below
      // for the wrong reason (GIT_TRACE ignored, stderr not captured).
      assert.match(trace, /trace: built-in: git commit/, 'GIT_TRACE produced no usable trace — the check below would pass on an empty string');

      const spawned = trace.split('\n').filter(l => /run_command:.*\bgit\s+(gc|maintenance)\b/.test(l));
      assert.deepEqual(spawned, [], `git commit forked a background writer that can race fixture teardown:\n${spawned.join('\n')}`);
    });
  });
});

// A pre-commit hook in a linked worktree runs the suite with git's own
// repository variables exported, and GIT_DIR there is absolute. Every fixture
// that ran git in its temp dir then ran it against the real repository: one
// hook run left the shared .git/config with core.bare = true and the
// worktree's index holding a single file (2026-10-21). In the main checkout
// GIT_DIR is the relative `.git`, which happens to resolve inside each temp
// dir, so nothing showed there. The preload drops the variables that point
// git at a repository, an index or an object store.
describe('git sandbox: the suite never inherits a repository from the hook that ran it', () => {
  it('a fixture\'s git writes its own repository, not the one GIT_DIR named', () => {
    const outer = mkdtempSync(join(tmpdir(), 'gsd-gitsandbox-outer-'));
    const fixture = mkdtempSync(join(tmpdir(), 'gsd-gitsandbox-fixture-'));
    try {
      assert.equal(spawnSync('git', ['init', '-q', outer]).status, 0);
      const env = {
        ...process.env,
        GIT_DIR: join(outer, '.git'),
        GIT_INDEX_FILE: join(outer, '.git', 'index'),
        GIT_WORK_TREE: outer,
      };
      const script = "require('node:child_process').execFileSync('git', ['init', '-q', '.']);"
        + "require('node:child_process').execFileSync('git', ['config', 'core.bare', 'true']);";
      const run = spawnSync(process.execPath, ['--require', join(HERE, 'git-sandbox.cjs'), '-e', script], { cwd: fixture, env, encoding: 'utf-8' });
      assert.equal(run.status, 0, run.stderr);
      const outerBare = spawnSync('git', ['config', '--file', join(outer, '.git', 'config'), 'core.bare'], { encoding: 'utf-8' }).stdout.trim();
      assert.equal(outerBare, 'false', 'the repository GIT_DIR named was written');
      assert.equal(existsSync(join(fixture, '.git')), true, 'the fixture got its own repository');
    } finally {
      rmSync(outer, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
