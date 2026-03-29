// State constants and lock infrastructure

import { join, dirname } from 'node:path';
import { withFileLock } from '../../utils.js';

export const RESEARCH_FILES = ['STACK.md', 'ARCHITECTURE.md', 'PITFALLS.md', 'SUMMARY.md'];
export const MAX_EVIDENCE_ENTRIES = 200;
export const MAX_ARCHIVE_ENTRIES = 1000;

// M-10: Structured error codes
export const ERROR_CODES = {
  NO_PROJECT_DIR: 'NO_PROJECT_DIR',
  INVALID_INPUT: 'INVALID_INPUT',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  STATE_EXISTS: 'STATE_EXISTS',
  NOT_FOUND: 'NOT_FOUND',
  TERMINAL_STATE: 'TERMINAL_STATE',
  TRANSITION_ERROR: 'TRANSITION_ERROR',
  HANDOFF_GATE: 'HANDOFF_GATE',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
};

// C-1: Serialize all state mutations to prevent TOCTOU races
// C-2: Layer cross-process advisory file lock on top of in-process queue
// Per-basePath keyed maps — safe for multi-project concurrent use
const _mutationQueues = new Map();
const _fileLockPaths = new Map();

export function setLockPath(lockPath) {
  // Legacy API for tests — sets/clears the default (null-key) lock path
  if (lockPath === null) {
    _fileLockPaths.delete(null);
    _mutationQueues.delete(null);
  } else {
    _fileLockPaths.set(null, lockPath);
  }
}

/**
 * Ensure lock path is set for a given state path.
 * Must be called before withStateLock in all mutation paths.
 */
export function ensureLockPathFromStatePath(statePath) {
  if (statePath) {
    const lockPath = join(dirname(statePath), 'state.lock');
    _fileLockPaths.set(statePath, lockPath);
  }
}

export function withStateLock(fn, statePath) {
  const lockPath = _fileLockPaths.get(statePath) ?? _fileLockPaths.get(null);
  const queueKey = statePath ?? null;
  const prev = _mutationQueues.get(queueKey) ?? Promise.resolve();
  const p = prev.then(() => {
    if (lockPath) {
      return withFileLock(lockPath, fn);
    }
    process.stderr.write('[gsd] WARNING: withStateLock called without lock path — cross-process safety not guaranteed\n');
    return fn();
  });
  _mutationQueues.set(queueKey, p.catch(() => {}));
  return p;
}

export const DEFAULT_MAX_RETRY = 3;

export function inferWorkflowModeAfterResearch(state) {
  if (state.current_review?.scope === 'phase') return 'reviewing_phase';
  if (state.current_review?.scope === 'task') return 'reviewing_task';
  return 'executing_task';
}

export function normalizeResearchArtifacts(artifacts) {
  const normalized = {};
  for (const fileName of RESEARCH_FILES) {
    const content = artifacts[fileName];
    if (!content) { normalized[fileName] = '\n'; continue; }
    normalized[fileName] = content.endsWith('\n') ? content : `${content}\n`;
  }
  return normalized;
}
