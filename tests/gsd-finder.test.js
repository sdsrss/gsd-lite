import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findGsdDir, readState, getProgress } = require('../hooks/lib/gsd-finder.cjs');

describe('gsd-finder shared utilities', () => {
  describe('findGsdDir', () => {
    it('finds .gsd directory with state.json in current dir', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gsd-finder-'));
      try {
        const gsdDir = join(root, '.gsd');
        await mkdir(gsdDir, { recursive: true });
        await writeFile(join(gsdDir, 'state.json'), '{}');

        const result = findGsdDir(root);
        assert.equal(result, gsdDir);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('finds .gsd directory in parent', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gsd-finder-'));
      try {
        const gsdDir = join(root, '.gsd');
        const subDir = join(root, 'src', 'components');
        await mkdir(gsdDir, { recursive: true });
        await writeFile(join(gsdDir, 'state.json'), '{}');
        await mkdir(subDir, { recursive: true });

        const result = findGsdDir(subDir);
        assert.equal(result, gsdDir);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('returns null when no .gsd found', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gsd-finder-'));
      try {
        const result = findGsdDir(root);
        assert.equal(result, null);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('ignores .gsd directory without state.json', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gsd-finder-'));
      try {
        await mkdir(join(root, '.gsd'), { recursive: true });
        // No state.json inside

        const result = findGsdDir(root);
        assert.equal(result, null);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('readState', () => {
    it('reads and parses state.json', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gsd-finder-'));
      try {
        const gsdDir = join(root, '.gsd');
        await mkdir(gsdDir, { recursive: true });
        const state = { workflow_mode: 'executing_task', project: 'Test' };
        await writeFile(join(gsdDir, 'state.json'), JSON.stringify(state));

        const result = readState(gsdDir);
        assert.deepEqual(result, state);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('returns null when state.json missing', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gsd-finder-'));
      try {
        const result = readState(root);
        assert.equal(result, null);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('returns null on invalid JSON', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gsd-finder-'));
      try {
        const gsdDir = join(root, '.gsd');
        await mkdir(gsdDir, { recursive: true });
        await writeFile(join(gsdDir, 'state.json'), 'not json{');

        const result = readState(gsdDir);
        assert.equal(result, null);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('getProgress', () => {
    it('computes progress from state with phases', () => {
      const state = {
        project: 'MyApp',
        workflow_mode: 'executing_task',
        current_phase: 2,
        current_task: '2.1',
        total_phases: 3,
        git_head: 'abc123def456',
        phases: [
          {
            id: 1, name: 'Setup',
            todo: [
              { id: '1.1', name: 'Init project', lifecycle: 'accepted' },
              { id: '1.2', name: 'Add deps', lifecycle: 'accepted' },
            ],
          },
          {
            id: 2, name: 'Core',
            todo: [
              { id: '2.1', name: 'Build API endpoints', lifecycle: 'running' },
              { id: '2.2', name: 'Add auth', lifecycle: 'pending' },
            ],
          },
          {
            id: 3, name: 'Polish',
            todo: [
              { id: '3.1', name: 'UI cleanup', lifecycle: 'pending' },
            ],
          },
        ],
      };

      const progress = getProgress(state);
      assert.equal(progress.project, 'MyApp');
      assert.equal(progress.workflowMode, 'executing_task');
      assert.equal(progress.currentPhase, 2);
      assert.equal(progress.totalPhases, 3);
      assert.equal(progress.currentTask, '2.1');
      assert.equal(progress.phaseName, 'Core');
      assert.equal(progress.taskName, 'Build API endpoints');
      assert.equal(progress.acceptedTasks, 2);
      assert.equal(progress.totalTasks, 5);
      assert.equal(progress.gitHead, 'abc123def456');
    });

    it('returns null for null input', () => {
      const result = getProgress(null);
      assert.equal(result, null);
    });

    it('handles state with empty phases', () => {
      const state = {
        project: 'Empty',
        workflow_mode: 'planning',
        phases: [],
      };
      const progress = getProgress(state);
      assert.equal(progress.project, 'Empty');
      assert.equal(progress.acceptedTasks, 0);
      assert.equal(progress.totalTasks, 0);
    });

    it('handles missing fields gracefully', () => {
      const state = { workflow_mode: 'executing_task' };
      const progress = getProgress(state);
      assert.equal(progress.project, 'Unknown');
      assert.equal(progress.gitHead, '');
      assert.equal(progress.totalPhases, 0);
    });
  });
});
