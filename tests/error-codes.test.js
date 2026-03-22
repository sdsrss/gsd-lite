// tests/error-codes.test.js — M-10: Structured error codes
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ERROR_CODES, init, read, update, addEvidence, phaseComplete, pruneEvidence } from '../src/tools/state/index.js';

describe('M-10: structured error codes', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gsd-errcode-'));
  });

  it('exports ERROR_CODES object', () => {
    assert.ok(ERROR_CODES);
    assert.equal(typeof ERROR_CODES.NO_PROJECT_DIR, 'string');
    assert.equal(typeof ERROR_CODES.INVALID_INPUT, 'string');
    assert.equal(typeof ERROR_CODES.VALIDATION_FAILED, 'string');
    assert.equal(typeof ERROR_CODES.STATE_EXISTS, 'string');
    assert.equal(typeof ERROR_CODES.NOT_FOUND, 'string');
    assert.equal(typeof ERROR_CODES.TERMINAL_STATE, 'string');
    assert.equal(typeof ERROR_CODES.TRANSITION_ERROR, 'string');
    assert.equal(typeof ERROR_CODES.HANDOFF_GATE, 'string');
  });

  it('init returns INVALID_INPUT for bad project', async () => {
    const result = await init({ project: '', phases: [], basePath: tempDir });
    assert.equal(result.code, ERROR_CODES.INVALID_INPUT);
  });

  it('init returns INVALID_INPUT for empty phases', async () => {
    const result = await init({ project: 'test', phases: [], basePath: tempDir });
    assert.equal(result.code, ERROR_CODES.INVALID_INPUT);
  });

  it('init returns STATE_EXISTS when state already exists', async () => {
    await init({ project: 'test', phases: [{ name: 'P1', tasks: [{ name: 'T1' }] }], basePath: tempDir });
    const result = await init({ project: 'test', phases: [{ name: 'P1', tasks: [{ name: 'T1' }] }], basePath: tempDir });
    assert.equal(result.code, ERROR_CODES.STATE_EXISTS);
  });

  it('read returns NO_PROJECT_DIR when no .gsd', async () => {
    const result = await read({ basePath: tempDir });
    assert.equal(result.code, ERROR_CODES.NO_PROJECT_DIR);
  });

  it('update returns INVALID_INPUT for non-object updates', async () => {
    const result = await update({ updates: null });
    assert.equal(result.code, ERROR_CODES.INVALID_INPUT);
  });

  it('update returns NO_PROJECT_DIR when no .gsd', async () => {
    const result = await update({ updates: { workflow_mode: 'completed' }, basePath: tempDir });
    assert.equal(result.code, ERROR_CODES.NO_PROJECT_DIR);
  });

  it('update returns TERMINAL_STATE for completed workflow change', async () => {
    await init({ project: 'test', phases: [{ name: 'P1', tasks: [{ name: 'T1' }] }], basePath: tempDir });
    // Walk tasks to accepted so completed transition is valid
    await update({ updates: { phases: [{ id: 1, lifecycle: 'active', todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: tempDir });
    await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'accepted' }] }] }, basePath: tempDir });
    await update({ updates: { phases: [{ id: 1, lifecycle: 'reviewing' }] }, basePath: tempDir });
    await update({ updates: { phases: [{ id: 1, lifecycle: 'accepted' }] }, basePath: tempDir });
    await update({ updates: { workflow_mode: 'reviewing_phase', current_review: { scope: 'phase', scope_id: 1 } }, basePath: tempDir });
    await update({ updates: { workflow_mode: 'completed' }, basePath: tempDir });
    const result = await update({ updates: { workflow_mode: 'planning' }, basePath: tempDir });
    assert.equal(result.code, ERROR_CODES.TERMINAL_STATE);
  });

  it('update returns VALIDATION_FAILED for invalid data', async () => {
    await init({ project: 'test', phases: [{ name: 'P1', tasks: [{ index: 1, name: 'T1' }] }], basePath: tempDir });
    const result = await update({ updates: { evidence: { 'ev:1': 'bad' } }, basePath: tempDir });
    assert.equal(result.code, ERROR_CODES.VALIDATION_FAILED);
  });

  it('update returns TRANSITION_ERROR for invalid lifecycle', async () => {
    await init({ project: 'test', phases: [{ name: 'P1', tasks: [{ index: 1, name: 'T1' }] }], basePath: tempDir });
    const result = await update({ updates: { phases: [{ id: 1, lifecycle: 'accepted' }] }, basePath: tempDir });
    assert.equal(result.code, ERROR_CODES.TRANSITION_ERROR);
  });

  it('addEvidence returns INVALID_INPUT for bad id', async () => {
    const result = await addEvidence({ id: '', data: { scope: 'task:1.1' }, basePath: tempDir });
    assert.equal(result.code, ERROR_CODES.INVALID_INPUT);
  });

  it('phaseComplete returns INVALID_INPUT for bad phase_id', async () => {
    const result = await phaseComplete({ phase_id: 'bad', basePath: tempDir });
    assert.equal(result.code, ERROR_CODES.INVALID_INPUT);
  });

  it('phaseComplete returns NOT_FOUND for non-existent phase', async () => {
    await init({ project: 'test', phases: [{ name: 'P1', tasks: [{ index: 1, name: 'T1' }] }], basePath: tempDir });
    const result = await phaseComplete({ phase_id: 99, basePath: tempDir });
    assert.equal(result.code, ERROR_CODES.NOT_FOUND);
  });

  it('phaseComplete returns HANDOFF_GATE when tasks not accepted', async () => {
    await init({ project: 'test', phases: [{ name: 'P1', tasks: [{ index: 1, name: 'T1' }] }], basePath: tempDir });
    // Phase is active, but tasks are not accepted — handoff gate fails
    await update({ updates: { phases: [{ id: 1, lifecycle: 'reviewing' }] }, basePath: tempDir });
    const result = await phaseComplete({ phase_id: 1, basePath: tempDir });
    assert.equal(result.code, ERROR_CODES.HANDOFF_GATE);
  });

  it('pruneEvidence returns INVALID_INPUT for bad currentPhase', async () => {
    const result = await pruneEvidence({ currentPhase: 'bad' });
    assert.equal(result.code, ERROR_CODES.INVALID_INPUT);
  });
});
