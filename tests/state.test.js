import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat as fsStat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, read, update, phaseComplete, matchDecisionForBlocker } from '../src/tools/state.js';
import { readJson } from '../src/utils.js';

describe('state tools', () => {
  let tempDir;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-state-'));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('init', () => {
    it('creates .gsd directory with state.json', async () => {
      const result = await init({
        project: 'test-project',
        phases: [{ name: 'setup', tasks: [{ index: 1, name: 'init repo' }] }],
        basePath: tempDir,
      });
      assert.equal(result.success, true);

      const readResult = await readJson(join(tempDir, '.gsd', 'state.json'));
      assert.equal(readResult.ok, true);
      const state = readResult.data;
      assert.equal(state.project, 'test-project');
      assert.equal(state.workflow_mode, 'executing_task');
      assert.equal(state.phases.length, 1);
      assert.equal(state.phases[0].lifecycle, 'active');
    });

    it('creates phases directory', async () => {
      const s = await fsStat(join(tempDir, '.gsd', 'phases'));
      assert.ok(s.isDirectory());
    });

    it('creates plan.md', async () => {
      const s = await fsStat(join(tempDir, '.gsd', 'plan.md'));
      assert.ok(s.isFile());
    });
  });

  describe('read', () => {
    it('returns full state', async () => {
      const result = await read({ basePath: tempDir });
      assert.equal(result.project, 'test-project');
      assert.equal(result.workflow_mode, 'executing_task');
    });

    it('returns filtered fields', async () => {
      const result = await read({ fields: ['project', 'workflow_mode'], basePath: tempDir });
      assert.equal(result.project, 'test-project');
      assert.equal(result.workflow_mode, 'executing_task');
      assert.equal(result.phases, undefined);
    });

    it('returns error when state not found', async () => {
      const result = await read({ basePath: '/tmp/nonexistent-gsd-12345' });
      assert.equal(result.error, true);
    });
  });

  describe('update', () => {
    it('updates canonical fields', async () => {
      const result = await update({
        updates: { workflow_mode: 'executing_task', current_task: '1.1' },
        basePath: tempDir,
      });
      assert.equal(result.success, true);
      const state = await read({ basePath: tempDir });
      assert.equal(state.workflow_mode, 'executing_task');
      assert.equal(state.current_task, '1.1');
    });

    it('rejects non-canonical fields', async () => {
      const result = await update({
        updates: { stopped_at: 'some value' },
        basePath: tempDir,
      });
      assert.equal(result.error, true);
      assert.ok(result.message.includes('stopped_at'));
    });

    it('validates state after update', async () => {
      const result = await update({
        updates: { workflow_mode: 'invalid_mode' },
        basePath: tempDir,
      });
      assert.equal(result.error, true);
    });

    it('rejects null updates payload', async () => {
      const result = await update({ updates: null, basePath: tempDir });
      assert.equal(result.error, true);
      assert.match(result.message, /updates must be a non-null object/);
    });

    it('rejects malformed phases that fail schema validation', async () => {
      const result = await update({
        updates: {
          phases: [{ id: 2, name: 'broken', lifecycle: 'pending' }],
          total_phases: 2,
        },
        basePath: tempDir,
      });
      assert.equal(result.error, true);
      assert.match(result.message, /todo must be an array/);
    });
  });

  describe('update terminal state guard', () => {
    it('rejects workflow_mode change from completed to paused_by_user', async () => {
      // First set up completed state: need phase accepted first
      const dir = await (await import('node:fs/promises')).mkdtemp(join((await import('node:os')).tmpdir(), 'gsd-terminal-'));
      try {
        await init({
          project: 'terminal-test',
          phases: [{ name: 'P1', tasks: [{ index: 1, name: 'T1' }] }],
          basePath: dir,
        });
        // Walk lifecycle: pending→running→checkpointed→accepted
        await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: dir });
        await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'checkpointed', checkpoint_commit: 'abc' }] }] }, basePath: dir });
        await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'accepted' }] }] }, basePath: dir });
        // Phase: active→reviewing→accepted
        await update({ updates: { phases: [{ id: 1, lifecycle: 'reviewing' }] }, basePath: dir });
        await update({ updates: { phases: [{ id: 1, lifecycle: 'accepted' }] }, basePath: dir });
        // Walk workflow: executing_task→reviewing_phase→completed
        await update({ updates: { workflow_mode: 'reviewing_phase', current_review: { scope: 'phase', scope_id: 1 } }, basePath: dir });
        await update({ updates: { workflow_mode: 'completed' }, basePath: dir });
        // Now try to change to paused_by_user — should be rejected
        const result = await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: dir });
        assert.equal(result.error, true);
        assert.match(result.message, /terminal state/);
      } finally {
        await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects workflow_mode change from failed to paused_by_user', async () => {
      const dir = await (await import('node:fs/promises')).mkdtemp(join((await import('node:os')).tmpdir(), 'gsd-terminal-'));
      try {
        await init({
          project: 'terminal-fail-test',
          phases: [{ name: 'P1', tasks: [{ index: 1, name: 'T1' }] }],
          basePath: dir,
        });
        await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: dir });
        await update({ updates: { phases: [{ id: 1, lifecycle: 'failed', todo: [{ id: '1.1', lifecycle: 'failed' }] }] }, basePath: dir });
        await update({ updates: { workflow_mode: 'failed' }, basePath: dir });
        // Now try to change to paused_by_user — should be rejected
        const result = await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: dir });
        assert.equal(result.error, true);
        assert.match(result.message, /terminal state/);
      } finally {
        await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true });
      }
    });

    it('allows workflow_mode change from executing_task to paused_by_user (regression)', async () => {
      // tempDir already has executing_task from prior tests
      const result = await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: tempDir });
      assert.equal(result.success, true);
      const state = await read({ basePath: tempDir });
      assert.equal(state.workflow_mode, 'paused_by_user');
      // Restore for subsequent tests
      await update({ updates: { workflow_mode: 'executing_task' }, basePath: tempDir });
    });
  });

  describe('update lifecycle validation', () => {
    it('rejects illegal task lifecycle transition (pending → accepted)', async () => {
      const state = await read({ basePath: tempDir });
      const phases = JSON.parse(JSON.stringify(state.phases));
      phases[0].todo[0].lifecycle = 'accepted'; // skip running+checkpointed
      const result = await update({ updates: { phases }, basePath: tempDir });
      assert.equal(result.error, true);
      assert.ok(result.message.includes('pending'));
    });

    it('rejects illegal phase lifecycle transition (pending → reviewing)', async () => {
      const state = await read({ basePath: tempDir });
      const phases = JSON.parse(JSON.stringify(state.phases));
      phases[0].lifecycle = 'accepted'; // skip reviewing
      const result = await update({ updates: { phases }, basePath: tempDir });
      assert.equal(result.error, true);
      assert.ok(result.message.includes('active'));
    });

    it('allows legal task lifecycle transition (pending → running)', async () => {
      const state = await read({ basePath: tempDir });
      const phases = JSON.parse(JSON.stringify(state.phases));
      phases[0].todo[0].lifecycle = 'running';
      const result = await update({ updates: { phases }, basePath: tempDir });
      assert.equal(result.success, true);
    });
  });

  describe('phaseComplete', () => {
    it('rejects when handoff gate not met', async () => {
      const result = await phaseComplete({ phase_id: 1, basePath: tempDir });
      assert.equal(result.error, true);
    });
  });
});

