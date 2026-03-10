// tests/reclassify.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('reclassifyReviewLevel', () => {
  it('upgrades L1 to L2 when contract_changed + auth', async () => {
    const { reclassifyReviewLevel } = await import('../src/tools/state.js');
    const task = { id: '2.1', level: 'L1', name: 'auth login endpoint' };
    const executorResult = { contract_changed: true, decisions: [] };
    const newLevel = reclassifyReviewLevel(task, executorResult);
    assert.equal(newLevel, 'L2');
  });

  it('keeps L1 when contract_changed but not auth/payment', async () => {
    const { reclassifyReviewLevel } = await import('../src/tools/state.js');
    const task = { id: '2.1', level: 'L1', name: 'add logging utility' };
    const executorResult = { contract_changed: true, decisions: [] };
    const newLevel = reclassifyReviewLevel(task, executorResult);
    assert.equal(newLevel, 'L1');
  });

  it('upgrades when executor suggests [LEVEL-UP]', async () => {
    const { reclassifyReviewLevel } = await import('../src/tools/state.js');
    const task = { id: '2.1', level: 'L1', name: 'data export' };
    const executorResult = { contract_changed: false, decisions: ['[LEVEL-UP] touches user data export'] };
    const newLevel = reclassifyReviewLevel(task, executorResult);
    assert.equal(newLevel, 'L2');
  });

  it('never downgrades L2', async () => {
    const { reclassifyReviewLevel } = await import('../src/tools/state.js');
    const task = { id: '2.1', level: 'L2', name: 'simple config' };
    const executorResult = { contract_changed: false, decisions: [] };
    const newLevel = reclassifyReviewLevel(task, executorResult);
    assert.equal(newLevel, 'L2');
  });
});
