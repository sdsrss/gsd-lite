// State CRUD operations

import { dirname, join, relative } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ensureDir, readJson, writeJson, writeAtomic, getStatePath, getGitHead, isPlainObject, clearGsdDirCache } from '../../utils.js';
import {
  CANONICAL_FIELDS,
  TASK_LEVELS,
  validateState,
  validateStateUpdate,
  validateTransition,
  createInitialState,
  migrateState,
  detectCycles,
} from '../../schema.js';
import {
  ERROR_CODES,
  MAX_EVIDENCE_ENTRIES,
  MAX_ARCHIVE_ENTRIES,
  ensureLockPathFromStatePath,
  withStateLock,
} from './constants.js';
import { propagateInvalidation } from './logic.js';

/**
 * Compute SHA-256 content hashes for an array of file paths.
 * Returns an object mapping relative-to-gsdDir paths to hex hashes.
 * Missing/unreadable files are silently skipped.
 */
async function computePlanHashes(filePaths, gsdDir) {
  const hashes = {};
  for (const filePath of filePaths) {
    try {
      const content = await readFile(filePath, 'utf-8');
      hashes[relative(gsdDir, filePath)] = createHash('sha256').update(content).digest('hex');
    } catch {
      // File doesn't exist or is unreadable — skip
    }
  }
  return hashes;
}

/**
 * Initialize a new GSD project: creates .gsd/, state.json, plan.md, phases/
 */
export async function init({ project, phases, research, force = false, basePath = process.cwd() }) {
  if (!project || typeof project !== 'string') {
    return { error: true, code: ERROR_CODES.INVALID_INPUT, message: 'project must be a non-empty string' };
  }
  // Sanitize: strip HTML comment delimiters (could break marker-based CLAUDE.md injection) and cap length
  project = project.replace(/<!--|-->/g, '').trim().slice(0, 200);
  if (!project) {
    return { error: true, code: ERROR_CODES.INVALID_INPUT, message: 'project name is empty after sanitization' };
  }
  if (!Array.isArray(phases)) {
    return { error: true, code: ERROR_CODES.INVALID_INPUT, message: 'phases must be an array' };
  }
  if (phases.length === 0) {
    return { error: true, code: ERROR_CODES.INVALID_INPUT, message: 'phases must contain at least one phase' };
  }
  const gsdDir = join(basePath, '.gsd');
  const statePath = join(gsdDir, 'state.json');
  ensureLockPathFromStatePath(statePath);

  return withStateLock(async () => {
    // Guard: reject re-initialization unless force is set
    if (!force) {
      try {
        await stat(statePath);
        return { error: true, code: ERROR_CODES.STATE_EXISTS, message: 'state.json already exists; pass force: true to reinitialize' };
      } catch {} // File doesn't exist, proceed
    } else {
      // H-8: Backup existing state before force overwrite
      try {
        const existing = await readJson(statePath);
        if (existing.ok) {
          await writeJson(join(gsdDir, 'state.json.bak'), existing.data);
        }
      } catch {} // No existing state to backup
    }

    const phasesDir = join(gsdDir, 'phases');

    clearGsdDirCache(); // Invalidate cache since we're creating .gsd/
    await ensureDir(phasesDir);
    if (research) {
      await ensureDir(join(gsdDir, 'research'));
    }

    const state = createInitialState({ project, phases });
    if (state.error) return state;
    state.git_head = await getGitHead(basePath);

    // Create plan.md placeholder (atomic write)
    await writeAtomic(
      join(gsdDir, 'plan.md'),
      `# ${project}\n\nPlan placeholder — populate during planning phase.\n`,
    );

    // Create phase placeholder .md files (atomic writes)
    for (const phase of state.phases) {
      await writeAtomic(
        join(phasesDir, `phase-${phase.id}.md`),
        `# Phase ${phase.id}: ${phase.name}\n\nTasks and details go here.\n`,
      );
    }

    const trackedFiles = [
      join(gsdDir, 'plan.md'),
      ...state.phases.map((phase) => join(phasesDir, `phase-${phase.id}.md`)),
    ];
    const mtimes = await Promise.all(trackedFiles.map(async (filePath) => (await stat(filePath)).mtimeMs));
    // Math.ceil is required: mtimeMs has sub-millisecond precision (float), but
    // Date.toISOString() truncates to milliseconds. Without ceil, the stored timestamp
    // can be slightly less than the file's actual mtime, causing false plan-drift detection.
    state.context.last_session = new Date(Math.ceil(Math.max(...mtimes))).toISOString();
    // Store content hashes for plan drift detection (hash-based, not mtime-based)
    state.context.plan_hashes = await computePlanHashes(trackedFiles, gsdDir);
    await writeJson(statePath, state);

    return {
      success: true,
      project: state.project,
      total_phases: state.total_phases,
      phases: state.phases.map(p => ({
        id: p.id,
        name: p.name,
        tasks: p.todo.length,
      })),
      research: !!research,
    };
  });
}

