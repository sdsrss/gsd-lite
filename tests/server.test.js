import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('server tool handling', () => {
  it('returns structured errors for invalid tool input', async () => {
    const { handleToolCall } = await import('../src/server.js');
    const result = await handleToolCall('gsd-state-update', { updates: null, basePath: process.cwd() });
    assert.equal(result.error, true);
    assert.match(result.message, /updates must be a non-null object/);
  });

  it('returns unknown tool errors without throwing', async () => {
    const { handleToolCall } = await import('../src/server.js');
    const result = await handleToolCall('unknown-tool', {});
    assert.equal(result.error, true);
    assert.match(result.message, /Unknown tool/);
  });

  it('can resume minimal orchestration through server tool', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'gsd-server-orchestrator-'));
    try {
      const { handleToolCall } = await import('../src/server.js');
      await handleToolCall('gsd-state-init', {
        project: 'orchestrator-server-test',
        phases: [{ name: 'P1', tasks: [{ index: 1, name: 'Task A' }] }],
        basePath: tempDir,
      });

      const result = await handleToolCall('gsd-orchestrator-resume', { basePath: tempDir });
      assert.equal(result.success, true);
      assert.equal(result.action, 'dispatch_executor');
      assert.equal(result.task_id, '1.1');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('can route executor failure to debugger through server tools', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'gsd-server-debugger-'));
    try {
      const { handleToolCall } = await import('../src/server.js');
      await handleToolCall('gsd-state-init', {
        project: 'orchestrator-server-debugger',
        phases: [{ name: 'P1', tasks: [{ index: 1, name: 'Task A' }] }],
        basePath: tempDir,
      });
      await handleToolCall('gsd-state-update', {
        updates: {
          current_task: '1.1',
          phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running', retry_count: 2 }] }],
        },
        basePath: tempDir,
      });

      const result = await handleToolCall('gsd-orchestrator-handle-executor-result', {
        basePath: tempDir,
        result: {
          task_id: '1.1',
          outcome: 'failed',
          summary: 'repeat failure',
          files_changed: [],
          decisions: [],
          blockers: [],
          contract_changed: false,
          evidence: [],
        },
      });

      assert.equal(result.success, true);
      assert.equal(result.action, 'dispatch_debugger');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('can surface research refresh pre-flight through resume server tool', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'gsd-server-research-refresh-'));
    try {
      const { handleToolCall } = await import('../src/server.js');
      await handleToolCall('gsd-state-init', {
        project: 'orchestrator-server-research-refresh',
        phases: [{ name: 'P1', tasks: [{ index: 1, name: 'Task A' }] }],
        basePath: tempDir,
      });
      await handleToolCall('gsd-state-update', {
        updates: {
          research: {
            expires_at: '2000-01-01T00:00:00Z',
            decision_index: {
              'decision:stack': { summary: 'Use React 18', expires_at: '2000-01-01T00:00:00Z' },
            },
          },
        },
        basePath: tempDir,
      });

      const result = await handleToolCall('gsd-orchestrator-resume', { basePath: tempDir });
      assert.equal(result.success, true);
      assert.equal(result.action, 'dispatch_researcher');
      assert.equal(result.workflow_mode, 'research_refresh_needed');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('can surface direction drift through resume server tool', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'gsd-server-direction-drift-'));
    try {
      const { handleToolCall } = await import('../src/server.js');
      await handleToolCall('gsd-state-init', {
        project: 'orchestrator-server-direction-drift',
        phases: [{ name: 'P1', tasks: [{ index: 1, name: 'Task A' }] }],
        basePath: tempDir,
      });
      await handleToolCall('gsd-state-update', {
        updates: {
          workflow_mode: 'executing_task',
          phases: [{ id: 1, phase_handoff: { direction_ok: false } }],
        },
        basePath: tempDir,
      });

      const result = await handleToolCall('gsd-orchestrator-resume', { basePath: tempDir });
      assert.equal(result.success, true);
      assert.equal(result.action, 'awaiting_user');
      assert.equal(result.workflow_mode, 'awaiting_user');
      assert.deepEqual(result.drift_phase, { id: 1, name: 'P1' });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('can persist researcher output through server tool and continue orchestration', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'gsd-server-research-store-'));
    try {
      const { handleToolCall } = await import('../src/server.js');
      await handleToolCall('gsd-state-init', {
        project: 'orchestrator-server-research-store',
        phases: [{ name: 'P1', tasks: [{ index: 1, name: 'Task A', research_basis: ['decision:jwt-rotation'] }] }],
        research: true,
        basePath: tempDir,
      });
      await handleToolCall('gsd-state-update', {
        updates: { workflow_mode: 'research_refresh_needed' },
        basePath: tempDir,
      });

      const result = await handleToolCall('gsd-orchestrator-handle-researcher-result', {
        basePath: tempDir,
        result: {
          decision_ids: ['decision:jwt-rotation'],
          volatility: 'medium',
          expires_at: '2026-03-16T10:30:00Z',
          sources: [{ id: 'src1', type: 'Context7', ref: 'Next.js auth docs' }],
        },
        decision_index: {
          'decision:jwt-rotation': {
            summary: 'Use refresh token rotation',
            source: 'Context7',
            expires_at: '2026-03-16T10:30:00Z',
          },
        },
        artifacts: {
          'STACK.md': '# Stack\n- Next.js\n',
          'ARCHITECTURE.md': '# Architecture\n- BFF\n',
          'PITFALLS.md': '# Pitfalls\n- Token replay\n',
          'SUMMARY.md': '# Summary\nvolatility: medium\nexpires_at: 2026-03-16T10:30:00Z\ndecisions:\n- decision:jwt-rotation\n',
        },
      });

      assert.equal(result.success, true);
      assert.equal(result.action, 'dispatch_executor');
      assert.deepEqual(result.decision_ids, ['decision:jwt-rotation']);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('MCP tool call chain', () => {
  let tempDir;
  let handleToolCall;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-server-'));
    ({ handleToolCall } = await import('../src/server.js'));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('init creates project state', async () => {
    const result = await handleToolCall('gsd-state-init', {
      project: 'smoke-test',
      phases: [{
        name: 'Core',
        tasks: [
          { index: 1, name: 'Task A' },
          { index: 2, name: 'Task B' },
        ],
      }],
      basePath: tempDir,
    });
    assert.equal(result.success, true);
  });

  it('read after init returns full state', async () => {
    const state = await handleToolCall('gsd-state-read', { basePath: tempDir });
    assert.equal(state.project, 'smoke-test');
    assert.equal(state.workflow_mode, 'executing_task');
    assert.equal(state.phases.length, 1);
    assert.equal(state.phases[0].name, 'Core');
    assert.equal(state.phases[0].todo.length, 2);
    assert.equal(state.phases[0].todo[0].lifecycle, 'pending');
    assert.equal(state.phases[0].todo[1].lifecycle, 'pending');
  });

  it('update task A to running', async () => {
    const result = await handleToolCall('gsd-state-update', {
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);
  });

  it('update task A to checkpointed with commit', async () => {
    const result = await handleToolCall('gsd-state-update', {
      updates: {
        phases: [{
          id: 1,
          todo: [{ id: '1.1', lifecycle: 'checkpointed', checkpoint_commit: 'abc123' }],
        }],
      },
      basePath: tempDir,
    });
    assert.equal(result.success, true);
  });

  it('update task A to accepted', async () => {
    const result = await handleToolCall('gsd-state-update', {
      updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'accepted' }] }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);
  });

  it('walk task B through full lifecycle', async () => {
    const toRunning = await handleToolCall('gsd-state-update', {
      updates: { phases: [{ id: 1, todo: [{ id: '1.2', lifecycle: 'running' }] }] },
      basePath: tempDir,
    });
    assert.equal(toRunning.success, true);

    const toCheckpointed = await handleToolCall('gsd-state-update', {
      updates: {
        phases: [{
          id: 1,
          todo: [{ id: '1.2', lifecycle: 'checkpointed', checkpoint_commit: 'def456' }],
        }],
      },
      basePath: tempDir,
    });
    assert.equal(toCheckpointed.success, true);

    const toAccepted = await handleToolCall('gsd-state-update', {
      updates: { phases: [{ id: 1, todo: [{ id: '1.2', lifecycle: 'accepted' }] }] },
      basePath: tempDir,
    });
    assert.equal(toAccepted.success, true);
  });

  it('transition phase to reviewing before completion', async () => {
    const result = await handleToolCall('gsd-state-update', {
      updates: { phases: [{ id: 1, lifecycle: 'reviewing' }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);
  });

  it('mark phase review accepted before completion', async () => {
    const result = await handleToolCall('gsd-state-update', {
      updates: { phases: [{ id: 1, phase_review: { status: 'accepted' } }] },
      basePath: tempDir,
    });
    assert.equal(result.success, true);
  });

  it('phaseComplete succeeds when all tasks accepted', async () => {
    const result = await handleToolCall('gsd-phase-complete', {
      phase_id: 1,
      basePath: tempDir,
      verification: {
        lint: { exit_code: 0 },
        typecheck: { exit_code: 0 },
        test: { exit_code: 0 },
      },
      direction_ok: true,
    });
    assert.equal(result.success, true);
  });

  it('read final state shows completed phase', async () => {
    const state = await handleToolCall('gsd-state-read', { basePath: tempDir });
    assert.equal(state.phases[0].lifecycle, 'accepted');
    assert.equal(state.phases[0].todo[0].lifecycle, 'accepted');
    assert.equal(state.phases[0].todo[1].lifecycle, 'accepted');
    assert.equal(state.phases[0].todo[0].checkpoint_commit, 'abc123');
    assert.equal(state.phases[0].todo[1].checkpoint_commit, 'def456');
    assert.equal(state.phases[0].phase_handoff.required_reviews_passed, true);
    assert.equal(state.phases[0].phase_handoff.tests_passed, true);
  });
});

describe('gsd-health tool', () => {
  it('returns health status without state', async () => {
    const { handleToolCall } = await import('../src/server.js');
    const fakePath = '/tmp/nonexistent-gsd-health-' + Date.now();
    const result = await handleToolCall('gsd-health', { basePath: fakePath });
    assert.equal(result.status, 'ok');
    assert.equal(result.server, 'gsd-lite');
    assert.equal(result.version, '0.2.0');
    assert.equal(result.state_exists, false);
  });

  it('returns health status with project info when state exists', async () => {
    const healthDir = await mkdtemp(join(tmpdir(), 'gsd-health-'));
    try {
      const { handleToolCall } = await import('../src/server.js');
      await handleToolCall('gsd-state-init', {
        project: 'health-test',
        phases: [{ name: 'P1', tasks: [{ index: 1, name: 'T1' }] }],
        basePath: healthDir,
      });
      const result = await handleToolCall('gsd-health', { basePath: healthDir });
      assert.equal(result.status, 'ok');
      assert.equal(result.state_exists, true);
      assert.equal(result.project, 'health-test');
      assert.equal(result.workflow_mode, 'executing_task');
      assert.equal(result.current_phase, 1);
      assert.equal(result.total_phases, 1);
    } finally {
      await rm(healthDir, { recursive: true, force: true });
    }
  });
});

describe('MCP tool error handling', () => {
  let tempDir;
  let handleToolCall;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-server-err-'));
    ({ handleToolCall } = await import('../src/server.js'));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('init rejects missing project', async () => {
    const result = await handleToolCall('gsd-state-init', {
      phases: [{ name: 'P1', tasks: [] }],
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /project/);
  });

  it('read from nonexistent basePath returns error', async () => {
    // Use /tmp directly to avoid ancestor .gsd discovery (tmpdir() may be under $HOME)
    const fakePath = '/tmp/nonexistent-gsd-xyz-' + Date.now();
    const result = await handleToolCall('gsd-state-read', { basePath: fakePath });
    assert.equal(result.error, true);
    assert.match(result.message, /No .gsd directory/);
  });

  it('update rejects non-canonical fields', async () => {
    // First init a valid project in this temp dir
    await handleToolCall('gsd-state-init', {
      project: 'err-test',
      phases: [{ name: 'P1', tasks: [{ index: 1, name: 'T1' }] }],
      basePath: tempDir,
    });

    const result = await handleToolCall('gsd-state-update', {
      updates: { foo: 'bar' },
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /Non-canonical/);
  });

  it('phaseComplete fails when tasks are not accepted', async () => {
    // Phase has tasks still in pending — gate should block
    const result = await handleToolCall('gsd-phase-complete', {
      phase_id: 1,
      basePath: tempDir,
    });
    assert.equal(result.error, true);
    assert.match(result.message, /not met|not accepted|transition/i);
  });
});

describe('server dispatch coverage', () => {
  it('dispatches gsd-state-read with null args gracefully', async () => {
    const { handleToolCall } = await import('../src/server.js');
    const result = await handleToolCall('gsd-state-read', null);
    // Should still work (args defaults to {})
    assert.ok(result);
  });

  it('dispatches gsd-orchestrator-resume with null args', async () => {
    const { handleToolCall } = await import('../src/server.js');
    // Will fail due to no .gsd dir, but should not throw
    const result = await handleToolCall('gsd-orchestrator-resume', null);
    assert.ok(result);
  });

  it('dispatches gsd-orchestrator-handle-executor-result with null args', async () => {
    const { handleToolCall } = await import('../src/server.js');
    const result = await handleToolCall('gsd-orchestrator-handle-executor-result', null);
    assert.equal(result.error, true);
    assert.match(result.message, /result must be an object/);
  });

  it('dispatches gsd-orchestrator-handle-debugger-result with null args', async () => {
    const { handleToolCall } = await import('../src/server.js');
    const result = await handleToolCall('gsd-orchestrator-handle-debugger-result', null);
    assert.equal(result.error, true);
    assert.match(result.message, /result must be an object/);
  });

  it('dispatches gsd-orchestrator-handle-researcher-result with null args', async () => {
    const { handleToolCall } = await import('../src/server.js');
    const result = await handleToolCall('gsd-orchestrator-handle-researcher-result', null);
    assert.equal(result.error, true);
    assert.match(result.message, /result must be an object/);
  });

  it('dispatches gsd-orchestrator-handle-reviewer-result with null args', async () => {
    const { handleToolCall } = await import('../src/server.js');
    const result = await handleToolCall('gsd-orchestrator-handle-reviewer-result', null);
    assert.equal(result.error, true);
    assert.match(result.message, /result must be an object/);
  });

  it('catches thrown errors and wraps them as structured error', async () => {
    const { handleToolCall } = await import('../src/server.js');
    // gsd-state-init with invalid args that would cause an internal error
    const result = await handleToolCall('gsd-state-init', { project: null, phases: null });
    assert.equal(result.error, true);
  });

  it('dispatches gsd-health with null args', async () => {
    const { handleToolCall } = await import('../src/server.js');
    const result = await handleToolCall('gsd-health', null);
    assert.equal(result.status, 'ok');
    assert.equal(result.server, 'gsd-lite');
  });

  it('routes reviewer result through server tool', async () => {
    const reviewerDir = await mkdtemp(join(tmpdir(), 'gsd-server-reviewer-'));
    try {
      const { handleToolCall } = await import('../src/server.js');
      await handleToolCall('gsd-state-init', {
        project: 'server-reviewer-test',
        phases: [{ name: 'P1', tasks: [{ index: 1, name: 'Task A' }] }],
        basePath: reviewerDir,
      });
      // Move task through lifecycle to checkpointed
      await handleToolCall('gsd-state-update', {
        updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] },
        basePath: reviewerDir,
      });
      await handleToolCall('gsd-state-update', {
        updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'checkpointed', checkpoint_commit: 'abc' }] }] },
        basePath: reviewerDir,
      });

      const result = await handleToolCall('gsd-orchestrator-handle-reviewer-result', {
        basePath: reviewerDir,
        result: {
          scope: 'task',
          scope_id: '1.1',
          review_level: 'L2',
          spec_passed: true,
          quality_passed: true,
          critical_issues: [],
          important_issues: [],
          minor_issues: [],
          accepted_tasks: ['1.1'],
          rework_tasks: [],
          evidence: [],
        },
      });
      assert.equal(result.success, true);
      assert.equal(result.action, 'review_accepted');
    } finally {
      await rm(reviewerDir, { recursive: true, force: true });
    }
  });

  it('routes debugger result through server tool', async () => {
    const debuggerDir = await mkdtemp(join(tmpdir(), 'gsd-server-debugger-result-'));
    try {
      const { handleToolCall } = await import('../src/server.js');
      await handleToolCall('gsd-state-init', {
        project: 'server-debugger-result-test',
        phases: [{ name: 'P1', tasks: [{ index: 1, name: 'Task A' }] }],
        basePath: debuggerDir,
      });
      await handleToolCall('gsd-state-update', {
        updates: {
          current_task: '1.1',
          current_review: { scope: 'task', scope_id: '1.1', stage: 'debugging' },
          phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running', retry_count: 3 }] }],
        },
        basePath: debuggerDir,
      });

      const result = await handleToolCall('gsd-orchestrator-handle-debugger-result', {
        basePath: debuggerDir,
        result: {
          task_id: '1.1',
          outcome: 'fix_suggested',
          root_cause: 'Race condition',
          evidence: ['ev1'],
          hypothesis_tested: [{ hypothesis: 'Race in handler', result: 'confirmed', evidence: 'ev1' }],
          fix_direction: 'Add mutex',
          fix_attempts: 1,
          blockers: [],
          architecture_concern: false,
        },
      });
      assert.equal(result.success, true);
      assert.equal(result.action, 'dispatch_executor');
    } finally {
      await rm(debuggerDir, { recursive: true, force: true });
    }
  });
});