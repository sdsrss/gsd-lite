# E2E Test Plan — Resume Test Matrix

## All 11 `workflow_mode` Resume Scenarios

Each scenario covers: how to set up the state, what `/gsd:resume` should do, and how to verify correctness.

---

| # | workflow_mode | Expected Behavior | How to Set Up | How to Verify |
|---|---|---|---|---|
| 1 | `executing_task` | Continue task scheduling from `current_phase` + `current_task` | Run `/gsd:start`, let execution begin, then `/clear` + manually set `workflow_mode: "executing_task"` in state.json | Observe: next runnable task selected, executor dispatched, execution loop resumes |
| 2 | `reviewing_task` | Resume L2 single-task review | Set `workflow_mode: "reviewing_task"`, set `current_review: { scope: "task", scope_id: "1.2", stage: "spec" }`, ensure task `1.2` is `checkpointed` | Observe: `gsd-reviewer` dispatched with scope=task for task 1.2, review completes, scheduling resumes |
| 3 | `reviewing_phase` | Resume L1 batch phase review | Set `workflow_mode: "reviewing_phase"`, set `current_review: { scope: "phase", scope_id: 1 }`, ensure all L1 tasks in phase 1 are `checkpointed` | Observe: `gsd-reviewer` dispatched with scope=phase, batch review of all L1 tasks, results processed |
| 4 | `awaiting_clear` | Continue execution (context was cleared) | Let context drop < 40% during execution, or manually set `workflow_mode: "awaiting_clear"` | Observe: `workflow_mode` changes to `executing_task`, scheduling resumes from `current_phase`/`current_task` |
| 5 | `awaiting_user` | Show blocked issues, wait for user input | Set `workflow_mode: "awaiting_user"`, set task(s) with `lifecycle: "blocked"` and `blocked_reason` | Observe: blocked tasks displayed with reasons, no code execution, waits for user decision |
| 6 | `paused_by_user` | Ask user whether to continue | Set `workflow_mode: "paused_by_user"` (simulating `/gsd:stop`) | Observe: progress summary shown, user asked "Continue?", user confirms → resumes, user declines → stays paused |
| 7 | `reconcile_workspace` | Show workspace diff, ask user to reconcile | Set `workflow_mode: "reconcile_workspace"`, or change `git_head` in state.json to an old commit | Observe: diff displayed (old HEAD vs current HEAD), user given 3 options (accept/revert/manual), no auto code execution |
| 8 | `replan_required` | Stop execution, show plan version mismatch | Set `workflow_mode: "replan_required"`, or manually edit `phases/*.md` and change `plan_version` | Observe: specific changes shown, user given 3 options (confirm compat/replan/revert), execution stopped |
| 9 | `research_refresh_needed` | Refresh research first, then resume | Set `workflow_mode: "research_refresh_needed"`, set `research.expires_at` to a past date | Observe: expired research info shown, `gsd-researcher` dispatched, decision changes processed, affected tasks invalidated, execution resumes |
| 10 | `completed` | Inform project is completed | Set `workflow_mode: "completed"`, all phases `lifecycle: "accepted"` | Observe: final report displayed, user told to start new project |
| 11 | `failed` | Inform failure, show reason and options | Set `workflow_mode: "failed"`, at least one task/phase with `lifecycle: "failed"` | Observe: failure info displayed (phase/task/reason/retries), user given 3 options (retry/skip/replan) |

---

## Detailed Test Procedures

### 1. `executing_task`

**Setup state.json:**
```json
{
  "workflow_mode": "executing_task",
  "current_phase": 1,
  "current_task": "1.2",
  "phases": [{
    "id": 1, "lifecycle": "active",
    "todo": [
      { "id": "1.1", "lifecycle": "accepted", "requires": [], "retry_count": 0 },
      { "id": "1.2", "lifecycle": "running", "requires": [{"kind":"task","id":"1.1","gate":"accepted"}], "retry_count": 0 },
      { "id": "1.3", "lifecycle": "pending", "requires": [{"kind":"task","id":"1.2","gate":"checkpoint"}], "retry_count": 0 }
    ]
  }]
}
```

