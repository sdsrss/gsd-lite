# E2E Test Plan — Research Refresh 4 Rules

## Overview

验证 `applyResearchRefresh(state, newResearch)` 的 4 条决策更新规则，以及对依赖任务的连锁影响。

---

## Background

研究刷新时，将新研究结果与现有 `state.research.decision_index` 对比：

| Rule | 条件 | 行为 |
|------|------|------|
| 1 | Same ID + same summary | 更新 metadata (expires_at 等)，task lifecycle 不变 |
| 2 | Same ID + changed summary | 替换决策，依赖 task → `needs_revalidation`，evidence 清除 |
| 3 | Old ID missing from new | 依赖 task → `needs_revalidation` + 警告 |
| 4 | Brand new ID | 加入 index，不影响现有 task |

---

## Test Case 1: Rule 1 — Same ID + Same Summary

**Setup state.json:**
```json
{
  "research": {
    "decision_index": {
      "d_react": { "summary": "Use React 18", "volatility": "medium", "expires_at": "2025-12-01T00:00:00Z" }
    }
  },
  "phases": [{
    "id": 1, "lifecycle": "active",
    "todo": [
      { "id": "1.1", "name": "Setup React", "lifecycle": "checkpointed", "research_basis": ["d_react"], "evidence_refs": ["ev:1"], "retry_count": 0 }
    ]
  }],
  "evidence": { "ev:1": { "scope": "task:1.1", "type": "test", "data": {} } }
}
```

**New research:**
```json
{
  "decision_index": {
    "d_react": { "summary": "Use React 18", "volatility": "medium", "expires_at": "2026-06-01T00:00:00Z" }
  }
}
```

**Verify:**
- [ ] `d_react.expires_at` 更新为 `"2026-06-01T00:00:00Z"`
- [ ] `d_react.summary` 保持 "Use React 18"
- [ ] Task 1.1 lifecycle 保持 `"checkpointed"`（不变）
- [ ] Task 1.1 `evidence_refs` 保持 `["ev:1"]`（不清除）
- [ ] `state.evidence["ev:1"]` 保留
- [ ] `warnings` 数组为空

---

## Test Case 2: Rule 2 — Same ID + Changed Summary

**Setup state.json:**
```json
{
  "research": {
    "decision_index": {
      "d_state_mgmt": { "summary": "Use Zustand for state", "volatility": "low", "expires_at": "2026-03-01T00:00:00Z" }
    }
  },
  "phases": [{
    "id": 1, "lifecycle": "active",
    "todo": [
      { "id": "1.1", "name": "State setup", "lifecycle": "accepted", "research_basis": ["d_state_mgmt"], "evidence_refs": ["ev:1", "ev:2"], "retry_count": 0 },
      { "id": "1.2", "name": "Unrelated task", "lifecycle": "accepted", "research_basis": [], "evidence_refs": ["ev:3"], "retry_count": 0 }
    ]
  }],
  "evidence": {
    "ev:1": { "scope": "task:1.1", "type": "test", "data": {} },
    "ev:2": { "scope": "task:1.1", "type": "lint", "data": {} },
    "ev:3": { "scope": "task:1.2", "type": "test", "data": {} }
  }
}
```

**New research:**
```json
{
  "decision_index": {
    "d_state_mgmt": { "summary": "Use Jotai for state (lighter weight)", "volatility": "low", "expires_at": "2026-09-01T00:00:00Z" }
  }
}
```

**Verify:**
- [ ] `d_state_mgmt.summary` 更新为 "Use Jotai for state (lighter weight)"
- [ ] Task 1.1 lifecycle 变为 `"needs_revalidation"`
- [ ] Task 1.1 `evidence_refs` 被清空为 `[]`
- [ ] Task 1.2 lifecycle 保持 `"accepted"`（不受影响，无 research_basis 引用）
- [ ] Task 1.2 `evidence_refs` 保持 `["ev:3"]`
- [ ] `warnings` 数组为空（Rule 2 不产生 warning）
- [ ] `state.evidence` 中的条目不受影响（evidence 本身不删除，只清除 task 的 refs）

### 2b. Lifecycle 不允许转换的情况

**Setup:** Task 1.1 lifecycle = `"pending"`

**Verify:**
- [ ] `"pending"` 不在 TASK_LIFECYCLE 中允许转换到 `"needs_revalidation"` 的源状态列表中
- [ ] Task 1.1 lifecycle 保持 `"pending"`
- [ ] 不报错（C-3 安全守卫：只转换允许的 lifecycle）

---

## Test Case 3: Rule 3 — Old ID Missing

