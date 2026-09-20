// tests/context-build.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { buildExecutorContext } from '../src/tools/state/index.js';

describe('buildExecutorContext', () => {
  it('constructs context with all 6 fields', () => {
    const state = {
      phases: [{
        id: 1,
        todo: [
          { id: '1.1', lifecycle: 'accepted', files_changed: ['a.js'], checkpoint_commit: 'abc', requires: [], research_basis: [] },
          { id: '1.2', lifecycle: 'pending', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }], research_basis: ['decision:jwt'], level: 'L1', review_required: true, retry_count: 0 },
        ],
      }],
      research: { decision_index: { 'decision:jwt': { summary: 'Use JWT', source: 'Context7' } } },
    };
    const ctx = buildExecutorContext(state, '1.2', 1);
    assert.ok(ctx.task_spec !== undefined);
    assert.ok(ctx.research_decisions !== undefined);
    assert.ok(ctx.predecessor_outputs !== undefined);
    assert.ok(ctx.project_conventions !== undefined);
    assert.ok(ctx.workflows !== undefined);
    assert.ok(ctx.constraints !== undefined);
    assert.equal(ctx.constraints.level, 'L1');
    assert.deepEqual(ctx.predecessor_outputs, [{ files_changed: ['a.js'], checkpoint_commit: 'abc' }]);
    assert.equal(ctx.research_decisions[0].summary, 'Use JWT');
  });

  it('returns a structured error when phase is missing', () => {
    const result = buildExecutorContext({ phases: [] }, '1.1', 1);
    assert.equal(result.error, true);
    assert.match(result.message, /Phase 1 not found/);
  });

  it('includes debugging workflow when retry_count > 0', () => {
    const state = {
      phases: [{
        id: 1,
        todo: [
          { id: '1.1', lifecycle: 'pending', requires: [], research_basis: [], retry_count: 2, level: 'L1' },
        ],
      }],
    };
    const ctx = buildExecutorContext(state, '1.1', 1);
    assert.ok(!ctx.error, 'should not return error');
    assert.ok(
      ctx.workflows.some(w => w.endsWith('/debugging.md')),
      `should include the debugging workflow, got ${JSON.stringify(ctx.workflows)}`,
    );
  });

  // The executor is handed these paths and told to read them. It runs with the
  // USER'S project as its working directory, not this package — so a relative
  // path resolves against a directory where none of these files exist. The bug
  // survived because this repo is the one cwd where they all resolve, which is
  // also why these tests stat the files from a different cwd instead of
  // matching the strings.
  describe('workflow paths the executor is told to read', () => {
    const contextFor = (extra = {}) => buildExecutorContext({
      phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'pending', requires: [], research_basis: [], level: 'L1', ...extra }] }],
      research: { decision_index: { 'decision:x': { summary: 's', source: 'c' } } },
    }, '1.1', 1);

    it('are absolute', () => {
      const ctx = contextFor();
      assert.ok(ctx.workflows.length > 0, 'no workflows returned — this suite would be vacuous');
      const relative = ctx.workflows.filter(w => !isAbsolute(w));
      assert.deepEqual(relative, [], 'a relative path resolves against the caller\'s cwd, which is the user\'s project');
    });

    it('point at files that exist, from a working directory that is not this package', () => {
      const elsewhere = mkdtempSync(join(tmpdir(), 'gsd-cwd-'));
      const original = process.cwd();
      try {
        process.chdir(elsewhere);
        // Every arm, not just the default two: each push in buildExecutorContext
        // is its own path, and a fix that only resolves the default arm leaves
        // the retry and research arms broken in exactly the same way.
        for (const [label, ctx] of [
          ['default', contextFor()],
          ['retry', contextFor({ retry_count: 2 })],
          ['research', contextFor({ research_basis: ['decision:x'] })],
        ]) {
          for (const w of ctx.workflows) {
            assert.ok(existsSync(w), `${label}: executor is told to read ${w}, which does not exist`);
          }
        }
      } finally {
        process.chdir(original);
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });
  });

  it('handles research_basis referencing non-existent decision_index entry gracefully', () => {
    const state = {
      phases: [{
        id: 1,
        todo: [
          { id: '1.1', lifecycle: 'pending', requires: [], research_basis: ['decision:nonexistent'], level: 'L1' },
        ],
      }],
      research: { decision_index: {} },
    };
    const ctx = buildExecutorContext(state, '1.1', 1);
    assert.ok(!ctx.error, 'should not throw or return error');
    assert.equal(ctx.research_decisions.length, 1);
    assert.equal(ctx.research_decisions[0].summary, 'not found');
  });

  it('references correct phase file for task in phase 2', () => {
    const state = {
      phases: [
        { id: 1, todo: [] },
        {
          id: 2,
          todo: [
            { id: '2.1', lifecycle: 'pending', requires: [], research_basis: [], level: 'L2' },
          ],
        },
      ],
    };
    const ctx = buildExecutorContext(state, '2.1', 2);
    assert.ok(!ctx.error, 'should not return error');
    assert.equal(ctx.task_spec, 'phases/phase-2.md');
  });

  it('reflects review_required: false in constraints', () => {
    const state = {
      phases: [{
        id: 1,
        todo: [
          { id: '1.1', lifecycle: 'pending', requires: [], research_basis: [], level: 'L0', review_required: false },
        ],
      }],
    };
    const ctx = buildExecutorContext(state, '1.1', 1);
    assert.ok(!ctx.error, 'should not return error');
    assert.equal(ctx.constraints.review_required, false);
  });

  it('does not throw when state.research is null', () => {
    const state = {
      phases: [{
        id: 1,
        todo: [
          { id: '1.1', lifecycle: 'pending', requires: [], research_basis: ['decision:x'], level: 'L1' },
        ],
      }],
      research: null,
    };
    const ctx = buildExecutorContext(state, '1.1', 1);
    assert.ok(!ctx.error, 'should not return error');
    assert.equal(ctx.research_decisions.length, 1);
    assert.equal(ctx.research_decisions[0].summary, 'not found');
  });

  it('returns empty predecessor_outputs when requires is empty', () => {
    const state = {
      phases: [{
        id: 1,
        todo: [
          { id: '1.1', lifecycle: 'pending', requires: [], research_basis: [], level: 'L1' },
        ],
      }],
    };
    const ctx = buildExecutorContext(state, '1.1', 1);
    assert.ok(!ctx.error, 'should not return error');
    assert.deepEqual(ctx.predecessor_outputs, []);
  });
});
