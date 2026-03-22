#!/bin/bash
# Smoke test: verifies core GSD-Lite functionality in a clean temp directory.
# Usage: bash scripts/smoke-test.sh
set -euo pipefail

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

TOTAL=9
echo "=== GSD-Lite Smoke Test ==="
echo "Temp dir: $TMPDIR"

# 1. State init
echo -n "[1/$TOTAL] State init... "
node -e "
  import { init, read } from './src/tools/state/index.js';
  const r = await init({ project: 'smoke', phases: [{ name: 'P1', tasks: [{ index: 1, name: 'T1' }] }], basePath: '$TMPDIR' });
  if (r.error) { console.error(JSON.stringify(r)); process.exit(1); }
  const s = await read({ basePath: '$TMPDIR' });
  if (s.project !== 'smoke') { console.error('project name mismatch'); process.exit(1); }
" && echo "OK" || { echo "FAIL"; exit 1; }

# 2. State update + lifecycle
echo -n "[2/$TOTAL] Lifecycle transitions... "
node -e "
  import { update, read } from './src/tools/state/index.js';
  const bp = '$TMPDIR';
  let r = await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: bp });
  if (r.error) { console.error(JSON.stringify(r)); process.exit(1); }
  r = await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'checkpointed', checkpoint_commit: 'abc' }] }] }, basePath: bp });
  if (r.error) { console.error(JSON.stringify(r)); process.exit(1); }
  const s = await read({ basePath: bp });
  if (s.phases[0].todo[0].lifecycle !== 'checkpointed') { console.error('bad lifecycle'); process.exit(1); }
" && echo "OK" || { echo "FAIL"; exit 1; }

# 3. Orchestrator resume
echo -n "[3/$TOTAL] Orchestrator resume... "
node -e "
  import { resumeWorkflow } from './src/tools/orchestrator/index.js';
  const r = await resumeWorkflow({ basePath: '$TMPDIR' });
  if (!r.success) { console.error(JSON.stringify(r)); process.exit(1); }
  if (r.action !== 'trigger_review') { console.error('expected trigger_review, got ' + r.action); process.exit(1); }
" && echo "OK" || { echo "FAIL"; exit 1; }

# 4. Schema validation
echo -n "[4/$TOTAL] Schema validation... "
node -e "
  import { validateState, createInitialState } from './src/schema.js';
  const s = createInitialState({ project: 'smoke', phases: [{ name: 'P1', tasks: [{ index: 1, name: 'T1' }] }] });
  const r = validateState(s);
  if (!r.valid) { console.error(r.errors.join('; ')); process.exit(1); }
" && echo "OK" || { echo "FAIL"; exit 1; }

# 5. MCP server health
echo -n "[5/$TOTAL] MCP server module load... "
node -e "
  import './src/server.js';
  // If module loads without error, that's a basic health check
" && echo "OK" || { echo "FAIL"; exit 1; }

# 6. Install chain — verify install.js loads without error
echo -n "[6/$TOTAL] Install chain (module load)... "
node -e "
  import { main } from './install.js';
  if (typeof main !== 'function') { console.error('main is not a function'); process.exit(1); }
" && echo "OK" || { echo "FAIL"; exit 1; }

