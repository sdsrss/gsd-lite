// State schema + lifecycle validation

import { isPlainObject } from './utils.js';

export const WORKFLOW_MODES = [
  'planning',
  'executing_task',
  'reviewing_task',
  'reviewing_phase',
  'awaiting_clear',
  'awaiting_user',
  'paused_by_user',
  'reconcile_workspace',
  'replan_required',
  'research_refresh_needed',
  'completed',
  'failed',
];

export const TASK_LIFECYCLE = {
  pending:              ['running', 'blocked'],
  running:              ['checkpointed', 'blocked', 'failed'],
  checkpointed:         ['accepted', 'needs_revalidation'],
  accepted:             ['needs_revalidation'],
  blocked:              ['pending'],
  failed:               ['pending'],
  needs_revalidation:   ['pending'],
};

export const PHASE_LIFECYCLE = {
  pending:    ['active'],
  active:     ['reviewing', 'blocked', 'failed'],
  reviewing:  ['accepted', 'active'],
  accepted:   [],
  blocked:    ['active'],
  failed:     [],
};

export const TASK_LEVELS = ['L0', 'L1', 'L2', 'L3'];

export const PHASE_REVIEW_STATUS = ['pending', 'reviewing', 'accepted', 'rework_required'];

export const CANONICAL_FIELDS = [
  'project',
  'schema_version',
  'workflow_mode',
  'plan_version',
  'git_head',
  'current_phase',
  'current_task',
  'current_review',
  'total_phases',
  'phases',
  'decisions',
  'context',
  'research',
  'evidence',
];

function validateResearchSourcesArray(sources, errors, path = 'sources') {
  if (!Array.isArray(sources)) {
    errors.push(`${path} must be array`);
    return;
  }

  for (const source of sources) {
    if (!isPlainObject(source)) {
      errors.push(`${path} entries must be objects`);
      continue;
    }
    if (typeof source.id !== 'string' || source.id.length === 0) errors.push(`${path}[].id must be non-empty string`);
    if (typeof source.type !== 'string' || source.type.length === 0) errors.push(`${path}[].type must be non-empty string`);
    if (typeof source.ref !== 'string' || source.ref.length === 0) errors.push(`${path}[].ref must be non-empty string`);
  }
}

