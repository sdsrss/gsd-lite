// scripts/gate-replay-changed.sh decides, per commit range, whether a VACUOUS
// verdict is a finding or is the question being unanswerable. That decision had
// two bugs in two review rounds and no test either time:
//
//   1. excluding every `*.md` classified 71271dd — the documented vacuous commit
//      the whole mechanism exists for — as test-only, because it changes only
//      agents/*.md and tests/. Shipped prompt templates are source.
//   2. reusing the `--diff-filter=AMR` list for the classification hid source
//      DELETIONS, so removing src/foo.js while editing a test was exempted.
//
// Both were found by a reviewer reading the rule, not by running it. These pin
// the rule against this repository's own history, which is what the bugs were
// about: real commit shapes, not invented ones.
//
// The script resolves its own repo root from BASH_SOURCE, so it always operates
// on this checkout. That is why the fixtures are real SHAs rather than scratch
// repos — and it makes them durable: these commits cannot change.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function replay(base, at) {
  // NODE_TEST_CONTEXT must not reach the child. The script runs `node --test`,
  // and Node refuses to recurse: inside a test file it prints "run() is being
  // called recursively within a test file. skipping running files" and exits
  // having run nothing, which the replay correctly reports as INCONCLUSIVE.
  // Every assertion below would then be about the harness rather than the rule —
  // the first draft of this file did exactly that, and the verdict it read was
  // INCONCLUSIVE for a reason that has nothing to do with the commit.
  // GIT_* must not reach it either, and this one was found the hard way: the
  // first version of this file made the PRE-COMMIT HOOK fail nondeterministically.
  // `git commit` exports GIT_INDEX_FILE and GIT_DIR into its hooks, the hook runs
  // the suite, the suite spawns this script, and the script's `git worktree add`
  // inherits a GIT_DIR pointing at a repository mid-commit. The script is correct;
  // the test was handing it a poisoned environment. A flaky test in the
  // pre-commit path is worse than no test, so the child gets a clean one.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST') || key.startsWith('GIT_')) delete env[key];
  }
  const run = spawnSync('bash', [join(repoRoot, 'scripts', 'gate-replay-changed.sh'), base, at], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 300_000,
    env,
  });
  return { code: run.status, out: `${run.stdout || ''}${run.stderr || ''}` };
}

