# E2E Test Plan — Decision Auto-Unblock

## Overview

验证 `matchDecisionForBlocker(decisions, blockedReason)` 的关键字匹配逻辑，以及编排器在 `awaiting_user` 模式下自动解锁 blocked task 的完整流程。

---

## Background

当 task 被标记为 `blocked` 后，编排器在 resume 时会：
1. 检查 `state.decisions` 数组
2. 对每个 blocked task 的 `blocked_reason` 调用 `matchDecisionForBlocker`
3. 如果找到匹配 → 自动解锁 task，不需用户输入
4. 如果无匹配 → 提示用户决策

**匹配逻辑:**
- Tokenize: 将文本按空白和标点拆分为小写 token
- 过滤: 移除长度 < 2 的 token
- 匹配: 计算 decision.summary tokens 与 blockedReason tokens 的重叠数
- 阈值: 重叠 ≥ 2 (MIN_OVERLAP) 才算匹配
- 选择: 重叠最多的 decision 胜出

---

## Test Case 1: 精确匹配

**Setup:**
```json
{
  "decisions": [
    { "id": "d1", "summary": "Use PostgreSQL database with connection pooling" },
    { "id": "d2", "summary": "REST API with JWT authentication" }
  ]
}
```

**Blocked reason:** `"Need database connection credentials"`

**Verify:**
- [ ] Tokenize "Need database connection credentials" → `["need", "database", "connection", "credentials"]`
- [ ] Tokenize d1 summary → `["use", "postgresql", "database", "with", "connection", "pooling"]`
- [ ] Overlap with d1: `{"database", "connection"}` = 2 tokens
- [ ] Tokenize d2 summary → `["rest", "api", "with", "jwt", "authentication"]`
- [ ] Overlap with d2: `{}` = 0 tokens
- [ ] Result: d1 matches (overlap=2 ≥ MIN_OVERLAP=2)
- [ ] `matchDecisionForBlocker` 返回 d1

---

## Test Case 2: 无匹配（重叠不足）

**Setup:**
```json
{
  "decisions": [
    { "id": "d1", "summary": "Use React for frontend" }
  ]
}
```

**Blocked reason:** `"Need API endpoint URL"`

**Verify:**
- [ ] Tokenize reason → `["need", "api", "endpoint", "url"]`
- [ ] Tokenize d1 → `["use", "react", "for", "frontend"]`
- [ ] Overlap: `{}` = 0 tokens（"for" 长度 = 3 但不在 reason 中）
- [ ] Result: `null`（无匹配）

---

## Test Case 3: 单 Token 重叠（不足）

**Setup:**
```json
{
  "decisions": [
    { "id": "d1", "summary": "Use PostgreSQL database" }
  ]
}
```

**Blocked reason:** `"Which database engine to use?"`

**Verify:**
- [ ] Reason tokens: `["which", "database", "engine", "use"]`
- [ ] d1 tokens: `["use", "postgresql", "database"]`
- [ ] Overlap: `{"database", "use"}` = 2
- [ ] Result: d1 matches (overlap=2 = MIN_OVERLAP)

---

## Test Case 4: 多 Decision 竞争 — 最佳匹配

**Setup:**
```json
{
  "decisions": [
    { "id": "d1", "summary": "Use JWT token rotation strategy" },
    { "id": "d2", "summary": "JWT refresh token with 7-day expiry" },
    { "id": "d3", "summary": "Use React components" }
  ]
}
```

**Blocked reason:** `"Need JWT refresh token strategy"`

**Verify:**
- [ ] Reason tokens: `["need", "jwt", "refresh", "token", "strategy"]`
- [ ] d1 overlap: `{"jwt", "token", "strategy"}` = 3
- [ ] d2 overlap: `{"jwt", "refresh", "token"}` = 3
- [ ] d3 overlap: `{}` = 0
- [ ] d1 和 d2 overlap 相同 → 返回先遇到的 (d1)
- [ ] `matchDecisionForBlocker` 返回 d1

---

## Test Case 5: 空输入处理

### 5a. 空 decisions 数组