/**
 * Read state.json, optionally filtering to specific fields.
 */
export async function read({ fields, basePath = process.cwd(), validate = false } = {}) {
  const statePath = await getStatePath(basePath);
  if (!statePath) {
    return { error: true, code: ERROR_CODES.NO_PROJECT_DIR, message: 'No .gsd directory found' };
  }

  const result = await readJson(statePath);
  if (!result.ok) {
    return { error: true, code: ERROR_CODES.NO_PROJECT_DIR, message: result.error };
  }
  const state = migrateState(result.data);

  // H-7: Optional semantic validation on read
  if (validate) {
    const validation = validateState(state);
    if (!validation.valid) {
      return { error: true, code: ERROR_CODES.VALIDATION_FAILED, message: `State validation failed: ${validation.errors.join('; ')}` };
    }
  }

  if (fields && Array.isArray(fields) && fields.length > 0) {
    const filtered = {};
    for (const key of fields) {
      if (key in state) {
        filtered[key] = state[key];
      }
    }
    return filtered;
  }

  return state;
}

/**
 * Update state.json with canonical field guard and full validation.
 */
export async function update({ updates, basePath = process.cwd(), expectedVersion, _append_decisions, _propagation_tasks } = {}) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return { error: true, code: ERROR_CODES.INVALID_INPUT, message: 'updates must be a non-null object' };
  }
  // Guard: reject non-canonical fields
  const nonCanonical = Object.keys(updates).filter(
    (key) => !CANONICAL_FIELDS.includes(key),
  );
  if (nonCanonical.length > 0) {
    return {
      error: true,
      code: ERROR_CODES.INVALID_INPUT,
      message: `Non-canonical fields rejected: ${nonCanonical.join(', ')}`,
    };
  }

  const statePath = await getStatePath(basePath);
  if (!statePath) {
    return { error: true, code: ERROR_CODES.NO_PROJECT_DIR, message: 'No .gsd directory found' };
  }
  ensureLockPathFromStatePath(statePath);

  return withStateLock(async () => {
    const result = await readJson(statePath);
    if (!result.ok) {
      return { error: true, code: ERROR_CODES.NO_PROJECT_DIR, message: result.error };
    }
    const state = migrateState(result.data);

    // Optimistic concurrency: check version if caller provided expectedVersion
    if (expectedVersion !== undefined && expectedVersion !== null) {
      const onDiskVersion = state._version ?? 0;
      if (onDiskVersion !== expectedVersion) {
        return {
          error: true,
          code: ERROR_CODES.VERSION_CONFLICT,
          message: `State was modified by another session (expected version ${expectedVersion}, found ${onDiskVersion})`,
        };
      }
    }

    // Guard: reject workflow_mode changes FROM terminal states
    if (updates.workflow_mode) {
      const currentMode = state.workflow_mode;
      if ((currentMode === 'completed' || currentMode === 'failed')
          && updates.workflow_mode !== currentMode) {
        return { error: true, code: ERROR_CODES.TERMINAL_STATE, message: `Cannot change workflow_mode from terminal state '${currentMode}'` };
      }
    }

    // Validate lifecycle transitions before merging
    if (updates.phases && Array.isArray(updates.phases)) {
      for (const newPhase of updates.phases) {
        const oldPhase = state.phases.find(p => p.id === newPhase.id);
        if (!oldPhase) continue;

        // Check phase lifecycle transition
        if (newPhase.lifecycle && newPhase.lifecycle !== oldPhase.lifecycle) {
          const tr = validateTransition('phase', oldPhase.lifecycle, newPhase.lifecycle);
          if (!tr.valid) return { error: true, code: ERROR_CODES.TRANSITION_ERROR, message: tr.error };
        }

        // Check task lifecycle transitions
        if (Array.isArray(newPhase.todo)) {
          for (const newTask of newPhase.todo) {
            const oldTask = (oldPhase.todo || []).find(t => t.id === newTask.id);
            if (!oldTask) continue;
            if (newTask.lifecycle && newTask.lifecycle !== oldTask.lifecycle) {
              const tr = validateTransition('task', oldTask.lifecycle, newTask.lifecycle);
              if (!tr.valid) return { error: true, code: ERROR_CODES.TRANSITION_ERROR, message: tr.error };
            }
          }
        }
      }
    }

    // Deep merge phases by ID instead of shallow replace [I-1]
    const merged = { ...state, ...updates };

    // Deep merge context by key (preserves plan_hashes, last_session, etc.)
    if (updates.context && isPlainObject(updates.context)) {
      merged.context = { ...(state.context || {}), ...updates.context };
    }

    // Deep merge evidence by key (preserves existing entries)
    if (updates.evidence && isPlainObject(updates.evidence)) {
      merged.evidence = { ...(state.evidence || {}), ...updates.evidence };
    }

    if (updates.phases && Array.isArray(updates.phases)) {
      merged.phases = state.phases.map(oldPhase => {
        const newPhase = updates.phases.find(p => p.id === oldPhase.id);
        if (!newPhase) return oldPhase;
        const mergedPhase = { ...oldPhase, ...newPhase };
        if (isPlainObject(oldPhase.phase_review) || isPlainObject(newPhase.phase_review)) {
          mergedPhase.phase_review = { ...oldPhase.phase_review, ...newPhase.phase_review };
        }
        if (isPlainObject(oldPhase.phase_handoff) || isPlainObject(newPhase.phase_handoff)) {
          mergedPhase.phase_handoff = { ...oldPhase.phase_handoff, ...newPhase.phase_handoff };
        }
        // Deep merge tasks within phase by ID
        if (Array.isArray(newPhase.todo)) {
          mergedPhase.todo = oldPhase.todo.map(oldTask => {
            const newTask = newPhase.todo.find(t => t.id === oldTask.id);
            return newTask ? { ...oldTask, ...newTask } : oldTask;
          });
          // Add any new tasks not in old phase
          for (const newTask of newPhase.todo) {
            if (!oldPhase.todo.find(t => t.id === newTask.id)) {
              mergedPhase.todo.push(newTask);
            }
          }
        }
        return mergedPhase;
      });
      // Add any new phases not in old state
      for (const newPhase of updates.phases) {
        if (!state.phases.find(p => p.id === newPhase.id)) {
          merged.phases.push(newPhase);
        }
      }
    }

    // Atomic decisions append: accumulate inside the lock against fresh state
    if (Array.isArray(_append_decisions) && _append_decisions.length > 0) {
      const existing = Array.isArray(merged.decisions) ? merged.decisions : [];
      merged.decisions = [...existing, ..._append_decisions];
      // Cap to prevent unbounded growth (same MAX_DECISIONS as orchestrator)
      if (merged.decisions.length > 200) {
        merged.decisions = merged.decisions.slice(-200);
      }
    }

    // Atomic propagation: run invalidation inside the lock on freshly-merged state
    if (Array.isArray(_propagation_tasks) && _propagation_tasks.length > 0) {
      for (const { phase_id, task_id, contract_changed } of _propagation_tasks) {
        if (!contract_changed) continue;
        const targetPhase = merged.phases.find(p => p.id === phase_id);
        if (targetPhase) {
          propagateInvalidation(targetPhase, task_id, true);
        }
      }
    }

    // Recompute `done` from actual accepted tasks (prevents counter drift)
    if ((updates.phases && Array.isArray(updates.phases)) || _propagation_tasks?.length > 0) {
      for (const phase of merged.phases) {
        if (Array.isArray(phase.todo)) {
          phase.done = phase.todo.filter(t => t.lifecycle === 'accepted').length;
        }
      }
    }

    // Auto-prune evidence when entries exceed limit
    if (merged.evidence && Object.keys(merged.evidence).length > MAX_EVIDENCE_ENTRIES) {
      const gsdDir = dirname(statePath);
      await _pruneEvidenceFromState(merged, merged.current_phase, gsdDir);
    }

    // Use incremental validation for simple updates (no phases/propagation/decisions changes)
    const needsFullValidation = updates.phases
      || (_append_decisions?.length > 0)
      || (_propagation_tasks?.length > 0);
    const validation = needsFullValidation
      ? validateState(merged)
      : validateStateUpdate(state, updates);
    if (!validation.valid) {
      return {
        error: true,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `Validation failed: ${validation.errors.join('; ')}`,
      };
    }

    // Optimistic concurrency: increment _version on every successful write
    merged._version = (merged._version ?? 0) + 1;

    await writeJson(statePath, merged);
    return { success: true, state: merged };
  });
}

