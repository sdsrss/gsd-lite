# E2E Test Plan — PRD + Context Recovery

## Flow: `/gsd:prd` input → execute → `awaiting_clear` → `/clear` + `/gsd:resume` → completion

### Prerequisites

- Clean git repo with at least one commit
- Node.js available
- No existing `.gsd/` directory (or remove it first)

---

## Test Case 1: PRD with File Path Input

**Action:** `/gsd:prd docs/requirements.md`

### 1a. Input Parsing
- [ ] Orchestrator detects input contains `/` or `.` and checks if file exists
- [ ] File exists → reads file content using Read tool
- [ ] File does not exist → error message displayed, flow stops

### 1b. Content Extraction
- [ ] Key requirements extracted from file and presented as structured list
- [ ] Each requirement has priority annotation
- [ ] User asked to confirm understanding: "Are these the key requirements?"

### 1c. Supplementary Questions
- [ ] Ambiguous points and missing information identified
- [ ] Questions presented with options (recommended option marked)
- [ ] User can answer or provide custom input
- [ ] Follow-up questions until requirements are clear

### 1d. Remainder of Flow
- [ ] Research decision logic executes (same as `/gsd:start`)
- [ ] Plan generation, self-review, user confirmation (same as `/gsd:start`)
- [ ] `.gsd/` created with `state.json`, `plan.md`, `phases/*.md`
- [ ] Execution loop begins

---

## Test Case 2: PRD with Text Description Input

**Action:** `/gsd:prd "Implement user authentication with JWT, support OAuth2 providers"`

