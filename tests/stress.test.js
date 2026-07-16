// tests/stress.test.js — R-26: large-scale state stress (hundreds of tasks).
// Documents the latency characteristics of core operations at scale. Bounds are
// intentionally generous so the test isn't flaky on slow CI; the console line
// records the real numbers (see docs/calibration-notes.md for the write-up).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, read, update } from '../src/tools/state/index.js';
import { resumeWorkflow } from '../src/tools/orchestrator/index.js';

describe('R-26: large-scale state stress (hundreds of tasks)', () => {
  it('handles a ~300-task project within reasonable latency bounds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gsd-stress-'));
    try {
      const PHASES = 6;
      const PER_PHASE = 50; // 300 tasks total
      const phases = [];
      for (let p = 1; p <= PHASES; p++) {
        const tasks = [];
        for (let t = 1; t <= PER_PHASE; t++) {
          tasks.push({
            index: t,
            name: `task ${p}.${t}`,
            level: 'L1',
            requires: t > 1 ? [{ kind: 'task', id: `${p}.${t - 1}`, gate: 'accepted' }] : [],
          });
        }
        phases.push({ name: `Phase ${p}`, tasks });
      }

      const t0 = Date.now();
      const initRes = await init({ project: 'stress', phases, basePath: dir });
      const initMs = Date.now() - t0;
      assert.equal(initRes.success, true, `init should succeed: ${JSON.stringify(initRes)}`);

      const state = await read({ basePath: dir });
      const total = state.phases.reduce((n, ph) => n + ph.todo.length, 0);
      assert.equal(total, PHASES * PER_PHASE);

      // resume drives selectRunnableTask over a 50-task phase (the scheduling path).
      const t1 = Date.now();
      const resumed = await resumeWorkflow({ basePath: dir });
      const resumeMs = Date.now() - t1;
      assert.equal(resumed.action, 'dispatch_executor');
      assert.equal(resumed.task_id, '1.1');

      // single state update (full-validation path over 300 tasks).
      const t2 = Date.now();
      const upd = await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: dir });
      const updateMs = Date.now() - t2;
      assert.equal(upd.success, true);

      console.log(`[stress] 300 tasks / 6 phases — init=${initMs}ms resume=${resumeMs}ms update=${updateMs}ms`);

      // Latency characteristic: all core ops complete comfortably under these
      // bounds at ~300 tasks. Scheduling is roughly O(tasks-in-phase); the L15
      // index optimization stays deferred until single-phase counts reach the
      // hundreds (documented in docs/calibration-notes.md).
      assert.ok(initMs < 5000, `init < 5s, got ${initMs}ms`);
      assert.ok(resumeMs < 3000, `resume < 3s, got ${resumeMs}ms`);
      assert.ok(updateMs < 3000, `update < 3s, got ${updateMs}ms`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
