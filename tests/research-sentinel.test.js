import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { init, setLockPath } from '../src/tools/state/index.js';
import { resumeWorkflow } from '../src/tools/orchestrator/index.js';

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' };

/**
 * `.gsd/.research-commit-pending` marks the window between renaming the
 * research artifacts in and writing the state that references them. A crash
 * inside that window leaves the two disagreeing.
 *
 * storeResearch has written and cleaned up that marker since it was added, and
 * nothing ever read it — the comment said "on recovery (future iteration)". A
 * marker no one reads is not crash-safety; it is a file. The only test on it
 * asserted that logic.js *contains the strings* `.research-commit-pending`,
 * `await writeFile(sentinelPath` and `await unlink(sentinelPath` — which passes
 * whether or not the mechanism does anything, and fails when someone moves the
 * call into a helper. It is replaced by these.
 */
async function withProject(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-research-sentinel-'));
  try {
    execSync('git init && git commit --allow-empty -m init', { cwd: dir, env: gitEnv, stdio: 'ignore' });
    setLockPath(null);
    await init({
      project: 'sentinel',
      phases: [{ name: 'Core', tasks: [{ name: 'A' }] }],
      basePath: dir,
    });
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('a research commit that did not finish is reported, not just recorded', () => {
  it('resume says so when the marker is there', async () => {
    await withProject(async (dir) => {
      // What a crash between the artifact renames and the state write leaves.
      await writeFile(join(dir, '.gsd', '.research-commit-pending'), JSON.stringify({ timestamp: Date.now(), pid: 4242 }));

      const result = await resumeWorkflow({ basePath: dir });
      assert.equal(result.error, undefined, `resume errored: ${result.message}`);
      const warnings = result.warnings || [];
      assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
      assert.equal(warnings[0].code, 'RESEARCH_COMMIT_PENDING');
      assert.match(warnings[0].message, /research/i);
      assert.match(warnings[0].message, /re-run|delete/i, 'say what the user can do about it');
    });
  });

  it('says nothing when there is no marker', async () => {
    await withProject(async (dir) => {
      const result = await resumeWorkflow({ basePath: dir });
      assert.equal(result.error, undefined);
      assert.equal(result.warnings, undefined, 'a clean project gets no warning at all');
    });
  });

  it('keeps warning until the condition is resolved, rather than clearing it on read', async () => {
    await withProject(async (dir) => {
      const marker = join(dir, '.gsd', '.research-commit-pending');
      await writeFile(marker, '{}');

      await resumeWorkflow({ basePath: dir });
      assert.ok(existsSync(marker), 'reporting a half-written state must not delete the evidence of it');

      const second = await resumeWorkflow({ basePath: dir });
      assert.equal((second.warnings || [])[0]?.code, 'RESEARCH_COMMIT_PENDING',
        'a one-shot notice is lost by whoever was not looking at that moment');
    });
  });
});
