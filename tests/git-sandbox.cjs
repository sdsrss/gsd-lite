/**
 * Environment isolation for the test suite, preloaded by the npm test scripts
 * (`node --require ./tests/git-sandbox.cjs --test …`). Two things:
 *
 * 1. GIT_CONFIG_GLOBAL → tests/gitconfig, so every git the suite spawns runs
 *    with gc.auto=0. Without it `git commit` forks `git maintenance run --auto
 *    --detach`, which races the fixture teardown that removes the temp repo
 *    (issue #9). See tests/gitconfig for the full reason.
 *
 * 2. XDG_RUNTIME_DIR → a temp directory, so the context bridge
 *    (hooks/lib/ctx-bridge.cjs) lands there instead of in the developer's real
 *    ~/.claude/gsd/runtime/ctx. The bridge falls back to the config dir when
 *    XDG_RUNTIME_DIR is unset, which is the common case on macOS and on this
 *    machine — and a test suite that leaves files in a user's live config
 *    directory is a test suite nobody can trust about cleanup.
 *
 * Child processes inherit both through process.env, including the fixtures
 * that build their own env object — they all spread ...process.env.
 *
 * --require, not --import: package.json declares node >=20.0.0 and --import
 * only landed in 20.6.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.GIT_CONFIG_GLOBAL = path.join(__dirname, 'gitconfig');

// The test runner spawns a child per test file with this same preload, so only
// the process that created the directory owns it — the children inherit the
// path and must not make their own, or make one and delete it out from under
// the others.
if (!process.env.GSD_TEST_RUNTIME_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-runtime-'));
  process.env.GSD_TEST_RUNTIME_DIR = dir;
  process.env.XDG_RUNTIME_DIR = dir;
  process.on('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort at exit */ }
  });
} else {
  process.env.XDG_RUNTIME_DIR = process.env.GSD_TEST_RUNTIME_DIR;
}
