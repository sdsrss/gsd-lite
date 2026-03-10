# E2E Test Plan — Workflow Mode Transitions

## Overview

验证 `workflow_mode` 状态转换的自动触发逻辑。e2e-resume-matrix.md 覆盖了"已经在某模式下的 resume 行为"，本测试覆盖"如何从一个模式自动转换到另一个模式"。

---

## Transition Map

```
executing_task ──┬──→ reviewing_task     (L2 task checkpointed)
                 ├──→ reviewing_phase    (all L1 tasks checkpointed)
                 ├──→ awaiting_clear     (context < 40%)
                 ├──→ awaiting_user      (task blocked, no decision match)
                 └──→ completed          (all phases accepted)

reviewing_task ──┬──→ executing_task     (L2 review passed)
                 └──→ executing_task     (L2 review failed → rework)

reviewing_phase ─┬──→ executing_task     (batch review passed → phase handoff)
                 └──→ executing_task     (batch review failed → rework tasks)
```

---

## Test Case 1: `executing_task` → `reviewing_task` (L2 Checkpoint)

**Setup state.json:**
```json
{
  "workflow_mode": "executing_task",
  "current_phase": 1,
  "phases": [{
    "id": 1, "lifecycle": "active",
    "todo": [
      { "id": "1.1", "name": "Auth module", "lifecycle": "running", "level": "L2", "requires": [], "retry_count": 0, "review_required": true }
    ]
  }]
}
```

**Trigger:** Executor 返回 `{ outcome: "checkpointed", task_id: "1.1", checkpoint_commit: "abc123", files_changed: ["src/auth.js"] }`

**Verify:**
- [ ] Task 1.1 lifecycle → `"checkpointed"`
- [ ] Task 1.1 level = `"L2"` → 触发即时审查
- [ ] `workflow_mode` 变为 `"reviewing_task"`
- [ ] `current_review` 设置为: `{ scope: "task", scope_id: "1.1", stage: "spec" }`
- [ ] `gsd-reviewer` 被派发，scope = task, 包含 checkpoint info
- [ ] 不等到 phase 结束才审查（L2 = 即时审查）

---

## Test Case 2: `executing_task` → `reviewing_phase` (All L1 Checkpointed)

**Setup state.json:**
```json
{
  "workflow_mode": "executing_task",
  "current_phase": 1,
  "phases": [{
    "id": 1, "lifecycle": "active",
    "todo": [
      { "id": "1.1", "name": "Init", "lifecycle": "accepted", "level": "L0", "requires": [], "retry_count": 0 },
      { "id": "1.2", "name": "Core logic", "lifecycle": "checkpointed", "level": "L1", "requires": [], "retry_count": 0, "checkpoint_commit": "aaa111" },
      { "id": "1.3", "name": "Tests", "lifecycle": "running", "level": "L1", "requires": [{"kind":"task","id":"1.2","gate":"checkpoint"}], "retry_count": 0 }
    ]
  }]
}
```

**Trigger:** Executor 返回 Task 1.3 `{ outcome: "checkpointed", checkpoint_commit: "bbb222" }`

**Verify:**
- [ ] Task 1.3 lifecycle → `"checkpointed"`
- [ ] `selectRunnableTask` 检查: 无 pending/needs_revalidation task → 无可运行任务
- [ ] 所有 L1 tasks (1.2, 1.3) 都是 `checkpointed` → 触发批量审查
- [ ] `workflow_mode` 变为 `"reviewing_phase"`
- [ ] `current_review` = `{ scope: "phase", scope_id: 1 }`
- [ ] `gsd-reviewer` 被派发，scope = phase, 包含所有 L1 tasks

**Edge case — L0 task:**
- [ ] Task 1.1 (L0, accepted) 不参与批量审查
- [ ] L0 task 不阻塞批量审查触发

---

## Test Case 3: `reviewing_task` → `executing_task` (L2 Review Passed)

**Setup:**
- `workflow_mode: "reviewing_task"`
- `current_review: { scope: "task", scope_id: "1.1", stage: "spec" }`
- Task 1.1: `lifecycle: "checkpointed"`, `level: "L2"`

