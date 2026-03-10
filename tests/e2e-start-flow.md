# E2E Test Plan — Start Flow

## Flow: `/gsd:start` → research → plan → execute → review → accepted

### Prerequisites

- Clean git repo with at least one commit
- Node.js available; `node --test` works
- No existing `.gsd/` directory (or remove it first)

---

## Step 1: Start — Interactive Discussion

**Action:** Run `/gsd:start` and provide a project description.

**Verify:**
- [ ] Orchestrator detects input language and responds in same language
- [ ] Orchestrator performs codebase analysis (reads project structure, package.json, etc.)
- [ ] Orchestrator asks open-ended questions about requirements
- [ ] Follow-up questions use `references/questioning.md` techniques (challenge ambiguity, concretize, discover boundaries)
- [ ] Each question provides options with a recommended option marked
- [ ] Discussion converges in 2-4 rounds

---

## Step 2: Research Phase

**Action:** Orchestrator decides whether research is needed and dispatches `gsd-researcher`.

**Verify:**
- [ ] Research decision logic is correct:
  - New project → must research
  - New tech stack → must research
  - Simple bug fix → skip research
  - Existing `.gsd/research/` and not expired → skip
- [ ] If research runs, `gsd-researcher` sub-agent is dispatched in fresh context
- [ ] Research output written to `.gsd/research/` (STACK.md, ARCHITECTURE.md, PITFALLS.md, SUMMARY.md)
- [ ] Key findings shown to user: tech stack recommendations + pitfall warnings + recommended approach
- [ ] Researcher result is valid JSON conforming to researcher result contract:
  ```json
  {
    "decision_index": { "<id>": { "summary": "...", "volatility": "low|medium|high", "expires_at": "..." } },
    "files_written": ["..."]
  }
  ```

---

## Step 3: Deep Thinking

**Action:** Orchestrator invokes `sequential-thinking` MCP if available.

**Verify:**
- [ ] If `sequential-thinking` available → called with requirements summary + codebase analysis + research results
- [ ] If not available → graceful fallback to inline thinking, flow continues

---

## Step 4: Plan Generation

**Action:** Orchestrator generates phased plan.

**Verify:**
- [ ] `plan.md` created as read-only index (no task-level details)
- [ ] `phases/*.md` created with detailed task specs per phase
- [ ] Each phase has 5-8 tasks
- [ ] Each task has metadata: `requires`, `review_required`, `research_basis`, `level`
- [ ] Review levels correctly assigned: L0 (docs/config), L1 (normal), L2 (auth/payment/public API)
- [ ] Dependency gates correctly set: `checkpoint` (low risk), `accepted` (default), `phase_complete` (cross-phase)

---

## Step 5: Plan Self-Review

**Action:** Orchestrator performs lightweight self-review.

**Verify:**
- [ ] Basic review: no missing requirements, reasonable phase splits, correct dependencies, executable verification conditions
- [ ] If high-risk project → enhanced review triggers:
  - Requirements coverage check
  - Risk ordering (high-risk first)
  - Dependency safety (L2 downstream uses `gate:accepted`)
  - Verification sufficiency for auth/payment tasks
  - Pitfall coverage from `research/PITFALLS.md`
- [ ] Self-review runs at most 2 rounds; unresolved issues shown to user with risk annotation

---

## Step 6: User Confirms Plan

**Action:** User reviews and confirms plan.

**Verify:**
- [ ] Plan displayed to user with phase/task breakdown
- [ ] User can request adjustments → plan updated → re-displayed
- [ ] User confirms → flow proceeds

---

## Step 7: State Initialization (state.json)

**Action:** Orchestrator creates `.gsd/` and writes `state.json`.

**state.json correctness checks:**
- [ ] `project` — non-empty string matching project name
- [ ] `workflow_mode` — `"executing_task"`
- [ ] `plan_version` — `1`
- [ ] `git_head` — matches current `git rev-parse HEAD`
- [ ] `current_phase` — `1`
- [ ] `current_task` — `null` (filled by execution loop)
- [ ] `current_review` — `null`
- [ ] `total_phases` — matches number of phases
- [ ] `phases` array — each phase has:
  - `id`, `name`, `lifecycle` (`"pending"`, first = `"active"`)
  - `phase_review: { status: "pending", retry_count: 0 }`
  - `tasks` count, `done` = 0
  - `todo` array with tasks, each having: `id`, `name`, `lifecycle: "pending"`, `level`, `requires`, `retry_count: 0`, `review_required`, `verification_required`, `checkpoint_commit: null`, `research_basis`, `evidence_refs: []`
  - `phase_handoff: { required_reviews_passed: false, tests_passed: false, critical_issues_open: 0 }`