describe('concurrent withStateLock serialization', () => {
  let tempDir;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-concurrent-'));
    await init({
      project: 'concurrent-test',
      phases: [{ name: 'Core', tasks: [
        { index: 1, name: 'Task A' },
        { index: 2, name: 'Task B' },
        { index: 3, name: 'Task C' },
      ] }],
      basePath: tempDir,
    });
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('serializes concurrent update() calls and produces consistent final state', async () => {
    // Fire 3 concurrent updates that each transition a different task to running.
    // If withStateLock does NOT serialize, some updates may be lost due to TOCTOU.
    const results = await Promise.all([
      update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: tempDir }),
      update({ updates: { phases: [{ id: 1, todo: [{ id: '1.2', lifecycle: 'running' }] }] }, basePath: tempDir }),
      update({ updates: { phases: [{ id: 1, todo: [{ id: '1.3', lifecycle: 'running' }] }] }, basePath: tempDir }),
    ]);

    // All 3 should succeed
    for (const r of results) {
      assert.equal(r.success, true, `Expected success, got: ${JSON.stringify(r)}`);
    }

    // Final state should have all 3 tasks as running (serialized, not interleaved)
    const state = await read({ basePath: tempDir });
    assert.equal(state.phases[0].todo[0].lifecycle, 'running');
    assert.equal(state.phases[0].todo[1].lifecycle, 'running');
    assert.equal(state.phases[0].todo[2].lifecycle, 'running');
  });

  it('serializes concurrent addEvidence() calls without data loss', async () => {
    const { addEvidence } = await import('../src/tools/state.js');

    const results = await Promise.all([
      addEvidence({ id: 'ev:concurrent:1', data: { scope: 'task:1.1', summary: 'first' }, basePath: tempDir }),
      addEvidence({ id: 'ev:concurrent:2', data: { scope: 'task:1.2', summary: 'second' }, basePath: tempDir }),
      addEvidence({ id: 'ev:concurrent:3', data: { scope: 'task:1.3', summary: 'third' }, basePath: tempDir }),
    ]);

    for (const r of results) {
      assert.equal(r.success, true);
    }

    const state = await read({ basePath: tempDir });
    assert.equal(state.evidence['ev:concurrent:1'].summary, 'first');
    assert.equal(state.evidence['ev:concurrent:2'].summary, 'second');
    assert.equal(state.evidence['ev:concurrent:3'].summary, 'third');
  });
});