**Verify:**
- [ ] Pre-flight checks pass (git HEAD, plan version, research expiry, workspace clean)
- [ ] Task 1.2 in `running` state → treated as interrupted, re-dispatched
- [ ] If 1.2 were `checkpointed` → next runnable task selected (1.3 if gate met)
- [ ] Executor context built correctly for resumed task
- [ ] Progress panel displayed with accurate counts

---

### 2. `reviewing_task`

**Setup state.json:**
```json
{
  "workflow_mode": "reviewing_task",
  "current_review": { "scope": "task", "scope_id": "1.2", "stage": "spec" },
  "current_phase": 1,
  "phases": [{
    "id": 1, "lifecycle": "active",
    "todo": [
      { "id": "1.1", "lifecycle": "accepted", "requires": [] },
      { "id": "1.2", "lifecycle": "checkpointed", "level": "L2", "requires": [{"kind":"task","id":"1.1","gate":"accepted"}], "checkpoint_commit": "abc123", "files_changed": ["src/auth.js"] }
    ]
  }]
}
```

**Verify:**
- [ ] `gsd-reviewer` dispatched with task 1.2 checkpoint info
- [ ] Review stage (`spec`) passed to reviewer
- [ ] Review passes → task 1.2 `lifecycle` → `accepted`
- [ ] Review fails with Critical → rework triggered
- [ ] After review, normal scheduling resumes

---

### 3. `reviewing_phase`

**Setup state.json:**
```json
{
  "workflow_mode": "reviewing_phase",
  "current_review": { "scope": "phase", "scope_id": 1 },
  "current_phase": 1,
  "phases": [{
    "id": 1, "lifecycle": "active",
    "todo": [
      { "id": "1.1", "lifecycle": "checkpointed", "level": "L1", "checkpoint_commit": "abc1" },
      { "id": "1.2", "lifecycle": "checkpointed", "level": "L1", "checkpoint_commit": "abc2" },
      { "id": "1.3", "lifecycle": "accepted", "level": "L0" }
    ]
  }]
}
```

**Verify:**
- [ ] All L1 tasks (1.1, 1.2) included in batch review
- [ ] L0 task (1.3) already accepted, not re-reviewed
- [ ] All pass → tasks accepted, phase handoff gate checked
- [ ] Critical found → affected tasks reworked, invalidation propagated
- [ ] After batch review completes → phase handoff or continued execution

---

### 4. `awaiting_clear`

**Setup:** Let context naturally exhaust, or manually set:
```json
{ "workflow_mode": "awaiting_clear", "current_phase": 2, "current_task": "2.3" }
```

**Verify:**
- [ ] No special prompts (unlike `awaiting_user`)
- [ ] `workflow_mode` switched to `executing_task`
- [ ] Scheduling resumes from phase 2, task 2.3
- [ ] No tasks re-executed
- [ ] All prior state preserved

---

### 5. `awaiting_user`

**Setup state.json:**
```json
{
  "workflow_mode": "awaiting_user",
  "current_phase": 1,
  "phases": [{
    "id": 1, "lifecycle": "active",
    "todo": [
      { "id": "1.1", "lifecycle": "accepted" },
      { "id": "1.2", "lifecycle": "blocked", "blocked_reason": "Need database credentials", "unblock_condition": "User provides DB connection string" },
      { "id": "1.3", "lifecycle": "blocked", "blocked_reason": "API endpoint unclear", "unblock_condition": "User clarifies REST vs GraphQL" }
    ]
  }],
  "decisions": [
    { "id": "d1", "task": "1.1", "summary": "Use PostgreSQL", "phase": 1 }
  ]
}
```

