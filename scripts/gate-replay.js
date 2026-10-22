#!/usr/bin/env node

/**
 * Replay a test file against the tree it was written to fix.
 *
 * A test added alongside a fix is only worth its line count if it was RED on
 * the tree before the fix. Checking that by reverting the fix by hand tests one
 * mutation — the one you just performed — and three times in this repo a gate
 * written that way passed on a tree that already violated it. `/等|举例不是穷举/`
 * is the clearest case: `等` is an ordinary character every prompt already
 * contained, so the assertion could not fail, and the defect it named shipped
 * underneath it.
 *
 * This replays the WHOLE test file on the base revision's tree instead. No
 * regex extraction, no judgement about which assertion encodes the fix, and it
 * works the same for a prose gate and a behavioural one:
 *
 *     node scripts/gate-replay.js tests/untrusted-checkout.test.js
 *     node scripts/gate-replay.js --base 58b438a --at 71271dd tests/foo.test.js
 *
 * Three outcomes, and the third is the one that makes this honest:
 *
 *   DISCRIMINATIVE  some test failed on the base tree. The failing names are
 *                   printed, because "red" is not the claim — "red for the
 *                   reason the gate names" is, and only a reader can confirm
 *                   that. A test that fails on the base tree because a helper
 *                   it imports did not exist yet reads exactly like a test that
 *                   earns its place.
 *   VACUOUS         every test passed on the base tree. The file encodes
 *                   nothing the commit fixed. Exit 1.
 *   INCONCLUSIVE    nothing was evaluated — the file could not load against
 *                   that tree, or it declared no tests at all. NOT a pass and
 *                   not a failure; the replay says nothing. Exit 2.
 *
 * A question that cannot have a vacuity answer is REFUSED (also exit 2) rather
 * than answered: base and at the same commit, or a path that does not exist at
 * `at`. Both used to produce a verdict — one a confident VACUOUS, the other a
 * stack trace at exit 1, which is the code VACUOUS uses.
 *
 * A test without a result of its own — cancelled by its parent, behind a hook
 * that failed, or never declared because its describe threw — is neither a
 * pass nor a failure, so a file with such tests and no failure is
 * INCONCLUSIVE, never VACUOUS. A timeout, a test's or a suite's, is a failure;
 * a TODO or SKIP test is no result.
 *
 * Nothing is written inside the repo: the base tree is a detached worktree in a
 * temp dir, removed on exit, and its node_modules holds a symlink to each of
 * this checkout's packages.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

function parseArgs(argv) {
  const opts = { base: null, at: 'HEAD', files: [] };
  for (let i = 0; i < argv.length; i++) {
    // `--base` as the final argument takes undefined, and `opts.base ||=` below
    // then falls back to `at^` — a silent answer to a different question, which
    // is the defect this whole script is about.
    if (argv[i] === '--base' || argv[i] === '--at') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('-')) throw new Error(`${argv[i - 1]} needs a revision`);
      if (argv[i - 1] === '--base') opts.base = value;
      else opts.at = value;
    } else if (argv[i].startsWith('-')) throw new Error(`unknown flag ${argv[i]}`);
    else opts.files.push(argv[i]);
  }
  if (!opts.files.length) throw new Error('usage: gate-replay.js [--base <rev>] [--at <rev>] <test file>...');
  // Default: the parent of the revision the tests come from. That is the tree
  // the author was looking at, which is the tree the gate has to reject.
  opts.base ||= `${opts.at}^`;
  return opts;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  // A usage error exits 2 with its own sentence, like every other question this
  // script declines to answer. Letting it throw printed a stack trace, which is
  // the shape a reader reads as "the tool broke", not "you asked it wrong".
  console.log(`REFUSED — ${err.message}`);
  process.exit(2);
}
const baseSha = git('rev-parse', '--short', opts.base);
const atSha = git('rev-parse', '--short', opts.at);

// A degenerate question deserves a refusal, not a verdict. Replaying a file on
// its own tree passes by construction, and printing VACUOUS for it would be
// this script making exactly the claim it exists to catch.
if (git('rev-parse', opts.base) === git('rev-parse', opts.at)) {
  console.log(`REFUSED — base and at are the same commit (${baseSha}). A file replayed on`);
  console.log('its own tree passes by construction; that is not a vacuity result.');
  process.exit(2);
}

// Read every file out of `at` BEFORE creating anything, so a typo fails here
// with its own message rather than as a stack trace at exit 1 — the code that
// also means VACUOUS, which would let a mistyped path read as a verdict.
const sources = new Map();
for (const file of opts.files) {
  try {
    sources.set(file, git('show', `${opts.at}:${file}`));
  } catch {
    console.log(`REFUSED — ${file} does not exist at ${atSha}. Nothing was replayed.`);
    process.exit(2);
  }
}

// The run has a bound. A test that hangs on the base tree with no timeout
// of its own held the runner, and this replay with it, forever. Past the
// bound there is no verdict. Not a per-test --test-timeout: Node 22 applies it
// to each file's process as a whole, so a slow file (e2e-install takes
// minutes) would read as a red.
const boundSetting = process.env.GATE_REPLAY_RUN_TIMEOUT_MS;
const runTimeout = boundSetting === undefined || boundSetting === '' ? 30 * 60_000 : Number(boundSetting);
// A timer holds at most 2^31 - 1 ms; past that Node fires it at once.
if (!Number.isSafeInteger(runTimeout) || runTimeout <= 0 || runTimeout > 2 ** 31 - 1) {
  console.log(`REFUSED — GATE_REPLAY_RUN_TIMEOUT_MS must be a whole number of milliseconds from 1 to 2147483647, not "${boundSetting}". Nothing was replayed.`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'gsd-gate-replay-'));
const tree = join(work, 'tree');
// What the tests make in the temp directory goes here and is removed with the
// rest: a run stopped at its bound, or a test that does not clean up, left
// its directories in the system's.
const scratch = join(work, 'tmp');

// The creating task disposes its own sandbox; a leftover worktree also leaves
// a registration behind in .git/worktrees that `git worktree list` then shows.
function cleanup() {
  try { git('worktree', 'remove', '--force', tree); } catch { /* never registered */ }
  rmSync(work, { recursive: true, force: true });
}