# 7. Multi-phase workflow — 2-phase project, advance P1 through to complete_phase signal
TMPDIR_MP=$(mktemp -d)
trap 'rm -rf "$TMPDIR" "$TMPDIR_MP"' EXIT
echo -n "[7/$TOTAL] Multi-phase workflow... "
node -e "
  import { init, update, read, phaseComplete } from './src/tools/state/index.js';
  import { resumeWorkflow, handleExecutorResult, handleReviewerResult } from './src/tools/orchestrator/index.js';
  const bp = '$TMPDIR_MP';

  // Create 2-phase project with 1 task each
  let r = await init({
    project: 'multi-phase',
    phases: [
      { name: 'Phase1', tasks: [{ index: 1, name: 'Task1' }] },
      { name: 'Phase2', tasks: [{ index: 1, name: 'Task2' }] },
    ],
    basePath: bp,
  });
  if (r.error) { console.error('init:', JSON.stringify(r)); process.exit(1); }

  // Advance task 1.1: pending -> running
  r = await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: bp });
  if (r.error) { console.error('running:', JSON.stringify(r)); process.exit(1); }

  // Submit executor result: checkpointed
  r = await handleExecutorResult({
    result: {
      task_id: '1.1',
      outcome: 'checkpointed',
      summary: 'Task completed',
      checkpoint_commit: 'abc123',
      files_changed: ['file.js'],
      decisions: [],
      blockers: [],
      contract_changed: false,
      evidence: [],
    },
    basePath: bp,
  });
  if (r.error) { console.error('executor:', JSON.stringify(r)); process.exit(1); }
  // L1 tasks with review_required=true are NOT auto-accepted; they await batch review
  if (r.action !== 'continue_execution') { console.error('expected continue_execution, got ' + r.action); process.exit(1); }

  // Resume should trigger phase review (task is checkpointed, none pending)
  r = await resumeWorkflow({ basePath: bp });
  if (r.error) { console.error('resume1:', JSON.stringify(r)); process.exit(1); }
  if (r.action !== 'trigger_review') { console.error('expected trigger_review, got ' + r.action); process.exit(1); }

  // Submit reviewer result: accept phase
  r = await handleReviewerResult({
    result: {
      scope: 'phase',
      scope_id: 1,
      review_level: 'L1-batch',
      spec_passed: true,
      quality_passed: true,
      critical_issues: [],
      important_issues: [],
      minor_issues: [],
      accepted_tasks: ['1.1'],
      rework_tasks: [],
      evidence: [],
    },
    basePath: bp,
  });
  if (r.error) { console.error('reviewer:', JSON.stringify(r)); process.exit(1); }

  // Resume should now signal complete_phase (all accepted + review passed)
  r = await resumeWorkflow({ basePath: bp });
  if (r.error) { console.error('resume2:', JSON.stringify(r)); process.exit(1); }
  if (r.action !== 'complete_phase') { console.error('expected complete_phase, got ' + r.action); process.exit(1); }
" && echo "OK" || { echo "FAIL"; exit 1; }

# 8. Stop/Resume roundtrip — pause and recover
TMPDIR_SR=$(mktemp -d)
trap 'rm -rf "$TMPDIR" "$TMPDIR_MP" "$TMPDIR_SR"' EXIT
echo -n "[8/$TOTAL] Stop/Resume roundtrip... "
node -e "
  import { init, update, read } from './src/tools/state/index.js';
  import { resumeWorkflow } from './src/tools/orchestrator/index.js';
  const bp = '$TMPDIR_SR';

  // Create project
  let r = await init({ project: 'stop-resume', phases: [{ name: 'P1', tasks: [{ index: 1, name: 'T1' }] }], basePath: bp });
  if (r.error) { console.error('init:', JSON.stringify(r)); process.exit(1); }

  // Stop: set workflow_mode to paused_by_user
  r = await update({ updates: { workflow_mode: 'paused_by_user' }, basePath: bp });
  if (r.error) { console.error('pause:', JSON.stringify(r)); process.exit(1); }

  // Verify paused state
  let s = await read({ basePath: bp });
  if (s.workflow_mode !== 'paused_by_user') { console.error('expected paused_by_user, got ' + s.workflow_mode); process.exit(1); }

  // Resume: orchestrator should report paused state with resume_to
  r = await resumeWorkflow({ basePath: bp });
  if (!r.success) { console.error('resume:', JSON.stringify(r)); process.exit(1); }
  if (r.workflow_mode !== 'paused_by_user') { console.error('expected paused_by_user mode, got ' + r.workflow_mode); process.exit(1); }
  if (r.action !== 'await_manual_intervention') { console.error('expected await_manual_intervention, got ' + r.action); process.exit(1); }
  if (r.resume_to !== 'executing_task') { console.error('expected resume_to=executing_task, got ' + r.resume_to); process.exit(1); }

  // Simulate user confirming resume: set workflow_mode back to executing_task
  r = await update({ updates: { workflow_mode: 'executing_task' }, basePath: bp });
  if (r.error) { console.error('unpause:', JSON.stringify(r)); process.exit(1); }

  // Now resumeWorkflow should dispatch executor
  r = await resumeWorkflow({ basePath: bp });
  if (!r.success) { console.error('resume2:', JSON.stringify(r)); process.exit(1); }
  if (r.action !== 'dispatch_executor') { console.error('expected dispatch_executor after resume, got ' + r.action); process.exit(1); }
