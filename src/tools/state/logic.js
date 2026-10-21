// Automation/business logic functions

import { dirname, join } from 'node:path';
import { writeFile, rename, unlink, open, stat } from 'node:fs/promises';
import { ensureDir, writeJson, getStatePath, fsyncDir, isPlainObject, shippedDocPath } from '../../utils.js';
import { taskRefsForAgent } from '../../agent-payload.js';
import {
  DEP_GATES,
  TASK_LIFECYCLE,
  isDepGateAllowed,
  BLOCKED_TAG,
  nextSuspendedModes,
  resumeTarget,
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
  loadState,
  withStateLock,
  inferWorkflowModeAfterResearch,
  normalizeResearchArtifacts,
} from './constants.js';

/**
 * Has this phase's review requirement been met?
 *
 * One rule, three callers — the zero-task branch below, `phaseComplete`'s
 * handoff gate in crud.js, and resume.js's auto-completion. It used to be
 * written out three times and the copies had already diverged: two carried an
 * all-tasks-accepted clause, one did not, and only crud.js required
 * `lifecycle === 'active'` on it.
 *
 *  - A recorded, accepted phase review satisfies it, as does the reviewer's own
 *    `required_reviews_passed` flag.
 *  - So does "every task accepted, no review ever started": L0 tasks auto-accept
 *    without an individual review, so `required_reviews_passed` stays false and
 *    the phase could otherwise never complete (bee5ce2).
 *  - Once a review is in flight (lifecycle 'reviewing') that no longer applies.
 *    A review someone started has to finish; auto-accepting would discard it.
 *  - A zero-task phase has nothing to accept, so only the recorded forms count.
 *    Without the length check an empty milestone would pass vacuously — every
 *    task in an empty list is accepted.
 */