export function validateResearchDecisionIndex(decisionIndex, requiredIds = []) {
  const errors = [];
  if (!isPlainObject(decisionIndex)) {
    errors.push('decision_index must be an object');
    return { valid: false, errors };
  }

  for (const id of requiredIds) {
    if (!isPlainObject(decisionIndex[id])) {
      errors.push(`decision_index.${id} must be an object`);
    }
  }

  for (const [id, entry] of Object.entries(decisionIndex)) {
    if (!isPlainObject(entry)) {
      errors.push(`decision_index.${id} must be an object`);
      continue;
    }
    if (typeof entry.summary !== 'string' || entry.summary.length === 0) {
      errors.push(`decision_index.${id}.summary must be a non-empty string`);
    }
    if ('source' in entry && (typeof entry.source !== 'string' || entry.source.length === 0)) {
      errors.push(`decision_index.${id}.source must be a non-empty string`);
    }
    if ('expires_at' in entry && (typeof entry.expires_at !== 'string' || entry.expires_at.length === 0)) {
      errors.push(`decision_index.${id}.expires_at must be a non-empty string`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateResearchArtifacts(artifacts, { decisionIds = [], volatility, expiresAt } = {}) {
  const errors = [];
  if (!isPlainObject(artifacts)) {
    return { valid: false, errors: ['artifacts must be an object'] };
  }

  const requiredFiles = ['STACK.md', 'ARCHITECTURE.md', 'PITFALLS.md', 'SUMMARY.md'];
  for (const fileName of requiredFiles) {
    if (typeof artifacts[fileName] !== 'string' || artifacts[fileName].trim().length === 0) {
      errors.push(`artifacts.${fileName} must be a non-empty string`);
    }
  }

  const summary = typeof artifacts['SUMMARY.md'] === 'string' ? artifacts['SUMMARY.md'] : '';
  if (volatility && !summary.includes(volatility)) {
    errors.push('artifacts.SUMMARY.md must mention volatility');
  }
  if (expiresAt && !summary.includes(expiresAt)) {
    errors.push('artifacts.SUMMARY.md must mention expires_at');
  }
  for (const id of decisionIds) {
    if (!summary.includes(id)) {
      errors.push(`artifacts.SUMMARY.md must mention decision id ${id}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateTransition(entity, from, to) {
  if (entity !== 'task' && entity !== 'phase') {
    return { valid: false, error: `Unknown entity type: ${entity}` };
  }
  const transitions = entity === 'task' ? TASK_LIFECYCLE : PHASE_LIFECYCLE;
  if (!transitions[from]) {
    return { valid: false, error: `Unknown ${entity} state: ${from}` };
  }
  if (!transitions[from].includes(to)) {
    return { valid: false, error: `Invalid ${entity} transition: ${from} → ${to}` };
  }
  return { valid: true };
}

/**
 * Incremental validation: only validate changed fields + their relationships.
 * Falls back to full validateState() for complex updates (phases).
 */
export function validateStateUpdate(state, updates) {
  // For phases updates, fall back to full validation
  if ('phases' in updates) {
    return validateState({ ...state, ...updates });
  }

  const errors = [];

  for (const key of Object.keys(updates)) {
    switch (key) {
      case 'workflow_mode':
        if (!WORKFLOW_MODES.includes(updates.workflow_mode)) {
          errors.push(`Invalid workflow_mode: ${updates.workflow_mode}`);
        }
        break;
      case 'current_phase':
        if (!Number.isFinite(updates.current_phase)) {
          errors.push('current_phase must be a finite number');
        }
        break;
      case 'current_task':
        if (updates.current_task !== null && typeof updates.current_task !== 'string') {
          errors.push('current_task must be a string or null');
        }
        break;
      case 'current_review':
        if (updates.current_review !== null && !isPlainObject(updates.current_review)) {
          errors.push('current_review must be an object or null');
        }
        break;
      case 'git_head':
        if (updates.git_head !== null && typeof updates.git_head !== 'string') {
          errors.push('git_head must be a string or null');
        }
        break;
      case 'plan_version':
        if (!Number.isFinite(updates.plan_version)) {
          errors.push('plan_version must be a finite number');
        }
        break;
      case 'schema_version':
        if (!Number.isFinite(updates.schema_version)) {
          errors.push('schema_version must be a finite number');
        }
        break;
      case 'total_phases':
        if (!Number.isFinite(updates.total_phases)) {
          errors.push('total_phases must be a finite number');
        }
        break;
      case 'project':
        if (!updates.project || typeof updates.project !== 'string') {
          errors.push('project must be a non-empty string');
        }
        break;
      case 'decisions':
        if (!Array.isArray(updates.decisions)) {
          errors.push('decisions must be an array');
        }
        break;
      case 'context':
        if (!isPlainObject(updates.context)) {
          errors.push('context must be an object');
        } else {
          const ctx = { ...state.context, ...updates.context };
          if (typeof ctx.last_session !== 'string') errors.push('context.last_session must be a string');
          if (!Number.isFinite(ctx.remaining_percentage)) errors.push('context.remaining_percentage must be a finite number');
        }
        break;
      case 'evidence':
        if (!isPlainObject(updates.evidence)) {
          errors.push('evidence must be an object');
        }
        break;
      case 'research':
        if (updates.research !== null && !isPlainObject(updates.research)) {
          errors.push('research must be null or an object');
        }
        break;
      default:
        errors.push(`Unknown canonical field: ${key}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateState(state) {
  const errors = [];
  if (!state.project || typeof state.project !== 'string') {
    errors.push('project must be a non-empty string');
  }
  if (!Number.isFinite(state.schema_version)) {
    errors.push('schema_version must be a finite number');
  }
  if (!WORKFLOW_MODES.includes(state.workflow_mode)) {
    errors.push(`Invalid workflow_mode: ${state.workflow_mode}`);
  }
  if (!Number.isFinite(state.plan_version)) {
    errors.push('plan_version must be a finite number');
  }
  if (!Number.isFinite(state.current_phase)) {
    errors.push('current_phase must be a finite number');
  }
  if (state.git_head !== null && typeof state.git_head !== 'string') {
    errors.push('git_head must be a string or null');
  }
  if (!Number.isFinite(state.total_phases)) {
    errors.push('total_phases must be a finite number');
  }
  if (!Array.isArray(state.phases)) {
    errors.push('phases must be an array');
  }
  if (!Array.isArray(state.decisions)) {
    errors.push('decisions must be an array');
  }
  if (!isPlainObject(state.context)) {
    errors.push('context must be an object');
  } else {
    if (typeof state.context.last_session !== 'string') {
      errors.push('context.last_session must be a string');
    }
    if (!Number.isFinite(state.context.remaining_percentage)) {
      errors.push('context.remaining_percentage must be a finite number');
    }
  }
  if (state.research !== null && !isPlainObject(state.research)) {
    errors.push('research must be null or an object');
  }
  if (isPlainObject(state.research) && 'decision_index' in state.research && !isPlainObject(state.research.decision_index)) {
    errors.push('research.decision_index must be an object');
  }
  if (isPlainObject(state.research)) {
    if ('volatility' in state.research && !['low', 'medium', 'high'].includes(state.research.volatility)) {
      errors.push('research.volatility must be low|medium|high');
    }
    if ('expires_at' in state.research
      && (typeof state.research.expires_at !== 'string' || state.research.expires_at.length === 0)) {
      errors.push('research.expires_at must be a non-empty string');
    }
    if ('files' in state.research && !Array.isArray(state.research.files)) {
      errors.push('research.files must be an array');
    }
    if (Array.isArray(state.research.files)) {
      for (const fileName of state.research.files) {
        if (typeof fileName !== 'string' || fileName.length === 0) {
          errors.push('research.files entries must be non-empty strings');
          break;
        }
      }
    }
    if ('sources' in state.research) {
      validateResearchSourcesArray(state.research.sources, errors, 'research.sources');
    }
    if ('decision_index' in state.research) {
      const decisionIndexValidation = validateResearchDecisionIndex(state.research.decision_index);
      errors.push(...decisionIndexValidation.errors.map((error) => `research.${error}`));
    }
  }
  if (state.current_task !== null && typeof state.current_task !== 'string') {
    errors.push('current_task must be a string or null');
  }
  if (state.current_review !== null && !isPlainObject(state.current_review)) {
    errors.push('current_review must be an object or null');
  }
  if (!isPlainObject(state.evidence)) {
    errors.push('evidence must be an object');
  }
  if (Array.isArray(state.phases)) {
    if (typeof state.total_phases === 'number' && state.total_phases !== state.phases.length) {
      errors.push(`total_phases (${state.total_phases}) does not match phases.length (${state.phases.length})`);
    }
    for (const phase of state.phases) {
      if (!isPlainObject(phase)) {
        errors.push('phase must be an object');
        continue;
      }
      if (!Number.isFinite(phase.id)) {
        errors.push('phase.id must be a finite number');
      }
      if (!phase.name || typeof phase.name !== 'string') {
        errors.push(`Phase ${phase.id}: name must be a non-empty string`);
      }
      if (!PHASE_LIFECYCLE[phase.lifecycle]) {
        errors.push(`Phase ${phase.id}: invalid lifecycle ${phase.lifecycle}`);
      }
      if (!isPlainObject(phase.phase_review)) {
        errors.push(`Phase ${phase.id}: phase_review must be an object`);
      } else {
        if (!PHASE_REVIEW_STATUS.includes(phase.phase_review.status)) {
          errors.push(`Phase ${phase.id}: invalid phase_review.status ${phase.phase_review.status}`);
        }
        if (!Number.isFinite(phase.phase_review.retry_count)) {
          errors.push(`Phase ${phase.id}: phase_review.retry_count must be a finite number`);
        }
      }
      if (!Number.isFinite(phase.tasks)) {
        errors.push(`Phase ${phase.id}: tasks must be a finite number`);
      }
      if (!Number.isFinite(phase.done)) {
        errors.push(`Phase ${phase.id}: done must be a finite number`);
      }
      if (!Array.isArray(phase.todo)) {
        errors.push(`Phase ${phase.id}: todo must be an array`);
        continue;
      }
      if (!isPlainObject(phase.phase_handoff)) {
        errors.push(`Phase ${phase.id}: phase_handoff must be an object`);
      } else {
        if (typeof phase.phase_handoff.required_reviews_passed !== 'boolean') {
          errors.push(`Phase ${phase.id}: phase_handoff.required_reviews_passed must be boolean`);
        }
        if (typeof phase.phase_handoff.tests_passed !== 'boolean') {
          errors.push(`Phase ${phase.id}: phase_handoff.tests_passed must be boolean`);
        }
        if (!Number.isFinite(phase.phase_handoff.critical_issues_open)) {
          errors.push(`Phase ${phase.id}: phase_handoff.critical_issues_open must be a finite number`);
        }
        if ('direction_ok' in phase.phase_handoff && typeof phase.phase_handoff.direction_ok !== 'boolean') {
          errors.push(`Phase ${phase.id}: phase_handoff.direction_ok must be boolean when present`);
        }
      }
      for (const task of phase.todo) {
        if (!isPlainObject(task)) {
          errors.push(`Phase ${phase.id}: task must be an object`);
          continue;
        }
        if (!task.id || typeof task.id !== 'string') {
          errors.push('task.id must be a non-empty string');
        }
        if (!task.name || typeof task.name !== 'string') {
          errors.push(`Task ${task.id}: name must be a non-empty string`);
        }
        if (!TASK_LIFECYCLE[task.lifecycle]) {
          errors.push(`Task ${task.id}: invalid lifecycle ${task.lifecycle}`);
        }
        if (!TASK_LEVELS.includes(task.level)) {
          errors.push(`Task ${task.id}: level must be one of ${TASK_LEVELS.join(', ')}`);
        }
        if (!Array.isArray(task.requires)) {
          errors.push(`Task ${task.id}: requires must be an array`);
        }
        if (!Number.isFinite(task.retry_count)) {
          errors.push(`Task ${task.id}: retry_count must be a finite number`);
        }
        if (typeof task.review_required !== 'boolean') {
          errors.push(`Task ${task.id}: review_required must be a boolean`);
        }
        if (typeof task.verification_required !== 'boolean') {
          errors.push(`Task ${task.id}: verification_required must be a boolean`);
        }
        if (task.checkpoint_commit !== null && typeof task.checkpoint_commit !== 'string') {
          errors.push(`Task ${task.id}: checkpoint_commit must be a string or null`);
        }
        if (!Array.isArray(task.research_basis)) {
          errors.push(`Task ${task.id}: research_basis must be an array`);
        }
        if (!Array.isArray(task.evidence_refs)) {
          errors.push(`Task ${task.id}: evidence_refs must be an array`);
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate an executor result against the agent contract.
 */
export function validateExecutorResult(r) {
  const errors = [];
  if (typeof r.task_id !== 'string' || r.task_id.length === 0) errors.push('missing task_id');
  if (!['checkpointed', 'blocked', 'failed'].includes(r.outcome)) errors.push('invalid outcome');
  if (typeof r.summary !== 'string' || r.summary.length === 0) errors.push('summary must be non-empty string');
  if ('checkpoint_commit' in r && r.checkpoint_commit !== null && typeof r.checkpoint_commit !== 'string') {
    errors.push('checkpoint_commit must be string or null');
  }
  if (!Array.isArray(r.files_changed)) errors.push('files_changed must be array');
  if (!Array.isArray(r.decisions)) errors.push('decisions must be array');
  if (!Array.isArray(r.blockers)) errors.push('blockers must be array');
  if (typeof r.contract_changed !== 'boolean') errors.push('contract_changed must be boolean');
  if (!Array.isArray(r.evidence)) errors.push('evidence must be array');
  if (r.outcome === 'checkpointed' && typeof r.checkpoint_commit !== 'string') {
    errors.push('checkpointed outcome requires checkpoint_commit');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a reviewer result against the agent contract.
 */
export function validateReviewerResult(r) {
  const errors = [];
  if (!['task', 'phase'].includes(r.scope)) errors.push('invalid scope');
  if (!(typeof r.scope_id === 'string' || typeof r.scope_id === 'number') || r.scope_id === '') {
    errors.push('missing scope_id');
  }
  if (!['L2', 'L1-batch'].includes(r.review_level)) errors.push('invalid review_level');
  if (typeof r.spec_passed !== 'boolean') errors.push('spec_passed must be boolean');
  if (typeof r.quality_passed !== 'boolean') errors.push('quality_passed must be boolean');
  if (!Array.isArray(r.critical_issues)) errors.push('critical_issues must be array');
  if (!Array.isArray(r.important_issues)) errors.push('important_issues must be array');
  if (!Array.isArray(r.minor_issues)) errors.push('minor_issues must be array');
  if (!Array.isArray(r.accepted_tasks)) errors.push('accepted_tasks must be array');
  if (!Array.isArray(r.rework_tasks)) errors.push('rework_tasks must be array');
  if (!Array.isArray(r.evidence)) errors.push('evidence must be array');

  if (Array.isArray(r.accepted_tasks) && Array.isArray(r.rework_tasks)) {
    const overlap = r.accepted_tasks.filter(id => r.rework_tasks.includes(id));
    if (overlap.length > 0) {
      errors.push(`accepted_tasks and rework_tasks must be disjoint; overlap: ${overlap.join(', ')}`);
    }
  }
  for (const issue of r.critical_issues || []) {
    if (!isPlainObject(issue)) {
      errors.push('critical_issues entries must be objects');
      continue;
    }
    if (typeof issue.reason !== 'string' || issue.reason.length === 0) {
      errors.push('critical_issues[].reason must be non-empty string');
    }
    if ('task_id' in issue && typeof issue.task_id !== 'string') {
      errors.push('critical_issues[].task_id must be string');
    }
    if ('invalidates_downstream' in issue && typeof issue.invalidates_downstream !== 'boolean') {
      errors.push('critical_issues[].invalidates_downstream must be boolean');
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a researcher result against the agent contract.
 */
export function validateResearcherResult(r) {
  const errors = [];
  if (!Array.isArray(r.decision_ids)) errors.push('decision_ids must be array');
  if (!['low', 'medium', 'high'].includes(r.volatility)) errors.push('invalid volatility');
  if (typeof r.expires_at !== 'string' || r.expires_at.length === 0) errors.push('missing expires_at');
  validateResearchSourcesArray(r.sources, errors, 'sources');

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a debugger result against the agent contract.
 */
export function validateDebuggerResult(r) {
  const errors = [];
  if (typeof r.task_id !== 'string' || r.task_id.length === 0) errors.push('missing task_id');
  if (!['root_cause_found', 'fix_suggested', 'failed'].includes(r.outcome)) errors.push('invalid outcome');
  if (typeof r.root_cause !== 'string' || r.root_cause.length === 0) errors.push('root_cause must be non-empty string');
  if (!Array.isArray(r.evidence)) errors.push('evidence must be array');
  if (!Array.isArray(r.hypothesis_tested)) errors.push('hypothesis_tested must be array');
  if (typeof r.fix_direction !== 'string' || r.fix_direction.length === 0) errors.push('fix_direction must be non-empty string');
  if (!Number.isInteger(r.fix_attempts) || r.fix_attempts < 0) errors.push('fix_attempts must be non-negative integer');
  if (!Array.isArray(r.blockers)) errors.push('blockers must be array');
  if (typeof r.architecture_concern !== 'boolean') errors.push('architecture_concern must be boolean');
  if (r.fix_attempts >= 3 && r.outcome !== 'failed') errors.push('fix_attempts >= 3 requires failed outcome');

  for (const hypothesis of r.hypothesis_tested || []) {
    if (!isPlainObject(hypothesis)) {
      errors.push('hypothesis_tested entries must be objects');
      continue;
    }
    if (typeof hypothesis.hypothesis !== 'string' || hypothesis.hypothesis.length === 0) {
      errors.push('hypothesis_tested[].hypothesis must be non-empty string');
    }
    if (!['confirmed', 'rejected'].includes(hypothesis.result)) {
      errors.push('hypothesis_tested[].result must be confirmed or rejected');
    }
    if (typeof hypothesis.evidence !== 'string' || hypothesis.evidence.length === 0) {
      errors.push('hypothesis_tested[].evidence must be non-empty string');
    }
  }

  return { valid: errors.length === 0, errors };
}

export function createInitialState({ project, phases }) {
  if (!Array.isArray(phases)) {
    return { error: true, message: 'phases must be an array' };
  }
  // Validate task names and uniqueness before creating state
  const seenIds = new Set();
  for (const [pi, p] of phases.entries()) {
    for (const [ti, t] of (p.tasks || []).entries()) {
      if (!t.name || typeof t.name !== 'string') {
        return { error: true, message: `Phase ${pi + 1} task ${ti + 1}: name is required (got ${JSON.stringify(t.name)})` };
      }
      const id = `${pi + 1}.${t.index ?? (ti + 1)}`;
      if (seenIds.has(id)) {
        return { error: true, message: `Duplicate task ID: ${id} in phase ${pi + 1}` };
      }
      seenIds.add(id);
    }
  }
  return {
    project,
    schema_version: 1,
    workflow_mode: 'executing_task',
    plan_version: 1,
    git_head: null,
    current_phase: 1,
    current_task: null,
    current_review: null,
    total_phases: phases.length,
    phases: phases.map((p, i) => ({
      id: i + 1,
      name: p.name,
      lifecycle: i === 0 ? 'active' : 'pending',
      phase_review: { status: 'pending', retry_count: 0 },
      tasks: p.tasks ? p.tasks.length : 0,
      done: 0,
      todo: (p.tasks || []).map((t, ti) => ({
        id: `${i + 1}.${t.index ?? (ti + 1)}`,
        name: t.name,
        lifecycle: 'pending',
        level: t.level || 'L1',
        requires: t.requires || [],
        retry_count: 0,
        review_required: t.review_required !== false,
        verification_required: t.verification_required !== false,
        checkpoint_commit: null,
        research_basis: t.research_basis || [],
        evidence_refs: [],
        ...(t.blocked_reason ? { blocked_reason: t.blocked_reason } : {}),
        ...(t.invalidate_downstream_on_change ? { invalidate_downstream_on_change: true } : {}),
      })),
      phase_handoff: {
        required_reviews_passed: false,
        tests_passed: false,
        critical_issues_open: 0,
      },
    })),
    decisions: [],
    context: {
      last_session: new Date().toISOString(),
      remaining_percentage: 100,
    },
    research: null,
    evidence: {},
  };
}
