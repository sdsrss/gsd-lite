#!/bin/bash
# Smoke test: verifies core GSD-Lite functionality in a clean temp directory.
# Usage: bash scripts/smoke-test.sh
set -euo pipefail

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "=== GSD-Lite Smoke Test ==="
echo "Temp dir: $TMPDIR"

# 1. State init
echo -n "[1/5] State init... "
node -e "
  import { init, read } from './src/tools/state.js';
  const r = await init({ project: 'smoke', phases: [{ name: 'P1', tasks: [{ index: 1, name: 'T1' }] }], basePath: '$TMPDIR' });
  if (r.error) { console.error(JSON.stringify(r)); process.exit(1); }
  const s = await read({ basePath: '$TMPDIR' });
  if (s.project !== 'smoke') { console.error('project name mismatch'); process.exit(1); }
" && echo "OK" || { echo "FAIL"; exit 1; }

# 2. State update + lifecycle
echo -n "[2/5] Lifecycle transitions... "
node -e "
  import { update, read } from './src/tools/state.js';
  const bp = '$TMPDIR';
  let r = await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: bp });
  if (r.error) { console.error(JSON.stringify(r)); process.exit(1); }
  r = await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'checkpointed', checkpoint_commit: 'abc' }] }] }, basePath: bp });
  if (r.error) { console.error(JSON.stringify(r)); process.exit(1); }
  const s = await read({ basePath: bp });
  if (s.phases[0].todo[0].lifecycle !== 'checkpointed') { console.error('bad lifecycle'); process.exit(1); }
" && echo "OK" || { echo "FAIL"; exit 1; }

# 3. Orchestrator resume
echo -n "[3/5] Orchestrator resume... "
node -e "
  import { resumeWorkflow } from './src/tools/orchestrator.js';
  const r = await resumeWorkflow({ basePath: '$TMPDIR' });
  if (!r.success) { console.error(JSON.stringify(r)); process.exit(1); }
  if (r.action !== 'trigger_review') { console.error('expected trigger_review, got ' + r.action); process.exit(1); }
" && echo "OK" || { echo "FAIL"; exit 1; }

# 4. Schema validation
echo -n "[4/5] Schema validation... "
node -e "
  import { validateState, createInitialState } from './src/schema.js';
  const s = createInitialState({ project: 'smoke', phases: [{ name: 'P1', tasks: [{ index: 1, name: 'T1' }] }] });
  const r = validateState(s);
  if (!r.valid) { console.error(r.errors.join('; ')); process.exit(1); }
" && echo "OK" || { echo "FAIL"; exit 1; }

# 5. MCP server health
echo -n "[5/5] MCP server module load... "
node -e "
  import './src/server.js';
  // If module loads without error, that's a basic health check
" && echo "OK" || { echo "FAIL"; exit 1; }

echo ""
echo "=== ALL SMOKE TESTS PASSED ==="
