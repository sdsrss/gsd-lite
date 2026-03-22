import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const HOOK_PATH = join(import.meta.dirname, '..', 'hooks', 'gsd-context-monitor.cjs');

/**
 * Helper: run the CJS context-monitor hook with given JSON stdin.
 * Returns { stdout, stderr, status }.
 */
function runHook(inputData, opts = {}) {
  const input = JSON.stringify(inputData);
  try {
    const stdout = execFileSync(process.execPath, [HOOK_PATH], {
      input,
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, GSD_DEBUG: '1', ...(opts.env || {}) },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', status: err.status };
  }
}

/**
 * Write a bridge metrics file for a given session ID.
 */
function writeBridgeFile(sessionId, metrics) {
  const bridgePath = join(tmpdir(), `gsd-ctx-${sessionId}.json`);
  writeFileSync(bridgePath, JSON.stringify(metrics));
  return bridgePath;
}

/**
 * Clean up bridge + warned files for a session.
 */
function cleanupSession(sessionId) {
  const bridgePath = join(tmpdir(), `gsd-ctx-${sessionId}.json`);
  const warnPath = join(tmpdir(), `gsd-ctx-${sessionId}-warned.json`);
  try { unlinkSync(bridgePath); } catch {}
  try { unlinkSync(warnPath); } catch {}
}

describe('gsd-context-monitor.cjs (production PostToolUse hook)', () => {
  // Each test uses a unique session ID to avoid cross-test interference
  let testCounter = 0;
  function nextSessionId() {
    return `test-ctx-${Date.now()}-${++testCounter}`;
  }

  it('exits silently when no session_id is provided', () => {
    const result = runHook({ tool_use_id: 'abc' });
    assert.equal(result.stdout, '');
    assert.equal(result.status, 0);
  });

  it('exits silently when session_id is empty string', () => {
    const result = runHook({ session_id: '' });
    assert.equal(result.stdout, '');
    assert.equal(result.status, 0);
  });

  it('exits silently when no bridge file exists', () => {
    const sid = nextSessionId();
    cleanupSession(sid); // ensure no bridge file
    const result = runHook({ session_id: sid });
    assert.equal(result.stdout, '');
    assert.equal(result.status, 0);
  });

  it('exits silently when remaining > 35% (above warning threshold)', () => {
    const sid = nextSessionId();
    const now = Math.floor(Date.now() / 1000);
    writeBridgeFile(sid, {
      remaining_percentage: 72,
      used_pct: 28,
      has_gsd: true,
      timestamp: now,
    });
    try {
      const result = runHook({ session_id: sid });
      assert.equal(result.stdout, '');
      assert.equal(result.status, 0);
    } finally {
      cleanupSession(sid);
    }
  });

  it('exits silently when metrics are stale (older than 60s)', () => {
    const sid = nextSessionId();
    const staleTimestamp = Math.floor(Date.now() / 1000) - 120; // 2 minutes old
    writeBridgeFile(sid, {
      remaining_percentage: 20,
      used_pct: 80,
      has_gsd: true,
      timestamp: staleTimestamp,
    });
    try {
      const result = runHook({ session_id: sid });
      assert.equal(result.stdout, '');
      assert.equal(result.status, 0);
    } finally {
      cleanupSession(sid);
    }
  });

  it('exits silently when has_gsd is false (non-GSD session)', () => {
    const sid = nextSessionId();
    const now = Math.floor(Date.now() / 1000);
    writeBridgeFile(sid, {
      remaining_percentage: 20,
      used_pct: 80,
      has_gsd: false,
      timestamp: now,
    });
    try {
      const result = runHook({ session_id: sid });
      assert.equal(result.stdout, '');
      assert.equal(result.status, 0);
    } finally {
      cleanupSession(sid);
    }
  });

  it('emits WARNING when remaining <= 35% and > 25%', () => {
    const sid = nextSessionId();
    const now = Math.floor(Date.now() / 1000);
    writeBridgeFile(sid, {
      remaining_percentage: 30,
      used_pct: 70,
      has_gsd: true,
      timestamp: now,
    });
    try {
      const result = runHook({ session_id: sid });
      assert.equal(result.status, 0);
      const output = JSON.parse(result.stdout);
      assert.ok(output.hookSpecificOutput);
      assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
      const msg = output.hookSpecificOutput.additionalContext;
      assert.ok(msg.includes('CONTEXT WARNING'), `Expected WARNING, got: ${msg}`);
      assert.ok(msg.includes('70%'), 'Should include used percentage');
      assert.ok(msg.includes('30%'), 'Should include remaining percentage');
    } finally {
      cleanupSession(sid);
    }
  });

  it('emits CRITICAL when remaining <= 25%', () => {
    const sid = nextSessionId();
    const now = Math.floor(Date.now() / 1000);
    writeBridgeFile(sid, {
      remaining_percentage: 20,
      used_pct: 80,
      has_gsd: true,
      timestamp: now,
    });
    try {
      const result = runHook({ session_id: sid });
      assert.equal(result.status, 0);
      const output = JSON.parse(result.stdout);
      const msg = output.hookSpecificOutput.additionalContext;
      assert.ok(msg.includes('CONTEXT CRITICAL'), `Expected CRITICAL, got: ${msg}`);
      assert.ok(msg.includes('80%'), 'Should include used percentage');
      assert.ok(msg.includes('20%'), 'Should include remaining percentage');
      assert.ok(msg.includes('awaiting_clear'), 'Should instruct to set awaiting_clear');
    } finally {
      cleanupSession(sid);
    }
  });

  // Boundary tests
  it('boundary: 36% remaining exits silently (just above threshold)', () => {
    const sid = nextSessionId();
    const now = Math.floor(Date.now() / 1000);
    writeBridgeFile(sid, {
      remaining_percentage: 36,
      used_pct: 64,
      has_gsd: true,
      timestamp: now,
    });
    try {
      const result = runHook({ session_id: sid });
      assert.equal(result.stdout, '');
      assert.equal(result.status, 0);
    } finally {
      cleanupSession(sid);
    }
  });

  it('boundary: 35% remaining emits WARNING (exactly at threshold)', () => {
    const sid = nextSessionId();
    const now = Math.floor(Date.now() / 1000);
    writeBridgeFile(sid, {
      remaining_percentage: 35,
      used_pct: 65,
      has_gsd: true,
      timestamp: now,
    });
    try {
      const result = runHook({ session_id: sid });
      const output = JSON.parse(result.stdout);
      const msg = output.hookSpecificOutput.additionalContext;
      assert.ok(msg.includes('CONTEXT WARNING'), `Expected WARNING at 35%, got: ${msg}`);
    } finally {
      cleanupSession(sid);
    }
  });

  it('boundary: 26% remaining emits WARNING (just above critical)', () => {
    const sid = nextSessionId();
    const now = Math.floor(Date.now() / 1000);
    writeBridgeFile(sid, {
      remaining_percentage: 26,
      used_pct: 74,
      has_gsd: true,
      timestamp: now,
    });
    try {
      const result = runHook({ session_id: sid });
      const output = JSON.parse(result.stdout);
      const msg = output.hookSpecificOutput.additionalContext;
      assert.ok(msg.includes('CONTEXT WARNING'), `Expected WARNING at 26%, got: ${msg}`);
    } finally {
      cleanupSession(sid);
    }
  });

  it('boundary: 25% remaining emits CRITICAL (exactly at critical threshold)', () => {
    const sid = nextSessionId();
    const now = Math.floor(Date.now() / 1000);
    writeBridgeFile(sid, {
      remaining_percentage: 25,
      used_pct: 75,
      has_gsd: true,
      timestamp: now,
    });
    try {
      const result = runHook({ session_id: sid });
      const output = JSON.parse(result.stdout);
      const msg = output.hookSpecificOutput.additionalContext;
      assert.ok(msg.includes('CONTEXT CRITICAL'), `Expected CRITICAL at 25%, got: ${msg}`);
    } finally {
      cleanupSession(sid);
    }
  });

  it('boundary: 24% remaining emits CRITICAL', () => {
    const sid = nextSessionId();
    const now = Math.floor(Date.now() / 1000);
    writeBridgeFile(sid, {
      remaining_percentage: 24,
      used_pct: 76,
      has_gsd: true,
      timestamp: now,
    });
    try {
      const result = runHook({ session_id: sid });
      const output = JSON.parse(result.stdout);
      const msg = output.hookSpecificOutput.additionalContext;
      assert.ok(msg.includes('CONTEXT CRITICAL'), `Expected CRITICAL at 24%, got: ${msg}`);
    } finally {
      cleanupSession(sid);
    }
  });

  // Debounce tests
  describe('debouncing', () => {
    it('suppresses repeated warnings within DEBOUNCE_CALLS (5)', () => {
      const sid = nextSessionId();
      const now = Math.floor(Date.now() / 1000);
      writeBridgeFile(sid, {
        remaining_percentage: 30,
        used_pct: 70,
        has_gsd: true,
        timestamp: now,
      });
      try {
        // First call: should emit warning
        const first = runHook({ session_id: sid });
        assert.ok(first.stdout.length > 0, 'First call should emit warning');
        const firstOutput = JSON.parse(first.stdout);
        assert.ok(firstOutput.hookSpecificOutput.additionalContext.includes('CONTEXT WARNING'));

        // Calls 2-5: should be debounced (silent)
        for (let i = 2; i <= 5; i++) {
          // Refresh timestamp so metrics aren't stale
          writeBridgeFile(sid, {
            remaining_percentage: 30,
            used_pct: 70,
            has_gsd: true,
            timestamp: Math.floor(Date.now() / 1000),
          });
          const result = runHook({ session_id: sid });
          assert.equal(result.stdout, '', `Call ${i} should be debounced (silent)`);
        }

        // 6th call: should emit warning again (debounce expired)
        writeBridgeFile(sid, {
          remaining_percentage: 30,
          used_pct: 70,
          has_gsd: true,
          timestamp: Math.floor(Date.now() / 1000),
        });
        const sixth = runHook({ session_id: sid });
        assert.ok(sixth.stdout.length > 0, '6th call should emit warning (debounce expired)');
        const sixthOutput = JSON.parse(sixth.stdout);
        assert.ok(sixthOutput.hookSpecificOutput.additionalContext.includes('CONTEXT WARNING'));
      } finally {
        cleanupSession(sid);
      }
    });

    it('severity escalation bypasses debounce (warning -> critical)', () => {
      const sid = nextSessionId();
      const now = Math.floor(Date.now() / 1000);
      // First call: WARNING at 30%
      writeBridgeFile(sid, {
        remaining_percentage: 30,
        used_pct: 70,
        has_gsd: true,
        timestamp: now,
      });
      try {
        const first = runHook({ session_id: sid });
        assert.ok(first.stdout.length > 0, 'First call should emit warning');
        const firstOutput = JSON.parse(first.stdout);
        assert.ok(firstOutput.hookSpecificOutput.additionalContext.includes('CONTEXT WARNING'));

        // Second call: CRITICAL at 20% — should bypass debounce
        writeBridgeFile(sid, {
          remaining_percentage: 20,
          used_pct: 80,
          has_gsd: true,
          timestamp: Math.floor(Date.now() / 1000),
        });
        const second = runHook({ session_id: sid });
        assert.ok(second.stdout.length > 0, 'Severity escalation should bypass debounce');
        const secondOutput = JSON.parse(second.stdout);
        assert.ok(secondOutput.hookSpecificOutput.additionalContext.includes('CONTEXT CRITICAL'));
      } finally {
        cleanupSession(sid);
      }
    });

    it('same severity does NOT bypass debounce', () => {
      const sid = nextSessionId();
      const now = Math.floor(Date.now() / 1000);
      // First call: CRITICAL at 20%
      writeBridgeFile(sid, {
        remaining_percentage: 20,
        used_pct: 80,
        has_gsd: true,
        timestamp: now,
      });
      try {
        const first = runHook({ session_id: sid });
        assert.ok(first.stdout.length > 0, 'First call should emit critical');

        // Second call: still CRITICAL at 15% — should be debounced (no escalation)
        writeBridgeFile(sid, {
          remaining_percentage: 15,
          used_pct: 85,
          has_gsd: true,
          timestamp: Math.floor(Date.now() / 1000),
        });
        const second = runHook({ session_id: sid });
        assert.equal(second.stdout, '', 'Same severity (critical->critical) should be debounced');
      } finally {
        cleanupSession(sid);
      }
    });
  });

  // Session ID sanitization
  it('sanitizes session_id (strips non-alphanumeric characters)', () => {
    const sid = nextSessionId();
    const sanitized = sid.replace(/[^a-zA-Z0-9_-]/g, '');
    const now = Math.floor(Date.now() / 1000);
    writeBridgeFile(sanitized, {
      remaining_percentage: 30,
      used_pct: 70,
      has_gsd: true,
      timestamp: now,
    });
    try {
      const result = runHook({ session_id: sid });
      // The session ID from nextSessionId() only contains safe chars already,
      // so this should find the bridge file and emit a warning
      assert.ok(result.stdout.length > 0, 'Should work with sanitized session ID');
    } finally {
      cleanupSession(sanitized);
    }
  });

  it('handles malformed bridge file JSON gracefully', () => {
    const sid = nextSessionId();
    const bridgePath = join(tmpdir(), `gsd-ctx-${sid}.json`);
    writeFileSync(bridgePath, 'not valid json');
    try {
      const result = runHook({ session_id: sid });
      assert.equal(result.stdout, '');
      assert.equal(result.status, 0);
    } finally {
      cleanupSession(sid);
    }
  });

  it('handles missing timestamp in metrics (treats as stale)', () => {
    const sid = nextSessionId();
    writeBridgeFile(sid, {
      remaining_percentage: 20,
      used_pct: 80,
      has_gsd: true,
      // no timestamp
    });
    try {
      const result = runHook({ session_id: sid });
      assert.equal(result.stdout, '', 'Missing timestamp should be treated as stale');
      assert.equal(result.status, 0);
    } finally {
      cleanupSession(sid);
    }
  });

  it('output has correct hookSpecificOutput structure', () => {
    const sid = nextSessionId();
    const now = Math.floor(Date.now() / 1000);
    writeBridgeFile(sid, {
      remaining_percentage: 30,
      used_pct: 70,
      has_gsd: true,
      timestamp: now,
    });
    try {
      const result = runHook({ session_id: sid });
      const output = JSON.parse(result.stdout);
      assert.ok(output.hookSpecificOutput, 'Should have hookSpecificOutput');
      assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
      assert.ok(typeof output.hookSpecificOutput.additionalContext === 'string');
    } finally {
      cleanupSession(sid);
    }
  });
});
