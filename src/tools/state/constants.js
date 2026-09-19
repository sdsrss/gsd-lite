// State constants and lock infrastructure

import { join, dirname } from 'node:path';
import { isPlainObject, readJson, withFileLock } from '../../utils.js';
import { migrateState } from '../../schema.js';

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

const RECOVERY_HINT =
  'Restore .gsd/state.json from git or .gsd/state.json.bak, or re-run /gsd:start with force: true.';

export const CORRUPT_STATE_MESSAGE =
  `state.json is corrupt: expected a JSON object with a "phases" array. ${RECOVERY_HINT}`;

/**
 * Read + migrate state.json, rejecting a file that parses as JSON but is not a
 * usable state object. Without this guard `null`, an array, a scalar, or a
 * `phases` value that is not an array flows straight into callers and crashes
 * them with a raw TypeError ("Cannot read properties of null", "state.phases?.find
 * is not a function") instead of a structured, actionable error.
 * @returns {Promise<{state: object} | {error: object}>}
 */
export async function loadState(statePath) {
  const result = await readJson(statePath);
  if (!result.ok) {
    // A missing file means "no project yet"; anything else (parse error,
    // permission denied, truncated write) means the file is there but unusable —
    // reporting that as NO_PROJECT_DIR sends the user to /gsd:start, which then
    // refuses with STATE_EXISTS.
    if (result.error?.includes('ENOENT')) {
      return { error: { error: true, code: ERROR_CODES.NO_PROJECT_DIR, message: 'No GSD project found (state.json missing). Run /gsd:start or /gsd:prd to begin.' } };
    }
    return { error: { error: true, code: ERROR_CODES.VALIDATION_FAILED, message: `state.json is unreadable: ${result.error}. ${RECOVERY_HINT}` } };
  }
  if (!isPlainObject(result.data) || !Array.isArray(result.data.phases)) {
    return { error: { error: true, code: ERROR_CODES.VALIDATION_FAILED, message: CORRUPT_STATE_MESSAGE } };
  }
  return { state: migrateState(result.data) };
}

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
