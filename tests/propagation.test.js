// tests/propagation.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('propagateInvalidation', () => {
  it('invalidates downstream when contract_changed is true', async () => {
    const { propagateInvalidation } = await import('../src/tools/state.js');
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'accepted', requires: [], evidence_refs: ['ev:1'] },
        { id: '1.2', lifecycle: 'accepted', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }], evidence_refs: ['ev:2'] },
        { id: '1.3', lifecycle: 'checkpointed', requires: [{ kind: 'task', id: '1.2', gate: 'checkpoint' }], evidence_refs: ['ev:3'] },
      ],
    };
    propagateInvalidation(phase, '1.1', true);
    assert.equal(phase.todo[1].lifecycle, 'needs_revalidation');
    assert.equal(phase.todo[2].lifecycle, 'needs_revalidation');
    assert.deepEqual(phase.todo[1].evidence_refs, []);
    assert.deepEqual(phase.todo[2].evidence_refs, []);
  });

  it('does NOT invalidate when contract_changed is false', async () => {
    const { propagateInvalidation } = await import('../src/tools/state.js');
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'accepted', requires: [], evidence_refs: ['ev:1'] },
        { id: '1.2', lifecycle: 'accepted', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }], evidence_refs: ['ev:2'] },
      ],
    };
    propagateInvalidation(phase, '1.1', false);
    assert.equal(phase.todo[1].lifecycle, 'accepted');
    assert.deepEqual(phase.todo[1].evidence_refs, ['ev:2']);
  });

  it('handles chain A→B→C propagation', async () => {
    const { propagateInvalidation } = await import('../src/tools/state.js');
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'accepted', requires: [], evidence_refs: [] },
        { id: '1.2', lifecycle: 'accepted', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }], evidence_refs: ['ev:b'] },
        { id: '1.3', lifecycle: 'accepted', requires: [{ kind: 'task', id: '1.2', gate: 'accepted' }], evidence_refs: ['ev:c'] },
      ],
    };
    propagateInvalidation(phase, '1.1', true);
    assert.equal(phase.todo[1].lifecycle, 'needs_revalidation');
    assert.equal(phase.todo[2].lifecycle, 'needs_revalidation');
  });
});