**Setup state.json:**
```json
{
  "research": {
    "decision_index": {
      "d_auth_strategy": { "summary": "Use session-based auth", "volatility": "high", "expires_at": "2025-12-15T00:00:00Z" },
      "d_db": { "summary": "Use PostgreSQL", "volatility": "low", "expires_at": "2026-06-01T00:00:00Z" }
    }
  },
  "phases": [{
    "id": 1, "lifecycle": "active",
    "todo": [
      { "id": "1.1", "name": "Auth setup", "lifecycle": "checkpointed", "research_basis": ["d_auth_strategy"], "evidence_refs": ["ev:1"], "retry_count": 0 },
      { "id": "1.2", "name": "DB setup", "lifecycle": "accepted", "research_basis": ["d_db"], "evidence_refs": ["ev:2"], "retry_count": 0 },
      { "id": "1.3", "name": "No research", "lifecycle": "accepted", "research_basis": [], "evidence_refs": ["ev:3"], "retry_count": 0 }
    ]
  }]
}
```

**New research (d_auth_strategy 被删除):**
```json
{
  "decision_index": {
    "d_db": { "summary": "Use PostgreSQL", "volatility": "low", "expires_at": "2026-09-01T00:00:00Z" }
  }
}
```

**Verify:**
- [ ] Task 1.1 lifecycle 变为 `"needs_revalidation"`（依赖 d_auth_strategy 被移除）
- [ ] Task 1.1 `evidence_refs` 被清空
- [ ] Task 1.2 lifecycle 保持 `"accepted"`（d_db 仍存在，summary 相同 → Rule 1）
- [ ] Task 1.2 `evidence_refs` 保持 `["ev:2"]`
- [ ] Task 1.3 lifecycle 保持 `"accepted"`（无 research_basis）
- [ ] `warnings` 包含: `'Decision "d_auth_strategy" removed in new research — dependent tasks invalidated'`
- [ ] `d_auth_strategy` 仍保留在 `decision_index` 中（旧记录不删除，只标记为 invalidated）
- [ ] `d_db.expires_at` 更新为新值

---

## Test Case 4: Rule 4 — Brand New ID

**Setup state.json:**
```json
{
  "research": {
    "decision_index": {
      "d_existing": { "summary": "Use TypeScript", "volatility": "low", "expires_at": "2026-06-01T00:00:00Z" }
    }
  },
  "phases": [{
    "id": 1, "lifecycle": "active",
    "todo": [
      { "id": "1.1", "name": "TS setup", "lifecycle": "accepted", "research_basis": ["d_existing"], "evidence_refs": ["ev:1"], "retry_count": 0 },
      { "id": "1.2", "name": "Other task", "lifecycle": "pending", "research_basis": [], "evidence_refs": [], "retry_count": 0 }
    ]
  }]
}
```

**New research (包含新 ID):**
```json
{
  "decision_index": {
    "d_existing": { "summary": "Use TypeScript", "volatility": "low", "expires_at": "2026-09-01T00:00:00Z" },
    "d_new_framework": { "summary": "Use Fastify instead of Express", "volatility": "medium", "expires_at": "2026-04-01T00:00:00Z" }
  }
}
```

**Verify:**
- [ ] `d_new_framework` 被添加到 `decision_index`
- [ ] `d_existing` 保留，expires_at 更新（Rule 1）
- [ ] Task 1.1 lifecycle 保持 `"accepted"`（d_existing 未变）
- [ ] Task 1.2 lifecycle 保持 `"pending"`（无 research_basis）
- [ ] `warnings` 数组为空
- [ ] 无 task 被 invalidate

---

## Test Case 5: 组合场景 — 4 条规则同时触发

**Setup state.json:**
```json
{
  "research": {
    "decision_index": {
      "d_unchanged": { "summary": "Use ESLint", "volatility": "low", "expires_at": "2026-01-01T00:00:00Z" },
      "d_changed": { "summary": "Use Jest for testing", "volatility": "medium", "expires_at": "2026-01-01T00:00:00Z" },
      "d_removed": { "summary": "Use Redis for caching", "volatility": "high", "expires_at": "2025-12-01T00:00:00Z" }
    }
  },
  "phases": [{
    "id": 1, "lifecycle": "active",
    "todo": [
      { "id": "1.1", "name": "Lint config", "lifecycle": "accepted", "research_basis": ["d_unchanged"], "evidence_refs": ["ev:1"], "retry_count": 0 },
      { "id": "1.2", "name": "Test infra", "lifecycle": "checkpointed", "research_basis": ["d_changed"], "evidence_refs": ["ev:2"], "retry_count": 0 },
      { "id": "1.3", "name": "Cache layer", "lifecycle": "accepted", "research_basis": ["d_removed"], "evidence_refs": ["ev:3"], "retry_count": 0 },
      { "id": "1.4", "name": "Standalone", "lifecycle": "pending", "research_basis": [], "evidence_refs": [], "retry_count": 0 }
    ]
  }]
}
```

