import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statusLine, postToolUse } from '../hooks/context-monitor.js';

describe('context-monitor hooks', () => {
  let tempDir;
  let originalCwd;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-context-'));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  after(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('statusLine', () => {
    it('writes remaining_percentage to .gsd/.context-health', () => {
      statusLine({ context_window: { remaining_percentage: 72 } });
      const content = readFileSync(join(tempDir, '.gsd', '.context-health'), 'utf-8');
      assert.equal(content, '72');
    });

    it('overwrites on subsequent calls', () => {
      statusLine({ context_window: { remaining_percentage: 50 } });
      const content = readFileSync(join(tempDir, '.gsd', '.context-health'), 'utf-8');
      assert.equal(content, '50');
    });

    it('creates .gsd/ directory if not exists', async () => {
      // Remove .gsd/ and verify it gets recreated
      await rm(join(tempDir, '.gsd'), { recursive: true, force: true });
      statusLine({ context_window: { remaining_percentage: 60 } });
      const content = readFileSync(join(tempDir, '.gsd', '.context-health'), 'utf-8');
      assert.equal(content, '60');
    });

    it('handles null data gracefully', () => {
      assert.doesNotThrow(() => statusLine(null));
    });

    it('handles empty object gracefully', () => {
      assert.doesNotThrow(() => statusLine({}));
    });

    it('handles missing remaining_percentage gracefully', () => {
      assert.doesNotThrow(() => statusLine({ context_window: {} }));
    });

    it('handles undefined data gracefully', () => {
      assert.doesNotThrow(() => statusLine(undefined));
    });
  });

  describe('postToolUse', () => {
    function writeHealth(value) {
      mkdirSync(join(tempDir, '.gsd'), { recursive: true });
      writeFileSync(join(tempDir, '.gsd', '.context-health'), String(value));
    }

    it('returns null when health >= 40', () => {
      writeHealth(72);
      assert.equal(postToolUse(), null);
    });

    it('returns LOW warning when 20 <= health < 40', () => {
      writeHealth(35);
      const result = postToolUse();
      assert.ok(result.includes('CONTEXT LOW'));
      assert.ok(result.includes('35%'));
      assert.ok(result.includes('awaiting_clear'));
    });

    it('returns EMERGENCY when health < 20', () => {
      writeHealth(15);
      const result = postToolUse();
      assert.ok(result.includes('CONTEXT EMERGENCY'));
      assert.ok(result.includes('15%'));
      assert.ok(result.includes('Save state NOW'));
    });

    it('returns null when .context-health does not exist', async () => {
      await rm(join(tempDir, '.gsd'), { recursive: true, force: true });
      assert.equal(postToolUse(), null);
    });

    // Boundary tests (Test Case 6)
    it('boundary: 40% returns null (40 is not < 40)', () => {
      writeHealth(40);
      assert.equal(postToolUse(), null);
    });

    it('boundary: 39% returns LOW warning', () => {
      writeHealth(39);
      const result = postToolUse();
      assert.ok(result.includes('CONTEXT LOW'));
      assert.ok(result.includes('39%'));
    });

    it('boundary: 20% returns LOW warning (20 is not < 20)', () => {
      writeHealth(20);
      const result = postToolUse();
      assert.ok(result.includes('CONTEXT LOW'));
      assert.ok(result.includes('20%'));
    });

    it('boundary: 19% returns EMERGENCY', () => {
      writeHealth(19);
      const result = postToolUse();
      assert.ok(result.includes('CONTEXT EMERGENCY'));
      assert.ok(result.includes('19%'));
    });
  });
});