/**
 * Complete a phase: checks handoff gate, transitions lifecycle, increments current_phase.
 */
function verificationPassed(verification) {
  if (!verification || typeof verification !== 'object') return false;
  return ['lint', 'typecheck', 'test'].every((key) => (
    verification[key]
    && typeof verification[key].exit_code === 'number'
    && verification[key].exit_code === 0
  ));
}

function verificationSummary(verification) {
  if (!verification || typeof verification !== 'object') return 'no verification details';
  const parts = ['lint', 'typecheck', 'test'].map((key) => {
    const v = verification[key];
    if (!v) return `${key}:missing`;
    if (typeof v !== 'object' || !('exit_code' in v)) return `${key}:invalid-format (expected {exit_code: number})`;
    return `${key}:${v.exit_code === 0 ? 'pass' : `fail(${v.exit_code})`}`;
  });
  return parts.join(', ');
}

export async function phaseComplete({
  phase_id,
  basePath = process.cwd(),
  verification,
  run_verify = false,
  direction_ok,
} = {}) {
  if (typeof phase_id !== 'number') {
    return { error: true, code: ERROR_CODES.INVALID_INPUT, message: 'phase_id must be a number' };
  }
  if (verification != null && (typeof verification !== 'object' || Array.isArray(verification))) {
    return { error: true, code: ERROR_CODES.INVALID_INPUT, message: 'verification must be an object when provided' };
  }
  if (typeof run_verify !== 'boolean') {
    return { error: true, code: ERROR_CODES.INVALID_INPUT, message: 'run_verify must be a boolean' };
  }
  if (direction_ok !== undefined && typeof direction_ok !== 'boolean') {
    return { error: true, code: ERROR_CODES.INVALID_INPUT, message: 'direction_ok must be a boolean when provided' };
  }
  const statePath = await getStatePath(basePath);
  if (!statePath) {
    return { error: true, code: ERROR_CODES.NO_PROJECT_DIR, message: 'No .gsd directory found' };
  }
  ensureLockPathFromStatePath(statePath);

  return withStateLock(async () => {
    const result = await readJson(statePath);
    if (!result.ok) {
      return { error: true, code: ERROR_CODES.NO_PROJECT_DIR, message: result.error };
    }
    const state = migrateState(result.data);

    const phase = state.phases.find((p) => p.id === phase_id);
    if (!phase) {
      return { error: true, code: ERROR_CODES.NOT_FOUND, message: `Phase ${phase_id} not found` };
    }
    if (!Array.isArray(phase.todo)) {
      return { error: true, code: ERROR_CODES.VALIDATION_FAILED, message: `Phase ${phase_id} has invalid todo list` };
    }
    if (!phase.phase_handoff || typeof phase.phase_handoff !== 'object') {
      return { error: true, code: ERROR_CODES.VALIDATION_FAILED, message: `Phase ${phase_id} is missing phase_handoff metadata` };
    }

    // Validate phase lifecycle transition FIRST (fail-fast) [I-4]
    // Allow active → accepted by auto-advancing through 'reviewing' intermediate state
    if (phase.lifecycle === 'active') {
      const intermediateResult = validateTransition('phase', 'active', 'reviewing');
      const finalResult = validateTransition('phase', 'reviewing', 'accepted');
      if (!intermediateResult.valid || !finalResult.valid) {
        return { error: true, code: ERROR_CODES.TRANSITION_ERROR, message: `Invalid phase transition: ${phase.lifecycle} → accepted` };
      }
      // Will be set to 'accepted' below; just validate here
    } else {
      const transitionResult = validateTransition(
        'phase',
        phase.lifecycle,
        'accepted',
      );
      if (!transitionResult.valid) {
        return { error: true, code: ERROR_CODES.TRANSITION_ERROR, message: transitionResult.error };
      }
    }

    // Check handoff gate: all tasks must be accepted
    const pendingTasks = phase.todo.filter((t) => t.lifecycle !== 'accepted');
    if (pendingTasks.length > 0) {
      return {
        error: true,
        code: ERROR_CODES.HANDOFF_GATE,
        message: `Handoff gate not met: ${pendingTasks.length} task(s) not accepted — ${pendingTasks.map((t) => `${t.id}:${t.lifecycle}`).join(', ')}`,
      };
    }

    // Check critical issues
    if (phase.phase_handoff.critical_issues_open > 0) {
      return {
        error: true,
        code: ERROR_CODES.HANDOFF_GATE,
        message: `Handoff gate not met: ${phase.phase_handoff.critical_issues_open} critical issue(s) open`,
      };
    }

    const reviewPassed = phase.phase_review?.status === 'accepted'
      || phase.phase_handoff.required_reviews_passed === true;
    if (!reviewPassed) {
      return {
        error: true,
        code: ERROR_CODES.HANDOFF_GATE,
        message: 'Handoff gate not met: required reviews not passed',
      };
    }

    if (run_verify && !verification) {
      return {
        error: true,
        code: ERROR_CODES.INVALID_INPUT,
        message: 'run_verify requires verification results to be passed via the verification parameter; the state layer does not execute external tools',
      };
    }
    const verificationResult = verification || null;
    const testsPassed = verificationResult
      ? verificationPassed(verificationResult)
      : phase.phase_handoff.tests_passed === true;
    if (!testsPassed) {
      return {
        error: true,
        code: ERROR_CODES.HANDOFF_GATE,
        message: `Handoff gate not met: verification checks failed — ${verificationSummary(verificationResult)}`,
      };
    }

    const directionOk = direction_ok ?? phase.phase_handoff.direction_ok;
    if (directionOk === false) {
      state.workflow_mode = 'awaiting_user';
      state.current_task = null;
      state.current_review = {
        scope: 'phase',
        scope_id: phase.id,
        stage: 'direction_drift',
        summary: `Direction drift detected for phase ${phase.id}`,
      };
      phase.phase_handoff.direction_ok = false;
      const driftValidation = validateState(state);
      if (!driftValidation.valid) {
        return { error: true, code: ERROR_CODES.VALIDATION_FAILED, message: `Validation failed: ${driftValidation.errors.join('; ')}` };
      }
      state._version = (state._version ?? 0) + 1;
      await writeJson(statePath, state);
      return {
        success: true,
        action: 'direction_drift',
        workflow_mode: 'awaiting_user',
        phase_id: phase.id,
        message: 'Direction drift detected; awaiting user decision before phase can complete',
      };
    }

    // Apply transition
    phase.lifecycle = 'accepted';
    phase.phase_handoff.required_reviews_passed = reviewPassed;
    phase.phase_handoff.tests_passed = testsPassed;
    if (direction_ok !== undefined) {
      phase.phase_handoff.direction_ok = direction_ok;
    }

    // Increment current_phase if this was the active phase
    if (state.current_phase === phase_id && phase_id < state.total_phases) {
      state.current_phase = phase_id + 1;
      // Activate the next phase (M-3: use validateTransition for consistency)
      const nextPhase = state.phases.find((p) => p.id === state.current_phase);
      if (nextPhase) {
        const nextTr = validateTransition('phase', nextPhase.lifecycle, 'active');
        if (nextTr.valid) nextPhase.lifecycle = 'active';
      }
    } else if (state.current_phase === phase_id && phase_id >= state.total_phases) {
      // Final phase completed — mark workflow as completed
      state.workflow_mode = 'completed';
      state.current_task = null;
      state.current_review = null;
    }

    // Update git_head to current commit
    const gsdDir = dirname(statePath);
    state.git_head = await getGitHead(dirname(gsdDir));

    // Prune evidence from old phases (in-memory to avoid double read/write)
    await _pruneEvidenceFromState(state, state.current_phase, gsdDir);

    // Validate final state before persisting (match direction_ok=false branch)
    const finalValidation = validateState(state);
    if (!finalValidation.valid) {
      return { error: true, code: ERROR_CODES.VALIDATION_FAILED, message: `Validation failed: ${finalValidation.errors.join('; ')}` };
    }
    state._version = (state._version ?? 0) + 1;
    await writeJson(statePath, state);
    return { success: true };
  });
}