// The runner and the file processes it starts run as one process group, and
// a stop takes the group: killed alone, the runner left each file process
// running, and one with a handle open ran on for good (delta review). And
// every process under the runner, whatever group it put itself in: a test
// that starts its steps detached (tests/e2e-install.test.js does, for each
// npm step) leaves the group, and those ran on (final review). The tree is
// read before anything is killed, since a killed parent's children go to
// init. What a run that finished left outside the group is not reached.
function descendants(pid) {
  let table;
  try {
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const children = new Map();
  for (const line of table.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const found = [];
  for (const queue = [pid]; queue.length > 0;) {
    for (const child of children.get(queue.shift()) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

let stopRun = () => {};
function runBounded(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { ...options, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const stop = () => {
      const tree = descendants(child.pid);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      for (const pid of tree) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      }
    };
    stopRun = stop;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stop(); }, runTimeout);
    child.on('error', (err) => { clearTimeout(timer); rejectRun(err); });
    // Whatever of the group outlives the runner is a file process it left.
    child.on('exit', () => { clearTimeout(timer); stop(); });
    child.on('close', () => {
      stopRun = () => {};
      resolveRun({ stdout, stderr, timedOut });
    });
  });
}

// Interrupted, the replay stops its run and removes what it made; killed by a
// signal before, it left its worktree registered (delta review).
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(signal, () => {
    stopRun();
    cleanup();
    process.exit(code);
  });
}

