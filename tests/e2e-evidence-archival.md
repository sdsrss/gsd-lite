# E2E Test Plan — Evidence Archival

## Overview

验证 `pruneEvidence` / `_pruneEvidenceFromState` 在跨阶段转换时的证据裁剪行为：
- 保留当前阶段和前一阶段的 evidence
- 将更老阶段的 evidence 归档到 `evidence-archive.json`
- 在 `phaseComplete()` 时自动触发裁剪

---

## Background

**裁剪规则:**
- threshold = `currentPhase - 1`
- Evidence scope 格式: `"task:X.Y"` → phase 编号 = X
- phase < threshold → 归档
- phase ≥ threshold → 保留
- 归档文件: `.gsd/evidence-archive.json`（合并到已有归档）

**触发时机:**
- `phaseComplete()` 完成阶段交接后自动调用
- `pruneEvidence()` 手动调用

---

## Test Case 1: Phase 2 完成 → Phase 1 Evidence 保留

**Setup state.json:**
```json
{
  "current_phase": 2,
  "phases": [
    { "id": 1, "lifecycle": "accepted", "tasks": 2, "done": 2, "todo": [
      { "id": "1.1", "lifecycle": "accepted" },
      { "id": "1.2", "lifecycle": "accepted" }
    ], "phase_review": { "status": "accepted", "retry_count": 0 }, "phase_handoff": { "required_reviews_passed": true, "tests_passed": true, "critical_issues_open": 0 } },
    { "id": 2, "lifecycle": "active", "tasks": 2, "done": 2, "todo": [
      { "id": "2.1", "lifecycle": "accepted" },
      { "id": "2.2", "lifecycle": "accepted" }
    ], "phase_review": { "status": "accepted", "retry_count": 0 }, "phase_handoff": { "required_reviews_passed": true, "tests_passed": true, "critical_issues_open": 0 } }
  ],
  "evidence": {
    "ev:1.1": { "scope": "task:1.1", "type": "test", "data": { "passed": true } },
    "ev:1.2": { "scope": "task:1.2", "type": "lint", "data": { "clean": true } },
    "ev:2.1": { "scope": "task:2.1", "type": "test", "data": { "passed": true } },
    "ev:2.2": { "scope": "task:2.2", "type": "test", "data": { "passed": true } }
  }
}
```

**Action:** `phaseComplete({ phase_id: 2 })` → `current_phase` 变为 3

**Verify:**
- [ ] threshold = 3 - 1 = 2
- [ ] `ev:1.1` (phase 1) → 1 < 2 → 归档
- [ ] `ev:1.2` (phase 1) → 1 < 2 → 归档
- [ ] `ev:2.1` (phase 2) → 2 ≥ 2 → 保留
- [ ] `ev:2.2` (phase 2) → 2 ≥ 2 → 保留
- [ ] `state.evidence` 只包含 `ev:2.1` 和 `ev:2.2`
- [ ] `.gsd/evidence-archive.json` 包含 `ev:1.1` 和 `ev:1.2`

---

## Test Case 2: Phase 3 完成 → Phase 1+2 归档

**Setup:** 3 个 phase，Phase 3 正在完成

**evidence:**
```json
{
  "ev:1.1": { "scope": "task:1.1", "type": "test", "data": {} },
  "ev:2.1": { "scope": "task:2.1", "type": "test", "data": {} },
  "ev:2.2": { "scope": "task:2.2", "type": "test", "data": {} },
  "ev:3.1": { "scope": "task:3.1", "type": "test", "data": {} }
}
```

**Action:** `phaseComplete({ phase_id: 3 })` → `current_phase` 变为 4（或保持 3 如果是最后一个 phase）

假设 `total_phases = 4`, `current_phase` → 4:

**Verify:**
- [ ] threshold = 4 - 1 = 3
- [ ] `ev:1.1` (phase 1) → 1 < 3 → 归档
- [ ] `ev:2.1` (phase 2) → 2 < 3 → 归档
- [ ] `ev:2.2` (phase 2) → 2 < 3 → 归档
- [ ] `ev:3.1` (phase 3) → 3 ≥ 3 → 保留
- [ ] `state.evidence` 只包含 `ev:3.1`
- [ ] `evidence-archive.json` 包含 `ev:1.1`, `ev:2.1`, `ev:2.2`

---

## Test Case 3: 累积归档（多次 phase 完成）

**Scenario:** Phase 1 完成后归档，Phase 2 完成后再归档

### 3a. Phase 1 完成

**evidence:** `{ "ev:0.1": {"scope":"task:0.1",...} }` (假设 Phase 0 存在或无 phase 0 evidence)

实际场景: Phase 1 是第一个 phase → `current_phase` = 1 → 2, threshold = 1
- Phase 0 evidence 不存在 → 无归档
- 所有 evidence 保留

### 3b. Phase 2 完成

