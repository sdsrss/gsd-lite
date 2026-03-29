// tests/propagation.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { propagateInvalidation } from '../src/tools/state/index.js';

describe('propagateInvalidation', () => {
  it('invalidates downstream when contract_changed is true', () => {
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'accepted', requires: [], evidence_refs: ['ev:1'] },
        { id: '1.2', lifecycle: 'accepted', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }], evidence_refs: ['ev:2'] },
        { id: '1.3', lifecycle: 'checkpointed', requires: [{ kind: 'task', id: '1.2', gate: 'checkpoint' }], evidence_refs: ['ev:3'] },
      ],
    };
    propagateInvalidation(phase, '1.1', true);
    assert.equal(phase.todo[1].lifecycle, 'needs_revalidation'); // accepted → needs_revalidation
    assert.equal(phase.todo[2].lifecycle, 'needs_revalidation'); // checkpointed → needs_revalidation
    assert.deepEqual(phase.todo[1].evidence_refs, []);
    assert.deepEqual(phase.todo[2].evidence_refs, []);
  });

  it('does NOT invalidate tasks in running/pending/failed/blocked states (C-2)', () => {
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'accepted', requires: [], evidence_refs: [] },
        { id: '1.2', lifecycle: 'running', requires: [{ kind: 'task', id: '1.1', gate: 'checkpoint' }], evidence_refs: ['ev:2'] },
        { id: '1.3', lifecycle: 'pending', requires: [{ kind: 'task', id: '1.1', gate: 'checkpoint' }], evidence_refs: [] },
        { id: '1.4', lifecycle: 'failed', requires: [{ kind: 'task', id: '1.1', gate: 'checkpoint' }], evidence_refs: ['ev:4'] },
        { id: '1.5', lifecycle: 'blocked', requires: [{ kind: 'task', id: '1.1', gate: 'checkpoint' }], evidence_refs: [] },
      ],
    };
    propagateInvalidation(phase, '1.1', true);
    assert.equal(phase.todo[1].lifecycle, 'running');   // unchanged
    assert.equal(phase.todo[2].lifecycle, 'pending');    // unchanged
    assert.equal(phase.todo[3].lifecycle, 'failed');     // unchanged (terminal)
    assert.equal(phase.todo[4].lifecycle, 'blocked');    // unchanged
  });

  it('does NOT invalidate when contract_changed is false', () => {
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

  it('handles chain A→B→C propagation', () => {
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

  it('handles task with no requires (isolated)', () => {
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'accepted', requires: [], evidence_refs: ['ev:1'] },
        { id: '1.2', lifecycle: 'accepted', requires: [], evidence_refs: ['ev:2'] },
      ],
    };
    propagateInvalidation(phase, '1.1', true);
    assert.equal(phase.todo[1].lifecycle, 'accepted'); // unaffected, no dependency
  });

  it('handles diamond dependency A→B,A→C,B→D,C→D', () => {
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'accepted', requires: [], evidence_refs: [] },
        { id: '1.2', lifecycle: 'accepted', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }], evidence_refs: ['ev:b'] },
        { id: '1.3', lifecycle: 'accepted', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }], evidence_refs: ['ev:c'] },
        { id: '1.4', lifecycle: 'accepted', requires: [{ kind: 'task', id: '1.2', gate: 'accepted' }, { kind: 'task', id: '1.3', gate: 'accepted' }], evidence_refs: ['ev:d'] },
      ],
    };
    propagateInvalidation(phase, '1.1', true);
    assert.equal(phase.todo[0].lifecycle, 'accepted'); // source not changed by propagation
    assert.equal(phase.todo[1].lifecycle, 'needs_revalidation');
    assert.equal(phase.todo[2].lifecycle, 'needs_revalidation');
    assert.equal(phase.todo[3].lifecycle, 'needs_revalidation');
    assert.deepEqual(phase.todo[3].evidence_refs, []);
  });

  it('does not affect tasks only linked via phase gate', () => {
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'accepted', requires: [], evidence_refs: ['ev:1'] },
        { id: '1.2', lifecycle: 'accepted', requires: [{ kind: 'phase', id: 0, gate: 'phase_complete' }], evidence_refs: ['ev:2'] },
      ],
    };
    propagateInvalidation(phase, '1.1', true);
    assert.equal(phase.todo[1].lifecycle, 'accepted'); // phase dep, not task dep
  });

  it('handles invalidation of already needs_revalidation task', () => {
    const phase = {
      todo: [
        { id: '1.1', lifecycle: 'accepted', requires: [], evidence_refs: [] },
        { id: '1.2', lifecycle: 'needs_revalidation', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }], evidence_refs: [] },
      ],
    };
    propagateInvalidation(phase, '1.1', true);
    assert.equal(phase.todo[1].lifecycle, 'needs_revalidation'); // stays same
    assert.deepEqual(phase.todo[1].evidence_refs, []); // evidence_refs must be cleared on re-invalidation
  });
});