let exitCode = 0;
try {
  git('worktree', 'add', '--detach', tree, baseSha);
  // symlinkSync happily creates a DANGLING link when the target is absent, and
  // the replay then fails to load every import and reports INCONCLUSIVE — which
  // does not fail the job. A skipped `npm ci` would therefore read as "nothing
  // was evaluated" rather than as a broken checker. Say so instead.
  if (!existsSync(join(root, 'node_modules'))) {
    throw new Error(`node_modules is missing at ${root} — run npm ci first; without it every replay is INCONCLUSIVE for the wrong reason`);
  }
  // A directory of links, not one link to the directory. install.js copies a
  // checkout's node_modules with mkdir + cpSync, and cpSync on a symlink source
  // copies the link and then throws EEXIST against the directory mkdir made —
  // which cancelled every Layer A suite of tests/e2e-install.test.js on replay.
  mkdirSync(join(tree, 'node_modules'));
  for (const entry of readdirSync(join(root, 'node_modules'))) {
    symlinkSync(join(root, 'node_modules', entry), join(tree, 'node_modules', entry));
  }

  for (const [file, src] of sources) {
    // The test as written AT `at`, on the tree as it stood at `base`.
    mkdirSync(join(tree, dirname(file)), { recursive: true });
    writeFileSync(join(tree, file), `${src}\n`);
  }

  console.log(`replaying ${opts.files.join(', ')}\n  as written at ${atSha}\n  on the tree at ${baseSha}\n`);
  // The reporter is PINNED, and the bug it closes was silent. Node picks its
  // default reporter from whether stdout is a TTY: 20 and 22 emit TAP when
  // piped, 24 and later emit `spec` either way. This parser only ever understood
  // `spec` (`ℹ tests N`), so on Node 20 and 22 it read a perfectly good TAP
  // summary as "no summary printed" and returned INCONCLUSIVE — which does not
  // fail anything. The gate was blind on two of the three Node versions this
  // project supports, and nothing said so, because INCONCLUSIVE is a legitimate
  // verdict rather than an error. Surfaced only when a test OF the gate ran it
  // under the CI matrix instead of on one developer's Node.
  mkdirSync(scratch);
  const run = await runBounded(
    process.execPath,
    ['--require', './tests/git-sandbox.cjs', '--test', '--test-reporter=tap', ...opts.files],
    { cwd: tree, env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch } },
  );
  const out = `${run.stdout}${run.stderr}`;

  const num = (label) => {
    const m = out.match(new RegExp(`^# ${label} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const tests = num('tests');
  const fail = num('fail');

  // TAP names every result on its own line, and a failing SUITE gets one too —
  // so the naive list came out longer than the count above it (3 names under
  // "2/42 failed"), which is the small incoherence that teaches a reader to skim
  // output. Each result carries a YAML block naming its `type`, so leaves are
  // separable from their enclosing describe without guessing from indentation.
  const lines = out.split('\n');
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(not ok|ok) \d+ - (.+)$/);
    if (!m) continue;
    // The type, and for a failure its failureType and error, sit in the YAML
    // block between this result and the next one.
    let type = null;
    let failureType = null;
    let error = null;
    for (let j = i + 1; j < lines.length && !/^\s*(not ok|ok) \d+ - /.test(lines[j]); j++) {
      type ??= lines[j].match(/^\s*type: '(\w+)'/)?.[1] ?? null;
      failureType ??= lines[j].match(/^\s*failureType: '(\w+)'/)?.[1] ?? null;
      error ??= lines[j].match(/^\s*error: (.+)$/)?.[1] ?? null;
    }
    const skipped = / # (SKIP|TODO)\b/.test(m[3]);
    results.push({ ok: m[2] === 'ok', name: m[3].replace(/ # (SKIP|TODO)\b.*$/, '').trim(), type, failureType, error, skipped, indent: m[1].length });
  }
  // A suite's result follows its children's, one level out, so a result's
  // parent is the next one less indented. A TODO or SKIP suite makes what it
  // holds the same: Node 20 does not mark a todo suite's tests themselves.
  for (let i = results.length - 1; i >= 0; i--) {
    const parent = results.slice(i + 1).find((r) => r.indent < results[i].indent);
    if (parent?.skipped) results[i].skipped = true;
  }
  // The verdict is read from each result's failureType, not from the summary
  // counts, because Node's counts do not say what ran: a test that timed out
  // is counted under `# cancelled` beside the ones that never ran, a test
  // behind a failing hook under `# fail`, and a failing `todo` is a `not ok`
  // counted nowhere. So:
  //   - a TODO or SKIP test is no result (a todo is expected to fail);
  //   - cancelledByParent never ran, and hookFailed is the hook's result
  //     (before or after the body — TAP does not say which), not the test's;
  //   - a timeout is a red, a test's or a whole suite's (its tests are then
  //     reported as cancelled). A test still pending when the event loop ran
  //     dry is the same hang on Node 20 and 22, which report it as
  //     cancelledByParent where 24 and later report the timeout, but they
  //     give every test not yet finished that same result and do not say
  //     which one hung: no result, said so. Counting them all as red named
  //     tests that never ran and called a stuck before() DISCRIMINATIVE;
  //   - a describe whose callback threw registered none of its tests, and a
  //     suite whose before or after hook failed is the hook's result, as a
  //     test's hook is.
  // `type` is absent on a bare result line, and on every test result under
  // Node 20; keep those rather than dropping a real failure over a missing
  // diagnostic.
  const NO_RESULT = ['cancelledByParent', 'hookFailed'];
  const DRAINED = /Promise resolution is still pending but the event loop has already resolved/;
  const leafResults = results.filter((r) => r.type !== 'suite' && !r.skipped);
  const suiteResults = results.filter((r) => r.type === 'suite' && !r.skipped);
  const failingTests = leafResults.filter((r) => !r.ok && !NO_RESULT.includes(r.failureType)).map((r) => r.name);
  const timedOutSuites = suiteResults.filter((r) => r.failureType === 'testTimeoutFailure').map((r) => r.name);
  const failing = [...failingTests, ...timedOutSuites];
  const noResult = leafResults.filter((r) => !r.ok && NO_RESULT.includes(r.failureType));
  const drained = noResult.filter((r) => DRAINED.test(r.error ?? ''));
  const brokenSuites = suiteResults.filter((r) => r.failureType === 'testCodeFailure');
  const suiteHookFailures = suiteResults.filter((r) => r.failureType === 'hookFailed');
  // Counted apart, each against its own kind: a suite is not one of the
  // tests it holds, and "1/3 failed" read as a test where a suite timed out.
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const noResultParts = [
    noResult.length > 0 && `${noResult.length} of ${plural(tests, 'test', 'tests')} have no result of their own`,
    drained.length > 0 && `${plural(drained.length, 'was', 'were')} still pending when the event loop ran dry (how Node ${process.versions.node.split('.')[0]} reports a hang, without saying which test hung)`,
    brokenSuites.length > 0 && `${plural(brokenSuites.length, 'suite threw while declaring its tests', 'suites threw while declaring their tests')}`,
    suiteHookFailures.length > 0 && `${plural(suiteHookFailures.length, 'suite\'s hook failed', 'suites\' hooks failed')}`,
  ].filter(Boolean);
  const passing = leafResults.filter((r) => r.ok).map((r) => r.name);
  const hookFailures = results.filter((r) => !r.ok && r.failureType === 'hookFailed');
  const printWhy = () => {
    for (const r of hookFailures) {
      console.log(`  a hook failed${r.type === 'suite' ? ` in "${r.name}"` : ` before or after "${r.name}"`}: ${(r.error ?? '').slice(0, 200)}`);
    }
    for (const r of brokenSuites) console.log(`  "${r.name}" threw while declaring its tests: ${(r.error ?? '').slice(0, 200)}`);
  };

  // Node names a FILE as the test when the file contributed no test of its own,
  // in both directions: one failing test named after the file when it could not
  // load, one PASSING test named after it when it loaded and declared nothing.
  // Both read as ordinary results. The first version of this script had neither
  // check and certified a replay against a tree missing src/agent-payload.js as
  // DISCRIMINATIVE; review then pointed a replay at a source file and got
  // `VACUOUS — 1/1 passed`, which tells the reader their gate is worthless when
  // the truth is that they typed the wrong path. A script whose whole thesis is
  // verdicts that look real and are not does not get to have one.
  const didNotLoad = failingTests.filter((name) => opts.files.includes(name));
  const declaredNothing = passing.filter((name) => opts.files.includes(name));
  // Message first, error code second: the code matches node's own `throw new
  // ERR_MODULE_NOT_FOUND(` line in the stack, which names the class and not the
  // module that is missing.
  const loadError = (out.match(/^.*(Cannot find module|Cannot find package|SyntaxError:|ERR_UNKNOWN_FILE_EXTENSION).*$/m)
    || out.match(/^.*ERR_MODULE_NOT_FOUND.*$/m) || [])[0];

  if (run.timedOut) {
    console.log(`INCONCLUSIVE — the replay did not finish in ${Math.round(runTimeout / 1000)} s on ${baseSha} and was stopped; nothing was judged.`);
    exitCode = 2;
  } else if (tests === null || fail === null) {
    console.log('INCONCLUSIVE — the runner printed no summary. Raw output:\n');
    console.log(out.trim().split('\n').slice(-25).join('\n'));
    exitCode = 2;
  } else if (declaredNothing.length) {
    console.log(`INCONCLUSIVE — ${declaredNothing.join(', ')} declared no tests against ${baseSha}.`);
    console.log('\nNode reports a file containing no test as ONE PASSING test named after the');
    console.log('file, which is indistinguishable from a suite that passed. Nothing was');
    console.log('gated, so there is no vacuity result to give. Check the path is a test file.');
    exitCode = 2;
  } else if ((tests === 0 && noResultParts.length === 0) || didNotLoad.length) {
    console.log(`INCONCLUSIVE — ${didNotLoad.join(', ') || 'the file'} did not load against ${baseSha}.`);
    if (loadError) console.log(`  ${loadError.trim()}`);
    console.log('\nNode reports an unloadable file as one failing test named after the file, so');
    console.log('this looks like a red and is not one: no assertion was ever evaluated. Replay');
    console.log('against a base where the file\'s imports resolve — usually the commit\'s own');
    console.log('parent rather than a distant branch point.');
    exitCode = 2;
  } else if (failing.length > 0) {
    const red = [
      failingTests.length > 0 && `${failingTests.length}/${tests} failed`,
      timedOutSuites.length > 0 && plural(timedOutSuites.length, 'suite timed out', 'suites timed out'),
    ].filter(Boolean).join(' and ');
    console.log(`DISCRIMINATIVE — ${red} on ${baseSha}:\n`);
    for (const name of [...new Set(failing)]) console.log(`  ✖ ${name}`);
    if (noResultParts.length > 0) {
      console.log(`\n  (also: ${noResultParts.join('; ')})`);
      printWhy();
    }
    console.log('\nRead the failures before believing them. A test that goes red on the base tree');
    console.log('for an unrelated reason — a missing import, a helper added by the same commit —');
    console.log('is indistinguishable from one that earns its place, except by reading it.');
  } else if (noResultParts.length > 0) {
    console.log(`INCONCLUSIVE — ${noResultParts.join('; ')} on ${baseSha}.`);
    printWhy();
    console.log('\nA test whose setup or teardown failed, or that was never declared, was neither');
    console.log('passed nor failed. The rest passing says nothing about these. Replay against a');
    console.log('base where the setup succeeds, or read why it failed above.');
    exitCode = 2;
  } else if (passing.length === 0) {
    console.log(`INCONCLUSIVE — every test in the file was skipped on ${baseSha}; nothing was evaluated.`);
    exitCode = 2;
  } else {
    console.log(`VACUOUS — ${passing.length}/${tests} passed on ${baseSha}.`);
    console.log(`Every test in this file is green on the tree ${atSha} was written to change, so`);
    console.log('the file encodes nothing that commit fixed. Assert the property, not a token of it.');
    exitCode = 1;
  }
} finally {
  cleanup();
}

process.exit(exitCode);
