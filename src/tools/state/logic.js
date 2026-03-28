// Automation/business logic functions

import { dirname, join } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { ensureDir, readJson, writeJson, getStatePath } from '../../utils.js';
import {
  TASK_LIFECYCLE,
  migrateState,
  validateResearchArtifacts,
  validateResearchDecisionIndex,
  validateResearcherResult,
  validateState,
} from '../../schema.js';
import {
  ERROR_CODES,
  RESEARCH_FILES,
  DEFAULT_MAX_RETRY,
  ensureLockPathFromStatePath,
  withStateLock,
  inferWorkflowModeAfterResearch,
  normalizeResearchArtifacts,
} from './constants.js';

/**
 * Select the next runnable task from a phase, respecting dependency gates.
 * Returns { task } if a runnable task is found,
 * { mode: 'trigger_review' } if all remaining are checkpointed,
 * { mode: 'awaiting_user', blockers } if all are blocked,
 * { task: undefined } if nothing can run.
 * @param {object} phase - Phase object with todo array
 * @param {object} state - Full state object
 * @param {object} [options] - Options
 * @param {number} [options.maxRetry=3] - Maximum retry count before skipping a task
 */
export function selectRunnableTask(phase, state, { maxRetry = DEFAULT_MAX_RETRY } = {}) {
  if (!phase || !Array.isArray(phase.todo)) {
    return { error: true, message: 'Phase todo must be an array' };
  }
  // D-4: Zero-task phase — immediately trigger review so phase can advance
  if (phase.todo.length === 0) {
    return { mode: 'trigger_review' };
  }

  const runnableTasks = [];

  for (const task of phase.todo) {
    if (!['pending', 'needs_revalidation'].includes(task.lifecycle)) continue;
    if (task.retry_count >= maxRetry) continue;
    if (task.blocked_reason) continue;

    let depsOk = true;
    for (const dep of (task.requires || [])) {
      if (dep.kind === 'task') {
        const depTask = phase.todo.find(t => t.id === dep.id);
        if (!depTask) { depsOk = false; break; }
        const gate = dep.gate || 'accepted';
        if (gate === 'checkpoint' && !['checkpointed', 'accepted'].includes(depTask.lifecycle)) { depsOk = false; break; }
        if (gate === 'accepted' && depTask.lifecycle !== 'accepted') { depsOk = false; break; }
        if (gate === 'phase_complete') { depsOk = false; break; } // phase_complete is only valid on phase-kind deps
      } else if (dep.kind === 'phase') {
        const depPhaseId = Number(dep.id);
        const depPhase = (state.phases || []).find(p => p.id === depPhaseId);
        if (!depPhase || depPhase.lifecycle !== 'accepted') { depsOk = false; break; }
      }
    }
    if (depsOk) runnableTasks.push(task);
  }

  if (runnableTasks.length > 0) {
    return {
      task: runnableTasks[0],
      ...(runnableTasks.length > 1 ? { parallel_available: runnableTasks.slice(1) } : {}),
    };
  }

  const awaitingReview = phase.todo.filter(t => t.lifecycle === 'checkpointed');
  if (awaitingReview.length > 0) {
    return { mode: 'trigger_review' };
  }

  // All tasks accepted → trigger phase review if not already reviewed
  const allAccepted = phase.todo.length > 0 && phase.todo.every(t => t.lifecycle === 'accepted');
  if (allAccepted && phase.phase_review?.status !== 'accepted') {
    return { mode: 'trigger_review' };
  }

  const blockedTasks = phase.todo.filter(t => t.lifecycle === 'blocked');
  if (blockedTasks.length > 0) {
    return { mode: 'awaiting_user', blockers: blockedTasks.map(t => ({ id: t.id, reason: t.blocked_reason })) };
  }

  // Diagnose why no task is runnable
  const diagnostics = [];
  for (const task of phase.todo) {
    if (task.lifecycle === 'accepted' || task.lifecycle === 'failed') continue;
    const reasons = [];
    if (!['pending', 'needs_revalidation'].includes(task.lifecycle)) {
      reasons.push(`lifecycle=${task.lifecycle}`);
    }
    if (task.retry_count >= maxRetry) {
      reasons.push(`retry_count=${task.retry_count} >= max=${maxRetry}`);
    }
    if (task.blocked_reason) {
      reasons.push(`blocked: ${task.blocked_reason}`);
    }
    for (const dep of (task.requires || [])) {
      if (dep.kind === 'task') {
        const depTask = phase.todo.find(t => t.id === dep.id);
        const gate = dep.gate || 'accepted';
        if (!depTask) {
          reasons.push(`dep ${dep.id} not found`);
        } else if (gate === 'checkpoint' && !['checkpointed', 'accepted'].includes(depTask.lifecycle)) {
          reasons.push(`dep ${dep.id} needs checkpoint (is ${depTask.lifecycle})`);
        } else if (gate === 'accepted' && depTask.lifecycle !== 'accepted') {
          reasons.push(`dep ${dep.id} needs accepted (is ${depTask.lifecycle})`);
        } else if (gate === 'phase_complete') {
          reasons.push(`dep ${dep.id} has phase_complete gate (invalid for task-kind dependency)`);
        }
      } else if (dep.kind === 'phase') {
        const depPhaseId = Number(dep.id);
        const depPhase = (state.phases || []).find(p => p.id === depPhaseId);
        if (!depPhase || depPhase.lifecycle !== 'accepted') {
          reasons.push(`phase dep ${dep.id} not accepted`);
        }
      }
    }
    if (reasons.length > 0) {
      diagnostics.push({ id: task.id, reasons });
    }
  }

  return { task: undefined, diagnostics };
}

