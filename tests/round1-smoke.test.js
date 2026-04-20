// Round 1 smoke — drives the MCP server over stdio the way Claude Code would.
// Simulates: health → state-init → happy-path state-read/update → orchestrator
// resume → phase-complete. Catches issues that unit tests skip because they
// import the modules directly and bypass JSON-RPC serialization.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SERVER = join(__dirname, '..', 'src', 'server.js');

class McpClient {
  constructor(cwd) {
    this.proc = spawn('node', [SERVER], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.id = 0;
    this.buf = '';
    this.pending = new Map();
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk.toString();
      for (;;) {
        const nl = this.buf.indexOf('\n');
        if (nl < 0) break;
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const r = this.pending.get(msg.id);
          if (r) { this.pending.delete(msg.id); r(msg); }
        } catch { /* ignore non-JSON */ }
      }
    });
  }
  request(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 8000);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async call(tool, args) {
    const r = await this.request('tools/call', { name: tool, arguments: args });
    if (r.error) throw new Error(`RPC error ${r.error.code}: ${r.error.message}`);
    const text = r.result?.content?.[0]?.text;
    return text ? JSON.parse(text) : r.result;
  }
  async close() {
    this.proc.stdin.end();
    await new Promise((res) => this.proc.on('exit', res));
  }
}

describe('round1 — MCP stdio smoke', () => {
  let cwd;
  let mcp;
  before(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'gsd-r1-'));
    mcp = new McpClient(cwd);
    // Initialize MCP handshake
    await mcp.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'round1', version: '0.0.0' },
    });
  });
  after(async () => {
    await mcp.close();
    await rm(cwd, { recursive: true, force: true });
  });

  it('lists tools and reports health before init', async () => {
    const list = await mcp.request('tools/list', {});
    assert.ok(Array.isArray(list.result?.tools));
    const names = list.result.tools.map(t => t.name);
    assert.ok(names.includes('state-init'));
    assert.ok(names.includes('orchestrator-resume'));

    const health = await mcp.call('health', {});
    assert.equal(health.status, 'ok');
    assert.equal(health.state_exists, false, 'health reports no state before init');
  });

  it('initializes a minimal project and surfaces state', async () => {
    const initRes = await mcp.call('state-init', {
      project: 'r1-smoke',
      phases: [
        { name: 'Phase 1', tasks: [
          { name: 'write tests', level: 'L1' },
          { name: 'implement', level: 'L1', requires: [{ kind: 'task', id: '1.1', gate: 'accepted' }] },
        ] },
      ],
    });
    assert.equal(initRes.error, undefined, `state-init should not error: ${JSON.stringify(initRes)}`);
    assert.ok(existsSync(join(cwd, '.gsd', 'state.json')));
    assert.ok(existsSync(join(cwd, '.gsd', 'plan.md')));

    const state = await mcp.call('state-read', {});
    assert.equal(state.project, 'r1-smoke');
    assert.equal(state.total_phases, 1);
    // Initial workflow_mode is 'executing_task' (see schema.js createInitialState),
    // not 'planning' — 'planning' is listed in WORKFLOW_MODES but unused at init.
    assert.equal(state.workflow_mode, 'executing_task');
    // Phase task list lives under `todo` (array); `tasks` is a count number.
    assert.equal(state.phases?.[0]?.tasks, 2);
    assert.equal(state.phases?.[0]?.todo?.length, 2);
  });

  it('drives a task through executor → reviewer → accept', async () => {
    // Simulate orchestrator driving executor for task 1.1
    const upd1 = await mcp.call('state-update', {
      updates: { workflow_mode: 'executing_task', current_phase: 1, current_task: '1.1' },
    });
    assert.equal(upd1.success, true);

    const exec = await mcp.call('orchestrator-handle-executor-result', {
      result: {
        task_id: '1.1',
        outcome: 'checkpointed',
        summary: 'wrote unit test for add()',
        checkpoint_commit: 'abc123',
        files_changed: ['test/add.test.js'],
        decisions: [],
        blockers: [],
        contract_changed: false,
        evidence: ['test/add.test.js'],
      },
    });
    // Executor result should be persisted and next action surfaced
    assert.notEqual(exec.error, true, `executor handler should not error: ${JSON.stringify(exec)}`);

    // Orchestrator should be able to resume
    const resumeRes = await mcp.call('orchestrator-resume', {});
    assert.notEqual(resumeRes.error, true,
      `orchestrator-resume should not error: ${JSON.stringify(resumeRes)}`);

    // state-read should reflect task lifecycle move
    const state = await mcp.call('state-read', { fields: ['phases', 'workflow_mode'] });
    const task11 = state.phases?.[0]?.todo?.find(t => t.id === '1.1');
    assert.ok(task11, 'task 1.1 should exist in state.todo');
    assert.ok(['checkpointed', 'accepted'].includes(task11.lifecycle),
      `task 1.1 lifecycle should advance past pending/running, got: ${task11.lifecycle}`);
  });

  it('rejects malformed state-init gracefully', async () => {
    const r = await mcp.call('state-init', { project: 'dup' });
    // Missing phases — schema-required. Should fail but not crash server.
    assert.ok(r.error || r.success === false, `expected failure shape, got: ${JSON.stringify(r)}`);
  });

  it('rejects unknown tool with clear error', async () => {
    const r = await mcp.call('does-not-exist', {});
    assert.equal(r.error, true);
    assert.match(r.message, /Unknown tool/);
  });
});