// `git rev-parse --verify` rather than assuming: a shallow clone would make
// every assertion below pass for the wrong reason, which is the shape of defect
// this file exists to stop.
function haveCommit(sha) {
  return spawnSync('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).status === 0;
}

// Missing history means two different things and they need different answers.
//
// In CI it means `fetch-depth: 0` was lost from the workflow, which would
// silently disable every test in this file — the write-only shape the gate these
// tests guard was built to stop. That must fail, loudly.
//
// On a developer's shallow clone it means the question cannot be asked here. A
// failure there is noise, and noise is how a suite stops being read. Skip, and
// say which commit is missing so the reason is never a mystery.
//
// The first version failed in both cases, which turned "unanswerable" into
// "broken" and reddened CI on a correct tree.
function requireCommit(t, sha) {
  if (haveCommit(sha)) return true;
  if (process.env.CI) {
    assert.fail(`${sha} is missing in CI — .github/workflows/ci.yml lost its fetch-depth: 0, and these tests silently check nothing without it`);
  }
  t.skip(`${sha} not in this clone (shallow) — run \`git fetch --unshallow\` to exercise this`);
  return false;
}

describe('the vacuity gate fires on source changes and not on test-only ones', () => {
  // The guard that would have caught the above at authoring time rather than
  // months later when someone tidies up branches.
  const PINNED = ['ab5d536', '406fd3a', '331dcda', '14e64fa'];

  it('pins only commits that main can reach', (t) => {
    if (!haveCommit('ab5d536')) return void t.skip('shallow clone — nothing to check');

    // Scans the CODE for every SHA literal rather than trusting the PINNED
    // list, because the first version trusted the list and that is exactly what
    // let a stray through: a bulk rename updated `'71271dd'` but not
    // `'71271dd^'`, the array looked right, and CI failed on missing history
    // while this clone still had the object.
    //
    // Comments are stripped first — this file names retired SHAs in its own
    // prose on purpose, and a raw scan would flag the history it is recording.
    const code = readFileSync(join(repoRoot, 'tests', 'gate-replay-changed.test.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    const shas = [...new Set((code.match(/'[0-9a-f]{7,40}\^?'/g) || []).map((m) => m.slice(1, -1).replace(/\^$/, '')))];
    assert.ok(shas.length >= 4, `expected the pinned fixtures in code, found ${shas.length}`);
    assert.deepEqual(shas.slice().sort(), PINNED.slice().sort(),
      'the SHAs used in code and the PINNED list have drifted apart; one of them is wrong');

    const unreachable = shas.filter((sha) => spawnSync(
      'git', ['-C', repoRoot, 'merge-base', '--is-ancestor', sha, 'main'],
    ).status !== 0);
    assert.deepEqual(unreachable, [],
      'these are reachable only from a feature branch, so deleting that branch makes them '
      + `disappear from a fresh clone and this whole file fails on missing history: ${unreachable.join(', ')}`);
  });

  it('fails on the documented vacuous commit, which changes only shipped prompts', (t) => {
    // ab5d536 changes agents/executor.md, agents/reviewer.md and one test. Under
    // a naive "*.md is documentation" rule that reads as test-only and the whole
    // mechanism goes quiet on the one case it was built for.
    //
    // It is the rebased landing of 71271dd, which is the SHA the runbook and the
    // script header name. This file used to pin 71271dd itself and that broke:
    // the repo merges with --rebase, so a feature branch's original commits are
    // never ancestors of main, and deleting the merged branch makes them
    // unreachable. CI's clone then cannot see them and the suite fails on
    // missing history rather than on the code. Pin what main can reach.
    if (!requireCommit(t, 'ab5d536')) return;
    const { code, out } = replay('ab5d536^', 'ab5d536');
    assert.equal(code, 1, `a vacuous gate over shipped prompts must fail the job:\n${out.slice(-600)}`);
    assert.match(out, /VACUOUS/, 'and say why');
    assert.doesNotMatch(out, /TEST-ONLY RANGE/, 'agents/*.md are shipped prompt templates, which are source');
  });

  it('exempts a genuinely test-only range', (t) => {
    // 406fd3a touches tests/recovery.test.js and nothing else. Its tests describe
    // the base tree, so they pass on it by construction; VACUOUS carries no
    // information and must not fail the job.
    if (!requireCommit(t, '406fd3a')) return;
    const { code, out } = replay('406fd3a^', '406fd3a');
    assert.equal(code, 0, `a test-only range must not fail:\n${out.slice(-600)}`);
    assert.match(out, /TEST-ONLY RANGE/, 'and must say that is why, not pass silently');
  });

  it('does not exempt a range that DELETES a source file', (t) => {
    // 331dcda deletes src/tools/orchestrator.js and touches tests.
    //
    // HONEST LIMIT, because the alternative is a test that reads stronger than
    // it is: this does NOT discriminate the bug it is named for. 331dcda also
    // MODIFIES source, so it is classified source-touching under both the buggy
    // and the fixed classifier. Swept all 400 commits of history — no commit
    // exists whose only source change is a deletion, so no real SHA can isolate
    // the shape. The behavioural case is proven in a scratch repo (see the
    // commit message); what pins the fix here is the source-level assertion
    // below, which does go red on the revert.
    if (!requireCommit(t, '331dcda')) return;
    const { out } = replay('331dcda^', '331dcda');
    assert.doesNotMatch(out, /TEST-ONLY RANGE/,
      `deleting source is a source change; this range must stay subject to the gate:\n${out.slice(-600)}`);
  });

  it('computes the source-touched test from an UNFILTERED diff', () => {
    // The assertion that actually pins the deletion fix, and it is a source-level
    // gate rather than a behavioural one for the reason stated above.
    //
    // Two lists exist on purpose: `--diff-filter=AMR` answers "which test files
    // can be replayed at `at`" (a deleted test cannot), and the unfiltered list
    // answers "did this range touch source". Reusing the first for the second
    // hides D and T, so deleting a source file counted as touching nothing.
    const src = readFileSync(join(repoRoot, 'scripts', 'gate-replay-changed.sh'), 'utf8');
    const line = src.split('\n').find((l) => l.includes('grep -vE "$NOT_SOURCE"'));
    assert.ok(line, 'the source-touched classifier moved — re-point this test at it');
    assert.match(line, /\$ALL_CHANGED/,
      'the classifier must read the unfiltered list; the --diff-filter=AMR one cannot see a deletion');
    assert.doesNotMatch(line, /\$REPLAYABLE/,
      'reading the replayable-files list here is the bug: AMR excludes D, so deleting source reads as touching nothing');

    // Vacuity guard: prove the two lists are actually built from different
    // commands, or the assertion above is about a name and not a behaviour.
    assert.match(src, /REPLAYABLE=\$\(git .*--diff-filter=AMR/,
      'REPLAYABLE must be the filtered list');
    assert.match(src, /ALL_CHANGED=\$\(git -C "\$ROOT" diff --name-only "\$BASE" "\$AT"\)/,
      'ALL_CHANGED must be built with no --diff-filter at all');
  });

  it('pins the test reporter instead of inheriting Node\'s default', () => {
    // A source-level gate, because the bug is version-dependent and a
    // behavioural test can only ever exercise whichever Node is running it.
    //
    // Node picks its default reporter from whether stdout is a TTY: 20 and 22
    // emit TAP when piped, 24+ emit `spec` either way. gate-replay.js parsed
    // only `spec` (`ℹ tests N`), so under 20 and 22 it read a good TAP summary
    // as "no summary printed" and returned INCONCLUSIVE — which does not fail
    // anything. The gate was blind on two of the three supported Node versions
    // and said nothing, because INCONCLUSIVE is a legitimate verdict. It
    // surfaced only when a test of the gate ran under the CI matrix.
    const src = readFileSync(join(repoRoot, 'scripts', 'gate-replay.js'), 'utf8');
    assert.match(src, /'--test-reporter=tap'/,
      'the reporter must be pinned, or the verdict depends on which Node runs it');
    assert.match(src, /\^# \$\{label\} \(\\\\d\+\)\$/,
      'and the summary parser must read TAP, matching the reporter that is pinned');
    assert.doesNotMatch(src, /\^ℹ \$\{label\}/,
      'the spec-format parser is what made this version-dependent');
  });

  it('passes an ordinary fix whose tests were red on the base tree', (t) => {
    // The other direction: the gate must be quiet on work that earns it, or it
    // becomes a check people route around.
    if (!requireCommit(t, '14e64fa')) return;
    const { code, out } = replay('14e64fa^', '14e64fa');
    assert.equal(code, 0, `an ordinary fix must pass:\n${out.slice(-600)}`);
    assert.match(out, /DISCRIMINATIVE/, 'because its tests were red on the base tree');
  });
});
