// tests/research-refresh.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('applyResearchRefresh', () => {
  it('rule 1: same ID + same conclusion → keep reference, update expires_at', async () => {
    const { applyResearchRefresh } = await import('../src/tools/state.js');
    const state = {
      research: { decision_index: { 'decision:jwt': { summary: 'Use JWT', expires_at: '2026-03-10' } } },
      phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'accepted', research_basis: ['decision:jwt'] }] }],
    };
    const newResearch = { decision_index: { 'decision:jwt': { summary: 'Use JWT', expires_at: '2026-03-20' } } };
    const result = applyResearchRefresh(state, newResearch);
    assert.equal(state.research.decision_index['decision:jwt'].expires_at, '2026-03-20');
    assert.equal(state.phases[0].todo[0].lifecycle, 'accepted');
    assert.deepEqual(result.warnings, []);
  });

  it('rule 2: same ID + changed conclusion → needs_revalidation', async () => {
    const { applyResearchRefresh } = await import('../src/tools/state.js');
    const state = {
      research: { decision_index: { 'decision:jwt': { summary: 'Use JWT' } } },
      phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'accepted', research_basis: ['decision:jwt'], evidence_refs: ['ev:1'] }] }],
    };
    const newResearch = { decision_index: { 'decision:jwt': { summary: 'Use session cookies instead' } } };
    applyResearchRefresh(state, newResearch);
    assert.equal(state.phases[0].todo[0].lifecycle, 'needs_revalidation');
  });

  it('rule 3: old ID missing → needs_revalidation + warning', async () => {
    const { applyResearchRefresh } = await import('../src/tools/state.js');
    const state = {
      research: { decision_index: { 'decision:old': { summary: 'Old tech' } } },
      phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'accepted', research_basis: ['decision:old'], evidence_refs: [] }] }],
    };
    const newResearch = { decision_index: {} };
    const result = applyResearchRefresh(state, newResearch);
    assert.equal(state.phases[0].todo[0].lifecycle, 'needs_revalidation');
    assert.ok(result.warnings.length > 0);
  });

  it('rule 4: brand new ID → no impact on existing tasks', async () => {
    const { applyResearchRefresh } = await import('../src/tools/state.js');
    const state = {
      research: { decision_index: {} },
      phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'accepted', research_basis: [], evidence_refs: [] }] }],
    };
    const newResearch = { decision_index: { 'decision:new': { summary: 'New finding' } } };
    applyResearchRefresh(state, newResearch);
    assert.equal(state.phases[0].todo[0].lifecycle, 'accepted');
  });

  it('does NOT invalidate tasks in running/pending/failed states (C-3)', async () => {
    const { applyResearchRefresh } = await import('../src/tools/state.js');
    const state = {
      research: { decision_index: { 'decision:x': { summary: 'Old' } } },
      phases: [{
        id: 1,
        todo: [
          { id: '1.1', lifecycle: 'running', research_basis: ['decision:x'], evidence_refs: ['ev:1'] },
          { id: '1.2', lifecycle: 'failed', research_basis: ['decision:x'], evidence_refs: ['ev:2'] },
          { id: '1.3', lifecycle: 'pending', research_basis: ['decision:x'], evidence_refs: [] },
        ],
      }],
    };
    const newResearch = { decision_index: { 'decision:x': { summary: 'Changed' } } };
    applyResearchRefresh(state, newResearch);
    assert.equal(state.phases[0].todo[0].lifecycle, 'running');  // unchanged
    assert.equal(state.phases[0].todo[1].lifecycle, 'failed');   // unchanged (terminal)
    assert.equal(state.phases[0].todo[2].lifecycle, 'pending');  // unchanged
  });
});