/**
 * Add an evidence entry to state.evidence keyed by id.
 */
export async function addEvidence({ id, data, basePath = process.cwd() }) {
  // I-8: Validate inputs
  if (!id || typeof id !== 'string') {
    return { error: true, code: ERROR_CODES.INVALID_INPUT, message: 'id must be a non-empty string' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { error: true, code: ERROR_CODES.INVALID_INPUT, message: 'data must be a non-null object' };
  }
  if (typeof data.scope !== 'string') {
    return { error: true, code: ERROR_CODES.INVALID_INPUT, message: 'data.scope must be a string' };
  }

  const statePath = await getStatePath(basePath);
  if (!statePath) {
    return { error: true, code: ERROR_CODES.NO_PROJECT_DIR, message: 'No .gsd directory found' };
  }
  ensureLockPathFromStatePath(statePath);

  return withStateLock(async () => {
    const result = await readJson(statePath);
    if (!result.ok) {
      return { error: true, code: ERROR_CODES.NO_PROJECT_DIR, message: result.error };
    }
    const state = migrateState(result.data);

    if (!state.evidence) {
      state.evidence = {};
    }

    state.evidence[id] = data;

    // Auto-prune when evidence exceeds limit
    const entries = Object.keys(state.evidence);
    if (entries.length > MAX_EVIDENCE_ENTRIES) {
      const gsdDir = dirname(statePath);
      await _pruneEvidenceFromState(state, state.current_phase, gsdDir);
    }

    state._version = (state._version ?? 0) + 1;
    await writeJson(statePath, state);
    return { success: true };
  });
}

/**
 * Internal: prune evidence in-memory and write archive file.
 * Mutates state.evidence. Returns count of archived entries.
 */
async function _pruneEvidenceFromState(state, currentPhase, gsdDir) {
  if (!state.evidence) return 0;

  const toArchive = {};
  const toKeep = {};

  for (const [id, entry] of Object.entries(state.evidence)) {
    const phaseNum = parseScopePhase(entry.scope);
    if (phaseNum !== null && phaseNum < currentPhase) {
      toArchive[id] = entry;
    } else {
      toKeep[id] = entry;
    }
  }

  const archivedCount = Object.keys(toArchive).length;

  if (archivedCount > 0) {
    const archivePath = join(gsdDir, 'evidence-archive.json');
    const existing = await readJson(archivePath);
    const archive = existing.ok ? existing.data : {};
    Object.assign(archive, toArchive);

    // H-2: Cap archive size to prevent unbounded growth
    const archiveKeys = Object.keys(archive);
    if (archiveKeys.length > MAX_ARCHIVE_ENTRIES) {
      const toRemove = archiveKeys.slice(0, archiveKeys.length - MAX_ARCHIVE_ENTRIES);
      for (const key of toRemove) delete archive[key];
    }

    await writeJson(archivePath, archive);
    state.evidence = toKeep;
  }

  return archivedCount;
}

/**
 * Prune evidence: archive entries from phases before currentPhase (keep only current phase).
 * Scope format is "task:X.Y" where X is the phase number.
 */
export async function pruneEvidence({ currentPhase, basePath = process.cwd() }) {
  if (typeof currentPhase !== 'number' || !Number.isFinite(currentPhase)) {
    return { error: true, code: ERROR_CODES.INVALID_INPUT, message: 'currentPhase must be a finite number' };
  }
  const statePath = await getStatePath(basePath);
  if (!statePath) {
    return { error: true, code: ERROR_CODES.NO_PROJECT_DIR, message: 'No .gsd directory found' };
  }
  ensureLockPathFromStatePath(statePath);

  return withStateLock(async () => {
    const result = await readJson(statePath);
    if (!result.ok) {
      return { error: true, code: ERROR_CODES.NO_PROJECT_DIR, message: result.error };
    }
    const state = migrateState(result.data);

    const gsdDir = dirname(statePath);
    const archived = await _pruneEvidenceFromState(state, currentPhase, gsdDir);
    if (archived > 0) {
      state._version = (state._version ?? 0) + 1;
      await writeJson(statePath, state);
    }

    return { success: true, archived };
  });
}

/**
 * Incrementally patch the plan: add/remove/reorder tasks, update task fields, add dependencies.
 * Runs inside withStateLock for atomicity. Validates schema + circular deps after patching.
 */
export async function patchPlan({ operations, basePath = process.cwd() } = {}) {
  if (!Array.isArray(operations) || operations.length === 0) {
    return { error: true, code: ERROR_CODES.INVALID_INPUT, message: 'operations must be a non-empty array' };
  }

  const validOps = ['add_task', 'remove_task', 'reorder_tasks', 'update_task', 'add_dependency'];
  for (const op of operations) {
    if (!op || typeof op !== 'object' || !validOps.includes(op.op)) {
      return { error: true, code: ERROR_CODES.INVALID_INPUT, message: `Invalid operation: ${JSON.stringify(op?.op)}. Must be one of: ${validOps.join(', ')}` };
    }
  }

  const statePath = await getStatePath(basePath);
  if (!statePath) {
    return { error: true, code: ERROR_CODES.NO_PROJECT_DIR, message: 'No .gsd directory found' };
  }
  ensureLockPathFromStatePath(statePath);

  return withStateLock(async () => {
    const result = await readJson(statePath);
    if (!result.ok) {
      return { error: true, code: ERROR_CODES.NO_PROJECT_DIR, message: result.error };
    }
    const state = migrateState(result.data);

    // Guard: only allow patching in non-terminal states
    if (state.workflow_mode === 'completed' || state.workflow_mode === 'failed') {
      return { error: true, code: ERROR_CODES.TERMINAL_STATE, message: `Cannot patch plan in terminal state '${state.workflow_mode}'` };
    }

    const applied = [];
    const errors = [];

    for (const op of operations) {
      const opResult = _applyPatchOp(state, op);
      if (opResult.error) {
        errors.push(`${op.op}: ${opResult.message}`);
      } else {
        applied.push(opResult.summary);
      }
    }

    if (errors.length > 0) {
      return { error: true, code: ERROR_CODES.VALIDATION_FAILED, message: `Patch failed: ${errors.join('; ')}` };
    }

    // Detect circular dependencies after all patches
    const cycleError = detectCycles(state.phases);
    if (cycleError) {
      return { error: true, code: ERROR_CODES.VALIDATION_FAILED, message: cycleError };
    }

    // Recompute done counts
    for (const phase of state.phases) {
      if (Array.isArray(phase.todo)) {
        phase.tasks = phase.todo.length;
        phase.done = phase.todo.filter(t => t.lifecycle === 'accepted').length;
      }
    }
    state.total_phases = state.phases.length;

    // Increment plan version
    state.plan_version = (state.plan_version || 0) + 1;

    // Full validation
    const validation = validateState(state);
    if (!validation.valid) {
      return { error: true, code: ERROR_CODES.VALIDATION_FAILED, message: `Validation failed: ${validation.errors.join('; ')}` };
    }

    state._version = (state._version ?? 0) + 1;
    await writeJson(statePath, state);
    return { success: true, applied, plan_version: state.plan_version };
  });
}

function _applyPatchOp(state, op) {
  switch (op.op) {
    case 'add_task': {
      const { phase_id, task } = op;
      if (typeof phase_id !== 'number') return { error: true, message: 'phase_id must be a number' };
      if (!task || typeof task.name !== 'string' || task.name.length === 0) return { error: true, message: 'task.name must be a non-empty string' };

      const phase = state.phases.find(p => p.id === phase_id);
      if (!phase) return { error: true, message: `Phase ${phase_id} not found` };

      // Cannot add tasks to accepted phases
      if (phase.lifecycle === 'accepted') return { error: true, message: `Cannot add tasks to accepted phase ${phase_id}` };

      // Compute next task index
      const existingIndices = phase.todo.map(t => {
        const parts = t.id.split('.');
        return parseInt(parts[1], 10);
      });
      const nextIndex = existingIndices.length > 0 ? Math.max(...existingIndices) + 1 : 1;
      const taskId = `${phase_id}.${task.index ?? nextIndex}`;

      // Check for duplicate ID
      if (phase.todo.some(t => t.id === taskId)) {
        return { error: true, message: `Task ID ${taskId} already exists` };
      }

      const level = task.level || 'L1';
      if (!TASK_LEVELS.includes(level)) {
        return { error: true, message: `level must be one of ${TASK_LEVELS.join(', ')} (got "${level}")` };
      }

      const newTask = {
        id: taskId,
        name: task.name,
        lifecycle: 'pending',
        level,
        requires: task.requires || [],
        retry_count: 0,
        review_required: task.review_required !== false,
        verification_required: task.verification_required !== false,
        checkpoint_commit: null,
        research_basis: task.research_basis || [],
        evidence_refs: [],
      };

      // Insert after specified task or at end
      if (task.after) {
        const afterIdx = phase.todo.findIndex(t => t.id === task.after);
        if (afterIdx === -1) return { error: true, message: `after task ${task.after} not found` };
        phase.todo.splice(afterIdx + 1, 0, newTask);
      } else {
        phase.todo.push(newTask);
      }

      return { summary: `Added task ${taskId} "${task.name}" to phase ${phase_id}` };
    }

    case 'remove_task': {
      const { task_id } = op;
      if (typeof task_id !== 'string') return { error: true, message: 'task_id must be a string' };

      const phase = state.phases.find(p => p.todo?.some(t => t.id === task_id));
      if (!phase) return { error: true, message: `Task ${task_id} not found` };

      const task = phase.todo.find(t => t.id === task_id);
      // Cannot remove running or accepted tasks
      if (['running', 'accepted', 'checkpointed'].includes(task.lifecycle)) {
        return { error: true, message: `Cannot remove task ${task_id} in '${task.lifecycle}' state` };
      }

      // Check if any other task depends on this one
      for (const p of state.phases) {
        for (const t of (p.todo || [])) {
          const depOnRemoved = (t.requires || []).some(d => d.kind === 'task' && d.id === task_id);
          if (depOnRemoved) {
            return { error: true, message: `Cannot remove task ${task_id}: task ${t.id} depends on it` };
          }
        }
      }

      // Remove current_task reference if it points to this task
      if (state.current_task === task_id) {
        state.current_task = null;
      }

      phase.todo = phase.todo.filter(t => t.id !== task_id);
      return { summary: `Removed task ${task_id} from phase ${phase.id}` };
    }

    case 'reorder_tasks': {
      const { phase_id, order } = op;
      if (typeof phase_id !== 'number') return { error: true, message: 'phase_id must be a number' };
      if (!Array.isArray(order)) return { error: true, message: 'order must be an array of task IDs' };

      const phase = state.phases.find(p => p.id === phase_id);
      if (!phase) return { error: true, message: `Phase ${phase_id} not found` };

      const taskMap = new Map(phase.todo.map(t => [t.id, t]));
      const existing = new Set(taskMap.keys());
      const ordered = new Set(order);

      // Must contain exactly the same task IDs
      if (ordered.size !== existing.size || ![...ordered].every(id => existing.has(id))) {
        return { error: true, message: `order must contain exactly the same task IDs as phase ${phase_id}` };
      }

      phase.todo = order.map(id => taskMap.get(id));
      return { summary: `Reordered tasks in phase ${phase_id}` };
    }

    case 'update_task': {
      const { task_id, ...fields } = op;
      if (typeof task_id !== 'string') return { error: true, message: 'task_id must be a string' };

      const phase = state.phases.find(p => p.todo?.some(t => t.id === task_id));
      if (!phase) return { error: true, message: `Task ${task_id} not found` };

      const task = phase.todo.find(t => t.id === task_id);
      const allowedFields = ['name', 'level', 'review_required', 'verification_required', 'research_basis'];
      const updates = {};
      for (const key of allowedFields) {
        if (key in fields) {
          updates[key] = fields[key];
        }
      }

      if (Object.keys(updates).length === 0) {
        return { error: true, message: `No valid fields to update. Allowed: ${allowedFields.join(', ')}` };
      }
      if (updates.level && !TASK_LEVELS.includes(updates.level)) {
        return { error: true, message: `level must be one of ${TASK_LEVELS.join(', ')} (got "${updates.level}")` };
      }

      Object.assign(task, updates);
      return { summary: `Updated task ${task_id}: ${Object.keys(updates).join(', ')}` };
    }

    case 'add_dependency': {
      const { task_id, requires } = op;
      if (typeof task_id !== 'string') return { error: true, message: 'task_id must be a string' };
      if (!requires || typeof requires !== 'object') return { error: true, message: 'requires must be an object with kind and id' };

      const phase = state.phases.find(p => p.todo?.some(t => t.id === task_id));
      if (!phase) return { error: true, message: `Task ${task_id} not found` };

      if (!['task', 'phase'].includes(requires.kind)) {
        return { error: true, message: `requires.kind must be "task" or "phase"` };
      }

      const validGates = ['checkpoint', 'accepted', 'phase_complete'];
      if (requires.gate && !validGates.includes(requires.gate)) {
        return { error: true, message: `requires.gate must be one of ${validGates.join(', ')}` };
      }

      // Validate target exists (task deps must be same-phase to match selectRunnableTask resolution)
      if (requires.kind === 'task') {
        const targetInSamePhase = phase.todo?.some(t => t.id === requires.id);
        if (!targetInSamePhase) return { error: true, message: `Dependency target task ${requires.id} not found in same phase (cross-phase task dependencies are not supported)` };
      } else {
        const phaseId = Number(requires.id);
        if (!state.phases.some(p => p.id === phaseId)) {
          return { error: true, message: `Dependency target phase ${requires.id} not found` };
        }
      }

      const task = phase.todo.find(t => t.id === task_id);
      // Check for duplicate dependency
      const isDupe = task.requires.some(d => d.kind === requires.kind && String(d.id) === String(requires.id));
      if (isDupe) return { error: true, message: `Task ${task_id} already depends on ${requires.kind}:${requires.id}` };

      task.requires.push(requires);
      return { summary: `Added dependency ${requires.kind}:${requires.id} to task ${task_id}` };
    }

    default:
      return { error: true, message: `Unknown operation: ${op.op}` };
  }
}

/**
 * Parse phase number from scope string like "task:X.Y" -> X.
 * Returns null if scope is missing or doesn't match.
 */
function parseScopePhase(scope) {
  if (typeof scope !== 'string') return null;
  const match = scope.match(/^task:(\d+)\./);
  return match ? parseInt(match[1], 10) : null;
}