export function phaseReviewSatisfied(phase) {
  if (!phase) return false;
  if (phase.phase_review?.status === 'accepted') return true;
  if (phase.phase_handoff?.required_reviews_passed === true) return true;
  const todo = phase.todo || [];
  return phase.lifecycle === 'active'
    && todo.length > 0
    && todo.every(t => t.lifecycle === 'accepted');
}

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
  // D-4: Zero-task phase — trigger review once so the phase can advance, but only
  // until that (vacuous) review passes. Returning trigger_review unconditionally
  // makes the resume loop oscillate forever (review accepts → resume → review again)
  // because an empty phase never reaches the normal all-accepted completion path.
  if (phase.todo.length === 0) {
    return phaseReviewSatisfied(phase) ? { task: undefined, diagnostics: [] } : { mode: 'trigger_review' };
  }

  const runnableTasks = [];

  for (const task of phase.todo) {
    if (!['pending', 'needs_revalidation'].includes(task.lifecycle)) continue;
    if (task.retry_count >= maxRetry) continue;
    if (task.blocked_reason) continue;

    let depsOk = true;
    for (const dep of (task.requires || [])) {
      // A dependency this function cannot resolve — unknown kind, a gate the
      // kind does not have — counts as unsatisfied, never as satisfied. Reading
      // it as met silently drops the ordering the plan asked for; refusing it
      // parks the task with a reason in the diagnostics below. The authoring
      // paths reject both (schema.js DEP_GATES), but a state.json written by
      // hand or by another version can still carry one.
      if (dep.kind === 'task') {
        const depTask = phase.todo.find(t => t.id === dep.id);
        if (!depTask) { depsOk = false; break; }
        const gate = dep.gate || 'accepted';
        if (!isDepGateAllowed('task', gate)) { depsOk = false; break; }
        if (gate === 'checkpoint' && !['checkpointed', 'accepted'].includes(depTask.lifecycle)) { depsOk = false; break; }
        if (gate === 'accepted' && depTask.lifecycle !== 'accepted') { depsOk = false; break; }
      } else if (dep.kind === 'phase') {
        if (!isDepGateAllowed('phase', dep.gate)) { depsOk = false; break; }
        const depPhaseId = Number(dep.id);
        const depPhase = (state.phases || []).find(p => p.id === depPhaseId);
        if (!depPhase || depPhase.lifecycle !== 'accepted') { depsOk = false; break; }
      } else {
        depsOk = false; break;
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
        } else if (!isDepGateAllowed('task', gate)) {
          // No state satisfies this one, so say so rather than describing a
          // wait: the plan has to change (state-patch, or replan).
          reasons.push(`dep ${dep.id} has gate '${gate}', which a task dependency never has (use ${DEP_GATES.task.join(' or ')}) — this task can never run as written`);
        } else if (gate === 'checkpoint' && !['checkpointed', 'accepted'].includes(depTask.lifecycle)) {
          reasons.push(`dep ${dep.id} needs checkpoint (is ${depTask.lifecycle})`);
        } else if (gate === 'accepted' && depTask.lifecycle !== 'accepted') {
          reasons.push(`dep ${dep.id} needs accepted (is ${depTask.lifecycle})`);
        }
      } else if (dep.kind === 'phase') {
        const depPhaseId = Number(dep.id);
        const depPhase = (state.phases || []).find(p => p.id === depPhaseId);
        if (!isDepGateAllowed('phase', dep.gate)) {
          reasons.push(`phase dep ${dep.id} has gate '${dep.gate}', which a phase dependency never has (use ${DEP_GATES.phase.join(' or ')}) — this task can never run as written`);
        } else if (!depPhase || depPhase.lifecycle !== 'accepted') {
          reasons.push(`phase dep ${dep.id} not accepted`);
        }
      } else {
        reasons.push(`dep ${JSON.stringify(dep.id)} has kind '${dep.kind}', which is neither task nor phase — this task can never run as written`);
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
 * A phase that has finished, or is under review, and regains unfinished work is
 * active again: its review and handoff described work that has changed.
 * validateState refuses an accepted phase holding a task that is not accepted,
 * and PHASE_LIFECYCLE gives `accepted` no exit, so this is the one way back.
 * Shared by contract-change and research invalidation so neither can reopen a
 * phase differently from the other.
 */
function reopenPhase(phase) {
  if (phase.lifecycle !== 'accepted' && phase.lifecycle !== 'reviewing') return;
  phase.lifecycle = 'active';
  phase.phase_review = { status: 'pending', retry_count: 0 };
  if (phase.phase_handoff) phase.phase_handoff.required_reviews_passed = false;
}

/**
 * R-12 (audit M2): propagate a contract-change invalidation ACROSS phases.
 * When a phase's contract changes, later phases that depend on it via a
 * phase-kind dependency have their already-completed (accepted/checkpointed)
 * dependent tasks marked needs_revalidation. An invalidated phase becomes a new
 * source so the effect cascades transitively; the invalidated phase is rolled
 * back from accepted/reviewing to active for re-review.
 *
 * Terminates because forward/self phase refs are rejected at plan time (R-06),
 * so phase dependencies form a backward-only DAG — each cascade step strictly
 * increases the source phase id.
 *
 * @param {object} state - full merged state (mutated in place)
 * @param {number} sourcePhaseId - id of the phase whose contract changed
 */
export function propagateCrossPhaseInvalidation(state, sourcePhaseId) {
  if (!Array.isArray(state.phases)) return;
  const canInvalidate = new Set(
    Object.entries(TASK_LIFECYCLE)
      .filter(([, targets]) => targets.includes('needs_revalidation'))
      .map(([s]) => s),
  );

  const processed = new Set();
  const queue = [sourcePhaseId];
  while (queue.length > 0) {
    const src = queue.shift();
    if (processed.has(src)) continue;
    processed.add(src);

    for (const phase of state.phases) {
      if (phase.id <= src) continue; // deps point backward — dependents have higher id
      let invalidatedAny = false;
      for (const task of (phase.todo || [])) {
        const dependsOnSrc = (task.requires || []).some(
          dep => dep.kind === 'phase' && Number(dep.id) === src,
        );
        if (dependsOnSrc && canInvalidate.has(task.lifecycle)) {
          task.lifecycle = 'needs_revalidation';
          task.evidence_refs = [];
          invalidatedAny = true;
        }
      }
      if (invalidatedAny) {
        reopenPhase(phase);
        queue.push(phase.id); // this phase is now incomplete → cascade to its dependents
      }
    }
  }
}

/**
 * Build executor context for a task: 6-field protocol.
 * Returns { task_spec, research_decisions, predecessor_outputs, project_conventions, workflows, constraints }.
 */
export function buildExecutorContext(state, taskId, phaseId, workspaceRoot) {
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
      // The fourth carrier, and the one that feeds the EXECUTOR — which holds
      // Write and Edit on top of Bash. It relayed both fields raw through three
      // review rounds because each round fixed the sites that round had found.
      return depTask ? taskRefsForAgent(depTask, workspaceRoot) : null;
    })
    .filter(Boolean);

  const project_conventions = 'CLAUDE.md';
  // Absolute, via shippedDocPath: the executor reads these with the user's
  // project as its working directory, where a relative path finds nothing.
  // Each arm is its own push — a fix applied to only the default pair would
  // leave the retry and research arms broken the same way, so they all route
  // through the same resolver.
  const workflows = [
    shippedDocPath('workflows', 'tdd-cycle.md'),
    shippedDocPath('workflows', 'deviation-rules.md'),
  ];
  if ((task.retry_count || 0) > 0) workflows.push(shippedDocPath('workflows', 'debugging.md'));
  if ((task.research_basis || []).length > 0) workflows.push(shippedDocPath('workflows', 'research.md'));
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
 * Apply research refresh: the new decision index replaces the old one whole,
 * and the rules decide which tasks it invalidates.
 *   1. Same ID + same summary -> kept, task lifecycle unchanged
 *   2. Same ID + changed summary -> dependent tasks invalidated (needs_revalidation)
 *   3. Old ID missing from new -> dependent tasks invalidated + warning
 *   4. Brand new ID -> added, no impact on existing tasks
 *
 * Replacement, not a merge: a refresh re-runs the research and storeResearch
 * rewrites all four documents, so nothing of an old entry outlives it. The
 * merge kept a dropped decision with its past expires_at (rule 3) and the old
 * expires_at of a kept one that came back without its own (rule 1); either one
 * expired the research again on the next resume, and the kept entry fired
 * rule 3 on every later refresh.
 *
 * A phase that held an invalidated task is reopened (reopenPhase). Later
 * phases are not: whether a contract changed is for the review of the
 * re-executed task to say (invalidates_downstream), as on every other path.
 * Returns { warnings: string[], invalidated: string[] } (task ids).
 */
export function applyResearchRefresh(state, newResearch) {
  const warnings = [];
  const oldIndex = state.research?.decision_index || {};
  const newIndex = newResearch?.decision_index || {};

  const invalidatedIds = new Set();
  for (const [id, oldDecision] of Object.entries(oldIndex)) {
    if (!(id in newIndex)) {
      invalidatedIds.add(id);
      warnings.push(`Decision "${id}" removed in new research — dependent tasks invalidated`);
    } else if (oldDecision?.summary !== newIndex[id].summary) {
      // An entry with no readable summary (0.17.0's state-update could write
      // null) counts as changed: its conclusion cannot be shown to hold.
      invalidatedIds.add(id);
    }
  }

  if (!state.research) state.research = {};
  state.research.decision_index = { ...newIndex };

  // C-3: Only invalidate tasks whose lifecycle allows needs_revalidation
  const invalidated = [];
  if (invalidatedIds.size > 0) {
    const canInvalidate = new Set(
      Object.entries(TASK_LIFECYCLE)
        .filter(([, targets]) => targets.includes('needs_revalidation'))
        .map(([s]) => s),
    );
    for (const phase of (state.phases || [])) {
      let phaseTouched = false;
      for (const task of (phase.todo || [])) {
        const basis = task.research_basis || [];
        const affected = basis.some(id => invalidatedIds.has(id));
        if (affected && canInvalidate.has(task.lifecycle)) {
          task.lifecycle = 'needs_revalidation';
          if (task.evidence_refs) task.evidence_refs = [];
          invalidated.push(task.id);
          phaseTouched = true;
        }
      }
      if (phaseTouched) reopenPhase(phase);
    }
  }

  return { warnings, invalidated };
}

// The shortest expiry a store accepts. The researcher's shortest TTL is three
// days and its blocked fallback asks for 24 hours; anything under an hour is a
// computation gone wrong, and stored it expires before the next resume.
const MIN_RESEARCH_TTL_MS = 60 * 60 * 1000;

/**
 * The expiry dates a researcher result carries, refused when any is not a
 * date at least MIN_RESEARCH_TTL_MS away. Stored as-is, an expired date made
 * the research expire on the next resume, and the refresh that triggered
 * could store it again. Checked here, at the store, and not in validateState:
 * research on record is supposed to expire with time.
 */
function staleExpiryErrors(result, decisionIndex) {
  const now = Date.now();
  const errors = [];
  const check = (label, value) => {
    const at = Date.parse(value);
    if (!Number.isFinite(at)) errors.push(`${label} must be an ISO 8601 date (got ${JSON.stringify(value)})`);
    else if (at <= now) errors.push(`${label} ${value} has already passed`);
    else if (at - now < MIN_RESEARCH_TTL_MS) errors.push(`${label} ${value} is less than an hour away`);
  };
  check('expires_at', result.expires_at);
  for (const [id, entry] of Object.entries(decisionIndex)) {
    if ('expires_at' in entry) check(`decision_index.${id}.expires_at`, entry.expires_at);
  }
  return errors;
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

  const staleErrors = staleExpiryErrors(result, decision_index);
  if (staleErrors.length > 0) {
    return {
      error: true,
      code: ERROR_CODES.VALIDATION_FAILED,
      message: `Research that expires this soon would be refreshed again on the next resume: ${staleErrors.join('; ')}`,
    };
  }

  const statePath = await getStatePath(basePath);
  if (!statePath) {
    return { error: true, code: ERROR_CODES.NO_PROJECT_DIR, message: 'No GSD project found (.gsd directory missing). Run /gsd:start or /gsd:prd to begin.' };
  }
  ensureLockPathFromStatePath(statePath);

  return withStateLock(async () => {
    const loaded = await loadState(statePath);
    if (loaded.error) return loaded.error;

    // The next state is worked out and validated before any file is written.
    // The documents used to be renamed into place first, so a refused state
    // left them describing research that state.json did not record, and the
    // commit marker that would have said so was removed with the refusal.
    const state = loaded.state;
    // What is on record is compared with and then replaced. A decision_index
    // that is not an object (0.17.0's state-update could write a string) holds
    // no decision to keep: read as itself, a string's characters became
    // removed decisions and `in` threw on it.
    if (isPlainObject(state.research) && !isPlainObject(state.research.decision_index)) state.research.decision_index = {};
    const previousIndex = state.research?.decision_index || {};

    // A blocked result says the research could not be done. Over real research
    // it replaced every decision on record, sent every task citing them back
    // for revalidation, reopened accepted phases and overwrote the four
    // documents with placeholders, so it is refused and the record stays.
    // Over nothing, or over a record that was itself blocked (a project planned
    // with no sources), there is nothing to protect and it is stored: refusing
    // it there left that project dispatching the researcher on every resume
    // once its 24-hour placeholder expired.
    // The result says which it is (`blocked`), and the record says what it
    // was stored as; neither is guessed from a summary any more. A summary
    // written as the placeholder under `blocked: false` contradicts itself
    // and is refused, so the next dispatch says which it is.
    const blocked = result.blocked === true;
    const recordHasResearch = isPlainObject(state.research) && state.research.blocked !== true
      && Object.keys(previousIndex).length > 0;
    const tagged = blocked ? [] : Object.keys(decision_index)
      .filter((id) => typeof decision_index[id]?.summary === 'string' && BLOCKED_TAG.test(decision_index[id].summary));
    if (tagged.length > 0) {
      return {
        error: true,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `Decision(s) ${tagged.join(', ')} are written as the [BLOCKED] placeholder, but the result says blocked: false. A result that could not be completed sets blocked: true; one that was completed does not use the placeholder.`,
      };
    }
    // The way out names the mode the refresh interrupted (suspended_modes);
    // executing_task, which it used to name, dropped a review in progress.
    const giveUp = `give up the expired research with state-update (research: null, workflow_mode: "${resumeTarget(state)}"), after which tasks' research_basis no longer resolves`;
    if (recordHasResearch && blocked) {
      return {
        error: true,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `A blocked research result (${Object.keys(decision_index).join(', ') || 'no decisions'}) would replace the research on record, so it is kept. Retry the refresh once the researcher can complete it, or ${giveUp}.`,
      };
    }
    // A result with no decisions is not a research that found none: a refresh
    // returns the whole decision set, and stored, this one replaced every
    // decision on record and sent every task citing them back.
    if (recordHasResearch && Object.keys(decision_index).length === 0) {
      return {
        error: true,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `A research result with no decisions would replace the research on record, so it is kept. Return the complete decision set, keeping the ids in current_decision_index whose conclusions still hold, or ${giveUp}.`,
      };
    }
    // The one writer of the decision index; with no research on record the old
    // index is empty and nothing is invalidated.
    const { warnings, invalidated } = applyResearchRefresh(state, { decision_index });
    state.research = {
      ...state.research,
      blocked,
      volatility: result.volatility,
      expires_at: result.expires_at,
      sources: result.sources,
      files: RESEARCH_FILES,
      updated_at: new Date().toISOString(),
    };

    // A research_basis id the research does not have resolves to "not found"
    // in every executor dispatch. Say so while the plan can still be fixed;
    // ids this refresh removed already have their own warning.
    for (const phase of (state.phases || [])) {
      for (const task of (phase.todo || [])) {
        const unknown = (task.research_basis || []).filter((id) => !(id in decision_index) && !(id in previousIndex));
        if (unknown.length > 0) {
          warnings.push(`Task ${task.id} cites ${unknown.join(', ')}, which the stored research does not have`);
        }
      }
    }

    if (state.workflow_mode === 'research_refresh_needed') {
      const resumed = inferWorkflowModeAfterResearch(state, { invalidated: invalidated.length > 0 });
      state.suspended_modes = nextSuspendedModes(state.suspended_modes, state.workflow_mode, resumed.workflow_mode);
      state.workflow_mode = resumed.workflow_mode;
      state.current_review = resumed.current_review;
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

    const gsdDir = dirname(statePath);
    const researchDir = join(gsdDir, 'research');
    await ensureDir(researchDir);

    // Crash-consistency sentinel: marks the window between artifact renames and
    // the state.json write. resumeWorkflow reports it if it is still there.
    const sentinelPath = join(gsdDir, '.research-commit-pending');
    // A marker already here is an earlier write that stopped partway; this
    // attempt failing must not be what clears it.
    const earlierMarker = await stat(sentinelPath).then(() => true, () => false);
    await writeFile(sentinelPath, JSON.stringify({ timestamp: Date.now(), pid: process.pid }));

    // Atomic multi-file write: write all artifacts first, then rename in batch
    const normalizedArtifacts = normalizeResearchArtifacts(artifacts);
    const tmpSuffix = `.${process.pid}-${Date.now()}.tmp`;
    const tmpPaths = [];
    let renamed = 0;
    try {
      for (const fileName of RESEARCH_FILES) {
        const finalPath = join(researchDir, fileName);
        const tmpFile = finalPath + tmpSuffix;
        tmpPaths.push({ tmp: tmpFile, final: finalPath });
        // R-13 (audit M5): fsync each artifact's data before renaming it in.
        const fh = await open(tmpFile, 'w');
        try {
          await fh.writeFile(normalizedArtifacts[fileName], 'utf-8');
          await fh.sync();
        } finally {
          await fh.close();
        }
      }
      // All writes succeeded + fsync'd — rename in batch, then fsync the dir so
      // the renames themselves survive a power loss.
      for (const { tmp, final: finalPath } of tmpPaths) {
        await rename(tmp, finalPath);
        renamed += 1;
      }
      await fsyncDir(researchDir);
    } catch (err) {
      // Cleanup any temp files on failure
      for (const { tmp } of tmpPaths) {
        try { await unlink(tmp); } catch {}
      }
      // The marker exists for exactly this: once a document has been renamed
      // in, the research directory no longer matches state.json. Removing it
      // here left that disagreement with nothing to report it.
      if (renamed === 0 && !earlierMarker) {
        try { await unlink(sentinelPath); } catch {}
      }
      throw err;
    }

    state._version = (state._version ?? 0) + 1;
    await writeJson(statePath, state);

    // Remove sentinel after successful state write — crash consistency window closed
    try { await unlink(sentinelPath); } catch {}

    return {
      success: true,
      workflow_mode: state.workflow_mode,
      stored_files: RESEARCH_FILES,
      decision_ids: result.decision_ids,
      warnings,
      invalidated_tasks: invalidated,
      research: state.research,
    };
  }, statePath);
}