**Verify:**
- [ ] No code execution happens automatically
- [ ] Blocked tasks listed with `blocked_reason` and `unblock_condition`
- [ ] Orchestrator checks `decisions` array first (d1 about PostgreSQL might partially answer 1.2)
- [ ] If decisions can answer → auto-unblock, resume without user input
- [ ] If not → user prompted for decisions
- [ ] User provides answer → tasks unblocked → `workflow_mode = executing_task` → scheduling resumes

---

### 6. `paused_by_user`

**Setup state.json:**
```json
{
  "workflow_mode": "paused_by_user",
  "current_phase": 2,
  "current_task": "2.1",
  "phases": [
    { "id": 1, "lifecycle": "accepted", "done": 5, "tasks": 5 },
    { "id": 2, "lifecycle": "active", "done": 0, "tasks": 4 }
  ]
}
```

**Verify:**
- [ ] Progress summary displayed:
  - Phase 1: 5/5 done (accepted)
  - Phase 2: 0/4 done (active)
- [ ] User asked: "Project is paused. Continue execution?"
- [ ] User says yes → `workflow_mode = executing_task`, scheduling resumes from 2.1
- [ ] User says no → state unchanged, remains paused
- [ ] No code execution before user confirms

---

### 7. `reconcile_workspace`

**Setup:** Change git HEAD after state was saved:
```bash
# Save state with git_head pointing to commit A
# Then make new commits B, C
# Or: manually set state.json git_head to an older commit
```

**Verify:**
- [ ] No code execution happens automatically
- [ ] Diff displayed:
  - Old HEAD (from state.json) vs current HEAD
  - `git log --oneline <old>..<new>` shown
  - `git diff <old>..HEAD --stat` shown
- [ ] Three options presented:
  - a) Accept current state, update `git_head`, continue
  - b) Revert to recorded HEAD
  - c) Manual reconcile, re-run `/gsd:resume` later
- [ ] Option (a) → `git_head` updated, `workflow_mode` restored to prior mode, execution resumes
- [ ] Option (b) → git operations to revert (with user confirmation)
- [ ] Option (c) → state unchanged

---

### 8. `replan_required`

**Setup:** Modify `phases/phase-1.md` content, or set `plan_version` to a mismatched value:
```json
{ "workflow_mode": "replan_required", "plan_version": 1 }
```
Then edit `phases/phase-1.md`.

**Verify:**
- [ ] Execution stopped completely
- [ ] Specific changes shown (which files modified)
- [ ] Three options:
  - a) Confirm changes are compatible, update `plan_version`, continue
  - b) Replan (go back to `/gsd:start` or `/gsd:prd` planning stage)
  - c) Revert file changes
- [ ] No automatic code execution under any option until user decides
- [ ] Option (a) → `plan_version` incremented, `workflow_mode` restored, execution resumes
- [ ] Option (b) → user redirected to planning flow

---

### 9. `research_refresh_needed`

**Setup state.json:**
```json
{
  "workflow_mode": "research_refresh_needed",
  "research": {
    "decision_index": {
      "d_react_version": { "summary": "Use React 18", "volatility": "medium", "expires_at": "2025-01-01T00:00:00Z" },
      "d_state_mgmt": { "summary": "Use Zustand for state", "volatility": "low", "expires_at": "2025-06-01T00:00:00Z" }
    }
  },
  "phases": [{
    "id": 1, "lifecycle": "active",
    "todo": [
      { "id": "1.1", "lifecycle": "pending", "research_basis": ["d_react_version"] },
      { "id": "1.2", "lifecycle": "accepted", "research_basis": ["d_state_mgmt"], "evidence_refs": ["ev:1"] }
    ]
  }]
}
```

**Verify:**
- [ ] Expired research info displayed (decision summaries + expiry dates)
- [ ] Affected tasks listed (those referencing expired decisions)
- [ ] `gsd-researcher` dispatched for refresh
- [ ] After refresh, 4 rules applied:
  - Same ID + same summary → update metadata, keep task lifecycle
  - Same ID + changed summary → task `needs_revalidation`, evidence cleared
  - Old ID missing → task `needs_revalidation` + warning
  - Brand new ID → added to index, no task impact
