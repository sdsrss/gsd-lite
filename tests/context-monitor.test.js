import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statusLine, postToolUse } from '../hooks/context-monitor.js';

describe('context-monitor hooks', () => {
  let tempDir;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-context-'));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('statusLine', () => {
    it('writes remaining_percentage to .gsd/.context-health', () => {
      statusLine({ context_window: { remaining_percentage: 72 } }, tempDir);
      const content = readFileSync(join(tempDir, '.gsd', '.context-health'), 'utf-8');
      assert.equal(content, '72');
    });

    it('overwrites on subsequent calls', () => {
      statusLine({ context_window: { remaining_percentage: 50 } }, tempDir);
      const content = readFileSync(join(tempDir, '.gsd', '.context-health'), 'utf-8');
      assert.equal(content, '50');
    });

    it('creates .gsd/ directory if not exists', async () => {
      await rm(join(tempDir, '.gsd'), { recursive: true, force: true });
      statusLine({ context_window: { remaining_percentage: 60 } }, tempDir);
      const content = readFileSync(join(tempDir, '.gsd', '.context-health'), 'utf-8');
      assert.equal(content, '60');
    });

    it('handles null data gracefully', () => {
      assert.doesNotThrow(() => statusLine(null, tempDir));
    });

    it('handles empty object gracefully', () => {
      assert.doesNotThrow(() => statusLine({}, tempDir));
    });

    it('handles missing remaining_percentage gracefully', () => {
      assert.doesNotThrow(() => statusLine({ context_window: {} }, tempDir));
    });

    it('handles undefined data gracefully', () => {
      assert.doesNotThrow(() => statusLine(undefined, tempDir));
    });
  });

  describe('postToolUse', () => {
    function writeHealth(value) {
      mkdirSync(join(tempDir, '.gsd'), { recursive: true });
      writeFileSync(join(tempDir, '.gsd', '.context-health'), String(value));
    }

    it('returns null when health >= 35', () => {
      writeHealth(72);
      assert.equal(postToolUse(tempDir), null);
    });

    it('returns LOW warning when 25 <= health < 35', () => {
      writeHealth(30);
      const result = postToolUse(tempDir);
      assert.ok(result.includes('CONTEXT LOW'));
      assert.ok(result.includes('30%'));
      assert.ok(result.includes('awaiting_clear'));
    });

    it('returns EMERGENCY when health < 25', () => {
      writeHealth(15);
      const result = postToolUse(tempDir);
      assert.ok(result.includes('CONTEXT EMERGENCY'));
      assert.ok(result.includes('15%'));
      assert.ok(result.includes('Save state NOW'));
    });

    it('returns null when .context-health does not exist', async () => {
      await rm(join(tempDir, '.gsd'), { recursive: true, force: true });
      assert.equal(postToolUse(tempDir), null);
    });

    // Boundary tests — aligned with CJS production thresholds (35/25)
    it('boundary: 35% returns null (35 is not < 35)', () => {
      writeHealth(35);
      assert.equal(postToolUse(tempDir), null);
    });

    it('boundary: 34% returns LOW warning', () => {
      writeHealth(34);
      const result = postToolUse(tempDir);
      assert.ok(result.includes('CONTEXT LOW'));
      assert.ok(result.includes('34%'));
    });

    it('boundary: 25% returns LOW warning (25 is not < 25)', () => {
      writeHealth(25);
      const result = postToolUse(tempDir);
      assert.ok(result.includes('CONTEXT LOW'));
      assert.ok(result.includes('25%'));
    });

    it('boundary: 24% returns EMERGENCY', () => {
      writeHealth(24);
      const result = postToolUse(tempDir);
      assert.ok(result.includes('CONTEXT EMERGENCY'));
      assert.ok(result.includes('24%'));
    });
  });
});
