// Round 2 — edge cases & error UX via live MCP server.
// Focus: does the server produce helpful error messages and recover cleanly?
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
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
    return JSON.parse(r.result.content[0].text);
  }
  async close() { this.proc.stdin.end(); await new Promise(r => this.proc.on('exit', r)); }
}

async function init(cwd) {
  const mcp = new McpClient(cwd);
  await mcp.request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'round2', version: '0.0.0' },
  });
  return mcp;
}

describe('round2 — edge cases & error UX', () => {
  let cwd; let mcp;
  before(async () => { cwd = await mkdtemp(join(tmpdir(), 'gsd-r2-')); mcp = await init(cwd); });
  after(async () => { await mcp.close(); await rm(cwd, { recursive: true, force: true }); });

  it('state-read returns actionable error before init', async () => {
    const r = await mcp.call('state-read', {});
    assert.equal(r.error, true);
    assert.match(r.message, /No GSD project|start|prd/i, `error should guide user: ${r.message}`);
  });

  it('state-init rejects duplicate without force', async () => {
    await mcp.call('state-init', { project: 'p', phases: [{ name: 'P1', tasks: [{ name: 't' }] }] });
    const r = await mcp.call('state-init', { project: 'p', phases: [{ name: 'P1', tasks: [{ name: 't' }] }] });
    assert.equal(r.error, true);
    assert.match(r.message, /force.*true|already exists/i);
  });

  it('state-init with empty phases array is rejected', async () => {
    const d2 = await mkdtemp(join(tmpdir(), 'gsd-r2b-'));
    const m2 = await init(d2);
    try {
      const r = await m2.call('state-init', { project: 'x', phases: [] });
      assert.equal(r.error, true);
      assert.match(r.message, /at least one phase|phases must/i);
    } finally { await m2.close(); await rm(d2, { recursive: true, force: true }); }
  });

  it('state-update rejects invalid workflow_mode with list of valid values', async () => {
    const r = await mcp.call('state-update', { updates: { workflow_mode: 'bogus_mode' } });
    assert.equal(r.error, true);
    assert.match(r.message, /Invalid workflow_mode/, `should name the invalid mode: ${r.message}`);
    assert.match(r.message, /executing_task|planning/, 'should list valid modes');
  });

  it('state-update rejects an illegal transition with source and allowed list', async () => {
    // From executing_task we can't jump to 'completed' directly without phases accepted
    const r = await mcp.call('state-update', { updates: { workflow_mode: 'completed' } });
    assert.equal(r.error, true);
    // Either rejected on transition table or on phases-not-accepted check
    assert.ok(
      /Invalid workflow_mode transition|not accepted/.test(r.message),
      `error should explain what is blocking: ${r.message}`,
    );
  });

  it('phase-complete on non-existent phase fails with helpful message', async () => {
    const r = await mcp.call('phase-complete', { phase_id: 99 });
    assert.equal(r.error || r.success === false, true);
    assert.ok(r.message, `must include a message, got: ${JSON.stringify(r)}`);
  });

  it('state-patch with unknown op is rejected without corrupting state', async () => {
    const before = await mcp.call('state-read', { fields: ['_version'] });
    const r = await mcp.call('state-patch', { operations: [{ op: 'nuke_everything' }] });
    assert.equal(r.error || r.success === false, true);
    const after = await mcp.call('state-read', { fields: ['_version'] });
    assert.equal(after._version, before._version,
      'failed patch must not bump _version');
  });

  it('orchestrator-handle-executor-result rejects malformed payload', async () => {
    const r = await mcp.call('orchestrator-handle-executor-result', {
      result: { task_id: 'not-real', outcome: 'invalid_outcome' },
    });
    // Should either error or return a structured failure with message
    if (r.error === true) {
      assert.ok(r.message, 'must include message');
    } else {
      // Some handlers return success:false rather than error:true
      assert.ok(r.success === false || r.guidance || r.message);
    }
  });

  it('corrupted state.json produces a parse/validation error, not a crash', async () => {
    // Overwrite state.json with invalid JSON
    const statePath = join(cwd, '.gsd', 'state.json');
    const backup = await readFile(statePath, 'utf-8');
    await writeFile(statePath, '{ not valid json', 'utf-8');
    try {
      const r = await mcp.call('state-read', {});
      assert.equal(r.error, true);
      assert.ok(r.message, 'must surface a message');
      // Server should still respond to health
      const h = await mcp.call('health', {});
      assert.equal(h.status, 'ok');
    } finally {
      await writeFile(statePath, backup, 'utf-8');
    }
  });

  it('stop/resume roundtrip preserves state', async () => {
    // Set a unique signal
    await mcp.call('state-update', { updates: {
      decisions: [{ id: 'D-rt', summary: 'roundtrip marker', rationale: 'test' }],
    } });
    // Simulate pause by user
    await mcp.call('state-update', { updates: { workflow_mode: 'paused_by_user' } });
    // Resume should surface a clear next-step hint, not crash
    const resumed = await mcp.call('orchestrator-resume', {});
    assert.notEqual(resumed.error, true,
      `resume should return structured action, not error: ${JSON.stringify(resumed)}`);
    // Decision marker must still be present
    const after = await mcp.call('state-read', { fields: ['decisions'] });
    const match = after.decisions?.find(d => d.id === 'D-rt');
    assert.ok(match, 'decision should survive pause + resume');
  });
});