- [ ] state.json updated with new research data
- [ ] `workflow_mode` changed to `executing_task`, scheduling resumes

---

### 10. `completed`

**Setup state.json:**
```json
{
  "workflow_mode": "completed",
  "project": "My Project",
  "current_phase": 3,
  "total_phases": 3,
  "phases": [
    { "id": 1, "lifecycle": "accepted", "done": 5, "tasks": 5 },
    { "id": 2, "lifecycle": "accepted", "done": 4, "tasks": 4 },
    { "id": 3, "lifecycle": "accepted", "done": 3, "tasks": 3 }
  ],
  "decisions": [
    { "id": "d1", "summary": "Use TypeScript" },
    { "id": "d2", "summary": "REST over GraphQL" }
  ]
}
```

**Verify:**
- [ ] Final completion report displayed:
  - Project name
  - Total phases (3/3 complete)
  - Total tasks (12/12 complete)
  - Key decisions summarized
  - Completion timestamp
- [ ] User informed: "Project completed. Run /gsd:start or /gsd:prd for a new project."
- [ ] No execution, no state changes

---

### 11. `failed`

**Setup state.json:**
```json
{
  "workflow_mode": "failed",
  "current_phase": 2,
  "phases": [
    { "id": 1, "lifecycle": "accepted" },
    {
      "id": 2, "lifecycle": "failed",
      "todo": [
        { "id": "2.1", "lifecycle": "accepted" },
        { "id": "2.2", "lifecycle": "failed", "blocked_reason": "Cannot connect to external API after 3 retries", "retry_count": 3 },
        { "id": "2.3", "lifecycle": "pending", "requires": [{"kind":"task","id":"2.2","gate":"accepted"}] }
      ]
    }
  ]
}
```

**Verify:**
- [ ] Failure info displayed:
  - Failed phase: Phase 2
  - Failed task: 2.2
  - Reason: "Cannot connect to external API after 3 retries"
  - Retry history: 3 attempts
- [ ] Three options presented:
  - a) Retry the failed task (reset retry_count, re-dispatch)
  - b) Skip failed task, continue with remaining tasks
  - c) Replan the project
- [ ] Option (a) → task 2.2 `lifecycle` reset, `retry_count` reset, executor re-dispatched
- [ ] Option (b) → task 2.2 skipped, task 2.3 assessed (may be blocked since 2.2 not accepted)
- [ ] Option (c) → user redirected to planning flow
- [ ] No automatic code execution before user selects option

---

## Pre-flight Check Override Matrix

The following table shows how pre-flight checks in STEP 2 of resume can override the saved `workflow_mode`:

| Saved workflow_mode | Git HEAD mismatch | Plan version mismatch | Research expired | Workspace conflict | Effective workflow_mode |
|---|---|---|---|---|---|
| `executing_task` | YES | - | - | - | `reconcile_workspace` |
| `executing_task` | NO | YES | - | - | `replan_required` |
| `executing_task` | NO | NO | YES | - | `research_refresh_needed` |
| `executing_task` | NO | NO | NO | YES | `awaiting_user` |
| `executing_task` | NO | NO | NO | NO | `executing_task` (unchanged) |
| `awaiting_clear` | YES | - | - | - | `reconcile_workspace` |
| `reviewing_phase` | NO | YES | - | - | `replan_required` |
| `completed` | any | any | any | any | `completed` (no override) |
| `failed` | any | any | any | any | `failed` (no override) |

**Key rule:** First check that hits overrides; checks do not accumulate. Priority order: Git HEAD > Plan version > Research expiry > Workspace conflict.

**Note:** Whether `completed` and `failed` modes bypass pre-flight checks is implementation-dependent. Verify actual behavior matches design intent.
