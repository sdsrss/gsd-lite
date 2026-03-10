# E2E Test Plan — `/gsd:stop` + Resume

## Overview

验证 `/gsd:stop` 命令的状态保存完整性、原子写入、以及 stop → resume 往返的数据零丢失。

---

## Test Case 1: 无 `.gsd/` 目录

**Action:** 在没有 `.gsd/` 目录的项目中运行 `/gsd:stop`

**Verify:**
- [ ] 输出: "未找到 GSD 项目状态，无需停止"
- [ ] 不创建任何文件/目录
- [ ] 不报异常

---

## Test Case 2: 执行中暂停

**Setup:** 项目正在执行中，`workflow_mode: "executing_task"`

**Setup state.json:**
```json
{
  "project": "Stop Test",
  "workflow_mode": "executing_task",
  "plan_version": 1,
  "git_head": "aaa1111",
  "current_phase": 2,
  "current_task": "2.2",
  "current_review": null,
  "total_phases": 3,
  "phases": [
    {
      "id": 1, "name": "Phase 1", "lifecycle": "accepted",
      "tasks": 3, "done": 3,
      "phase_review": { "status": "accepted", "retry_count": 0 },
      "phase_handoff": { "required_reviews_passed": true, "tests_passed": true, "critical_issues_open": 0 },
      "todo": [
        { "id": "1.1", "name": "Task A", "lifecycle": "accepted", "level": "L0", "requires": [], "retry_count": 0, "evidence_refs": ["ev:1"] },
        { "id": "1.2", "name": "Task B", "lifecycle": "accepted", "level": "L1", "requires": [], "retry_count": 0, "evidence_refs": ["ev:2"] },
        { "id": "1.3", "name": "Task C", "lifecycle": "accepted", "level": "L1", "requires": [], "retry_count": 0, "evidence_refs": ["ev:3"] }
      ]
    },
    {
      "id": 2, "name": "Phase 2", "lifecycle": "active",
      "tasks": 4, "done": 1,
      "phase_review": { "status": "pending", "retry_count": 0 },
      "phase_handoff": { "required_reviews_passed": false, "tests_passed": false, "critical_issues_open": 0 },
      "todo": [
        { "id": "2.1", "name": "Task D", "lifecycle": "accepted", "level": "L1", "requires": [], "retry_count": 0, "checkpoint_commit": "bbb2222", "evidence_refs": ["ev:4"] },
        { "id": "2.2", "name": "Task E", "lifecycle": "running", "level": "L2", "requires": [{"kind":"task","id":"2.1","gate":"accepted"}], "retry_count": 1, "evidence_refs": [] },
        { "id": "2.3", "name": "Task F", "lifecycle": "pending", "level": "L1", "requires": [{"kind":"task","id":"2.2","gate":"checkpoint"}], "retry_count": 0, "evidence_refs": [] },
        { "id": "2.4", "name": "Task G", "lifecycle": "blocked", "level": "L1", "requires": [], "retry_count": 0, "blocked_reason": "Need config file", "unblock_condition": "User creates .env", "evidence_refs": [] }
      ]
    },
    {
      "id": 3, "name": "Phase 3", "lifecycle": "pending",
      "tasks": 2, "done": 0,
      "phase_review": { "status": "pending", "retry_count": 0 },
      "phase_handoff": { "required_reviews_passed": false, "tests_passed": false, "critical_issues_open": 0 },
      "todo": [
        { "id": "3.1", "name": "Task H", "lifecycle": "pending", "level": "L1", "requires": [], "retry_count": 0, "evidence_refs": [] },
        { "id": "3.2", "name": "Task I", "lifecycle": "pending", "level": "L1", "requires": [{"kind":"task","id":"3.1","gate":"accepted"}], "retry_count": 0, "evidence_refs": [] }
      ]
    }
  ],
  "decisions": [
    { "id": "d1", "summary": "Use PostgreSQL", "phase": 1 },
    { "id": "d2", "summary": "REST API design", "phase": 2 }
  ],
  "evidence": {
    "ev:4": { "scope": "task:2.1", "type": "test", "data": { "passed": true } }
  },
  "research": {
    "decision_index": {
      "d_db": { "summary": "Use PostgreSQL", "volatility": "low", "expires_at": "2026-06-01T00:00:00Z" }
    }
  },
  "context": { "remaining_percentage": 65 }
}
```

### 2a. workflow_mode 更新

**Verify:**
- [ ] `workflow_mode` 变为 `"paused_by_user"`
- [ ] 原来的 `"executing_task"` 不再保留

### 2b. 执行位置保存

