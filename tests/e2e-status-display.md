# E2E Test Plan — `/gsd:status` Display

## Overview

验证 `/gsd:status` 命令在各种状态下的展示正确性。所有展示数据必须从 canonical fields 实时推导，不使用 derived/cached 值。

---

## Test Case 1: 无 `.gsd/` 目录

**Action:** 在没有 `.gsd/` 目录的项目中运行 `/gsd:status`

**Verify:**
- [ ] 输出错误信息: "未找到 GSD 项目状态，请先运行 /gsd:start 或 /gsd:prd"
- [ ] 不创建任何文件/目录
- [ ] 不报未处理异常

---

## Test Case 2: 损坏的 state.json

### 2a. JSON 语法错误

**Setup:** `.gsd/state.json` 内容为 `{ "project": "test", `（截断）

**Verify:**
- [ ] 输出错误信息，告知用户状态文件损坏
- [ ] 不崩溃/不抛异常
- [ ] 不修改 state.json

### 2b. 空文件

**Setup:** `.gsd/state.json` 为空文件

**Verify:**
- [ ] 输出错误信息
- [ ] 不崩溃

---

## Test Case 3: 正常执行中状态

**Setup state.json:**
```json
{
  "project": "My Auth App",
  "workflow_mode": "executing_task",
  "plan_version": 1,
  "git_head": "abc1234",
  "current_phase": 2,
  "current_task": "2.3",
  "current_review": null,
  "total_phases": 3,
  "phases": [
    {
      "id": 1, "name": "Setup & Auth", "lifecycle": "accepted",
      "tasks": 5, "done": 5,
      "phase_review": { "status": "accepted", "retry_count": 0 },
      "phase_handoff": { "required_reviews_passed": true, "tests_passed": true, "critical_issues_open": 0 },
      "todo": [
        { "id": "1.1", "name": "Init project", "lifecycle": "accepted", "level": "L0", "requires": [], "retry_count": 0 },
        { "id": "1.2", "name": "DB schema", "lifecycle": "accepted", "level": "L1", "requires": [], "retry_count": 0 },
        { "id": "1.3", "name": "Auth module", "lifecycle": "accepted", "level": "L2", "requires": [], "retry_count": 0 },
        { "id": "1.4", "name": "JWT tokens", "lifecycle": "accepted", "level": "L1", "requires": [], "retry_count": 0 },
        { "id": "1.5", "name": "Auth tests", "lifecycle": "accepted", "level": "L1", "requires": [], "retry_count": 0 }
      ]
    },
    {
      "id": 2, "name": "API Endpoints", "lifecycle": "active",
      "tasks": 4, "done": 2,
      "phase_review": { "status": "pending", "retry_count": 0 },
      "phase_handoff": { "required_reviews_passed": false, "tests_passed": false, "critical_issues_open": 0 },
      "todo": [
        { "id": "2.1", "name": "User CRUD", "lifecycle": "accepted", "level": "L1", "requires": [], "retry_count": 0 },
        { "id": "2.2", "name": "Role mgmt", "lifecycle": "accepted", "level": "L1", "requires": [{"kind":"task","id":"2.1","gate":"accepted"}], "retry_count": 0 },
        { "id": "2.3", "name": "Permissions", "lifecycle": "running", "level": "L2", "requires": [{"kind":"task","id":"2.2","gate":"accepted"}], "retry_count": 1 },
        { "id": "2.4", "name": "API tests", "lifecycle": "pending", "level": "L1", "requires": [{"kind":"task","id":"2.3","gate":"checkpoint"}], "retry_count": 0 }
      ]
    },
    {
      "id": 3, "name": "Frontend", "lifecycle": "pending",
      "tasks": 3, "done": 0,
      "phase_review": { "status": "pending", "retry_count": 0 },
      "phase_handoff": { "required_reviews_passed": false, "tests_passed": false, "critical_issues_open": 0 },
      "todo": [
        { "id": "3.1", "name": "Login page", "lifecycle": "pending", "level": "L1", "requires": [], "retry_count": 0 },
        { "id": "3.2", "name": "Dashboard", "lifecycle": "pending", "level": "L1", "requires": [{"kind":"task","id":"3.1","gate":"checkpoint"}], "retry_count": 0 },
        { "id": "3.3", "name": "E2E tests", "lifecycle": "pending", "level": "L1", "requires": [{"kind":"task","id":"3.2","gate":"accepted"}], "retry_count": 0 }
      ]
    }
  ],
  "decisions": [
    { "id": "d1", "summary": "Use PostgreSQL", "phase": 1 }
  ],
  "evidence": {},
  "research": null,
  "context": { "remaining_percentage": 72 }
}
```

### 3a. 项目概览

**Verify:**
- [ ] 显示: 项目名 = "My Auth App"
- [ ] 显示: 工作流模式 = "executing_task"
- [ ] 显示: 计划版本 = 1

### 3b. 总体进度

**Verify:**
- [ ] 总 task 数 = 12 (5+4+3)，从 `phases[].tasks` 逐个求和
- [ ] 已完成 task 数 = 7 (5+2+0)，从 `phases[].done` 逐个求和
- [ ] 进度百分比 = 58% (7/12)
- [ ] 阶段进度: 1/3 phases completed
- [ ] 进度条视觉正确

### 3c. 各阶段状态

**Verify:**
- [ ] Phase 1: "Setup & Auth" — lifecycle=accepted, 5/5 tasks
- [ ] Phase 2: "API Endpoints" — lifecycle=active, 2/4 tasks
- [ ] Phase 3: "Frontend" — lifecycle=pending, 0/3 tasks
- [ ] 审查状态: Phase 1 = accepted, Phase 2/3 = pending
- [ ] 交接状态: Phase 1 通过，Phase 2/3 未通过

