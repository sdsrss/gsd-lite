import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, read, update } from '../src/tools/state/index.js';
import { handleResearcherResult } from '../src/tools/orchestrator/index.js';

function makeValidResearcherResult(overrides = {}) {
  return {
    decision_ids: ['decision:jwt'],
    volatility: 'low',
    expires_at: '2027-01-01T00:00:00Z',
    sources: [{ id: 'src-1', type: 'documentation', ref: 'https://example.com/jwt' }],
    ...overrides,
  };
}

function makeValidArtifacts(overrides = {}) {
  return {
    'STACK.md': '# Stack\nNode.js + ESM',
    'ARCHITECTURE.md': '# Architecture\nMCP server pattern',
    'PITFALLS.md': '# Pitfalls\nWatch for race conditions',
    'SUMMARY.md': '# Summary\nResearch complete',
    ...overrides,
  };
}

function makeValidDecisionIndex(overrides = {}) {
  return {
    'decision:jwt': { summary: 'Use JWT for auth', source: 'Context7' },
    ...overrides,
  };
}

async function setupResearchProject(basePath) {
  await init({
    project: 'researcher-test',
    phases: [{
      name: 'Core',
      tasks: [
        { index: 1, name: 'Task A', level: 'L1' },
      ],
    }],
    research: true,
    basePath,
  });

  // Ensure research directory exists for storeResearch
  await mkdir(join(basePath, '.gsd', 'research'), { recursive: true });
}

describe('handleResearcherResult', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-researcher-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('stores valid research result and returns success', async () => {
    await setupResearchProject(tempDir);

    const result = await handleResearcherResult({
      result: makeValidResearcherResult(),
      artifacts: makeValidArtifacts(),
      decision_index: makeValidDecisionIndex(),
      basePath: tempDir,
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'research_stored');
    assert.deepEqual(result.decision_ids, ['decision:jwt']);
    assert.ok(Array.isArray(result.stored_files));
    assert.ok(result.stored_files.length > 0);

    const state = await read({ basePath: tempDir });
    assert.ok(state.research, 'state should have research field');
    assert.ok(state.research.decision_index['decision:jwt'], 'decision_index should contain the decision');
  });

  it('rejects null input', async () => {
    const result = await handleResearcherResult({ result: null, basePath: tempDir });
    assert.equal(result.error, true);
    assert.match(result.message, /result must be an object/);
  });

  it('rejects array input', async () => {
    const result = await handleResearcherResult({ result: [], basePath: tempDir });
    assert.equal(result.error, true);
    assert.match(result.message, /result must be an object/);
  });

  it('rejects string input', async () => {
    const result = await handleResearcherResult({ result: '[BLOCKED] needs info', basePath: tempDir });
    assert.equal(result.error, true);
    assert.match(result.message, /result must be an object/);
  });

  it('returns validation error for invalid researcher result', async () => {
    await setupResearchProject(tempDir);

    const result = await handleResearcherResult({
      result: { decision_ids: 'not-an-array' },
      artifacts: makeValidArtifacts(),
      decision_index: makeValidDecisionIndex(),
      basePath: tempDir,
    });

    assert.equal(result.error, true);
    assert.match(result.message, /Invalid researcher result/);
  });

  it('passes through research_warnings in the response', async () => {
    await setupResearchProject(tempDir);

    // First store initial research so a refresh can produce warnings
    await handleResearcherResult({
      result: makeValidResearcherResult({ decision_ids: ['decision:old'] }),
      artifacts: makeValidArtifacts(),
      decision_index: { 'decision:old': { summary: 'Old decision', source: 'test' } },
      basePath: tempDir,
    });

    // Second call removes 'decision:old' — should produce a warning
    const result = await handleResearcherResult({
      result: makeValidResearcherResult({ decision_ids: ['decision:jwt'] }),
      artifacts: makeValidArtifacts(),
      decision_index: makeValidDecisionIndex(),
      basePath: tempDir,
    });

    assert.equal(result.success, true);
    assert.ok(Array.isArray(result.research_warnings), 'should have research_warnings array');
  });

  it('returns structured error when storeResearch fails (no .gsd dir)', async () => {
    // Use a basePath with no .gsd directory — storeResearch should fail gracefully
    const emptyDir = await mkdtemp(join(tmpdir(), 'gsd-empty-'));

    try {
      const result = await handleResearcherResult({
        result: makeValidResearcherResult(),
        artifacts: makeValidArtifacts(),
        decision_index: makeValidDecisionIndex(),
        basePath: emptyDir,
      });

      assert.equal(result.error, true, 'should return error when no .gsd dir');
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});