describe('init force reinitialize', () => {
  let tempDir;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-force-init-'));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('rejects re-initialization without force flag', async () => {
    const first = await init({
      project: 'first-project',
      phases: [{ name: 'Phase 1', tasks: [{ index: 1, name: 'Task A' }] }],
      basePath: tempDir,
    });
    assert.equal(first.success, true);

    const second = await init({
      project: 'second-project',
      phases: [{ name: 'Phase 2', tasks: [{ index: 1, name: 'Task B' }] }],
      basePath: tempDir,
    });
    assert.equal(second.error, true);
    assert.match(second.message, /already exists/);

    // Original state should be unchanged
    const state = await read({ basePath: tempDir });
    assert.equal(state.project, 'first-project');
  });

  it('succeeds with force: true and creates fresh state', async () => {
    const result = await init({
      project: 'fresh-project',
      phases: [
        { name: 'Alpha', tasks: [{ index: 1, name: 'New Task' }] },
        { name: 'Beta', tasks: [{ index: 1, name: 'Another Task' }] },
      ],
      force: true,
      basePath: tempDir,
    });
    assert.equal(result.success, true);

    const state = await read({ basePath: tempDir });
    assert.equal(state.project, 'fresh-project');
    assert.equal(state.phases.length, 2);
    assert.equal(state.total_phases, 2);
    assert.equal(state.phases[0].name, 'Alpha');
    assert.equal(state.phases[0].lifecycle, 'active');
    assert.equal(state.phases[1].name, 'Beta');
    assert.equal(state.phases[1].lifecycle, 'pending');
    // Fresh state should have clean defaults
    assert.equal(state.current_task, null);
    assert.equal(state.current_review, null);
    assert.equal(state.workflow_mode, 'executing_task');
  });
});

describe('matchDecisionForBlocker edge cases', () => {
  it('returns null when overlap is below MIN_OVERLAP (single token)', () => {
    const decisions = [{ id: 'd1', summary: 'Use React frontend' }];
    const result = matchDecisionForBlocker(decisions, 'Need frontend framework');
    // Only "frontend" overlaps → 1 < MIN_OVERLAP(2) → null
    assert.equal(result, null);
  });

  it('matches at exact MIN_OVERLAP boundary (overlap=2)', () => {
    const decisions = [{ id: 'd1', summary: 'PostgreSQL database migration' }];
    const result = matchDecisionForBlocker(decisions, 'database migration tool');
    // "database" + "migration" overlap → 2 = MIN_OVERLAP → match
    assert.equal(result.id, 'd1');
  });

  it('returns the best match among multiple decisions', () => {
    const decisions = [
      { id: 'd1', summary: 'deploy staging server config' },
      { id: 'd2', summary: 'deploy staging environment' },
      { id: 'd3', summary: 'unrelated topic here' },
    ];
    const result = matchDecisionForBlocker(decisions, 'deploy staging server');
    // d1: "deploy"+"staging"+"server" = 3 overlap
    // d2: "deploy"+"staging" = 2 overlap
    // d3: 0 overlap
    assert.equal(result.id, 'd1');
  });

  it('returns null for empty decisions array', () => {
    const result = matchDecisionForBlocker([], 'some blocked reason');
    assert.equal(result, null);
  });

  it('returns null for empty or null blocked reason', () => {
    const decisions = [{ id: 'd1', summary: 'Use PostgreSQL database' }];
    assert.equal(matchDecisionForBlocker(decisions, ''), null);
    assert.equal(matchDecisionForBlocker(decisions, null), null);
  });

  it('returns null for decision without summary (no crash)', () => {
    const decisions = [{ id: 'd1' }];
    const result = matchDecisionForBlocker(decisions, 'some blocked reason here');
    assert.equal(result, null);
  });

  it('matches case-insensitively', () => {
    const decisions = [{ id: 'd1', summary: 'Use PostgreSQL database' }];
    const result = matchDecisionForBlocker(decisions, 'POSTGRESQL DATABASE choice');
    // "postgresql" + "database" overlap → 2 = MIN_OVERLAP → match
    assert.equal(result.id, 'd1');
  });

  it('filters out short tokens from punctuation splitting', () => {
    // "I/O" splits into "i" and "o" (both length 1, filtered by MIN_TOKEN_LENGTH=2)
    const decisions = [{ id: 'd1', summary: 'Handle I/O operations' }];
    const result = matchDecisionForBlocker(decisions, 'I/O performance');
    // After filtering: decision tokens = ["handle","operations"], reason tokens = ["performance"]
    // No overlap → null
    assert.equal(result, null);
  });
});