### 3d. 当前活跃任务

**Verify:**
- [ ] 当前任务: 2.3 — "Permissions"
- [ ] 任务状态: running
- [ ] 审查级别: L2
- [ ] 重试次数: 1

### 3e. 审查状态

**Verify:**
- [ ] `current_review` 为 null → 不显示审查段

### 3f. Blocked 摘要

**Verify:**
- [ ] 当前 phase (2) 无 blocked task → 不显示 Blocked 段

### 3g. 下一步操作建议

**Verify:**
- [ ] `workflow_mode = executing_task` → 建议: "自动执行中，等待完成"

---

## Test Case 4: 带审查和 Blocked 的状态

**Setup state.json:**
```json
{
  "project": "Test Project",
  "workflow_mode": "awaiting_user",
  "plan_version": 2,
  "git_head": "def5678",
  "current_phase": 1,
  "current_task": null,
  "current_review": { "scope": "phase", "scope_id": 1, "stage": "spec" },
  "total_phases": 2,
  "phases": [
    {
      "id": 1, "name": "Core", "lifecycle": "active",
      "tasks": 3, "done": 1,
      "phase_review": { "status": "pending", "retry_count": 0 },
      "phase_handoff": { "required_reviews_passed": false, "tests_passed": false, "critical_issues_open": 0 },
      "todo": [
        { "id": "1.1", "name": "Init", "lifecycle": "accepted", "level": "L0", "requires": [], "retry_count": 0 },
        { "id": "1.2", "name": "API client", "lifecycle": "blocked", "level": "L1", "requires": [], "retry_count": 0, "blocked_reason": "Need API credentials", "unblock_condition": "User provides API key" },
        { "id": "1.3", "name": "Data layer", "lifecycle": "blocked", "level": "L1", "requires": [{"kind":"task","id":"1.2","gate":"accepted"}], "retry_count": 0, "blocked_reason": "Depends on 1.2", "unblock_condition": "Task 1.2 completed" }
      ]
    },
    {
      "id": 2, "name": "UI", "lifecycle": "pending",
      "tasks": 2, "done": 0,
      "phase_review": { "status": "pending", "retry_count": 0 },
      "phase_handoff": { "required_reviews_passed": false, "tests_passed": false, "critical_issues_open": 0 },
      "todo": [
        { "id": "2.1", "name": "Components", "lifecycle": "pending", "level": "L1", "requires": [], "retry_count": 0 },
        { "id": "2.2", "name": "Integration", "lifecycle": "pending", "level": "L1", "requires": [{"kind":"task","id":"2.1","gate":"checkpoint"}], "retry_count": 0 }
      ]
    }
  ],
  "decisions": [],
  "evidence": {},
  "research": null,
  "context": { "remaining_percentage": 55 }
}
```

### 4a. 审查状态显示

**Verify:**
- [ ] 显示审查段: scope=phase, scope_id=1, stage=spec
- [ ] 审查信息正确: "审查中: phase — 1"

### 4b. Blocked 摘要显示

**Verify:**
- [ ] 列出 2 个 blocked 任务
- [ ] Task 1.2: reason="Need API credentials", condition="User provides API key"
- [ ] Task 1.3: reason="Depends on 1.2", condition="Task 1.2 completed"

### 4c. 下一步建议

**Verify:**
- [ ] `workflow_mode = awaiting_user` → 建议: "有 blocked 问题需要用户决策，运行 /gsd:resume 查看详情"

---

## Test Case 5: 所有 11 种 workflow_mode 的建议映射

**Method:** 逐一设置 `workflow_mode` 并验证建议文本

| # | workflow_mode | 预期建议 |
|---|---|---|
| 1 | `executing_task` | "自动执行中，等待完成" |
| 2 | `reviewing_task` | "L2 审查进行中" |
| 3 | `reviewing_phase` | "L1 阶段审查进行中" |
| 4 | `awaiting_clear` | "请执行 /clear 然后 /gsd:resume 继续" |
| 5 | `awaiting_user` | "有 blocked 问题需要用户决策，运行 /gsd:resume 查看详情" |
| 6 | `paused_by_user` | "已暂停，运行 /gsd:resume 继续" |
| 7 | `reconcile_workspace` | "工作区不一致，运行 /gsd:resume 进行 reconcile" |
| 8 | `replan_required` | "计划需要更新，运行 /gsd:resume 查看详情" |
| 9 | `research_refresh_needed` | "研究已过期，运行 /gsd:resume 刷新" |
| 10 | `completed` | "项目已完成" |
| 11 | `failed` | "项目执行失败，运行 /gsd:resume 查看详情" |

**Verify per mode:**
- [ ] 建议文本匹配上表
- [ ] 不推荐在 `completed` 或 `failed` 模式下自动执行

---

## Test Case 6: Completed 状态展示

**Setup state.json:** (所有 phases accepted, workflow_mode=completed)

**Verify:**
- [ ] 进度: 100% (all tasks done)
- [ ] 所有 phases 显示 lifecycle=accepted
- [ ] 建议: "项目已完成"
- [ ] 不显示"当前活跃任务"段（或显示 "无"）

---

## Test Case 7: 只读保证

**Action:** 运行 `/gsd:status`

**Verify:**
- [ ] state.json 文件 MD5/内容不变
- [ ] 不创建/删除/修改任何文件
- [ ] 不执行 git 操作
- [ ] 不执行代码/测试/构建

---

## Test Case 8: 语言检测

**Action:** 用英文输入运行 `/gsd:status`

**Verify:**
- [ ] 所有输出使用英文（标签、建议、错误信息）

**Action:** 用中文输入运行 `/gsd:status`

**Verify:**
- [ ] 所有输出使用中文
