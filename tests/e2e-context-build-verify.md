# E2E Test Plan — Executor Context Build & Contract Verification

## Overview

验证 `buildExecutorContext` 6字段协议的正确构建，以及 executor/reviewer/researcher 结果契约的校验。

---

## Part 1: buildExecutorContext 6 字段验证

### Test Case 1: 基本 Context 构建

**Setup state.json:**
```json
{
  "current_phase": 1,
  "phases": [{
    "id": 1, "lifecycle": "active",
    "todo": [
      {
        "id": "1.1", "name": "Setup DB",
        "lifecycle": "accepted", "level": "L1",
        "requires": [], "retry_count": 0,
        "research_basis": ["d_db"],
        "checkpoint_commit": "aaa111",
        "files_changed": ["src/db.js", "src/schema.sql"],
        "review_required": true
      },
      {
        "id": "1.2", "name": "API endpoints",
        "lifecycle": "pending", "level": "L1",
        "requires": [{"kind":"task","id":"1.1","gate":"accepted"}],
        "retry_count": 0,
        "research_basis": ["d_api"],
        "review_required": true
      }
    ]
  }],
  "research": {
    "decision_index": {
      "d_db": { "summary": "Use PostgreSQL", "volatility": "low", "expires_at": "2026-06-01" },
      "d_api": { "summary": "REST with OpenAPI", "volatility": "medium", "expires_at": "2026-03-01" }
    }
  }
}
```

**Action:** `buildExecutorContext(state, "1.2", 1)`

**Verify 6 fields:**

1. **task_spec:**
   - [ ] = `"phases/phase-1.md"`

2. **research_decisions:**
   - [ ] 包含 1 个条目: `{ id: "d_api", summary: "REST with OpenAPI", volatility: "medium", expires_at: "2026-03-01" }`
   - [ ] 正确从 `research.decision_index` 解析 `d_api`

3. **predecessor_outputs:**
   - [ ] 包含 1 个条目（来自 requires 中的 task 1.1）
   - [ ] `files_changed: ["src/db.js", "src/schema.sql"]`
   - [ ] `checkpoint_commit: "aaa111"`

4. **project_conventions:**
   - [ ] = `"CLAUDE.md"`

5. **workflows:**
   - [ ] 包含: `"workflows/tdd-cycle.md"`, `"workflows/deviation-rules.md"`
   - [ ] 不包含 `"workflows/debugging.md"`（retry_count=0）
   - [ ] 包含 `"workflows/research.md"`（有 research_basis）

6. **constraints:**
   - [ ] `retry_count: 0`
   - [ ] `level: "L1"`
   - [ ] `review_required: true`

---

### Test Case 2: Retry > 0 时包含 Debugging Workflow

**Setup:** Task 1.1 `retry_count: 2`

**Action:** `buildExecutorContext(state, "1.1", 1)`

**Verify:**
- [ ] `workflows` 包含 `"workflows/debugging.md"`
- [ ] `constraints.retry_count` = 2

---

### Test Case 3: 无 Research Basis

**Setup:** Task 无 `research_basis` 或 `research_basis: []`

**Action:** `buildExecutorContext(state, taskId, phaseId)`

**Verify:**
- [ ] `research_decisions` = `[]`
- [ ] `workflows` 不包含 `"workflows/research.md"`

---

### Test Case 4: Research Decision 不存在

**Setup:** Task `research_basis: ["d_nonexistent"]`, decision_index 中无此 ID

**Action:** `buildExecutorContext(state, taskId, phaseId)`

**Verify:**
- [ ] `research_decisions` = `[{ id: "d_nonexistent", summary: "not found" }]`
- [ ] 不崩溃

---

### Test Case 5: 多个 Predecessor 依赖

**Setup:** Task requires 2 个 task 依赖

**Verify:**
- [ ] `predecessor_outputs` 包含 2 个条目
- [ ] 每个条目有正确的 `files_changed` 和 `checkpoint_commit`
- [ ] 只包含 `kind: "task"` 依赖（忽略 `kind: "phase"`）

---

## Part 2: Agent Result Contract 验证

### Test Case 6: Executor 结果契约

**Valid result:**
```json
{
  "task_id": "1.2",
  "outcome": "checkpointed",
  "evidence": [{ "type": "test", "data": { "passed": true } }],
  "files_changed": ["src/api.js", "tests/api.test.js"],
  "checkpoint_commit": "ccc333",
  "contract_changed": false,
  "decisions": []
}
```

**Verify valid result:**
- [ ] `outcome` 是 "checkpointed" | "blocked" | "failed" 之一
- [ ] `task_id` 与请求的 task ID 匹配
- [ ] `files_changed` 是字符串数组
- [ ] `evidence` 是数组
- [ ] `decisions` 是数组（可为空）

**Invalid results to test:**
- [ ] 缺少 `task_id` → 编排器拒绝
- [ ] `outcome: "unknown"` → 编排器拒绝
- [ ] 缺少 `evidence` → 编排器拒绝或警告

---

### Test Case 7: Reviewer 结果契约

**Valid result:**
```json
{
  "scope": "phase",
  "scope_id": 1,
  "findings": [
    { "severity": "Minor", "description": "Unused import", "location": "src/utils.js:1" }
  ],
  "verdict": "accepted"
}
```

**Verify:**
- [ ] `scope` 是 "task" 或 "phase"
- [ ] `verdict` 是 "accepted" 或 "rework_required"
- [ ] `findings` 是数组，每个有 severity/description
- [ ] severity 层级: Critical > Important > Minor

---

### Test Case 8: Researcher 结果契约

**Valid result:**
```json
{
  "decision_index": {
    "d_react": { "summary": "Use React 18", "volatility": "low", "expires_at": "2026-06-01" }
  },
  "files_written": [".gsd/research/STACK.md", ".gsd/research/PITFALLS.md"]
}
```

**Verify:**
- [ ] `decision_index` 是对象，每个值有 summary/volatility/expires_at
- [ ] `volatility` 是 "low" | "medium" | "high"
- [ ] `files_written` 是字符串数组

---

### Test Case 9: Debugger 结果契约

**Valid result:**
```json
{
  "root_cause": "Connection pool exhaustion under concurrent requests",
  "fix_direction": "Increase pool size and add connection timeout",
  "confidence": "high"
}
```

**Verify:**
- [ ] `root_cause` 非空字符串
- [ ] `fix_direction` 非空字符串
- [ ] `confidence` 是 "high" | "medium" | "low"