**Trigger:** Reviewer 返回:
```json
{
  "scope": "task",
  "scope_id": "1.1",
  "findings": [],
  "verdict": "accepted"
}
```

**Verify:**
- [ ] Task 1.1 lifecycle → `"accepted"`
- [ ] `current_review` 清除 → `null`
- [ ] `workflow_mode` 变为 `"executing_task"`
- [ ] 下游依赖被解锁（依赖 1.1 accepted gate 的 task 现在可运行）
- [ ] 调度继续选择下一个 runnable task

---

## Test Case 4: `reviewing_task` → Rework (L2 Review Failed)

**Setup:**
- `workflow_mode: "reviewing_task"`
- Task 1.1: `lifecycle: "checkpointed"`, `level: "L2"`
- Task 1.2: `lifecycle: "pending"`, depends on 1.1 with `gate: "accepted"`

**Trigger:** Reviewer 返回:
```json
{
  "scope": "task",
  "scope_id": "1.1",
  "findings": [
    { "severity": "Critical", "description": "SQL injection vulnerability", "location": "src/auth.js:42" }
  ],
  "verdict": "rework_required"
}
```

**Verify:**
- [ ] Task 1.1 lifecycle 变为 `"rework"` 或回退到 `"pending"`
- [ ] Task 1.1 `retry_count` 递增
- [ ] `current_review` 清除
- [ ] `workflow_mode` 变为 `"executing_task"`
- [ ] Executor 被重新派发，包含 fix direction（Critical finding 信息）
- [ ] Task 1.2 仍然 blocked（1.1 未 accepted）
- [ ] 如果 `contract_changed: true` → `propagateInvalidation` 被调用

---

## Test Case 5: `reviewing_phase` → `executing_task` (Batch Review Passed)

**Setup:**
- `workflow_mode: "reviewing_phase"`
- `current_review: { scope: "phase", scope_id: 1 }`
- Phase 1: 3 个 L1 tasks 都是 `checkpointed`

**Trigger:** Reviewer 返回:
```json
{
  "scope": "phase",
  "scope_id": 1,
  "findings": [
    { "severity": "Minor", "description": "Could use better variable names", "location": "src/utils.js:10" }
  ],
  "verdict": "accepted"
}
```

**Verify:**
- [ ] 所有 3 个 L1 tasks lifecycle → `"accepted"`
- [ ] `current_review` 清除
- [ ] Phase handoff gate 检查:
  - 所有 tasks accepted ✓
  - No critical issues ✓
- [ ] Phase 1 lifecycle → `"accepted"`
- [ ] `current_phase` → 2
- [ ] Evidence 裁剪触发
- [ ] `workflow_mode` 变为 `"executing_task"`
- [ ] 调度从 Phase 2 第一个 runnable task 开始

---

## Test Case 6: `reviewing_phase` → Rework (Batch Review Failed)

**Setup:**
- `workflow_mode: "reviewing_phase"`
- Phase 1: tasks A(1.1), B(1.2→depends A), C(1.3→depends B), 全部 `checkpointed`

**Trigger:** Reviewer 返回:
```json
{
  "scope": "phase",
  "scope_id": 1,
  "findings": [
    { "severity": "Critical", "description": "API contract violation", "location": "src/api.js:15", "task_id": "1.1" }
  ],
  "verdict": "rework_required",
  "rework_tasks": ["1.1"]
}
```

**Verify:**
- [ ] Task 1.1 lifecycle 变为 rework/pending
- [ ] `propagateInvalidation(phase, "1.1", true)` 被调用（Critical = contract change assumed）
- [ ] Task 1.2 lifecycle → `"needs_revalidation"`, evidence_refs 清空
- [ ] Task 1.3 lifecycle → `"needs_revalidation"`, evidence_refs 清空（transitive）
- [ ] `current_review` 清除
- [ ] `workflow_mode` 变为 `"executing_task"`
- [ ] 调度: Task 1.1 被重新执行（含 fix direction）
- [ ] 完成后 1.2, 1.3 按顺序重新执行
- [ ] 所有 rework task 完成后 → 再次触发 batch review