### 2a. Input Parsing
- [ ] Orchestrator detects input is text (no file path indicators, or file doesn't exist)
- [ ] Text used directly as requirements description

### 2b. Codebase Analysis
- [ ] Orchestrator analyzes project structure, package.json, existing code
- [ ] Tech stack and existing conventions identified
- [ ] Relevant code areas located

### 2c. Content Extraction
- [ ] Requirements extracted from text description
- [ ] For short descriptions, orchestrator asks clarifying questions
- [ ] Structured requirements list presented to user for confirmation

### 2d. Flow Continues
- [ ] Same as file path input from this point forward
- [ ] state.json correctly initialized

---

## Test Case 3: `awaiting_clear` State Save

**Trigger:** Context health drops below 40% during execution.

### 3a. State Save Completeness
- [ ] `workflow_mode` changed to `"awaiting_clear"`
- [ ] `current_phase` reflects the active phase at save time
- [ ] `current_task` reflects the last task being processed (or null if between tasks)
- [ ] All task lifecycles accurately reflect their state at save time:
  - Completed tasks → `accepted` or `checkpointed`
  - In-progress task → `running` or `checkpointed` (if checkpoint commit made)
  - Not-started tasks → `pending`
  - Blocked tasks → `blocked` with `blocked_reason`
- [ ] `decisions` array contains all decisions made up to save point
- [ ] `evidence` map contains all evidence collected up to save point
- [ ] `git_head` matches current HEAD at save time
- [ ] `context.remaining_percentage` reflects the percentage at save time
- [ ] `research` data preserved (if research was done)
- [ ] `plan_version` unchanged

### 3b. User Notification
- [ ] Message displayed: context remaining < 40%, progress saved
- [ ] Instructions given: run `/clear` then `/gsd:resume` to continue
- [ ] Execution stops immediately (no further sub-agent dispatches)

### 3c. state.json Integrity
- [ ] File is valid JSON (not truncated or corrupted)
- [ ] All canonical fields present
- [ ] No derived fields stored
- [ ] Atomic write completed (not a partial write)

---

## Test Case 4: `/clear` + `/gsd:resume` — No State Loss

**Action:** After `awaiting_clear`, user runs `/clear` then `/gsd:resume`.

### 4a. Resume Reads State
- [ ] `/gsd:resume` reads `.gsd/state.json`
- [ ] All canonical fields successfully parsed
- [ ] `workflow_mode` is `"awaiting_clear"`

### 4b. Pre-flight Checks
- [ ] Git HEAD check: current HEAD compared to `state.json.git_head`
  - If match → proceed
  - If mismatch → `reconcile_workspace` (test with matching HEAD first)
- [ ] Plan version check: `plan.md` / `phases/*.md` checksums vs `plan_version`
  - No changes → proceed
- [ ] Research expiry check: `research.expires_at` vs current time
  - Not expired → proceed
- [ ] Workspace conflict check: `git status` clean
  - Clean → proceed

### 4c. State Preservation Verification

**Critical — verify zero data loss across `/clear` boundary:**

- [ ] `project` name unchanged
- [ ] `current_phase` matches pre-clear value
- [ ] `current_task` matches pre-clear value
- [ ] `total_phases` matches pre-clear value
- [ ] Task lifecycles unchanged:
  - Count of `accepted` tasks matches
  - Count of `checkpointed` tasks matches
  - Count of `pending` tasks matches
  - Count of `blocked` tasks matches
  - Count of `needs_revalidation` tasks matches
- [ ] `decisions` array length unchanged; all entries preserved
- [ ] `evidence` map size unchanged; all entries preserved
- [ ] `research.decision_index` unchanged (all decision IDs and summaries match)
- [ ] Phase `phase_handoff` data unchanged for each phase
- [ ] `plan_version` unchanged
- [ ] Task `requires` dependencies unchanged
- [ ] Task `retry_count` values unchanged
- [ ] Task `checkpoint_commit` values unchanged
- [ ] Task `evidence_refs` arrays unchanged

### 4d. Execution Resumes Correctly

- [ ] `workflow_mode` changed from `"awaiting_clear"` to `"executing_task"`
- [ ] Scheduling picks up from correct position:
  - If `current_task` was `running` → re-dispatch executor for that task
  - If `current_task` was `checkpointed` → proceed to review or next task
  - If `current_task` was `null` → select next runnable task
- [ ] Executor context correctly built (6-field protocol) for resumed task
- [ ] No tasks are re-executed that were already `accepted`
- [ ] No evidence is regenerated for already-verified tasks
- [ ] Execution continues to completion

### 4e. Progress Panel Displayed
- [ ] After resume, progress panel shows:
  ```
  Project: {project}
  Mode: executing_task
  Progress: Phase {current_phase}/{total_phases} | Task {done}/{tasks}
  Current: {current_task} — {task_name}
  Next: {derived next action}
  ```
- [ ] All values derived from canonical fields (not cached/derived fields)

---

## Test Case 5: Multiple `/clear` + `/gsd:resume` Cycles

**Scenario:** Context exhaustion happens multiple times during a long project.

### 5a. First Cycle
- [ ] Start → execute some tasks → `awaiting_clear` → `/clear` → `/gsd:resume` → continues

### 5b. Second Cycle
- [ ] Execution continues → more tasks → `awaiting_clear` again → `/clear` → `/gsd:resume`
- [ ] State from first cycle fully preserved
- [ ] Tasks completed in first cycle still `accepted`
- [ ] Decisions from all cycles accumulated

### 5c. Third+ Cycles
- [ ] Pattern continues without cumulative data loss
- [ ] Evidence pruning works correctly across cycles (old phase evidence archived)
- [ ] Final completion produces correct report covering all work done across all cycles

---

## Test Case 6: Edge Cases

### 6a. `/gsd:resume` Without Prior `/clear`
- [ ] If context is not exhausted but user runs `/gsd:resume`:
  - State loaded
  - Pre-flight checks run
  - Resumes based on `workflow_mode` (could be `executing_task`, not necessarily `awaiting_clear`)

### 6b. `/gsd:resume` With Corrupted state.json
- [ ] JSON parse error → user informed, execution stops
- [ ] Partial/truncated file → user informed, execution stops

### 6c. `/gsd:resume` When `.gsd/` Doesn't Exist
- [ ] Error: "No GSD project state found, please run /gsd:start or /gsd:prd"

### 6d. Context Exhaustion During Review
- [ ] If context < 40% during `gsd-reviewer` dispatch:
  - `current_review` saved with scope, scope_id, stage
  - `workflow_mode = awaiting_clear`
  - Resume correctly re-enters review (not re-executes task)

### 6e. Context Exhaustion Between Phases
- [ ] If context < 40% after phase handoff but before next phase starts:
  - `current_phase` already incremented
  - Resume starts next phase from scratch (first pending task)