" && echo "OK" || { echo "FAIL"; exit 1; }

# 9. Phase complete — phaseComplete activates next phase
TMPDIR_PC=$(mktemp -d)
trap 'rm -rf "$TMPDIR" "$TMPDIR_MP" "$TMPDIR_SR" "$TMPDIR_PC"' EXIT
echo -n "[9/$TOTAL] Phase complete... "
node -e "
  import { init, update, read, phaseComplete } from './src/tools/state/index.js';
  import { handleExecutorResult, handleReviewerResult } from './src/tools/orchestrator/index.js';
  const bp = '$TMPDIR_PC';

  // Create 2-phase project
  let r = await init({
    project: 'phase-complete',
    phases: [
      { name: 'Phase1', tasks: [{ index: 1, name: 'Task1' }] },
      { name: 'Phase2', tasks: [{ index: 1, name: 'Task2' }] },
    ],
    basePath: bp,
  });
  if (r.error) { console.error('init:', JSON.stringify(r)); process.exit(1); }

  // Advance task 1.1 to running
  r = await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: bp });
  if (r.error) { console.error('running:', JSON.stringify(r)); process.exit(1); }

  // Submit executor result
  r = await handleExecutorResult({
    result: {
      task_id: '1.1',
      outcome: 'checkpointed',
      summary: 'Done',
      checkpoint_commit: 'def456',
      files_changed: ['a.js'],
      decisions: [],
      blockers: [],
      contract_changed: false,
      evidence: [],
    },
    basePath: bp,
  });
  if (r.error) { console.error('executor:', JSON.stringify(r)); process.exit(1); }

  // Submit reviewer result to pass phase review
  // First set workflow_mode to reviewing_phase so reviewer can run
  r = await update({ updates: { workflow_mode: 'reviewing_phase', current_review: { scope: 'phase', scope_id: 1 }, phases: [{ id: 1, lifecycle: 'reviewing' }] }, basePath: bp });
  if (r.error) { console.error('set-review:', JSON.stringify(r)); process.exit(1); }

  r = await handleReviewerResult({
    result: {
      scope: 'phase',
      scope_id: 1,
      review_level: 'L1-batch',
      spec_passed: true,
      quality_passed: true,
      critical_issues: [],
      important_issues: [],
      minor_issues: [],
      accepted_tasks: ['1.1'],
      rework_tasks: [],
      evidence: [],
    },
    basePath: bp,
  });
  if (r.error) { console.error('reviewer:', JSON.stringify(r)); process.exit(1); }

  // Set tests_passed so handoff gate is satisfied
  r = await update({ updates: { phases: [{ id: 1, phase_handoff: { tests_passed: true } }] }, basePath: bp });
  if (r.error) { console.error('tests_passed:', JSON.stringify(r)); process.exit(1); }

  // Call phaseComplete
  r = await phaseComplete({ phase_id: 1, basePath: bp });
  if (r.error) { console.error('phaseComplete:', JSON.stringify(r)); process.exit(1); }
  if (!r.success) { console.error('phaseComplete not successful'); process.exit(1); }

  // Verify: phase 1 accepted, phase 2 active, current_phase = 2
  const s = await read({ basePath: bp });
  if (s.current_phase !== 2) { console.error('expected current_phase=2, got ' + s.current_phase); process.exit(1); }
  if (s.phases[0].lifecycle !== 'accepted') { console.error('expected P1 accepted, got ' + s.phases[0].lifecycle); process.exit(1); }
  if (s.phases[1].lifecycle !== 'active') { console.error('expected P2 active, got ' + s.phases[1].lifecycle); process.exit(1); }
" && echo "OK" || { echo "FAIL"; exit 1; }

echo ""
echo "=== ALL $TOTAL SMOKE TESTS PASSED ==="