- [ ] `decisions` — `[]`
- [ ] `context.remaining_percentage` — initialized
- [ ] `research` — populated if research ran, `null` otherwise
- [ ] `evidence` — `{}`
- [ ] All fields are canonical (no derived fields persisted)

---

## Step 8: Execution Loop — Task Scheduling

**Action:** Orchestrator enters main execution loop.

**Verify per task cycle:**

### 8a. Task Selection
- [ ] `selectRunnableTask` picks task where:
  - `lifecycle` is `pending` or `needs_revalidation`
  - All `requires` dependencies meet their gate (`checkpoint`/`accepted`/`phase_complete`)
  - `retry_count < 3`
  - No `blocked_reason`
- [ ] `current_task` updated in state.json

### 8b. Executor Context Construction
- [ ] 6-field protocol passed to executor:
  - `task_spec` — path to phase markdown
  - `research_decisions` — resolved from `research_basis`
  - `predecessor_outputs` — `files_changed` + `checkpoint_commit` from deps
  - `project_conventions` — `"CLAUDE.md"`
  - `workflows` — `["workflows/tdd-cycle.md", "workflows/deviation-rules.md"]`
  - `constraints` — `{ retry_count, level, review_required }`

### 8c. Executor Dispatch
- [ ] `gsd-executor` sub-agent dispatched with context
- [ ] Executor runs in fresh sub-agent context

### 8d. Executor Result Processing
- [ ] Result is valid JSON matching executor contract:
  ```json
  {
    "task_id": "X.Y",
    "outcome": "checkpointed|blocked|failed",
    "evidence": [...],
    "files_changed": [...],
    "checkpoint_commit": "sha",
    "contract_changed": true|false,
    "decisions": [...]
  }
  ```
- [ ] `checkpointed` → checkpoint commit + evidence refs written to state
- [ ] `blocked` → blocked_reason set; orchestrator checks `decisions` array for auto-answer; if can't → `workflow_mode = awaiting_user`
- [ ] `failed` → `retry_count` incremented; if < 3 → re-dispatch; if >= 3 → trigger debugger
- [ ] `[DECISION]` entries appended to `state.decisions` array

### 8e. Evidence Recording
- [ ] Evidence entries written to `state.evidence` with proper IDs
- [ ] Evidence references (`evidence_refs`) added to task in state.json
- [ ] Evidence contains: scope, type, data

---

## Step 9: Review Cycle

### L0 Review
- [ ] Tasks with `level: "L0"` → auto-accepted after checkpoint (no reviewer needed)

### L1 Review (Phase Batch)
- [ ] After all L1 tasks in phase are checkpointed → batch review triggered
- [ ] `gsd-reviewer` dispatched with scope = phase
- [ ] Reviewer result is valid JSON:
  ```json
  {
    "scope": "phase",
    "scope_id": 1,
    "findings": [...],
    "verdict": "accepted|rework_required"
  }
  ```
- [ ] No Critical findings → all tasks updated to `accepted`
- [ ] Critical findings → tasks marked for rework + invalidation propagated

### L2 Review (Immediate)
- [ ] Tasks with `level: "L2"` → immediate review after checkpoint
- [ ] `gsd-reviewer` dispatched with scope = task
- [ ] Task not accepted until review passes
- [ ] Downstream dependencies blocked until L2 task accepted

### Review Reclassification (Runtime)
- [ ] `contract_changed: true` + sensitive keyword in task name → L1 auto-upgraded to L2
- [ ] Executor `[LEVEL-UP]` annotation → L1 upgraded to L2
- [ ] Never downgrades (L2 stays L2)

---

## Step 10: Phase Handoff Gate

**Verify handoff gate checks:**
- [ ] All required tasks have `lifecycle: "accepted"`
- [ ] Required reviews passed
- [ ] `critical_issues_open === 0`
- [ ] Tests/lint/typecheck pass verification conditions
- [ ] Direction check: output still aligns with `plan.md` project goals
- [ ] All pass → phase `lifecycle` set to `"accepted"`, `current_phase` incremented
- [ ] Any fail → attempt fix (up to 3 times), then stop
- [ ] Direction drift → `workflow_mode = awaiting_user`

**state.json after phase handoff:**
- [ ] Phase `lifecycle` = `"accepted"`
- [ ] `phase_handoff.required_reviews_passed` = `true`
- [ ] `phase_handoff.tests_passed` = `true`
- [ ] `current_phase` incremented to next pending phase
- [ ] Old phase evidence archived (only current + previous phase retained)

---

## Step 11: Context Health Check

