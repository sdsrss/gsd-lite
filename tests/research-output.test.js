import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('research output persistence', () => {
  it('stores researcher output into state and .gsd/research artifacts', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'gsd-research-output-'));
    try {
      const { init, read, storeResearch } = await import('../src/tools/state/index.js');
      await init({
        project: 'research-output',
        phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }],
        research: true,
        basePath: tempDir,
      });

      const result = await storeResearch({
        basePath: tempDir,
        result: {
          decision_ids: ['decision:jwt-rotation'],
          volatility: 'medium',
          expires_at: '2099-03-16T10:30:00Z',
          sources: [{ id: 'src1', type: 'Context7', ref: 'Next.js auth docs' }],
        },
        decision_index: {
          'decision:jwt-rotation': {
            summary: 'Use refresh token rotation',
            source: 'Context7',
            expires_at: '2099-03-16T10:30:00Z',
          },
        },
        artifacts: {
          'STACK.md': '# Stack\n- Next.js\n',
          'ARCHITECTURE.md': '# Architecture\n- BFF\n',
          'PITFALLS.md': '# Pitfalls\n- Token replay\n',
          'SUMMARY.md': '# Summary\nvolatility: medium\nexpires_at: 2099-03-16T10:30:00Z\ndecisions:\n- decision:jwt-rotation\n',
        },
      });

      assert.equal(result.success, true);
      assert.deepEqual(result.stored_files, ['STACK.md', 'ARCHITECTURE.md', 'PITFALLS.md', 'SUMMARY.md']);

      const state = await read({ basePath: tempDir });
      assert.equal(state.research.volatility, 'medium');
      assert.equal(state.research.decision_index['decision:jwt-rotation'].summary, 'Use refresh token rotation');

      const summary = await readFile(join(tempDir, '.gsd', 'research', 'SUMMARY.md'), 'utf-8');
      assert.match(summary, /decision:jwt-rotation/);
      assert.match(summary, /2099-03-16T10:30:00Z/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('applies refresh invalidation rules while replacing research artifacts', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'gsd-research-refresh-output-'));
    try {
      const { init, read, storeResearch, update } = await import('../src/tools/state/index.js');
      await init({
        project: 'research-refresh-output',
        phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A', research_basis: ['decision:jwt'] }] }],
        research: true,
        basePath: tempDir,
      });
      await update({
        updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] },
        basePath: tempDir,
      });
      await update({
        updates: {
          phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'checkpointed', checkpoint_commit: 'abc123' }] }],
        },
        basePath: tempDir,
      });
      await update({
        updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'accepted', evidence_refs: ['ev:1'] }] }] },
        basePath: tempDir,
      });

      await storeResearch({
        basePath: tempDir,
        result: {
          decision_ids: ['decision:jwt'],
          volatility: 'medium',
          expires_at: '2099-03-16T10:30:00Z',
          sources: [{ id: 'src1', type: 'Context7', ref: 'Auth docs' }],
        },
        decision_index: {
          'decision:jwt': { summary: 'Use JWT', source: 'Context7', expires_at: '2099-03-16T10:30:00Z' },
        },
        artifacts: {
          'STACK.md': '# Stack\n',
          'ARCHITECTURE.md': '# Architecture\n',
          'PITFALLS.md': '# Pitfalls\n',
          'SUMMARY.md': '# Summary\nvolatility: medium\nexpires_at: 2099-03-16T10:30:00Z\ndecisions:\n- decision:jwt\n',
        },
      });

      const refreshed = await storeResearch({
        basePath: tempDir,
        result: {
          decision_ids: ['decision:jwt'],
          volatility: 'high',
          expires_at: '2026-04-01T10:30:00Z',
          sources: [{ id: 'src2', type: 'Context7', ref: 'Updated auth docs' }],
        },
        decision_index: {
          'decision:jwt': { summary: 'Use session cookies instead', source: 'Context7', expires_at: '2026-04-01T10:30:00Z' },
        },
        artifacts: {
          'STACK.md': '# Stack\n',
          'ARCHITECTURE.md': '# Architecture\n',
          'PITFALLS.md': '# Pitfalls\n',
          'SUMMARY.md': '# Summary\nvolatility: high\nexpires_at: 2026-04-01T10:30:00Z\ndecisions:\n- decision:jwt\n',
        },
      });

      assert.equal(refreshed.success, true);
      const state = await read({ basePath: tempDir });
      assert.equal(state.phases[0].todo[0].lifecycle, 'needs_revalidation');
      assert.deepEqual(state.phases[0].todo[0].evidence_refs, []);
      assert.equal(state.research.decision_index['decision:jwt'].summary, 'Use session cookies instead');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});