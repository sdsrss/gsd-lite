// tests/propagation.test.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  propagateInvalidation,
  propagateCrossPhaseInvalidation,
  init,
  read,
  update,
} from '../src/tools/state/index.js';

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

describe('propagateCrossPhaseInvalidation (R-12)', () => {
  const makeState = () => ({
    phases: [
      { id: 1, lifecycle: 'active', todo: [{ id: '1.1', lifecycle: 'accepted', requires: [], evidence_refs: ['ev:1'] }] },
      {
        id: 2, lifecycle: 'accepted',
        phase_review: { status: 'accepted', retry_count: 0 },
        phase_handoff: { required_reviews_passed: true },
        todo: [
          { id: '2.1', lifecycle: 'accepted', requires: [{ kind: 'phase', id: 1, gate: 'accepted' }], evidence_refs: ['ev:2'] },
          { id: '2.2', lifecycle: 'checkpointed', requires: [{ kind: 'phase', id: 1 }], evidence_refs: ['ev:3'] },
          { id: '2.3', lifecycle: 'accepted', requires: [], evidence_refs: ['ev:4'] }, // no phase-1 dep
        ],
      },
    ],
  });

  it('invalidates later-phase tasks that depend on the changed phase', () => {
    const state = makeState();
    propagateCrossPhaseInvalidation(state, 1);
    const p2 = state.phases[1];
    assert.equal(p2.todo[0].lifecycle, 'needs_revalidation'); // 2.1 depends on phase 1
    assert.equal(p2.todo[1].lifecycle, 'needs_revalidation'); // 2.2 depends on phase 1
    assert.deepEqual(p2.todo[0].evidence_refs, []);
    assert.equal(p2.todo[2].lifecycle, 'accepted');           // 2.3 has no phase-1 dep
  });

  it('rolls an accepted dependent phase back to active for re-review', () => {
    const state = makeState();
    propagateCrossPhaseInvalidation(state, 1);
    const p2 = state.phases[1];
    assert.equal(p2.lifecycle, 'active');
    assert.equal(p2.phase_review.status, 'pending');
    assert.equal(p2.phase_handoff.required_reviews_passed, false);
  });

  it('cascades transitively across a phase-1 → phase-2 → phase-3 chain', () => {
    const state = {
      phases: [
        { id: 1, lifecycle: 'active', todo: [{ id: '1.1', lifecycle: 'accepted', requires: [], evidence_refs: [] }] },
        { id: 2, lifecycle: 'accepted', phase_review: { status: 'accepted' }, todo: [{ id: '2.1', lifecycle: 'accepted', requires: [{ kind: 'phase', id: 1 }], evidence_refs: [] }] },
        { id: 3, lifecycle: 'accepted', phase_review: { status: 'accepted' }, todo: [{ id: '3.1', lifecycle: 'accepted', requires: [{ kind: 'phase', id: 2 }], evidence_refs: [] }] },
      ],
    };
    propagateCrossPhaseInvalidation(state, 1);
    assert.equal(state.phases[1].todo[0].lifecycle, 'needs_revalidation');
    assert.equal(state.phases[2].todo[0].lifecycle, 'needs_revalidation'); // cascaded via phase 2
    assert.equal(state.phases[2].lifecycle, 'active');
  });

  it('leaves non-invalidatable lifecycles (running/pending) untouched', () => {
    const state = {
      phases: [
        { id: 1, lifecycle: 'active', todo: [{ id: '1.1', lifecycle: 'accepted', requires: [] }] },
        { id: 2, lifecycle: 'active', todo: [
          { id: '2.1', lifecycle: 'running', requires: [{ kind: 'phase', id: 1 }], evidence_refs: [] },
          { id: '2.2', lifecycle: 'pending', requires: [{ kind: 'phase', id: 1 }], evidence_refs: [] },
        ] },
      ],
    };
    propagateCrossPhaseInvalidation(state, 1);
    assert.equal(state.phases[1].todo[0].lifecycle, 'running');
    assert.equal(state.phases[1].todo[1].lifecycle, 'pending');
  });
});

describe('R-12 cross-phase invalidation through update()', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'gsd-r12-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('a phase-1 contract change invalidates phase-2 tasks depending on phase 1', async () => {
    await init({
      project: 'r12-int',
      phases: [
        { name: 'P1', tasks: [{ index: 1, name: 'A' }] },
        { name: 'P2', tasks: [{ index: 1, name: 'B', requires: [{ kind: 'phase', id: 1 }] }] },
      ],
      basePath: dir,
    });
    // Drive both tasks to accepted and phase 2 through its lifecycle to accepted.
    await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: dir });
    await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'checkpointed', checkpoint_commit: 'a' }] }] }, basePath: dir });
    await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'accepted' }] }] }, basePath: dir });
    await update({ updates: { phases: [{ id: 2, lifecycle: 'active', todo: [{ id: '2.1', lifecycle: 'running' }] }] }, basePath: dir });
    await update({ updates: { phases: [{ id: 2, todo: [{ id: '2.1', lifecycle: 'checkpointed', checkpoint_commit: 'b' }] }] }, basePath: dir });
    await update({ updates: { phases: [{ id: 2, todo: [{ id: '2.1', lifecycle: 'accepted' }] }] }, basePath: dir });
    await update({ updates: { phases: [{ id: 2, lifecycle: 'reviewing' }] }, basePath: dir });
    await update({ updates: { phases: [{ id: 2, lifecycle: 'accepted', phase_review: { status: 'accepted' } }] }, basePath: dir });

    // Contract change on task 1.1 with downstream invalidation.
    const res = await update({
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'needs_revalidation' }] }] },
      basePath: dir,
      _propagation_tasks: [{ phase_id: 1, task_id: '1.1', contract_changed: true }],
    });
    assert.equal(res.success, true);

    const state = await read({ basePath: dir });
    assert.equal(state.phases[1].todo[0].lifecycle, 'needs_revalidation', 'phase-2 dependent task invalidated');
    assert.equal(state.phases[1].lifecycle, 'active', 'phase 2 rolled back to active');
  });
});