**Verify:**
- [ ] `current_phase` = 2（不变）
- [ ] `current_task` = "2.2"（不变）
- [ ] `current_review` = null（不变）

### 2c. Task Lifecycle 保存

**Verify:**
- [ ] Task 2.1: lifecycle=accepted（不变）
- [ ] Task 2.2: lifecycle=running（不变，保留运行中状态）
- [ ] Task 2.3: lifecycle=pending（不变）
- [ ] Task 2.4: lifecycle=blocked, blocked_reason="Need config file"（不变）

### 2d. Git HEAD 更新

**Verify:**
- [ ] `git_head` 更新为当前 `git rev-parse HEAD` 的值（可能与 "aaa1111" 不同）

### 2e. 时间戳更新

**Verify:**
- [ ] `context.last_session` 设置为当前时间

### 2f. 原子写入

**Verify:**
- [ ] 先写入 `.gsd/state.json.tmp`
- [ ] 成功后 rename 为 `.gsd/state.json`
- [ ] 最终无 `.gsd/state.json.tmp` 残留

### 2g. 确认输出

**Verify:**
- [ ] 输出包含: "已暂停"
- [ ] 输出包含: 项目名 "Stop Test"
- [ ] 输出包含: 停在位置 Phase 2 / Task 2.2
- [ ] 输出包含: 进度 4/9 tasks

### 2h. 不执行任何操作

**Verify:**
- [ ] 不运行代码/测试/构建
- [ ] 不清理临时文件
- [ ] 不修改 canonical fields 以外的内容

---

## Test Case 3: 审查中暂停

**Setup:** `workflow_mode: "reviewing_phase"`, `current_review: { scope: "phase", scope_id: 1, stage: "spec" }`

**Action:** 运行 `/gsd:stop`

**Verify:**
- [ ] `workflow_mode` 变为 `"paused_by_user"`
- [ ] `current_review` 保留完整 `{ scope: "phase", scope_id: 1, stage: "spec" }`
- [ ] 所有 task lifecycle 不变
- [ ] 确认输出显示审查中被暂停的信息

---

## Test Case 4: 已完成/已失败时暂停

### 4a. workflow_mode = completed

**Action:** 运行 `/gsd:stop`

**Verify:**
- [ ] 可以暂停（设为 paused_by_user）或提示项目已完成无需暂停
- [ ] 如果暂停: state 完整保存

### 4b. workflow_mode = failed

**Action:** 运行 `/gsd:stop`

**Verify:**
- [ ] 同上: 可以暂停或提示

---

## Test Case 5: Stop → Resume 往返数据完整性

**Action:**
1. 使用 Test Case 2 的状态运行 `/gsd:stop`
2. 运行 `/clear`
3. 运行 `/gsd:resume`

### 5a. 数据零丢失

**Verify (resume 后状态 vs stop 前状态):**
- [ ] `project` = "Stop Test"
- [ ] `plan_version` = 1
- [ ] `current_phase` = 2
- [ ] `current_task` = "2.2"
- [ ] `total_phases` = 3
- [ ] `decisions` 数组长度 = 2，内容完全一致
- [ ] `evidence` 所有条目保留
- [ ] `research.decision_index` 完全一致

### 5b. Task 状态完整

**Verify:**
- [ ] Phase 1: 3 个 accepted task（含 evidence_refs）
- [ ] Phase 2: accepted(2.1) + running(2.2,retry=1) + pending(2.3) + blocked(2.4,reason 保留)
- [ ] Phase 3: 2 个 pending task
- [ ] 所有 `requires` 依赖关系不变
- [ ] 所有 `retry_count` 不变
- [ ] 所有 `checkpoint_commit` 不变

### 5c. Resume 行为

**Verify:**
- [ ] `workflow_mode` 从 `"paused_by_user"` 恢复
- [ ] 用户被问: "项目已暂停，是否继续执行？"
- [ ] 确认后: `workflow_mode = "executing_task"`
- [ ] 调度从 Phase 2, Task 2.2 继续
- [ ] Task 2.2 (running 状态) 被重新派发给 executor

---

## Test Case 6: 多次 Stop/Resume 循环

**Action:**
1. Start → execute → `/gsd:stop` → `/clear` → `/gsd:resume` → continue
2. Continue → `/gsd:stop` → `/clear` → `/gsd:resume` → continue
3. Continue → complete

**Verify:**
- [ ] 每次 stop 后数据完整
- [ ] 每次 resume 后从正确位置继续
- [ ] decisions 累积跨所有 cycle
- [ ] evidence 跨 cycle 不丢失
- [ ] 最终完成报告覆盖所有工作
