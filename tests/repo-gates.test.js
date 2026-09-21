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
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

describe('repo gates — the prompt layer never hands an agent a bare relative doc path', () => {
  // An agent runs with the USER'S project as its working directory. A path like
  // `references/questioning.md` resolves there, finds nothing, and the
  // instruction silently does not happen — the executor never reads the TDD and
  // anti-rationalization workflows that are the product's whole point.
  //
  // It is not fixable by picking a better relative path either: install.js puts
  // npx-mode copies at ~/.claude/references/gsd/ while the plugin system serves
  // <root>/references/, so the same file sits at different depths and no single
  // relative string is right for both.
  //
  // This gate is the deliverable. The individual rewrites are not: this class
  // has come back in this repo every time a fix landed at a call site instead of
  // in something that fails loudly when the next one appears.
  const promptFiles = execFileSync('git', ['ls-files', 'commands/*.md', 'agents/*.md', 'workflows/*.md', 'references/*.md'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).split('\n').filter(Boolean);

  it('finds prompt files to check', () => {
    // Vacuity guard: an empty corpus would satisfy the assertion below without
    // reading anything.
    assert.ok(promptFiles.length >= 20, `expected the shipped prompt layer, found ${promptFiles.length} files`);
  });

  it('no prompt file names a bare relative references/ or workflows/ path', () => {
    const offenders = [];
    for (const file of promptFiles) {
      const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Backticks are NOT required. Requiring them is how this gate shipped
        // matching zero lines on its own tree: the six sites fixed alongside it
        // were backticked, two live instructions were not
        // (`commands/prd.md` "使用 references/questioning.md 的提问技巧",
        // `commands/resume.md` "按 references/execution-loop.md 执行循环"), and
        // the gate could see only the form already fixed. A gate that cannot
        // fail on the tree it ships with is the vacuous kind this file exists
        // to prevent.
        //
        // Backticks are not excluded here: excluding them was the first
        // attempt and it simply swapped one blind spot for the other, seeing
        // the bare form and missing the quoted one. The only exclusions are a
        // preceding `/` or word character, so a longer path that legitimately
        // contains these segments (~/.claude/references/gsd/x.md) is not a
        // false positive.
        //
        // The resolved form needs no exclusion: `<docs.workflows>/x.md` spells
        // `workflows>` rather than `workflows/`, so it cannot match. Prose that
        // merely says the word "workflows" cannot match either — a filename is
        // required.
        for (const m of line.matchAll(/(?:^|[^/\w])((?:references|workflows)\/[A-Za-z0-9._-]+\.md)/g)) {
          offenders.push(`${file}:${i + 1} → ${m[1]}`);
        }
      });
    }
    assert.deepEqual(offenders, [],
      `these resolve against the user's project, where they do not exist. Take the absolute path from the health tool's \`docs\` map instead:\n  ${offenders.join('\n  ')}`);
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

// Two scripts scrape the suite's own summary line for a test count:
// scripts/pre-commit.sh syncs it into CLAUDE.md, and scripts/sync-versions.js
// does the same on `npm version` and `prepublishOnly`. Both matched `# tests N`,
// which is the TAP reporter's form. `npm test` here is plain `node --test`, whose
// default reporter prints `ℹ tests N`, so both parsers matched nothing on every
// Node this repo supports — and both failed silently, because "found no count"
// runs the same code path as "count already correct".
//
// In pre-commit.sh the empty result was load-bearing rather than merely useless:
// section 4's "skip if the tests already ran" guard keys off that same variable,
// so an always-empty count made every commit touching tests/ run the full suite
// twice.
//
// The gate feeds each parser BOTH reporter forms. Checking only the one node
// prints today would be passed by a parser pinned to today's reporter, which is
// the defect itself — this repo has now shipped that shape twice (the prompt-path
// gate above matched only the form it was written beside).
describe('repo gates — the test-count parsers read the reporter this repo actually runs', () => {
  // Both decoys are load-bearing, and they pin different halves of the parse.
  //
  // The one BEFORE the summary is why the parser must take the last match: a
  // test name ending in digits otherwise wins on a first-match read.
  //
  // The one AFTER the summary is why the digits must be anchored to end of line.
  // It is not hypothetical: node's spec reporter reprints every failing test's
  // name under `✖ failing tests:`, below the counts. So on a red run — the run
  // where this matters — a test name is the LAST line mentioning "tests", and an
  // unanchored pattern reads 99 out of it no matter which match it takes.
  const REPORTERS = {
    spec: [
      '✔ parses tests 7',
      'ℹ tests 1439',
      'ℹ suites 313',
      'ℹ pass 1439',
      'ℹ fail 1',
      '✖ failing tests:',
      '✖ counts the tests 99 it was given (0.4ms)',
    ].join('\n'),
    tap: [
      'ok 1 - parses tests 7',
      'not ok 2 - counts the tests 99 it was given',
      '1..2',
      '# tests 1439',
      '# suites 313',
      '# pass 1438',
      '# fail 1',
    ].join('\n'),
  };

  // Comment lines are stripped first, for the reason withoutComments() above
  // exists: both scripts explain the old broken pattern in a comment beside the
  // fixed one, so a raw search finds the prose and reports the fix as unmade.
  // Caught by this gate on its own first run.
  function lineContaining(file, marker) {
    const src = readFileSync(join(repoRoot, 'scripts', file), 'utf8');
    const line = src
      .split('\n')
      .filter(l => !/^\s*(\/\/|#)/.test(l))
      .find(l => l.includes(marker));
    assert.ok(line, `scripts/${file} has no non-comment line containing ${marker} — this gate is pointed at nothing`);
    return line;
  }

  // Both tests below RUN the parsing line out of the script rather than
  // re-implementing it here. Re-implementing is what makes a gate drift from the
  // thing it guards: an earlier draft of this one extracted only the regex and
  // did the "take the last match" step itself, so deleting `tail -1` from the
  // hook would have left it green.
  it('pre-commit.sh reads the count in both reporter formats', () => {
    const line = lineContaining('pre-commit.sh', 'ACTUAL_COUNT=$(');
    for (const [name, output] of Object.entries(REPORTERS)) {
      const got = execFileSync('bash', ['-c', `TEST_OUT=$(cat)\n${line.trim()}\nprintf '%s' "$ACTUAL_COUNT"`], {
        input: output, encoding: 'utf8',
      });
      assert.equal(got, '1439',
        `pre-commit.sh read ${JSON.stringify(got)} from ${name}-reporter output, not the summary count 1439. The line run was:\n  ${line.trim()}`);
    }
  });

  it('sync-versions.js reads the count in both reporter formats', () => {
    const matchLine = lineContaining('sync-versions.js', 'matchAll(');
    const pickLine = lineContaining('sync-versions.js', 'countMatches.at(');
    const parse = new Function('testOutput', `${matchLine}\n${pickLine}\nreturn countMatch?.[1];`);
    for (const [name, output] of Object.entries(REPORTERS)) {
      const got = parse(output);
      assert.equal(got, '1439',
        `sync-versions.js read ${JSON.stringify(got)} from ${name}-reporter output, not the summary count 1439. The lines run were:\n  ${matchLine.trim()}\n  ${pickLine.trim()}`);
    }
  });

  it('the runner these scripts shell out to still prints a line the patterns can read', () => {
    // The fixtures above are this gate's model of node's output. If node changes
    // its reporter again, the fixtures keep passing while the real thing breaks —
    // exactly the failure being fixed. So assert against a real run too, on a
    // throwaway file rather than this suite, which would recurse.
    const dir = mkdtempSync(join(tmpdir(), 'gsd-reporter-'));
    try {
      const probe = join(dir, 'probe.test.js');
      writeFileSync(probe, "import {it} from 'node:test';it('probe',()=>{});\n");
      // NODE_TEST_CONTEXT is set in every file the runner spawns. A grandchild
      // that inherits it switches to the machine protocol the parent runner
      // consumes, and prints no human summary at all — which reads here exactly
      // like "node stopped printing the line", the thing this asserts about.
      const { NODE_TEST_CONTEXT: _drop, ...env } = process.env;
      const real = execFileSync('node', ['--test', probe], { encoding: 'utf8', timeout: 60000, env });
      assert.match(real, /^\s*[#ℹ] tests \d+\s*$/m,
        `the runner no longer prints a \`tests N\` summary line in either known form, so both parsers above are reading a format that no longer exists:\n${real}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
