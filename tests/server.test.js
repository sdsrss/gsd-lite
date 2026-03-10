import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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
});