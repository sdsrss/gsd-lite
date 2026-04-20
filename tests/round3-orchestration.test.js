// Round 3 — full orchestration cycles over live MCP stdio.
// Where round1 covered basic CRUD and round2 covered error UX, round3 drives
// end-to-end scenarios the way the orchestrator would in production:
// executor → reviewer → phase-complete → next phase; rework propagation;
// debugger architecture_concern escalation; researcher storage; resume idempotency.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SERVER = join(__dirname, '..', 'src', 'server.js');

class McpClient {
  constructor(cwd) {
    this.proc = spawn('node', [SERVER], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    this.id = 0; this.buf = ''; this.pending = new Map();
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk.toString();
      for (;;) {
        const nl = this.buf.indexOf('\n');
        if (nl < 0) break;
        const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const r = this.pending.get(msg.id);
          if (r) { this.pending.delete(msg.id); r(msg); }
        } catch {}
      }
    });
  }
  request(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout ${method}`)); }, 8000);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async call(tool, args) {
    const r = await this.request('tools/call', { name: tool, arguments: args });
    if (r.error) throw new Error(`RPC error ${r.error.code}: ${r.error.message}`);
    return JSON.parse(r.result.content[0].text);
  }
  async close() {
    this.proc.stdin.end();
    await new Promise(r => this.proc.on('exit', r));
  }
}

async function newProject(prefix) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  const mcp = new McpClient(cwd);
  await mcp.request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'round3', version: '0.0.0' },
  });
  return { cwd, mcp };
}

async function teardown({ cwd, mcp }) {
  await mcp.close();
  await rm(cwd, { recursive: true, force: true });
}

// Accept a task via reviewer (phase-scope).
function phaseAccept(scope_id, task_ids) {
  return {
    scope: 'phase', scope_id, review_level: 'L1-batch',
    spec_passed: true, quality_passed: true,
    critical_issues: [], important_issues: [], minor_issues: [],
    accepted_tasks: task_ids, rework_tasks: [], evidence: [],
  };
}

const GREEN_VERIFICATION = {
  lint: { exit_code: 0 },
  typecheck: { exit_code: 0 },
  test: { exit_code: 0 },
};

describe('round3 — full orchestration cycles', () => {
  it('drives a 2-phase project to completion end-to-end', async () => {
    const ctx = await newProject('gsd-r3a-');
    try {
      const { mcp } = ctx;
      await mcp.call('state-init', {
        project: 'two-phase',
        phases: [
          { name: 'Phase 1', tasks: [{ name: 't1', level: 'L1' }] },
          { name: 'Phase 2', tasks: [{ name: 't2', level: 'L1' }] },
        ],
      });

      // Phase 1 execution
      await mcp.call('state-update', {
        updates: { workflow_mode: 'executing_task', current_phase: 1, current_task: '1.1' },
      });
      const exec1 = await mcp.call('orchestrator-handle-executor-result', {
        result: {
          task_id: '1.1', outcome: 'checkpointed',
          summary: 'implemented t1', checkpoint_commit: 'c1',
          files_changed: ['a.js'], decisions: [], blockers: [],
          contract_changed: false, evidence: [],
        },
      });
      assert.equal(exec1.success, true);

      // Phase review for phase 1
      const rev1 = await mcp.call('orchestrator-handle-reviewer-result',
        { result: phaseAccept(1, ['1.1']) });
      assert.equal(rev1.action, 'review_accepted', `rev1: ${JSON.stringify(rev1)}`);

      // Complete phase 1 → current_phase should advance to 2
      const pc1 = await mcp.call('phase-complete', {
        phase_id: 1, verification: GREEN_VERIFICATION,
      });
      assert.equal(pc1.success, true, `pc1: ${JSON.stringify(pc1)}`);
      assert.notEqual(pc1.workflow_mode, 'completed', 'not yet complete after phase 1');

      const after1 = await mcp.call('state-read', { fields: ['current_phase', 'phases'] });
      assert.equal(after1.current_phase, 2, 'current_phase should advance to 2');
      assert.equal(after1.phases[0].lifecycle, 'accepted');
      assert.equal(after1.phases[1].lifecycle, 'active', 'phase 2 should be active');

      // Phase 2 execution
      await mcp.call('state-update', { updates: { current_task: '2.1' } });
      const exec2 = await mcp.call('orchestrator-handle-executor-result', {
        result: {
          task_id: '2.1', outcome: 'checkpointed',
          summary: 'implemented t2', checkpoint_commit: 'c2',
          files_changed: ['b.js'], decisions: [], blockers: [],
          contract_changed: false, evidence: [],
        },
      });
      assert.equal(exec2.success, true);

      const rev2 = await mcp.call('orchestrator-handle-reviewer-result',
        { result: phaseAccept(2, ['2.1']) });
      assert.equal(rev2.action, 'review_accepted');

      const pc2 = await mcp.call('phase-complete', {
        phase_id: 2, verification: GREEN_VERIFICATION,
      });
      assert.equal(pc2.success, true);
      assert.equal(pc2.workflow_mode, 'completed',
        `final phase should transition to completed: ${JSON.stringify(pc2)}`);

      // Resume on a completed project should surface terminal state, not crash
      const resumed = await mcp.call('orchestrator-resume', {});
      assert.notEqual(resumed.error, true, `resume after completion: ${JSON.stringify(resumed)}`);
    } finally { await teardown(ctx); }
  });

  it('propagates rework to downstream task when invalidates_downstream=true', async () => {
    const ctx = await newProject('gsd-r3b-');
    try {
      const { mcp } = ctx;
      await mcp.call('state-init', {
        project: 'rework',
        phases: [{
          name: 'Phase 1',
          tasks: [
            { name: 'api', level: 'L1' },
            { name: 'consumer', level: 'L1',
              requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }] },
          ],
        }],
      });

      // Checkpoint both tasks
      await mcp.call('state-update', {
        updates: { workflow_mode: 'executing_task', current_task: '1.1' },
      });
      await mcp.call('orchestrator-handle-executor-result', {
        result: {
          task_id: '1.1', outcome: 'checkpointed',
          summary: 'api', checkpoint_commit: 'a1',
          files_changed: [], decisions: [], blockers: [],
          contract_changed: false, evidence: [],
        },
      });
      await mcp.call('state-update', { updates: { current_task: '1.2' } });
      await mcp.call('orchestrator-handle-executor-result', {
        result: {
          task_id: '1.2', outcome: 'checkpointed',
          summary: 'consumer', checkpoint_commit: 'a2',
          files_changed: [], decisions: [], blockers: [],
          contract_changed: false, evidence: [],
        },
      });

      // Reviewer: 1.1 needs rework AND invalidates downstream
      const rev = await mcp.call('orchestrator-handle-reviewer-result', {
        result: {
          scope: 'phase', scope_id: 1, review_level: 'L1-batch',
          spec_passed: false, quality_passed: true,
          critical_issues: [
            { task_id: '1.1', reason: 'contract broken', invalidates_downstream: true },
          ],
          important_issues: [], minor_issues: [],
          accepted_tasks: [], rework_tasks: ['1.1'],
          evidence: [],
        },
      });
      assert.equal(rev.action, 'rework_required', `rev: ${JSON.stringify(rev)}`);
      assert.equal(rev.review_status, 'rework_required');

      const st = await mcp.call('state-read', { fields: ['phases'] });
      const t11 = st.phases[0].todo.find(t => t.id === '1.1');
      const t12 = st.phases[0].todo.find(t => t.id === '1.2');
      assert.equal(t11.lifecycle, 'needs_revalidation',
        `1.1 should be needs_revalidation: ${t11.lifecycle}`);
      // Downstream propagation: 1.2 should also need revalidation since 1.1 was
      // marked contract_changed and invalidates_downstream=true
      assert.ok(
        ['needs_revalidation', 'pending', 'running'].includes(t12.lifecycle),
        `1.2 downstream should be invalidated, got: ${t12.lifecycle}`,
      );
    } finally { await teardown(ctx); }
  });

  it('debugger architecture_concern transitions phase to failed', async () => {
    const ctx = await newProject('gsd-r3c-');
    try {
      const { mcp } = ctx;
      await mcp.call('state-init', {
        project: 'fail',
        phases: [{ name: 'P', tasks: [{ name: 't', level: 'L1' }] }],
      });
      await mcp.call('state-update', {
        updates: { workflow_mode: 'executing_task', current_task: '1.1' },
      });

      // Drive task to 3 consecutive failures → debugger dispatch
      for (let i = 0; i < 3; i++) {
        await mcp.call('orchestrator-handle-executor-result', {
          result: {
            task_id: '1.1', outcome: 'failed',
            summary: `attempt ${i} failed`, checkpoint_commit: null,
            files_changed: [], decisions: [], blockers: ['test-suite red'],
            contract_changed: false, evidence: [],
            error_fingerprint: 'TestSuite::failure',
          },
        });
      }

      // Debugger returns architecture_concern — should escalate to phase_failed
      const dbg = await mcp.call('orchestrator-handle-debugger-result', {
        result: {
          task_id: '1.1', outcome: 'failed',
          root_cause: 'module boundary inverted — needs re-architecture',
          fix_direction: 'redesign module boundary; out of scope for this task',
          evidence: ['tests/foo.test.js:42'],
          hypothesis_tested: [
            { hypothesis: 'stale cache', result: 'rejected', evidence: 'cleared cache, same failure' },
          ],
          fix_attempts: 3, blockers: [],
          architecture_concern: true,
        },
      });
      assert.equal(dbg.action, 'phase_failed', `dbg action: ${JSON.stringify(dbg)}`);
      assert.equal(dbg.workflow_mode, 'failed');

      const st = await mcp.call('state-read', { fields: ['workflow_mode', 'phases'] });
      assert.equal(st.workflow_mode, 'failed');
      assert.equal(st.phases[0].lifecycle, 'failed');
      assert.equal(st.phases[0].todo[0].lifecycle, 'failed');
    } finally { await teardown(ctx); }
  });

  it('researcher result persists decisions with expiration', async () => {
    const ctx = await newProject('gsd-r3d-');
    try {
      const { mcp } = ctx;
      await mcp.call('state-init', {
        project: 'research',
        phases: [{ name: 'P', tasks: [{ name: 't', level: 'L1' }] }],
      });

      const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
      const source = { id: 's1', type: 'docs', ref: 'https://example.test/spec' };
      const res = await mcp.call('orchestrator-handle-researcher-result', {
        result: {
          decision_ids: ['D-arch-01'],
          volatility: 'low',
          expires_at: expiresAt,
          sources: [source],
        },
        artifacts: {
          'STACK.md': '# Stack\nSQLite',
          'ARCHITECTURE.md': '# Architecture\nSingle-user CLI',
          'PITFALLS.md': '# Pitfalls\nNone known',
          'SUMMARY.md': '# Summary\nChose SQLite for zero-config storage',
        },
        decision_index: {
          'D-arch-01': {
            summary: 'Chose SQLite over Postgres for single-user CLI',
            source: 'SUMMARY.md#L1',
            expires_at: expiresAt,
          },
        },
      });
      assert.equal(res.action, 'research_stored', `res: ${JSON.stringify(res)}`);
      assert.ok(Array.isArray(res.decision_ids));
      assert.ok(res.decision_ids.includes('D-arch-01'));
    } finally { await teardown(ctx); }
  });

  it('orchestrator-resume is re-entrant — terminal states stay terminal', async () => {
    // resume is a progress-driver, not a pure read: calling it on a running
    // workflow WILL bump _version to advance the state machine. But calling it
    // on a TERMINAL state (completed/failed) must be a true noop.
    const ctx = await newProject('gsd-r3e-');
    try {
      const { mcp } = ctx;
      await mcp.call('state-init', {
        project: 'terminal-resume',
        phases: [{ name: 'P', tasks: [{ name: 't', level: 'L1' }] }],
      });
      // Force workflow to 'completed' via the natural path: auto-accept L0 task
      // would be simpler, but to exercise terminal-resume we just drive via state-update
      // through a valid sequence: executing_task → awaiting_user (not terminal) is not terminal.
      // Instead: checkpoint + accept + phase-complete.
      await mcp.call('state-update', {
        updates: { workflow_mode: 'executing_task', current_task: '1.1' },
      });
      await mcp.call('orchestrator-handle-executor-result', {
        result: {
          task_id: '1.1', outcome: 'checkpointed',
          summary: 'done', checkpoint_commit: 'c',
          files_changed: [], decisions: [], blockers: [],
          contract_changed: false, evidence: [],
        },
      });
      await mcp.call('orchestrator-handle-reviewer-result',
        { result: phaseAccept(1, ['1.1']) });
      const pc = await mcp.call('phase-complete', {
        phase_id: 1, verification: GREEN_VERIFICATION,
      });
      assert.equal(pc.workflow_mode, 'completed');

      const v1 = (await mcp.call('state-read', { fields: ['_version'] }))._version;
      const r1 = await mcp.call('orchestrator-resume', {});
      const r2 = await mcp.call('orchestrator-resume', {});
      const v2 = (await mcp.call('state-read', { fields: ['_version'] }))._version;
      assert.equal(r1.action, 'noop', `terminal resume should be noop: ${JSON.stringify(r1)}`);
      assert.equal(r2.action, 'noop');
      assert.equal(v1, v2, `terminal resume must NOT bump _version: ${v1} → ${v2}`);
    } finally { await teardown(ctx); }
  });

  it('orchestrator-resume from paused_by_user surfaces actionable action', async () => {
    const ctx = await newProject('gsd-r3f-');
    try {
      const { mcp } = ctx;
      await mcp.call('state-init', {
        project: 'paused',
        phases: [{ name: 'P', tasks: [{ name: 't', level: 'L1' }] }],
      });
      await mcp.call('state-update', { updates: { workflow_mode: 'paused_by_user' } });

      const r = await mcp.call('orchestrator-resume', {});
      assert.notEqual(r.error, true, `resume should not error: ${JSON.stringify(r)}`);
      assert.ok(typeof r.action === 'string' && r.action.length > 0,
        `resume must return a string action: ${JSON.stringify(r)}`);
    } finally { await teardown(ctx); }
  });

  it('invalid reviewer payload produces a field-specific error', async () => {
    const ctx = await newProject('gsd-r3g-');
    try {
      const { mcp } = ctx;
      await mcp.call('state-init', {
        project: 'ux-errs',
        phases: [{ name: 'P', tasks: [{ name: 't', level: 'L1' }] }],
      });

      // Invalid scope value should name the offending field in the error.
      const r = await mcp.call('orchestrator-handle-reviewer-result', {
        result: {
          scope: 'galaxy', scope_id: 1, review_level: 'L1-batch',
          spec_passed: true, quality_passed: true,
          critical_issues: [], important_issues: [], minor_issues: [],
          accepted_tasks: [], rework_tasks: [], evidence: [],
        },
      });
      assert.equal(r.error, true);
      assert.match(r.message, /scope/i, `error must name 'scope': ${r.message}`);
    } finally { await teardown(ctx); }
  });

  it('invalid debugger payload surfaces which field failed', async () => {
    const ctx = await newProject('gsd-r3h-');
    try {
      const { mcp } = ctx;
      await mcp.call('state-init', {
        project: 'debug-errs',
        phases: [{ name: 'P', tasks: [{ name: 't', level: 'L1' }] }],
      });

      // fix_attempts=5 but outcome!=failed should be rejected with a clear message
      const r = await mcp.call('orchestrator-handle-debugger-result', {
        result: {
          task_id: '1.1', outcome: 'fix_suggested',
          root_cause: 'x', fix_direction: 'y',
          evidence: [], hypothesis_tested: [],
          fix_attempts: 5, blockers: [],
          architecture_concern: false,
        },
      });
      assert.equal(r.error, true);
      assert.match(r.message, /fix_attempts/i,
        `error should name fix_attempts: ${r.message}`);
    } finally { await teardown(ctx); }
  });
});
