// tests/contracts.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// M-7: Import contract validators from schema.js (shared between server and tests)
import {
  validateExecutorResult,
  validateReviewerResult,
  validateResearcherResult,
  validateDebuggerResult,
} from '../src/schema.js';

describe('executor result contract', () => {
  const validResult = {
    task_id: '2.3',
    outcome: 'checkpointed',
    summary: 'Implemented endpoint',
    checkpoint_commit: 'a1b2c3d',
    files_changed: ['src/api.ts'],
    decisions: [],
    blockers: [],
    contract_changed: false,
    evidence: ['ev:test:api'],
  };

  it('accepts valid executor result', () => {
    assert.ok(validateExecutorResult(validResult).valid);
  });

  it('rejects missing task_id', () => {
    const r = { ...validResult, task_id: undefined };
    assert.equal(validateExecutorResult(r).valid, false);
  });

  it('rejects invalid outcome', () => {
    const r = { ...validResult, outcome: 'done' };
    assert.equal(validateExecutorResult(r).valid, false);
  });

  it('requires evidence array', () => {
    const r = { ...validResult, evidence: 'not-array' };
    assert.equal(validateExecutorResult(r).valid, false);
  });

  it('requires checkpoint_commit for checkpointed outcome', () => {
    const r = { ...validResult, checkpoint_commit: null };
    assert.equal(validateExecutorResult(r).valid, false);
  });
});

describe('reviewer result contract', () => {
  const validResult = {
    scope: 'task',
    scope_id: '2.3',
    review_level: 'L2',
    spec_passed: true,
    quality_passed: true,
    critical_issues: [],
    important_issues: [],
    minor_issues: [],
    accepted_tasks: ['2.3'],
    rework_tasks: [],
    evidence: ['ev:test:phase-2'],
  };

  it('accepts valid reviewer result', () => {
    assert.ok(validateReviewerResult(validResult).valid);
  });

  it('rejects invalid scope', () => {
    const r = { ...validResult, scope: 'file' };
    assert.equal(validateReviewerResult(r).valid, false);
  });

  it('requires review stage booleans and evidence', () => {
    const r = { ...validResult, spec_passed: 'yes', evidence: 'not-array' };
    assert.equal(validateReviewerResult(r).valid, false);
  });

  it('rejects scope_id of 0', () => {
    const r = { ...validResult, scope_id: 0 };
    assert.equal(validateReviewerResult(r).valid, false);
    assert.ok(validateReviewerResult(r).errors.some(e => e.includes('scope_id')));
  });
});

describe('researcher result contract', () => {
  const validResult = {
    decision_ids: ['decision:jwt-rotation'],
    volatility: 'medium',
    expires_at: '2099-03-16T10:30:00Z',
    sources: [{ id: 'src1', type: 'Context7', ref: 'docs' }],
  };

  it('accepts valid researcher result', () => {
    assert.ok(validateResearcherResult(validResult).valid);
  });

  it('rejects invalid volatility', () => {
    const r = { ...validResult, volatility: 'extreme' };
    assert.equal(validateResearcherResult(r).valid, false);
  });

  it('requires structured sources', () => {
    const r = { ...validResult, sources: [{ id: 'src1', type: 'Context7' }] };
    assert.equal(validateResearcherResult(r).valid, false);
  });
});

describe('debugger result contract', () => {
  const validResult = {
    task_id: '2.3',
    outcome: 'fix_suggested',
    root_cause: 'Connection pool exhaustion under concurrent requests',
    evidence: ['ev:repro:error-xyz', 'ev:trace:data-flow'],
    hypothesis_tested: [
      { hypothesis: 'Connection leak causes pool exhaustion', result: 'confirmed', evidence: 'ev:trace:data-flow' },
    ],
    fix_direction: 'Reuse pooled client and add timeout safeguards',
    fix_attempts: 1,
    blockers: [],
    architecture_concern: false,
  };

  it('accepts valid debugger result', () => {
    assert.ok(validateDebuggerResult(validResult).valid);
  });

  it('rejects invalid outcome', () => {
    const r = { ...validResult, outcome: 'unknown' };
    assert.equal(validateDebuggerResult(r).valid, false);
  });

  it('requires failed outcome after three fix attempts', () => {
    const r = { ...validResult, fix_attempts: 3, outcome: 'fix_suggested' };
    assert.equal(validateDebuggerResult(r).valid, false);
  });
});
