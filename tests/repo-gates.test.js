// Repo-level gates: checks that a quality gate this repo *declares* is actually
// wired up, rather than only described. git silently refuses to run a hook file
// that is not executable — it prints an advice line and commits anyway — so a
// pre-commit hook tracked as 100644 is a gate that has never fired for anyone
// who cloned the repo.
//
// This file covers the git-tracked mode of every hook `npm run prepare` installs.
// It does NOT check that `prepare` actually ran in a given checkout, that the
// symlink exists, or that the hook script itself passes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Derive the hook scripts from package.json's `prepare` script rather than
 * hardcoding a list — a second hook added there is covered automatically.
 * `ln -sf ../../scripts/pre-commit.sh .git/hooks/pre-commit` yields
 * "scripts/pre-commit.sh" (the target is relative to .git/hooks/).
 */
function hookScriptsFromPrepare() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const prepare = pkg.scripts?.prepare || '';
  const targets = [];
  for (const m of prepare.matchAll(/ln\s+-\w*\s+(\S+)\s+\.git\/hooks\/(\S+)/g)) {
    targets.push({ repoPath: normalize(join('.git/hooks', m[1])), hookName: m[2] });
  }
  return targets;
}

describe('repo gates — git hooks are executable', () => {
  const hooks = hookScriptsFromPrepare();

  it('package.json prepare installs at least one git hook', () => {
    // Guards the derivation itself: if prepare stops installing hooks, this test
    // would otherwise pass vacuously by iterating an empty list.
    assert.ok(hooks.length > 0, 'expected package.json scripts.prepare to install a git hook');
    assert.ok(
      hooks.some(h => h.hookName === 'pre-commit'),
      `expected a pre-commit hook among ${JSON.stringify(hooks)}`,
    );
  });

  for (const { repoPath, hookName } of hooks) {
    it(`${repoPath} is tracked executable, so the ${hookName} hook runs after a fresh clone`, () => {
      const entry = execFileSync('git', ['ls-files', '-s', '--', repoPath], {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim();
      assert.ok(entry, `${repoPath} is not tracked by git`);
      const mode = entry.split(/\s+/)[0];
      assert.equal(
        mode,
        '100755',
        `${repoPath} is tracked as ${mode}; git refuses to run a non-executable hook, so the ${hookName} gate never fires. Fix with: git update-index --chmod=+x ${repoPath}`,
      );
    });
  }
});

// A relative link in a tracked markdown file points at a path a reader is
// expected to be able to open. Linking a path that is gitignored or deleted
// gives every reader on GitHub and npm a 404, and nothing in the repo notices.
//
// This covers relative links in tracked .md files. It does NOT check external
// http(s) links, anchor fragments, or whether the linked file says anything
// useful.
describe('repo gates — markdown links resolve', () => {
  const trackedMarkdown = execFileSync('git', ['ls-files', '*.md'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).split('\n').filter(Boolean);

  const links = trackedMarkdown.flatMap(mdPath =>
    [...readFileSync(join(repoRoot, mdPath), 'utf8').matchAll(/\]\(([^)\s]+)\)/g)]
      .map(m => m[1])
      .filter(t => !/^(https?:|mailto:|#)/.test(t))
      .map(t => ({ mdPath, target: t.split('#')[0] }))
      .filter(l => l.target),
  );

  // Vacuity guard: this suite is one assertion over a corpus, so an empty corpus
  // would make it pass without checking anything. Deleting the last relative
  // link in the repo should turn this red, not quiet.
  it('finds relative markdown links to check', () => {
    assert.ok(trackedMarkdown.includes('README.md'), 'expected README.md among tracked markdown');
    assert.ok(links.length > 0, 'no relative markdown links found — the link check below would be vacuous');
  });

  it('every relative markdown link resolves', () => {
    const broken = links
      .filter(l => !existsSync(join(repoRoot, dirname(l.mdPath), l.target)))
      .map(l => `${l.mdPath} → ${l.target}`);
    assert.deepEqual(broken, [], `markdown links to paths that do not exist:\n  ${broken.join('\n  ')}`);
  });
});