/**
 * Propagate invalidation to downstream dependents when a task is reworked.
 * If contractChanged is true, all transitive dependents get needs_revalidation
 * and their evidence_refs are cleared.
 */
export function propagateInvalidation(phase, reworkTaskId, contractChanged) {
  if (!contractChanged) return;

  const affected = new Set();
  const queue = [reworkTaskId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    for (const task of phase.todo) {
      if (affected.has(task.id)) continue;
      const dependsOnCurrent = (task.requires || []).some(dep =>
        dep.kind === 'task' && dep.id === currentId
      );
      if (dependsOnCurrent) {
        affected.add(task.id);
        queue.push(task.id);
      }
    }
  }

  // C-2: Only transition tasks whose lifecycle allows needs_revalidation
  const canInvalidate = new Set(
    Object.entries(TASK_LIFECYCLE)
      .filter(([, targets]) => targets.includes('needs_revalidation'))
      .map(([state]) => state),
  );
  for (const task of phase.todo) {
    if (affected.has(task.id) && canInvalidate.has(task.lifecycle)) {
      task.lifecycle = 'needs_revalidation';
      task.evidence_refs = [];
    }
  }
}

/**
 * Build executor context for a task: 6-field protocol.
 * Returns { task_spec, research_decisions, predecessor_outputs, project_conventions, workflows, constraints }.
 */
export function buildExecutorContext(state, taskId, phaseId) {
  const phase = state.phases.find(p => p.id === phaseId);
  if (!phase) {
    return { error: true, message: `Phase ${phaseId} not found` };
  }
  if (!Array.isArray(phase.todo)) {
    return { error: true, message: `Phase ${phaseId} has invalid todo list` };
  }
  const task = phase.todo.find(t => t.id === taskId);
  if (!task) {
    return { error: true, message: `Task ${taskId} not found in phase ${phaseId}` };
  }

  const task_spec = `phases/phase-${phaseId}.md`;

  const research_decisions = (task.research_basis || []).map(id => {
    const decision = state.research?.decision_index?.[id];
    return decision ? { id, ...decision } : { id, summary: 'not found' };
  });

  const predecessor_outputs = (task.requires || [])
    .filter(dep => dep.kind === 'task')
    .map(dep => {
      const depTask = phase.todo.find(t => t.id === dep.id);
      return depTask ? { files_changed: depTask.files_changed || [], checkpoint_commit: depTask.checkpoint_commit } : null;
    })
    .filter(Boolean);

  const project_conventions = 'CLAUDE.md';
  const workflows = ['workflows/tdd-cycle.md', 'workflows/deviation-rules.md'];
  if ((task.retry_count || 0) > 0) workflows.push('workflows/debugging.md');
  if ((task.research_basis || []).length > 0) workflows.push('workflows/research.md');
  const constraints = {
    retry_count: task.retry_count || 0,
    level: task.level || 'L1',
    review_required: task.review_required !== false,
  };

  const debugger_guidance = task.debug_context ? {
    root_cause: task.debug_context.root_cause,
    fix_direction: task.debug_context.fix_direction,
    fix_attempts: task.debug_context.fix_attempts,
    evidence: task.debug_context.evidence || [],
  } : null;

  const rework_feedback = Array.isArray(task.last_review_feedback) && task.last_review_feedback.length > 0
    ? task.last_review_feedback
    : null;

  return {
    task_spec,
    research_decisions,
    predecessor_outputs,
    project_conventions,
    workflows,
    constraints,
    debugger_guidance,
    rework_feedback,
  };
}

