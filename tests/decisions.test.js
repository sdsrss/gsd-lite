// tests/decisions.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('matchDecisionForBlocker', () => {
  it('matches decision to blocked question', async () => {
    const { matchDecisionForBlocker } = await import('../src/tools/state.js');
    const decisions = [
      { id: 'd:auth-strategy', summary: '选择 JWT 而非 session', phase: 1 },
    ];
    const blockedReason = '需要确认认证方式: session 还是 JWT?';
    const match = matchDecisionForBlocker(decisions, blockedReason);
    assert.ok(match);
    assert.equal(match.id, 'd:auth-strategy');
  });

  it('returns null when no match', async () => {
    const { matchDecisionForBlocker } = await import('../src/tools/state.js');
    const decisions = [
      { id: 'd:db-choice', summary: 'PostgreSQL for DB', phase: 1 },
    ];
    const blockedReason = '需要确认缓存策略: Redis 还是 Memcached?';
    const match = matchDecisionForBlocker(decisions, blockedReason);
    assert.equal(match, null);
  });
});
