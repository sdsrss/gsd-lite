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
  WRITE_FAILED: 'WRITE_FAILED',
};

// R-14 (audit M6): filesystem failures that should surface as a structured
// WRITE_FAILED result instead of an uncaught promise rejection to the caller.
const FS_WRITE_ERROR_CODES = new Set([
  'ENOSPC', // no space left
  'EACCES', // permission denied
  'EROFS',  // read-only filesystem
  'EPERM',  // operation not permitted
  'EDQUOT', // disk quota exceeded
  'EIO',    // I/O error
  'EBUSY',  // resource busy
  'EMFILE', // too many open files (process)
  'ENFILE', // too many open files (system)
]);

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
  const runFn = async () => {
    if (lockPath) return withFileLock(lockPath, fn);
    process.stderr.write('[gsd] WARNING: withStateLock called without lock path — cross-process safety not guaranteed\n');
    return fn();
  };
  // R-14 (audit M6): map filesystem write failures to a structured WRITE_FAILED
  // result so a full disk / read-only fs / permission error reaches the caller as
  // { error: true, code: 'WRITE_FAILED' } instead of an uncaught rejection.
  // Non-fs errors (logic bugs) still propagate so they aren't silently masked.
  const p = prev.then(runFn).catch((err) => {
    if (err && FS_WRITE_ERROR_CODES.has(err.code)) {
      return { error: true, code: ERROR_CODES.WRITE_FAILED, message: `State write failed (${err.code}): ${err.message}` };
    }
    throw err;
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