**Pre-state evidence:**
```json
{
  "ev:1.1": { "scope": "task:1.1" },
  "ev:2.1": { "scope": "task:2.1" }
}
```

**Action:** `phaseComplete({ phase_id: 2 })` → `current_phase` = 3, threshold = 2

**Verify:**
- [ ] `ev:1.1` → 归档到 `evidence-archive.json`
- [ ] `ev:2.1` → 保留在 `state.evidence`

### 3c. Phase 3 完成

**Pre-state evidence:**
```json
{
  "ev:2.1": { "scope": "task:2.1" },
  "ev:3.1": { "scope": "task:3.1" }
}
```

**Action:** `phaseComplete({ phase_id: 3 })` → `current_phase` = 4, threshold = 3

**Verify:**
- [ ] `ev:2.1` → 归档到 `evidence-archive.json`
- [ ] `ev:3.1` → 保留
- [ ] `evidence-archive.json` 现在包含: `ev:1.1` (从 3b) + `ev:2.1` (从 3c)
- [ ] 归档文件合并正确，不覆盖已有条目

---

## Test Case 4: Scope 解析 (`parseScopePhase`)

| Scope string | 预期 phase | 行为 |
|---|---|---|
| `"task:1.1"` | 1 | 按 phase 1 处理 |
| `"task:2.3"` | 2 | 按 phase 2 处理 |
| `"task:10.5"` | 10 | 按 phase 10 处理 |
| `"task:1.1.extra"` | 1 | 匹配第一个数字 |
| `"phase:1"` | null | 不匹配 `task:X.Y` 格式 |
| `""` | null | 空字符串 |
| `null` | null | 非字符串 |
| `undefined` | null | 非字符串 |
| `"invalid"` | null | 无数字模式 |

**Verify per row:**
- [ ] `parseScopePhase(scope)` 返回预期值
- [ ] null 结果 → evidence 不归档（保留在 state.evidence）

---

## Test Case 5: 空 Evidence

**Setup:** `state.evidence = {}` 或 `state.evidence = null`

**Action:** `pruneEvidence({ currentPhase: 3 })`

**Verify:**
- [ ] 返回 `{ success: true, archived: 0 }`
- [ ] 不创建 `evidence-archive.json`（如果不存在）
- [ ] 不报错

---

## Test Case 6: 无需归档（所有 evidence 在当前范围内）

**Setup:** `current_phase = 2`

**evidence:**
```json
{
  "ev:2.1": { "scope": "task:2.1", "type": "test", "data": {} },
  "ev:2.2": { "scope": "task:2.2", "type": "test", "data": {} }
}
```

**Action:** `pruneEvidence({ currentPhase: 2 })`

**Verify:**
- [ ] threshold = 1
- [ ] phase 2 ≥ 1 → 全部保留
- [ ] 返回 `{ success: true, archived: 0 }`
- [ ] `state.evidence` 不变
- [ ] `evidence-archive.json` 不被创建/修改

---

## Test Case 7: 非标准 Scope 的 Evidence

**Setup:**
```json
{
  "ev:custom": { "scope": "global", "type": "config", "data": {} },
  "ev:1.1": { "scope": "task:1.1", "type": "test", "data": {} },
  "ev:no_scope": { "type": "test", "data": {} }
}
```

**Action:** `pruneEvidence({ currentPhase: 3 })` (threshold = 2)

**Verify:**
- [ ] `ev:custom` (scope="global") → `parseScopePhase("global")` = null → 保留
- [ ] `ev:1.1` (scope="task:1.1") → phase 1 < 2 → 归档
- [ ] `ev:no_scope` (无 scope) → `parseScopePhase(undefined)` = null → 保留
- [ ] 非标准 scope 的 evidence 永远不会被归档（安全默认）

---

## Test Case 8: phaseComplete 自动触发裁剪

**Setup:** Phase 2 所有 task 都是 accepted

**Action:** `phaseComplete({ phase_id: 2 })`

**Verify:**
- [ ] Phase 2 lifecycle 变为 `"accepted"`
- [ ] `current_phase` 递增
- [ ] 裁剪在 phase 完成后自动执行（不需要单独调用 pruneEvidence）
- [ ] `git_head` 更新为当前 HEAD
- [ ] state.json 原子写入（一次写入，不是先写 phase 再写 evidence）
- [ ] 归档和 state 更新在同一个 lock 内完成（C-1 mutation lock）

---

## Test Case 9: Evidence Archive 文件不存在时的首次归档

**Setup:** `.gsd/evidence-archive.json` 不存在

**Action:** 触发归档

**Verify:**
- [ ] `.gsd/evidence-archive.json` 被创建
- [ ] 内容为归档的 evidence 条目
- [ ] JSON 格式正确
- [ ] 不报错（readJson 返回 `{ ok: false }` → 使用空对象 `{}`）
