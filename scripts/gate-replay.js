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
 *   INCONCLUSIVE    no tests ran — the file could not load against that tree.
 *                   NOT a pass and not a failure; the replay says nothing.
 *                   Exit 2.
 *
 * Nothing is written inside the repo: the base tree is a detached worktree in a
 * temp dir, removed on exit, and node_modules is a symlink to this checkout's.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

function parseArgs(argv) {
  const opts = { base: null, at: 'HEAD', files: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') opts.base = argv[++i];
    else if (argv[i] === '--at') opts.at = argv[++i];
    else if (argv[i].startsWith('-')) throw new Error(`unknown flag ${argv[i]}`);
    else opts.files.push(argv[i]);
  }
  if (!opts.files.length) throw new Error('usage: gate-replay.js [--base <rev>] [--at <rev>] <test file>...');
  // Default: the parent of the revision the tests come from. That is the tree
  // the author was looking at, which is the tree the gate has to reject.
  opts.base ||= `${opts.at}^`;
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const baseSha = git('rev-parse', '--short', opts.base);
const atSha = git('rev-parse', '--short', opts.at);
const work = mkdtempSync(join(tmpdir(), 'gsd-gate-replay-'));
const tree = join(work, 'tree');

let exitCode = 0;
try {
  git('worktree', 'add', '--detach', tree, baseSha);
  symlinkSync(join(root, 'node_modules'), join(tree, 'node_modules'));

  for (const file of opts.files) {
    // The test as written AT `at`, on the tree as it stood at `base`.
    mkdirSync(join(tree, dirname(file)), { recursive: true });
    writeFileSync(join(tree, file), git('show', `${opts.at}:${file}`) + '\n');
  }

  console.log(`replaying ${opts.files.join(', ')}\n  as written at ${atSha}\n  on the tree at ${baseSha}\n`);
  const run = spawnSync(
    process.execPath,
    ['--require', './tests/git-sandbox.cjs', '--test', ...opts.files],
    { cwd: tree, encoding: 'utf8' },
  );
  const out = `${run.stdout || ''}${run.stderr || ''}`;

  const num = (label) => {
    const m = out.match(new RegExp(`^ℹ ${label} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const tests = num('tests');
  const fail = num('fail');

  // Parse the runner's trailing `failing tests:` section, not the inline ✖
  // marks. Node prints one for the enclosing describe as well, so the inline
  // marks outnumber `fail` — and a list longer than the count it sits under is
  // the kind of small incoherence that teaches a reader to skim output.
  const failing = out.split('✖ failing tests:').slice(1).join('').split('\n')
    .map((l) => l.match(/^✖ (.+?) \(\d/))
    .filter(Boolean)
    .map((m) => m[1]);

  // A file that cannot load is not a file that discriminates. Node counts an
  // unloadable test file as ONE failing test whose name is the file path, so
  // `fail > 0` is true and a summary is printed — the first version of this
  // script therefore certified a replay against a tree missing src/agent-payload.js
  // as DISCRIMINATIVE. It reads identically to a real red. Found by running the
  // control, not by reading the code, which is the whole argument of this file.
  const didNotLoad = failing.filter((name) => opts.files.includes(name));
  // Message first, error code second: the code matches node's own `throw new
  // ERR_MODULE_NOT_FOUND(` line in the stack, which names the class and not the
  // module that is missing.
  const loadError = (out.match(/^.*(Cannot find module|Cannot find package|SyntaxError:|ERR_UNKNOWN_FILE_EXTENSION).*$/m)
    || out.match(/^.*ERR_MODULE_NOT_FOUND.*$/m) || [])[0];

  if (tests === null || fail === null) {
    console.log('INCONCLUSIVE — the runner printed no summary. Raw output:\n');
    console.log(out.trim().split('\n').slice(-25).join('\n'));
    exitCode = 2;
  } else if (tests === 0 || didNotLoad.length) {
    console.log(`INCONCLUSIVE — ${didNotLoad.join(', ') || 'the file'} did not load against ${baseSha}.`);
    if (loadError) console.log(`  ${loadError.trim()}`);
    console.log('\nNode reports an unloadable file as one failing test named after the file, so');
    console.log('this looks like a red and is not one: no assertion was ever evaluated. Replay');
    console.log('against a base where the file\'s imports resolve — usually the commit\'s own');
    console.log('parent rather than a distant branch point.');
    exitCode = 2;
  } else if (fail === 0) {
    console.log(`VACUOUS — ${tests}/${tests} passed on ${baseSha}.`);
    console.log(`Every test in this file is green on the tree ${atSha} was written to change, so`);
    console.log('the file encodes nothing that commit fixed. Assert the property, not a token of it.');
    exitCode = 1;
  } else {
    console.log(`DISCRIMINATIVE — ${fail}/${tests} failed on ${baseSha}:\n`);
    for (const name of [...new Set(failing)]) console.log(`  ✖ ${name}`);
    console.log('\nRead the failures before believing them. A test that goes red on the base tree');
    console.log('for an unrelated reason — a missing import, a helper added by the same commit —');
    console.log('is indistinguishable from one that earns its place, except by reading it.');
  }
} finally {
  // The creating task disposes its own sandbox; a leftover worktree also leaves
  // a registration behind in .git/worktrees that `git worktree list` then shows.
  try { git('worktree', 'remove', '--force', tree); } catch { /* never registered */ }
  rmSync(work, { recursive: true, force: true });
}

process.exit(exitCode);