**New research:**
```json
{
  "decision_index": {
    "d_unchanged": { "summary": "Use ESLint", "volatility": "low", "expires_at": "2026-06-01T00:00:00Z" },
    "d_changed": { "summary": "Use Vitest for testing (faster)", "volatility": "medium", "expires_at": "2026-06-01T00:00:00Z" },
    "d_brand_new": { "summary": "Use Docker Compose for dev", "volatility": "low", "expires_at": "2026-12-01T00:00:00Z" }
  }
}
```

**Verify (每条规则):**

Rule 1 (`d_unchanged`):
- [ ] summary 保持 "Use ESLint"
- [ ] expires_at 更新为新值
- [ ] Task 1.1 lifecycle = `"accepted"`（不变）
- [ ] Task 1.1 evidence_refs 保留

Rule 2 (`d_changed`):
- [ ] summary 更新为 "Use Vitest for testing (faster)"
- [ ] Task 1.2 lifecycle 变为 `"needs_revalidation"`
- [ ] Task 1.2 evidence_refs 被清空

Rule 3 (`d_removed`):
- [ ] `d_removed` 在 invalidatedIds 中
- [ ] Task 1.3 lifecycle 变为 `"needs_revalidation"`
- [ ] Task 1.3 evidence_refs 被清空
- [ ] warnings 包含关于 `d_removed` 被移除的信息

Rule 4 (`d_brand_new`):
- [ ] `d_brand_new` 被添加到 decision_index
- [ ] 无 task 受影响
- [ ] Task 1.4 lifecycle = `"pending"`（不变）

**Overall:**
- [ ] `decision_index` 最终包含: d_unchanged, d_changed, d_removed (保留), d_brand_new
- [ ] warnings 长度 = 1 (只有 d_removed 产生 warning)
- [ ] 2 个 task 被 invalidate (1.2 + 1.3)
- [ ] 2 个 task 不受影响 (1.1 + 1.4)

---

## Test Case 6: 跨 Phase 影响

**Setup:** 多个 phase 的 task 引用同一个 decision

```json
{
  "research": {
    "decision_index": {
      "d_api_design": { "summary": "REST API", "volatility": "medium", "expires_at": "2025-12-01T00:00:00Z" }
    }
  },
  "phases": [
    {
      "id": 1, "lifecycle": "accepted",
      "todo": [
        { "id": "1.1", "lifecycle": "accepted", "research_basis": ["d_api_design"], "evidence_refs": ["ev:1"] }
      ]
    },
    {
      "id": 2, "lifecycle": "active",
      "todo": [
        { "id": "2.1", "lifecycle": "checkpointed", "research_basis": ["d_api_design"], "evidence_refs": ["ev:2"] },
        { "id": "2.2", "lifecycle": "pending", "research_basis": ["d_api_design"], "evidence_refs": [] }
      ]
    }
  ]
}
```

**New research:**
```json
{
  "decision_index": {
    "d_api_design": { "summary": "GraphQL API (changed)", "volatility": "medium", "expires_at": "2026-06-01T00:00:00Z" }
  }
}
```

**Verify:**
- [ ] Task 1.1 (accepted) → `"needs_revalidation"` (如果 accepted→needs_revalidation 是合法转换)
- [ ] Task 2.1 (checkpointed) → `"needs_revalidation"`
- [ ] Task 2.2 (pending) → 保持 `"pending"` (pending 不能转换到 needs_revalidation)
- [ ] 跨 phase 的所有引用 d_api_design 的 task 都被检查
- [ ] C-3 守卫: 只有 lifecycle 允许转换的 task 才会被 invalidate

---

## Test Case 7: 空 research → 新 research

**Setup:** `state.research` = `null` 或 `{}`

**New research:**
```json
{
  "decision_index": {
    "d_new": { "summary": "Use Bun runtime", "volatility": "high", "expires_at": "2026-01-15T00:00:00Z" }
  }
}
```

**Verify:**
- [ ] `state.research` 被初始化为 `{}`
- [ ] `state.research.decision_index.d_new` 被添加
- [ ] 无 task 受影响（Rule 4 only）
- [ ] 无 warnings
- [ ] 不报错

---

## Test Case 8: 完整编排流 — Pre-flight → Refresh → Resume

**Setup:**
1. state.json 中 `workflow_mode = "executing_task"`
2. `research.expires_at` 中有过期的决策
3. 用户运行 `/gsd:resume`

**Verify:**
- [ ] Pre-flight 检查检测到研究过期
- [ ] `workflow_mode` 被覆盖为 `"research_refresh_needed"`
- [ ] 过期决策信息显示给用户
- [ ] `gsd-researcher` 被派发进行刷新
- [ ] 刷新结果按 4 条规则处理
- [ ] 受影响 task 被 invalidate
- [ ] `workflow_mode` 恢复为 `"executing_task"`
- [ ] 调度从正确位置继续（invalidated tasks 重新排队）
