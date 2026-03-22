import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectCycles } from '../src/schema.js';

describe('detectCycles (shared Kahn algorithm)', () => {
  it('returns null for acyclic task dependencies', () => {
    const phases = [
      {
        id: 1,
        todo: [
          { id: '1.1', requires: [] },
          { id: '1.2', requires: [{ kind: 'task', id: '1.1' }] },
          { id: '1.3', requires: [{ kind: 'task', id: '1.2' }] },
        ],
      },
    ];
    assert.equal(detectCycles(phases), null);
  });

  it('detects a simple cycle', () => {
    const phases = [
      {
        id: 1,
        todo: [
          { id: '1.1', requires: [{ kind: 'task', id: '1.2' }] },
          { id: '1.2', requires: [{ kind: 'task', id: '1.1' }] },
        ],
      },
    ];
    const result = detectCycles(phases);
    assert.ok(result !== null);
    assert.ok(result.includes('Circular dependency'));
    assert.ok(result.includes('phase 1'));
  });

  it('ignores cross-phase dependencies (not in same phase)', () => {
    const phases = [
      {
        id: 1,
        todo: [
          { id: '1.1', requires: [{ kind: 'task', id: '2.1' }] },
        ],
      },
      {
        id: 2,
        todo: [
          { id: '2.1', requires: [] },
        ],
      },
    ];
    assert.equal(detectCycles(phases), null);
  });

  it('ignores phase-kind dependencies', () => {
    const phases = [
      {
        id: 1,
        todo: [
          { id: '1.1', requires: [{ kind: 'phase', id: '1' }] },
        ],
      },
    ];
    assert.equal(detectCycles(phases), null);
  });

  it('handles phases with no tasks', () => {
    const phases = [
      { id: 1, todo: [] },
    ];
    assert.equal(detectCycles(phases), null);
  });

  it('handles phases with missing todo', () => {
    const phases = [
      { id: 1 },
    ];
    assert.equal(detectCycles(phases), null);
  });

  it('detects a 3-node cycle', () => {
    const phases = [
      {
        id: 1,
        todo: [
          { id: '1.1', requires: [{ kind: 'task', id: '1.3' }] },
          { id: '1.2', requires: [{ kind: 'task', id: '1.1' }] },
          { id: '1.3', requires: [{ kind: 'task', id: '1.2' }] },
        ],
      },
    ];
    const result = detectCycles(phases);
    assert.ok(result !== null);
    assert.ok(result.includes('Circular dependency'));
  });
});