const SENSITIVE_KEYWORDS = /\b(auth|payment|security|public.?api|login|token|credential|session|oauth)\b/i;

/**
 * Reclassify review level at runtime based on executor results.
 * Upgrades L1->L2 when: contract_changed + sensitive keywords, [LEVEL-UP], or low confidence.
 * Downgrades L1->L0 when: confidence is high and no contract change.
 * Never downgrades L2/L3.
 */
export function reclassifyReviewLevel(task, executorResult) {
  const currentLevel = task.level || 'L1';

  // Never downgrade
  if (currentLevel === 'L2' || currentLevel === 'L3') {
    return currentLevel;
  }

  // Check for explicit [LEVEL-UP] in decisions
  const hasLevelUp = (executorResult.decisions || []).some(d =>
    (typeof d === 'string' && d.includes('[LEVEL-UP]'))
    || (d && typeof d === 'object' && typeof d.summary === 'string' && d.summary.includes('[LEVEL-UP]'))
  );
  if (hasLevelUp) return 'L2';

  // Check for contract change + sensitive keyword in task name
  if (executorResult.contract_changed && SENSITIVE_KEYWORDS.test(task.name || '')) {
    return 'L2';
  }

  // Confidence-based adjustment: low confidence upgrades L1 → L2
  if (executorResult.confidence === 'low' && currentLevel === 'L1') {
    return 'L2';
  }

  // High confidence on non-sensitive L1 tasks → downgrade to L0 (self-review sufficient)
  // Cross-validate: require objective evidence before trusting self-reported confidence.
  // Without evidence or with failed tests, confidence claim is not credible.
  if (executorResult.confidence === 'high' && currentLevel === 'L1'
      && !executorResult.contract_changed) {
    const hasEvidence = Array.isArray(executorResult.evidence) && executorResult.evidence.length > 0;
    const hasTestFailure = Array.isArray(executorResult.evidence)
      && executorResult.evidence.some(e => e && e.type === 'test' && e.passed === false);
    if (hasEvidence && !hasTestFailure) {
      return 'L0';
    }
    // Insufficient evidence or test failure — stay at L1 despite high confidence claim
  }

  return currentLevel;
}

const MIN_TOKEN_LENGTH = 2;
const MIN_OVERLAP = 2;

// High-frequency words too generic for meaningful keyword matching
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'not',
  'but', 'are', 'was', 'been', 'will', 'can', 'should', 'would', 'could',
  'use', 'using', 'need', 'needs', 'into', 'also', 'when', 'then',
  'than', 'more', 'some', 'does', 'did', 'its', 'has', 'all', 'any',
  'error', 'data', 'type', 'value', 'file', 'code', 'function',
  'return', 'null', 'true', 'false', 'undefined', 'object', 'string',
  'number', 'array', 'list', 'map', 'set', 'key', 'name',
]);

/**
 * Tokenize a string into lowercase tokens, splitting on whitespace and punctuation.
 * Filters out short tokens (< MIN_TOKEN_LENGTH) and stopwords.
 */