---

## Test Case 7: `executing_task` → `awaiting_user` (Blocked with No Match)

**Setup:**
- `workflow_mode: "executing_task"`
- All pending tasks have unsatisfied dependencies or are blocked

**Trigger:** `selectRunnableTask` 返回 `{ mode: "awaiting_user", blockers: [...] }`

**Verify:**
- [ ] 编排器先检查 `state.decisions` 是否能 auto-unblock
- [ ] 无匹配 → `workflow_mode` 变为 `"awaiting_user"`
- [ ] Blocked tasks 和原因展示给用户
- [ ] 不执行任何代码
- [ ] 等待用户输入

---

## Test Case 8: `executing_task` → `completed` (All Done)

**Setup:**
```json
{
  "workflow_mode": "executing_task",
  "current_phase": 3,
  "total_phases": 3,
  "phases": [
    { "id": 1, "lifecycle": "accepted" },
    { "id": 2, "lifecycle": "accepted" },
    { "id": 3, "lifecycle": "active", "todo": [
      { "id": "3.1", "lifecycle": "accepted" },
      { "id": "3.2", "lifecycle": "accepted" }
    ] }
  ]
}
```

**Trigger:** Phase 3 handoff gate 通过 → Phase 3 accepted

**Verify:**
- [ ] Phase 3 lifecycle → `"accepted"`
- [ ] 所有 phases 都是 `"accepted"`
- [ ] `current_phase` 不再递增（已是最后 phase）
- [ ] `workflow_mode` 变为 `"completed"`
- [ ] 最终报告生成:
  - 项目摘要
  - 各 phase 完成状态
  - 关键 decisions 总结
  - Evidence 摘要
- [ ] 不再派发任何子代理

---

## Test Case 9: L1→L2 Reclassification 触发即时审查

**Setup:**
- `workflow_mode: "executing_task"`
- Task 1.2: `level: "L1"`, `name: "Implement auth token validation"`
- 正常执行中

**Trigger:** Executor 返回:
```json
{
  "task_id": "1.2",
  "outcome": "checkpointed",
  "contract_changed": true,
  "decisions": []
}
```

**Verify:**
- [ ] `reclassifyReviewLevel(task, result)` 被调用
- [ ] `contract_changed: true` + task name contains "auth" → 返回 `"L2"`
- [ ] Task 1.2 level 更新为 `"L2"`
- [ ] 不走 batch review → 即时触发 L2 单任务审查
- [ ] `workflow_mode` 变为 `"reviewing_task"`
- [ ] `current_review` = `{ scope: "task", scope_id: "1.2" }`

---

## Test Case 10: `selectRunnableTask` → `trigger_review`

**Setup:**
- Phase 1 所有 task 都是 `checkpointed`（无 pending/needs_revalidation）
- 不满足"全部 accepted"条件

**Action:** `selectRunnableTask(phase, state)`

**Verify:**
- [ ] 返回 `{ mode: "trigger_review" }`
- [ ] 编排器检查: L2 tasks → 逐个审查; L1 tasks → 批量审查
- [ ] 正确设置 `workflow_mode` 和 `current_review`

---

## Test Case 11: 3次失败 → Debugger → Rework

**Setup:**
- Task 1.1 连续失败 3 次

**Trigger:** 第 3 次 executor 返回 `{ outcome: "failed" }`

**Verify:**
- [ ] `retry_count` = 3（达到 MAX_RETRY）
- [ ] `gsd-debugger` 被派发（不是 executor）
- [ ] Debugger 返回 `{ root_cause, fix_direction, confidence }`
- [ ] If viable → executor 重新派发（带 fix direction context）
- [ ] If not viable → task lifecycle = `"failed"`
- [ ] `workflow_mode` 保持 `"executing_task"`（其他 task 可能还能运行）
- [ ] 如果 failed task 是 critical → phase lifecycle = `"failed"` → `workflow_mode = "failed"`
