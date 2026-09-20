import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateExecutorResult } from '../src/schema.js';
import { reclassifyReviewLevel } from '../src/tools/state/logic.js';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The orchestrator drops a high-confidence L1 task to L0 — self-review only, no
 * independent reviewer — and cross-checks that self-report against the
 * evidence: `reclassifyReviewLevel` refuses the drop when an evidence entry is
 * a test that did not pass.
 *
 * That guard reads `type` and `passed`. The contract never asked for either:
 * the MCP tool description listed `{id, scope, type?}` with no `passed` at all,
 * agents/executor.md showed evidence entries as `{id, scope}`, and
 * validateExecutorResult checked only that `evidence` was an array. So the
 * failure branch could not fire on any result an executor was told to produce,
 * and "has evidence at all" was the whole check — satisfied equally by evidence
 * of success and evidence of failure.
 *
 * These pin both halves: what the guard does with the verdict, and that the
 * contract asks for it in all three places a caller might read.
 */
describe('evidence carries the verdict the review-level guard reads', () => {
  const base = {
    task_id: '1.1',
    outcome: 'checkpointed',
    summary: 'did the thing',
    checkpoint_commit: 'abc1234',
    files_changed: ['src/a.js'],
    decisions: [],
    blockers: [],
    contract_changed: false,
    evidence: [],
  };
  const task = { id: '1.1', name: 'add a helper', level: 'L1' };

  it('a failing test in the evidence keeps the task at L1', () => {
    const level = reclassifyReviewLevel(task, {
      ...base,
      confidence: 'high',
      evidence: [{ id: 'ev:test:a', scope: 'task:1.1', type: 'test', passed: false }],
    });
    assert.equal(level, 'L1', 'high confidence next to a failed test is not evidence of anything');
  });

  it('passing evidence lets the same task drop to L0', () => {
    const level = reclassifyReviewLevel(task, {
      ...base,
      confidence: 'high',
      evidence: [{ id: 'ev:test:a', scope: 'task:1.1', type: 'test', passed: true }],
    });
    assert.equal(level, 'L0');
  });

  it('accepts the bare-string evidence form callers have always been able to send', () => {
    assert.ok(validateExecutorResult({ ...base, evidence: ['ev:test:a'] }).valid);
  });

  it('accepts an object entry carrying type and passed', () => {
    assert.ok(validateExecutorResult({
      ...base,
      evidence: [{ id: 'ev:test:a', scope: 'task:1.1', type: 'test', passed: false }],
    }).valid);
  });

  // The fields the guard branches on have to be checkable, or a caller can send
  // `passed: "no"` — truthy, not false — and buy the downgrade the guard exists
  // to withhold.
  it('rejects a non-boolean passed', () => {
    const r = validateExecutorResult({
      ...base,
      // Otherwise valid, so the only thing under test is the verdict field.
      evidence: [{ id: 'ev:test:a', scope: 'task:1.1', type: 'test', passed: 'no' }],
    });
    assert.equal(r.valid, false, '"no" is truthy, so this would read as a pass');
    assert.match(r.errors.join('; '), /passed/);
  });

  it('rejects a non-string type', () => {
    const r = validateExecutorResult({ ...base, evidence: [{ id: 'ev:test:a', scope: 'task:1.1', type: 42 }] });
    assert.equal(r.valid, false);
    assert.match(r.errors.join('; '), /type/);
  });

  // handleExecutorResult keys state.evidence on id + scope and drops anything
  // missing either — silently, while the entry still counts as "has evidence"
  // for the downgrade. So the contract refuses what the store would discard.
  it('rejects an object entry with no id', () => {
    const r = validateExecutorResult({ ...base, evidence: [{ scope: 'task:1.1', type: 'test', passed: true }] });
    assert.equal(r.valid, false);
    assert.match(r.errors.join('; '), /id/);
  });

  it('rejects an object entry with no scope, which would not be recorded', () => {
    const r = validateExecutorResult({ ...base, evidence: [{ id: 'ev:test:a', type: 'test', passed: true }] });
    assert.equal(r.valid, false);
    assert.match(r.errors.join('; '), /scope/);
  });

  it('the tool schema, the executor contract and the evidence spec all describe the verdict', () => {
    // Same shape as the blocker-shape check: the drift was only visible by
    // reading three files side by side, so read them side by side.
    const serverSrc = readFileSync(join(PROJECT_ROOT, 'src', 'server.js'), 'utf8');
    const executorMd = readFileSync(join(PROJECT_ROOT, 'agents', 'executor.md'), 'utf8');
    const evidenceSpec = readFileSync(join(PROJECT_ROOT, 'references', 'evidence-spec.md'), 'utf8');

    const schemaLine = serverSrc.split('\n').find(l => l.includes('Executor result:'));
    assert.ok(schemaLine, 'could not find the executor result schema description in server.js');
    assert.match(schemaLine, /passed\?: boolean/,
      'the MCP schema must ask for the verdict the orchestrator branches on');

    assert.match(executorMd, /"passed"/,
      'agents/executor.md must show evidence entries carrying their verdict');
    assert.match(evidenceSpec, /passed/,
      'references/evidence-spec.md must document the field');
  });
});