function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[\s,.:;!?()[\]{}<>/\\|@#$%^&*+=~`'"，。：；！？（）【】、]+/)
    .filter(t => t.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(t));
}

/**
 * Match a blocked reason against research decisions by keyword overlap.
 * Returns the best-matching decision or null if no sufficient overlap.
 */
export function matchDecisionForBlocker(decisions, blockedReason) {
  const reasonTokens = new Set(tokenize(blockedReason));
  if (reasonTokens.size === 0) return null;

  let bestMatch = null;
  let bestOverlap = 0;

  for (const decision of decisions) {
    const summaryTokens = tokenize(decision.summary);
    let overlap = 0;
    for (const token of summaryTokens) {
      if (reasonTokens.has(token)) {
        overlap++;
      }
    }
    if (overlap >= MIN_OVERLAP && overlap > bestOverlap) {
      bestOverlap = overlap;
      bestMatch = decision;
    }
  }

  return bestMatch;
}

/**
 * Apply research refresh: compare new research decisions against existing state.
 * 4 rules:
 *   1. Same ID + same summary -> update metadata (e.g. expires_at), keep task lifecycle
 *   2. Same ID + changed summary -> invalidate dependent tasks (needs_revalidation)
 *   3. Old ID missing from new -> invalidate dependent tasks + warning
 *   4. Brand new ID -> add to index, no impact on existing tasks
 * Returns { warnings: string[] }.
 */
export function applyResearchRefresh(state, newResearch) {
  const warnings = [];
  const oldIndex = state.research?.decision_index || {};
  const newIndex = newResearch?.decision_index || {};

  // Copy-on-write: build merged index without mutating oldIndex
  const mergedIndex = { ...oldIndex };

  // Collect IDs of decisions that changed or were removed
  const invalidatedIds = new Set();

  // Check existing decisions against new
  for (const [id, oldDecision] of Object.entries(oldIndex)) {
    if (id in newIndex) {
      const newDecision = newIndex[id];
      if (oldDecision.summary === newDecision.summary) {
        // Rule 1: same conclusion — update metadata
        mergedIndex[id] = { ...oldDecision, ...newDecision };
      } else {
        // Rule 2: changed conclusion — replace and invalidate
        mergedIndex[id] = newDecision;
        invalidatedIds.add(id);
      }
    } else {
      // Rule 3: old ID missing from new research
      invalidatedIds.add(id);
      warnings.push(`Decision "${id}" removed in new research — dependent tasks invalidated`);
    }
  }

  // Rule 4: brand new IDs — just add them
  for (const [id, newDecision] of Object.entries(newIndex)) {
    if (!(id in oldIndex)) {
      mergedIndex[id] = newDecision;
    }
  }

  // Assign merged index to state (atomic replacement)
  if (!state.research) state.research = {};
  state.research.decision_index = mergedIndex;

  // C-3: Only invalidate tasks whose lifecycle allows needs_revalidation
  if (invalidatedIds.size > 0) {
    const canInvalidate = new Set(
      Object.entries(TASK_LIFECYCLE)
        .filter(([, targets]) => targets.includes('needs_revalidation'))
        .map(([s]) => s),
    );
    for (const phase of (state.phases || [])) {
      for (const task of (phase.todo || [])) {
        const basis = task.research_basis || [];
        const affected = basis.some(id => invalidatedIds.has(id));
        if (affected && canInvalidate.has(task.lifecycle)) {
          task.lifecycle = 'needs_revalidation';
          if (task.evidence_refs) task.evidence_refs = [];
        }
      }
    }
  }

  return { warnings };
}