**Verify:**
- [ ] `matchDecisionForBlocker([], "any reason")` → `null`

### 5b. 空 blocked reason

**Verify:**
- [ ] `matchDecisionForBlocker([{id:"d1", summary:"test"}], "")` → `null`
- [ ] `matchDecisionForBlocker([{id:"d1", summary:"test"}], null)` → `null`

### 5c. Decision 无 summary

**Verify:**
- [ ] `matchDecisionForBlocker([{id:"d1"}], "test reason")` → `null`
- [ ] 不崩溃

---

## Test Case 6: Token 过滤

**Blocked reason:** `"I/O of DB is too slow"`

**Verify:**
- [ ] Tokenize → 拆分为: `["of", "db", "is", "too", "slow"]`
- [ ] 过滤 (< 2 chars): 保留 `["of", "db", "is", "too", "slow"]`（全部 ≥ 2）
- [ ] 标点 `"I/O"` 拆分为 `["i", "o"]`，过滤后无（长度 = 1）

---

## Test Case 7: 完整编排流 — Auto-Unblock

**Setup state.json:**
```json
{
  "workflow_mode": "awaiting_user",
  "current_phase": 1,
  "phases": [{
    "id": 1, "lifecycle": "active",
    "todo": [
      { "id": "1.1", "lifecycle": "accepted" },
      {
        "id": "1.2", "lifecycle": "blocked",
        "blocked_reason": "Need database connection strategy",
        "unblock_condition": "User decides DB approach"
      },
      {
        "id": "1.3", "lifecycle": "blocked",
        "blocked_reason": "Unclear deployment platform",
        "unblock_condition": "User specifies cloud provider"
      }
    ]
  }],
  "decisions": [
    { "id": "d1", "summary": "Use PostgreSQL database with connection pooling", "phase": 1 },
    { "id": "d2", "summary": "Use JWT for authentication", "phase": 1 }
  ]
}
```

**Action:** 运行 `/gsd:resume`

### 7a. 自动匹配

**Verify:**
- [ ] Task 1.2 blocked_reason 与 d1 匹配:
  - Reason: `["need", "database", "connection", "strategy"]`
  - d1: `["use", "postgresql", "database", "with", "connection", "pooling"]`
  - Overlap: `{"database", "connection"}` = 2 → 匹配
- [ ] Task 1.3 blocked_reason 与所有 decisions 不匹配:
  - Reason: `["unclear", "deployment", "platform"]`
  - d1: overlap = 0
  - d2: overlap = 0
  - → 无匹配

### 7b. 自动解锁行为

**Verify:**
- [ ] Task 1.2: 自动解锁 → `lifecycle` 恢复为 `pending`（或 runnable 状态）
- [ ] Task 1.2: `blocked_reason` 清除
- [ ] Task 1.3: 仍为 `blocked`（无匹配）

### 7c. 用户交互

**Verify:**
- [ ] 编排器显示:
  - Task 1.2 被自动解锁（基于 decision d1）
  - Task 1.3 仍然 blocked，需要用户输入
- [ ] 只提示用户回答 Task 1.3 的问题
- [ ] 用户回答后 Task 1.3 解锁
- [ ] `workflow_mode` 变为 `"executing_task"`
- [ ] 调度继续

### 7d. 全部 Auto-Unblock

**Setup:** 所有 blocked task 都能被 decisions 匹配

**Verify:**
- [ ] 不提示用户（全部自动解锁）
- [ ] `workflow_mode` 直接变为 `"executing_task"`
- [ ] 调度立即继续

---

## Test Case 8: 大小写不敏感

**Setup:**
```json
{
  "decisions": [{ "id": "d1", "summary": "Use PostgreSQL Database" }]
}
```

**Blocked reason:** `"Need POSTGRESQL database config"`

**Verify:**
- [ ] Tokenize 都转小写
- [ ] `"PostgreSQL"` → `"postgresql"`, `"POSTGRESQL"` → `"postgresql"` → 匹配
- [ ] `"Database"` → `"database"`, `"database"` → `"database"` → 匹配
- [ ] Overlap = 2 → 返回 d1
