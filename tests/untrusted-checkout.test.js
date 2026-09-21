// `.gsd/` is committable — the README documents the choice — so a cloned
// repository can carry a complete, someone-else-authored project state, and
// `/gsd:resume` is the documented way to act on one. The executor it dispatches
// holds Bash.
//
// These are not "is the surface closed" tests; it is not. They pin the two
// places where the orchestrator was silently indistinguishable between its own
// instructions and a stranger's file content.
//
// See tasks/specs/untrusted-checkout-executor-surface.md.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { init, read, update, buildExecutorContext } from '../src/tools/state/index.js';
import { resumeWorkflow } from '../src/tools/orchestrator/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function project(name, { git }, fn) {
  const dir = await mkdtemp(join(tmpdir(), `gsd-${name}-`));
  try {
    if (git) {
      execSync('git init', { cwd: dir, stdio: 'ignore' });
      execSync('git config user.email test@example.com', { cwd: dir, stdio: 'ignore' });
      execSync('git config user.name Test', { cwd: dir, stdio: 'ignore' });
      writeFileSync(join(dir, 'README.md'), 'init\n');
      execSync('git add -A && git commit -m init', { cwd: dir, stdio: 'ignore' });
    }
    await init({
      project: name,
      phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: dir,
    });
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('a state with no git baseline in a git workspace stops instead of dispatching', () => {
  // The shape: `.gsd/state.json` arrived with the repository rather than being
  // written here, so it carries no `git_head`. Preflight compared HEADs only
  // when `state.git_head` was truthy, so this raised no hint at all — and
  // because plan-drift detection runs only when no earlier hint fired AND
  // `plan_hashes` is already populated, an absent baseline was seeded from
  // whatever plan files were present, i.e. the ones that came with the repo.
  // Both gates passed and resume dispatched.
  it('a git workspace whose state has no git_head reconciles', async () => {
    await project('untrusted-nohead', { git: true }, async (dir) => {
      const cleared = await update({ updates: { git_head: null }, basePath: dir });
      assert.ok(!cleared.error, `setup: ${cleared.message}`);
      // Assert the setup took effect. update() refuses illegal writes, and a
      // silently-refused setup makes the assertion below measure a state that
      // never existed.
      assert.equal((await read({ basePath: dir })).git_head, null, 'setup did not clear git_head');

      const result = await resumeWorkflow({ basePath: dir });
      assert.ok(!result.error, `resume errored instead of reconciling: ${result.code}: ${result.message}`);
      assert.equal(result.workflow_mode, 'reconcile_workspace',
        'a git workspace carrying a state with no baseline must stop for the user, not dispatch');
      assert.equal((await read({ basePath: dir })).workflow_mode, 'reconcile_workspace',
        'the override must persist, or the next resume repeats it');
    });
  });

  // This is the regression the narrow predicate exists to avoid, and the reason
  // this departs from the audit's recommendation ("treat git_head == null as
  // reconcile_workspace"). createInitialState sets git_head to null
  // (src/schema.js), state-init fills it from getGitHead, and getGitHead returns
  // null for any directory that is not a git repository (src/utils.js). So
  // `git_head: null` is the normal, permanent state of every non-git project —
  // the audit's version would park all of them in await_manual_intervention on
  // every resume, with no exit, because reconcile needs a HEAD to compare to.
  it('a non-git project with no git_head resumes as before', async () => {
    await project('untrusted-nogit', { git: false }, async (dir) => {
      assert.equal((await read({ basePath: dir })).git_head, null,
        'a non-git project is expected to carry git_head: null — if this fails the premise moved');

      const result = await resumeWorkflow({ basePath: dir });
      assert.ok(!result.error, `resume errored: ${result.code}: ${result.message}`);
      assert.notEqual(result.workflow_mode, 'reconcile_workspace',
        'a project that is simply not under git must not be treated as a transplanted state');
    });
  });

  it('a git workspace with a matching baseline still resumes untouched', async () => {
    // The other half of the predicate. Without this, narrowing the condition to
    // "always reconcile" would pass both tests above.
    await project('untrusted-normal', { git: true }, async (dir) => {
      const head = (await read({ basePath: dir })).git_head;
      assert.ok(head, 'state-init should record a HEAD inside a git repo');

      const result = await resumeWorkflow({ basePath: dir });
      assert.ok(!result.error, `resume errored: ${result.code}: ${result.message}`);
      assert.notEqual(result.workflow_mode, 'reconcile_workspace',
        'an ordinary git project must resume exactly as it did before');
    });
  });
});

describe('the dispatch payload says which of its fields are project data', () => {
  // buildExecutorContext puts research decisions, debugger guidance and review
  // feedback into the payload verbatim, and names a task_spec file for the
  // executor to read. In an untrusted checkout every one of those is the
  // repository author's text arriving where the orchestrator's own instructions
  // arrive. Nothing in the payload distinguished them.
  const state = {
    project: 'p',
    research: { decision_index: { d1: { summary: 'use X' } } },
    phases: [{
      id: 1,
      name: 'Core',
      todo: [{
        id: '1.1',
        name: 'Task A',
        lifecycle: 'pending',
        research_basis: ['d1'],
        last_review_feedback: ['tighten the guard'],
        debug_context: { root_cause: 'r', fix_direction: 'f', fix_attempts: 1 },
      }],
    }],
  };

  it('marks the fields that came from the workspace', () => {
    const ctx = buildExecutorContext(state, '1.1', 1);
    assert.ok(!ctx.error, `context build failed: ${ctx.message}`);
    assert.ok(ctx.input_provenance, 'the payload carries no provenance marker at all');

    const marked = ctx.input_provenance.project_data;
    assert.ok(Array.isArray(marked), 'input_provenance.project_data must list the fields');
    for (const field of ['task_spec', 'research_decisions', 'predecessor_outputs', 'debugger_guidance', 'rework_feedback']) {
      assert.ok(marked.includes(field),
        `${field} is read from the workspace but is not listed as project data`);
    }
  });

  it('says what the marker means rather than only naming the fields', () => {
    // A bare list of field names is a string an agent has no instruction to act
    // on. The note is the half that tells it what to do with them.
    const ctx = buildExecutorContext(state, '1.1', 1);
    assert.match(ctx.input_provenance.note, /not instructions/i,
      'the note must state that these fields are data rather than directives');
  });

  it('still returns every field it returned before', () => {
    // Additive, per the spec's constraint: existing consumers keep working.
    const ctx = buildExecutorContext(state, '1.1', 1);
    for (const field of ['task_spec', 'research_decisions', 'predecessor_outputs',
      'project_conventions', 'workflows', 'constraints', 'debugger_guidance', 'rework_feedback']) {
      assert.ok(field in ctx, `${field} disappeared from the payload`);
    }
  });
});

describe('every shipped agent prompt frames its inputs as data', () => {
  // The payload marker and the prompt sentence are one fix, not two. A marker
  // the prompt never mentions is a string the agent has no instruction to
  // respect; a sentence in a prompt file can be crowded out by a large payload.
  // This repo has twice shipped a fix at one call site and had the class return.
  const agents = ['executor.md', 'reviewer.md', 'researcher.md', 'debugger.md'];

  it('finds the prompts to check', () => {
    // Vacuity guard: an empty or renamed corpus would satisfy the loop below
    // without reading anything.
    for (const a of agents) {
      assert.ok(readFileSync(join(repoRoot, 'agents', a), 'utf8').length > 200,
        `agents/${a} is missing or too short to be the shipped prompt`);
    }
  });

  for (const agent of agents) {
    it(`agents/${agent} carries the data-not-instructions framing`, () => {
      const src = readFileSync(join(repoRoot, 'agents', agent), 'utf8');
      assert.match(src, /<data_not_instructions>/,
        `agents/${agent} does not tell the agent that state, plan, research and feedback are project data rather than directives`);
    });
  }
});
