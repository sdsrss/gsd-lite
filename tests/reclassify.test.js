// tests/reclassify.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reclassifyReviewLevel } from '../src/tools/state/index.js';

describe('reclassifyReviewLevel', () => {
  it('upgrades L1 to L2 when contract_changed + auth', () => {
    const task = { id: '2.1', level: 'L1', name: 'auth login endpoint' };
    const executorResult = { contract_changed: true, decisions: [] };
    const newLevel = reclassifyReviewLevel(task, executorResult);
    assert.equal(newLevel, 'L2');
  });

  it('keeps L1 when contract_changed but not auth/payment', () => {
    const task = { id: '2.1', level: 'L1', name: 'add logging utility' };
    const executorResult = { contract_changed: true, decisions: [] };
    const newLevel = reclassifyReviewLevel(task, executorResult);
    assert.equal(newLevel, 'L1');
  });

  it('upgrades when executor suggests [LEVEL-UP]', () => {
    const task = { id: '2.1', level: 'L1', name: 'data export' };
    const executorResult = { contract_changed: false, decisions: ['[LEVEL-UP] touches user data export'] };
    const newLevel = reclassifyReviewLevel(task, executorResult);
    assert.equal(newLevel, 'L2');
  });

  it('never downgrades L2', () => {
    const task = { id: '2.1', level: 'L2', name: 'simple config' };
    const executorResult = { contract_changed: false, decisions: [] };
    const newLevel = reclassifyReviewLevel(task, executorResult);
    assert.equal(newLevel, 'L2');
  });

  it('upgrades on object-form [LEVEL-UP] decision', () => {
    const task = { level: 'L1', name: 'simple task' };
    const executorResult = { contract_changed: false, decisions: [{ summary: '[LEVEL-UP] needs broader review' }] };
    const newLevel = reclassifyReviewLevel(task, executorResult);
    assert.equal(newLevel, 'L2');
  });

  // Confidence-based reclassification tests
  it('upgrades L1 to L2 when confidence is low', () => {
    const task = { id: '2.1', level: 'L1', name: 'add utility' };
    const executorResult = { contract_changed: false, decisions: [], confidence: 'low' };
    const newLevel = reclassifyReviewLevel(task, executorResult);
    assert.equal(newLevel, 'L2');
  });

  it('downgrades L1 to L0 when confidence is high, has evidence, and no contract change', () => {
    const task = { id: '2.1', level: 'L1', name: 'add logging' };
    const executorResult = { contract_changed: false, decisions: [], confidence: 'high', evidence: [{ type: 'test', passed: true }] };
    const newLevel = reclassifyReviewLevel(task, executorResult);
    assert.equal(newLevel, 'L0');
  });

  it('keeps L1 when confidence is high but no evidence provided', () => {
    const task = { id: '2.1', level: 'L1', name: 'add logging' };
    const executorResult = { contract_changed: false, decisions: [], confidence: 'high' };
    const newLevel = reclassifyReviewLevel(task, executorResult);
    assert.equal(newLevel, 'L1');
  });

  it('keeps L1 when confidence is high but tests failed', () => {
    const task = { id: '2.1', level: 'L1', name: 'add logging' };
    const executorResult = { contract_changed: false, decisions: [], confidence: 'high', evidence: [{ type: 'test', passed: false }] };
    const newLevel = reclassifyReviewLevel(task, executorResult);
    assert.equal(newLevel, 'L1');
  });

  it('keeps L1 when confidence is high but contract_changed', () => {
    const task = { id: '2.1', level: 'L1', name: 'add logging' };
    const executorResult = { contract_changed: true, decisions: [], confidence: 'high' };
    const newLevel = reclassifyReviewLevel(task, executorResult);
    assert.equal(newLevel, 'L1');
  });

  it('keeps L1 when confidence is medium (default behavior)', () => {
    const task = { id: '2.1', level: 'L1', name: 'add logging' };
    const executorResult = { contract_changed: false, decisions: [], confidence: 'medium' };
    const newLevel = reclassifyReviewLevel(task, executorResult);
    assert.equal(newLevel, 'L1');
  });

  it('never downgrades L2 even with high confidence', () => {
    const task = { id: '2.1', level: 'L2', name: 'auth flow' };
    const executorResult = { contract_changed: false, decisions: [], confidence: 'high' };
    const newLevel = reclassifyReviewLevel(task, executorResult);
    assert.equal(newLevel, 'L2');
  });

  it('keeps L1 when confidence is absent (backward compat)', () => {
    const task = { id: '2.1', level: 'L1', name: 'add logging' };
    const executorResult = { contract_changed: false, decisions: [] };
    const newLevel = reclassifyReviewLevel(task, executorResult);
    assert.equal(newLevel, 'L1');
  });

  it('downgrades auth task to L0 when confidence high + evidence + no contract change', () => {
    // Sensitive keyword alone doesn't prevent L0 downgrade if confidence is high,
    // evidence exists, and no contract changed
    const task = { id: '2.1', level: 'L1', name: 'auth session cleanup' };
    const executorResult = { contract_changed: false, decisions: [], confidence: 'high', evidence: [{ type: 'test', passed: true }] };
    const newLevel = reclassifyReviewLevel(task, executorResult);
    assert.equal(newLevel, 'L0');
  });
});
