// tests/contracts.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// These validate the JSON contract structures from agents

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
});

describe('researcher result contract', () => {
  const validResult = {
    decision_ids: ['decision:jwt-rotation'],
    volatility: 'medium',
    expires_at: '2026-03-16T10:30:00Z',
    sources: [{ id: 'src1', type: 'Context7', ref: 'docs' }],
  };

  it('accepts valid researcher result', () => {
    assert.ok(validateResearcherResult(validResult).valid);
  });

  it('rejects invalid volatility', () => {
    const r = { ...validResult, volatility: 'extreme' };
    assert.equal(validateResearcherResult(r).valid, false);
  });
});

// Contract validation functions — inline for now
function validateExecutorResult(r) {
  const errors = [];
  if (!r.task_id) errors.push('missing task_id');
  if (!['checkpointed', 'blocked', 'failed'].includes(r.outcome)) errors.push('invalid outcome');
  if (!Array.isArray(r.files_changed)) errors.push('files_changed must be array');
  if (!Array.isArray(r.decisions)) errors.push('decisions must be array');
  if (!Array.isArray(r.blockers)) errors.push('blockers must be array');
  if (typeof r.contract_changed !== 'boolean') errors.push('contract_changed must be boolean');
  if (!Array.isArray(r.evidence)) errors.push('evidence must be array');
  return { valid: errors.length === 0, errors };
}

function validateReviewerResult(r) {
  const errors = [];
  if (!['task', 'phase'].includes(r.scope)) errors.push('invalid scope');
  if (!r.scope_id) errors.push('missing scope_id');
  if (!Array.isArray(r.critical_issues)) errors.push('critical_issues must be array');
  if (!Array.isArray(r.accepted_tasks)) errors.push('accepted_tasks must be array');
  if (!Array.isArray(r.rework_tasks)) errors.push('rework_tasks must be array');
  return { valid: errors.length === 0, errors };
}

function validateResearcherResult(r) {
  const errors = [];
  if (!Array.isArray(r.decision_ids)) errors.push('decision_ids must be array');
  if (!['low', 'medium', 'high'].includes(r.volatility)) errors.push('invalid volatility');
  if (!r.expires_at) errors.push('missing expires_at');
  if (!Array.isArray(r.sources)) errors.push('sources must be array');
  return { valid: errors.length === 0, errors };
}