export async function storeResearch({ result, artifacts, decision_index, basePath = process.cwd() } = {}) {
  const resultValidation = validateResearcherResult(result || {});
  if (!resultValidation.valid) {
    return { error: true, code: ERROR_CODES.VALIDATION_FAILED, message: `Invalid researcher result: ${resultValidation.errors.join('; ')}` };
  }

  const artifactsValidation = validateResearchArtifacts(artifacts);
  if (!artifactsValidation.valid) {
    return { error: true, code: ERROR_CODES.VALIDATION_FAILED, message: `Invalid research artifacts: ${artifactsValidation.errors.join('; ')}` };
  }

  const decisionIndexValidation = validateResearchDecisionIndex(decision_index, result.decision_ids);
  if (!decisionIndexValidation.valid) {
    return { error: true, code: ERROR_CODES.VALIDATION_FAILED, message: `Invalid research decision_index: ${decisionIndexValidation.errors.join('; ')}` };
  }

  const statePath = await getStatePath(basePath);
  if (!statePath) {
    return { error: true, code: ERROR_CODES.NO_PROJECT_DIR, message: 'No .gsd directory found' };
  }
  ensureLockPathFromStatePath(statePath);

  return withStateLock(async () => {
    const current = await readJson(statePath);
    if (!current.ok) {
      return { error: true, code: ERROR_CODES.NO_PROJECT_DIR, message: current.error };
    }

    const state = migrateState(current.data);
    const gsdDir = dirname(statePath);
    const researchDir = join(gsdDir, 'research');
    await ensureDir(researchDir);

    // Crash-consistency sentinel: marks the window between artifact renames and
    // state.json write. On recovery (future iteration), presence of this file
    // indicates a potentially inconsistent research state.
    const sentinelPath = join(gsdDir, '.research-commit-pending');
    writeFileSync(sentinelPath, JSON.stringify({ timestamp: Date.now(), pid: process.pid }));

    // Atomic multi-file write: write all artifacts first, then rename in batch
    const normalizedArtifacts = normalizeResearchArtifacts(artifacts);
    const tmpSuffix = `.${process.pid}-${Date.now()}.tmp`;
    const tmpPaths = [];
    try {
      for (const fileName of RESEARCH_FILES) {
        const finalPath = join(researchDir, fileName);
        const tmpFile = finalPath + tmpSuffix;
        tmpPaths.push({ tmp: tmpFile, final: finalPath });
        await writeFile(tmpFile, normalizedArtifacts[fileName], 'utf-8');
      }
      // All writes succeeded — rename in batch
      for (const { tmp, final: finalPath } of tmpPaths) {
        await rename(tmp, finalPath);
      }
    } catch (err) {
      // Cleanup any temp files on failure
      for (const { tmp } of tmpPaths) {
        try { await unlink(tmp); } catch {}
      }
      try { unlinkSync(sentinelPath); } catch {}
      throw err;
    }

    const nextResearchBase = {
      volatility: result.volatility,
      expires_at: result.expires_at,
      sources: result.sources,
      files: RESEARCH_FILES,
      updated_at: new Date().toISOString(),
    };

    const refreshResult = state.research
      ? applyResearchRefresh(state, { ...nextResearchBase, decision_index })
      : { warnings: [] };

    // After applyResearchRefresh, state.research.decision_index is the merged result
    const mergedDecisionIndex = state.research?.decision_index || decision_index;
    state.research = {
      ...(state.research || {}),
      ...nextResearchBase,
      decision_index: mergedDecisionIndex,
    };

    if (state.workflow_mode === 'research_refresh_needed') {
      state.workflow_mode = inferWorkflowModeAfterResearch(state);
    }

    // Recompute done after applyResearchRefresh may have invalidated tasks
    for (const phase of (state.phases || [])) {
      if (Array.isArray(phase.todo)) {
        phase.done = phase.todo.filter(t => t.lifecycle === 'accepted').length;
      }
    }

    const validation = validateState(state);
    if (!validation.valid) {
      return { error: true, code: ERROR_CODES.VALIDATION_FAILED, message: `State validation failed: ${validation.errors.join('; ')}` };
    }

    state._version = (state._version ?? 0) + 1;
    await writeJson(statePath, state);

    // Remove sentinel after successful state write — crash consistency window closed
    try { unlinkSync(sentinelPath); } catch {}

    return {
      success: true,
      workflow_mode: state.workflow_mode,
      stored_files: RESEARCH_FILES,
      decision_ids: result.decision_ids,
      warnings: refreshResult.warnings,
      research: state.research,
    };
  });
}