- [ ] Before each sub-agent dispatch and at phase transitions, context health checked
- [ ] `remaining_percentage < 40%` → save state + `workflow_mode = awaiting_clear` + output message + stop
- [ ] `remaining_percentage < 20%` → emergency save + `workflow_mode = awaiting_clear` + urgent message + immediate stop

---

## Step 12: Final Report

**Action:** All phases completed.

**Verify:**
- [ ] `workflow_mode` updated to `"completed"`
- [ ] Final report includes:
  - Project summary
  - Per-phase completion status
  - Key decisions summary (from `state.decisions`)
  - Verification evidence summary
  - Remaining issues / follow-up suggestions (if any)

**Final state.json checks:**
- [ ] `workflow_mode` = `"completed"`
- [ ] All phases `lifecycle` = `"accepted"`
- [ ] All tasks `lifecycle` = `"accepted"`
- [ ] `evidence` contains entries for all verified tasks
- [ ] No orphaned `blocked` or `failed` tasks remain

---

## Integration Test Scenarios

### T32 — Rework Propagation

**Setup:**
- Phase with 3 tasks:
  - A (id: `1.1`, level: L1, requires: [])
  - B (id: `1.2`, requires: [{ kind: "task", id: "1.1", gate: "checkpoint" }])
  - C (id: `1.3`, requires: [{ kind: "task", id: "1.2", gate: "accepted" }])

**Execution sequence:**
1. A executes → `checkpointed`
2. B starts (checkpoint gate on A is satisfied)
3. B executes → `checkpointed`
4. Phase batch review runs (L1 review)
5. Reviewer finds A has **Critical** issue + `contract_changed: true`

**Expected state after rework trigger:**
- [ ] A → `lifecycle: "rework"` (or reset to `pending` for re-execution)
- [ ] B → `lifecycle: "needs_revalidation"` (direct dependent of A, contract changed)
- [ ] B → `evidence_refs: []` (cleared)
- [ ] C → unaffected (C depends on B via `accepted` gate; B has not been accepted, so C was never started)

**Verify propagation logic:**
- [ ] `propagateInvalidation(phase, '1.1', true)` called
- [ ] Transitive invalidation: if B were accepted and had its own dependents, those would also get `needs_revalidation`
- [ ] Non-contract changes (`contract_changed: false`) do NOT propagate

**After rework:**
- [ ] A re-executes with fix direction
- [ ] B re-executes (needs_revalidation → pending → running)
- [ ] C remains blocked until B reaches `accepted`
- [ ] Re-review triggered after rework tasks complete

---

### T33 — Review Reclassification

**Setup:**
- Task `1.1`: `level: "L1"`, `name: "Implement auth token validation"`
- Task executes successfully

**Trigger:**
- Executor result: `contract_changed: true`
- Task name contains `auth` (matches `SENSITIVE_KEYWORDS` regex)

**Expected:**
- [ ] `reclassifyReviewLevel(task, executorResult)` returns `"L2"`
- [ ] Task review level upgraded from L1 → L2
- [ ] Immediate independent review triggered (not deferred to batch)
- [ ] Downstream dependencies NOT released until L2 review passes

**Edge cases:**
- [ ] `contract_changed: true` but task name is "Update button styles" → stays L1
- [ ] `contract_changed: false` but task name has "auth" → stays L1 (both conditions required)
- [ ] Executor includes `[LEVEL-UP]` in decisions → upgraded to L2 regardless of task name
- [ ] Task already L2 → stays L2 (never downgrade)

---

### T34 — Debugger Trigger

**Setup:**
- Task `1.1` with `retry_count: 0`
- Executor fails 3 consecutive times (same error fingerprint or no new hypothesis)

**Execution sequence:**
1. Executor attempt 1 → `outcome: "failed"`, `retry_count` → 1
2. Executor attempt 2 → `outcome: "failed"`, `retry_count` → 2
3. Executor attempt 3 → `outcome: "failed"`, `retry_count` → 3 (hits MAX_RETRY)

**Expected after 3rd failure:**
- [ ] `gsd-debugger` sub-agent dispatched with:
  - Error messages from all 3 attempts
  - Executor fix attempt records
  - Relevant code paths
- [ ] Debugger returns structured result:
  ```json
  {
    "root_cause": "...",
    "fix_direction": "...",
    "confidence": "high|medium|low"
  }
  ```

**After debugger returns:**
- [ ] If fix direction viable → executor re-dispatched with fix direction as additional context
- [ ] If fix direction not viable → task marked `lifecycle: "failed"`
- [ ] If task critical → phase marked `lifecycle: "failed"`

**Verify state.json:**
- [ ] `retry_count` accurately reflects attempt count
- [ ] Debugger invocation recorded (evidence or decision)
- [ ] Failed task does not block scheduling of unrelated tasks
