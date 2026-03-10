// State schema + lifecycle validation

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
  failed:               [],
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

export const CANONICAL_FIELDS = [
  'project',
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

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateTransition(entity, from, to) {
  const transitions = entity === 'task' ? TASK_LIFECYCLE : PHASE_LIFECYCLE;
  if (!transitions[from]) {
    return { valid: false, error: `Unknown ${entity} state: ${from}` };
  }
  if (!transitions[from].includes(to)) {
    return { valid: false, error: `Invalid ${entity} transition: ${from} → ${to}` };
  }
  return { valid: true };
}

export function validateState(state) {
  const errors = [];
  if (!state.project || typeof state.project !== 'string') {
    errors.push('project must be a non-empty string');
  }
  if (!WORKFLOW_MODES.includes(state.workflow_mode)) {
    errors.push(`Invalid workflow_mode: ${state.workflow_mode}`);
  }
  if (typeof state.plan_version !== 'number') {
    errors.push('plan_version must be a number');
  }
  if (typeof state.current_phase !== 'number') {
    errors.push('current_phase must be a number');
  }
  if (state.git_head !== null && typeof state.git_head !== 'string') {
    errors.push('git_head must be a string or null');
  }
  if (typeof state.total_phases !== 'number') {
    errors.push('total_phases must be a number');
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
    if (typeof state.context.remaining_percentage !== 'number') {
      errors.push('context.remaining_percentage must be a number');
    }
  }
  if (state.research !== null && !isPlainObject(state.research)) {
    errors.push('research must be null or an object');
  }
  if (isPlainObject(state.research) && 'decision_index' in state.research && !isPlainObject(state.research.decision_index)) {
    errors.push('research.decision_index must be an object');
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
      if (typeof phase.id !== 'number') {
        errors.push('phase.id must be a number');
      }
      if (!phase.name || typeof phase.name !== 'string') {
        errors.push(`Phase ${phase.id}: name must be a non-empty string`);
      }
      if (!PHASE_LIFECYCLE[phase.lifecycle]) {
        errors.push(`Phase ${phase.id}: invalid lifecycle ${phase.lifecycle}`);
      }
      if (!isPlainObject(phase.phase_review)) {
        errors.push(`Phase ${phase.id}: phase_review must be an object`);
      } else if (typeof phase.phase_review.retry_count !== 'number') {
        errors.push(`Phase ${phase.id}: phase_review.retry_count must be a number`);
      }
      if (typeof phase.tasks !== 'number') {
        errors.push(`Phase ${phase.id}: tasks must be a number`);
      }
      if (typeof phase.done !== 'number') {
        errors.push(`Phase ${phase.id}: done must be a number`);
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
        if (typeof phase.phase_handoff.critical_issues_open !== 'number') {
          errors.push(`Phase ${phase.id}: phase_handoff.critical_issues_open must be a number`);
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
        if (typeof task.level !== 'string') {
          errors.push(`Task ${task.id}: level must be a string`);
        }
        if (!Array.isArray(task.requires)) {
          errors.push(`Task ${task.id}: requires must be an array`);
        }
        if (typeof task.retry_count !== 'number') {
          errors.push(`Task ${task.id}: retry_count must be a number`);
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
  if (!r.task_id) errors.push('missing task_id');
  if (!['checkpointed', 'blocked', 'failed'].includes(r.outcome)) errors.push('invalid outcome');
  if (!Array.isArray(r.files_changed)) errors.push('files_changed must be array');
  if (!Array.isArray(r.decisions)) errors.push('decisions must be array');
  if (!Array.isArray(r.blockers)) errors.push('blockers must be array');
  if (typeof r.contract_changed !== 'boolean') errors.push('contract_changed must be boolean');
  if (!Array.isArray(r.evidence)) errors.push('evidence must be array');
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a reviewer result against the agent contract.
 */
export function validateReviewerResult(r) {
  const errors = [];
  if (!['task', 'phase'].includes(r.scope)) errors.push('invalid scope');
  if (!r.scope_id) errors.push('missing scope_id');
  if (!Array.isArray(r.critical_issues)) errors.push('critical_issues must be array');
  if (!Array.isArray(r.accepted_tasks)) errors.push('accepted_tasks must be array');
  if (!Array.isArray(r.rework_tasks)) errors.push('rework_tasks must be array');
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a researcher result against the agent contract.
 */
export function validateResearcherResult(r) {
  const errors = [];
  if (!Array.isArray(r.decision_ids)) errors.push('decision_ids must be array');
  if (!['low', 'medium', 'high'].includes(r.volatility)) errors.push('invalid volatility');
  if (!r.expires_at) errors.push('missing expires_at');
  if (!Array.isArray(r.sources)) errors.push('sources must be array');
  return { valid: errors.length === 0, errors };
}

export function createInitialState({ project, phases }) {
  return {
    project,
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
        id: `${i + 1}.${t.index || ti + 1}`,
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
