/**
 * Preloaded by the npm test scripts (`node --require ./tests/git-sandbox.cjs
 * --test …`) so every git the suite spawns — directly, or through install.js,
 * the hooks and the CLI — reads tests/gitconfig as its global config.
 *
 * The one setting that matters is gc.auto=0: without it `git commit` forks
 * `git maintenance run --auto --detach`, which races the fixture teardown that
 * removes the temp repo (issue #9). See tests/gitconfig for the full reason.
 *
 * Child processes inherit it through process.env, including the fixtures that
 * build their own env object — they all spread ...process.env.
 *
 * --require, not --import: package.json declares node >=20.0.0 and --import
 * only landed in 20.6.
 */
const { join } = require('node:path');

process.env.GIT_CONFIG_GLOBAL = join(__dirname, 'gitconfig');
