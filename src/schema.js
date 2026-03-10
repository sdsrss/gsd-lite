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
  checkpointed:         ['accepted'],
  accepted:             ['needs_revalidation'],
  blocked:              ['pending', 'running'],
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
  if (!Array.isArray(state.phases)) {
    errors.push('phases must be an array');
  }
  if (!Array.isArray(state.decisions)) {
    errors.push('decisions must be an array');
  }
  if (Array.isArray(state.phases)) {
    for (const phase of state.phases) {
      if (!PHASE_LIFECYCLE[phase.lifecycle]) {
        errors.push(`Phase ${phase.id}: invalid lifecycle ${phase.lifecycle}`);
      }
      if (Array.isArray(phase.todo)) {
        for (const task of phase.todo) {
          if (!TASK_LIFECYCLE[task.lifecycle]) {
            errors.push(`Task ${task.id}: invalid lifecycle ${task.lifecycle}`);
          }
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function createInitialState({ project, phases }) {
  return {
    project,
    workflow_mode: 'planning',
    plan_version: 1,
    git_head: null,
    current_phase: 1,
    current_task: null,
    current_review: null,
    total_phases: phases.length,
    phases: phases.map((p, i) => ({
      id: i + 1,
      name: p.name,
      lifecycle: 'pending',
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
