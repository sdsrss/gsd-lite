import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { phaseReviewSatisfied } from '../src/tools/state/logic.js';

/**
 * "Has this phase's review requirement been met?" was written out three times —
 * `src/tools/orchestrator/resume.js`, `src/tools/state/crud.js` and the
 * zero-task branch of `selectRunnableTask` — and the three had already drifted
 * apart: two carried an all-tasks-accepted clause and one did not, and of the
 * two, only crud.js required `phase.lifecycle === 'active'`.
 *
 * They now share this predicate. These cases pin the rule as it behaved before
 * the three copies were merged, so the merge is provably a refactor: every one
 * of them passes against the old code and against the new.
 *
 * The rule, and why each clause is there:
 *  - a recorded, accepted phase review satisfies it;
 *  - so does the reviewer's own `required_reviews_passed` flag;
 *  - so does "every task accepted and no review ever started", because L0 tasks
 *    auto-accept without an individual review, `required_reviews_passed` stays
 *    false, and the phase could otherwise never complete (bee5ce2);
 *  - but once a review IS in flight (lifecycle 'reviewing'), it has to finish:
 *    auto-accepting then would discard a review someone asked for;
 *  - a zero-task phase has no tasks to accept, so only the first two apply —
 *    otherwise an empty milestone would satisfy a vacuous "every task accepted".
 */
const accepted = (id) => ({ id, lifecycle: 'accepted' });
const pending = (id) => ({ id, lifecycle: 'pending' });

describe('phaseReviewSatisfied — one rule for the three call sites', () => {
  it('a recorded accepted phase review satisfies it, whatever the tasks are doing', () => {
    assert.equal(phaseReviewSatisfied({
      lifecycle: 'reviewing',
      phase_review: { status: 'accepted' },
      todo: [pending('1.1')],
    }), true);
  });

  it('the reviewer\'s required_reviews_passed flag satisfies it', () => {
    assert.equal(phaseReviewSatisfied({
      lifecycle: 'reviewing',
      phase_review: { status: 'pending' },
      phase_handoff: { required_reviews_passed: true },
      todo: [pending('1.1')],
    }), true);
  });

  it('only an explicit true counts, not a truthy value', () => {
    assert.equal(phaseReviewSatisfied({
      lifecycle: 'reviewing',
      phase_handoff: { required_reviews_passed: 'yes' },
      todo: [pending('1.1')],
    }), false);
  });

  it('every task accepted with no review started satisfies it (the L0 path)', () => {
    assert.equal(phaseReviewSatisfied({
      lifecycle: 'active',
      phase_review: { status: 'pending' },
      phase_handoff: { required_reviews_passed: false },
      todo: [accepted('1.1'), accepted('1.2')],
    }), true);
  });

  it('every task accepted does NOT satisfy it once a review is in flight', () => {
    // The asymmetry crud.js carried and the other two did not. A review that
    // was started has to be finished; auto-accepting here would drop it.
    assert.equal(phaseReviewSatisfied({
      lifecycle: 'reviewing',
      phase_review: { status: 'pending' },
      todo: [accepted('1.1'), accepted('1.2')],
    }), false);
  });

  it('one unaccepted task is enough to withhold it', () => {
    assert.equal(phaseReviewSatisfied({
      lifecycle: 'active',
      todo: [accepted('1.1'), pending('1.2')],
    }), false);
  });

  it('a zero-task phase is not vacuously satisfied — it needs its review recorded', () => {
    assert.equal(phaseReviewSatisfied({ lifecycle: 'active', todo: [] }), false);
    assert.equal(phaseReviewSatisfied({
      lifecycle: 'active',
      phase_review: { status: 'accepted' },
      todo: [],
    }), true);
  });

  it('a phase with no todo array at all is treated as zero-task, not as an error', () => {
    assert.equal(phaseReviewSatisfied({ lifecycle: 'active' }), false);
    assert.equal(phaseReviewSatisfied(undefined), false);
  });
});
