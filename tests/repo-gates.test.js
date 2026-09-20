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
 * Drop whole-line comments before searching a workflow for step content.
 *
 * The gates below assert on the ORDER and PRESENCE of steps. A raw substring
 * search reads the file's prose too, and these workflows deliberately name the
 * steps their comments explain: the publish job's `permissions:` block has to
 * say why `npm publish` runs before the GitHub Release step, which puts the
 * string "npm publish" near the top of the job, far above the step that runs
 * it. `indexOf` then compares a comment against a step and reports a correct
 * workflow as broken. Strip first, search second.
 */
function withoutComments(yaml) {
  return yaml
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

function readWorkflow(name) {
  return withoutComments(readFileSync(join(repoRoot, '.github', 'workflows', name), 'utf8'));
}

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

describe('repo gates — the release workflow signs before it publishes', () => {
  // npm publish cannot be undone. The signing-key preflight only checked that
  // the secret was non-empty; the step that asserts it actually pairs with the
  // RELEASE_PUBLIC_KEY committed in the client ran afterwards. Rotate the secret
  // without updating the embedded key and the sequence was: npm gets the new
  // version permanently, the release job then fails, no signed GitHub Release
  // exists, and every auto-update client — which reads GitHub Releases, not npm
  // — fails closed and never sees the update again.
  const workflow = readWorkflow('release.yml');
  const stepAt = (needle) => {
    const at = workflow.indexOf(needle);
    assert.notEqual(at, -1, `release.yml no longer contains ${JSON.stringify(needle)} — update this gate`);
    return at;
  };

  it('verifies the signature against the embedded public key before npm publish', () => {
    assert.ok(
      stepAt('verifyReleaseSignature') < stepAt('npm publish'),
      'the key-pairing assertion must run before the irreversible publish',
    );
  });

  it('packs and signs before npm publish', () => {
    assert.ok(stepAt('npm pack') < stepAt('npm publish'), 'pack before publish');
    assert.ok(stepAt('createPrivateKey') < stepAt('npm publish'), 'sign before publish');
  });

  it('keeps the coverage thresholds where they can actually fail', () => {
    // CI's coverage gate is node's own --test-coverage-* thresholds inside this
    // script (it was c8's --check-coverage until c8 stopped loading on current
    // Node). A second "Check coverage threshold" step used to sit in ci.yml
    // shelling out to `c8 report`, which is not on PATH inside `run:` — so it
    // printed "Could not parse coverage, skipping" and exited 0 on every build.
    // Moving the numbers out of here without replacing the gate would leave the
    // same gap, quietly.
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    const coverage = pkg.scripts['test:coverage'];
    assert.match(coverage, /--experimental-test-coverage/);
    assert.match(coverage, /--test-coverage-lines=\d+/);
    assert.match(coverage, /--test-coverage-branches=\d+/);

    // Pin the deletion too, not just the survivor. Asserting only on
    // package.json — which this change never touched — passes identically on the
    // commit before it, so on its own it is a guard against a future edit rather
    // than evidence the no-op step is gone.
    const ci = readWorkflow('ci.yml');
    assert.ok(!/c8 report/.test(ci),
      'ci.yml still shells out to `c8 report`, which is not on PATH inside run: — that step cannot fail');
    assert.ok(!/name:.*Check coverage threshold/.test(ci));
  });

  it('runs the coverage gate only on the Node versions that have the flags', () => {
    // --test-coverage-lines / --test-coverage-branches landed in Node 22.8. On
    // Node 20 they are unknown options: node exits before running a single
    // test, so the 20 leg of the matrix has to run `npm test` instead. Folding
    // the two steps back into one `npm run test:coverage` turns that leg red
    // for a reason that has nothing to do with the code under review — and the
    // obvious "fix" for that red is to drop 20, which is the engines floor.
    const ci = readWorkflow('ci.yml');
    assert.match(ci, /node-version:\s*\[[^\]]*\b20\b[^\]]*\]/,
      'Node 20 is the engines floor and must stay in the CI matrix');

    // Split into step blocks so an `if:` is read against its own step rather
    // than whichever condition happens to sit above it in the file.
    const steps = ci.split(/\n\s{6}- /).slice(1);
    const coverageSteps = steps.filter(s => /run:[\s\S]*npm run test:coverage/.test(s));
    assert.equal(coverageSteps.length, 1,
      `expected exactly one step running the coverage gate, found ${coverageSteps.length}`);
    assert.match(coverageSteps[0], /if:\s*matrix\.node-version\s*!=\s*20/,
      'the coverage step must skip Node 20, whose node binary rejects the threshold flags outright');

    const plainTestSteps = steps.filter(s => /run:\s*npm test\b/.test(s));
    assert.equal(plainTestSteps.length, 1,
      'Node 20 must still run the suite — without this step the 20 leg tests nothing');
    assert.match(plainTestSteps[0], /if:\s*matrix\.node-version\s*==\s*20/);
  });

  it('grants the publish job the two writes it needs, and the run no more', () => {
    // Narrowing the publish job to read-only does not make the release safer:
    // `npm publish` runs before the GitHub Release step, so a job that cannot
    // write the Release still ships to npm — leaving a version on npm with no
    // signed Release behind it, which is exactly the state auto-update clients
    // fail closed on. `id-token: write` is what `--provenance` exchanges for a
    // Sigstore attestation. The top level stays read-only so `validate` — which
    // runs `npm ci` over the whole dependency tree first — never holds a
    // write-capable token.
    const topLevel = workflow.slice(0, workflow.indexOf('\njobs:'));
    assert.match(topLevel, /permissions:\s*\n\s+contents: read/,
      'release.yml grants write at the top level, so every job inherits it');

    const publishJob = workflow.slice(workflow.indexOf('\n  publish:'));
    assert.match(publishJob, /permissions:\s*\n\s+contents: write\s*\n\s+id-token: write/,
      'the publish job needs contents: write for the Release and id-token: write for provenance');
    assert.match(publishJob, /npm publish .*--provenance/,
      'provenance is what ties the published tarball to this workflow and commit');
  });

  it('publishes the same tarball it hashed and signed', () => {
    // Publishing the directory instead of the packed file would let npm and the
    // GitHub Release asset differ, and the sha256 in the release body describes
    // only the asset.
    assert.match(workflow, /npm publish "\$TARBALL" --access public/,
      'npm publish must be handed the packed tarball, not the working directory');
  });
});

describe('repo gates — actions are pinned to commit SHAs', () => {
  // A floating tag is mutable by the action's owner: `@v5` can point at
  // different code tomorrow, and whatever it points at runs inside this repo's
  // CI — in release.yml's case, alongside the npm token and the signing key. A
  // 40-hex SHA cannot be repointed. The trailing `# v5` comment is how a reader
  // still knows which major is pinned, so it is kept and searched past.
  for (const name of ['ci.yml', 'release.yml']) {
    it(`${name} pins every action to a full commit SHA`, () => {
      const uses = [...readWorkflow(name).matchAll(/uses:\s*(\S+)/g)].map(m => m[1]);
      // Vacuity guard: a workflow that stopped using actions entirely would
      // otherwise satisfy an "all of them are pinned" assertion over nothing.
      assert.ok(uses.length > 0, `${name} has no \`uses:\` entries — this gate would pass vacuously`);
      const floating = uses.filter(u => !/@[0-9a-f]{40}$/.test(u));
      assert.deepEqual(floating, [],
        `pin to the commit SHA of the major, not the tag: ${floating.join(', ')}`);
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
