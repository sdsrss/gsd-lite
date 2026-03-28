// tests/decisions.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchDecisionForBlocker } from '../src/tools/state/index.js';

describe('matchDecisionForBlocker', () => {
  it('matches decision to blocked question', () => {
    const decisions = [
      { id: 'd:auth-strategy', summary: '选择 JWT 而非 session', phase: 1 },
    ];
    const blockedReason = '需要确认认证方式: session 还是 JWT?';
    const match = matchDecisionForBlocker(decisions, blockedReason);
    assert.ok(match);
    assert.equal(match.id, 'd:auth-strategy');
  });

  it('returns null when no match', () => {
    const decisions = [
      { id: 'd:db-choice', summary: 'PostgreSQL for DB', phase: 1 },
    ];
    const blockedReason = '需要确认缓存策略: Redis 还是 Memcached?';
    const match = matchDecisionForBlocker(decisions, blockedReason);
    assert.equal(match, null);
  });

  it('matches when overlap exactly equals MIN_OVERLAP (2)', () => {
    const decisions = [
      { id: 'd:cache', summary: 'Redis caching strategy' },
    ];
    const blockedReason = 'Need redis caching confirmation';
    const match = matchDecisionForBlocker(decisions, blockedReason);
    assert.ok(match, 'overlap of 2 should match at MIN_OVERLAP boundary');
    assert.equal(match.id, 'd:cache');
  });

  it('does NOT match when overlap is below MIN_OVERLAP (1)', () => {
    const decisions = [
      { id: 'd:cache', summary: 'Redis caching strategy' },
    ];
    const blockedReason = 'Need redis confirmation';
    // Only "redis" overlaps → 1 < MIN_OVERLAP(2) → null
    const match = matchDecisionForBlocker(decisions, blockedReason);
    assert.equal(match, null, 'overlap of 1 should not match');
  });

  it('returns null for empty blockedReason', () => {
    const decisions = [
      { id: 'd:cache', summary: 'Redis caching strategy' },
    ];
    assert.equal(matchDecisionForBlocker(decisions, ''), null);
  });

  it('returns null for empty decisions array', () => {
    const result = matchDecisionForBlocker([], 'some blocked reason text here');
    assert.equal(result, null);
  });

  it('matches with English text strings', () => {
    const decisions = [
      { id: 'd:deploy', summary: 'Kubernetes deployment pipeline configuration' },
    ];
    const blockedReason = 'Blocked on deployment pipeline setup';
    const match = matchDecisionForBlocker(decisions, blockedReason);
    assert.ok(match, 'should match English text with overlap >= 2');
    assert.equal(match.id, 'd:deploy');
  });
});
