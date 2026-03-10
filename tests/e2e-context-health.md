# E2E Test Plan — Context Health Monitoring

## Overview

验证上下文健康监控系统（hooks/context-monitor.js）在不同阈值下的行为：
- StatusLine hook 写入 `.gsd/.context-health`
- PostToolUse hook 读取并返回警告/停止文本
- 编排器响应 hook 信号保存状态

---

## Architecture

```
Claude Code Runtime
  ├─ StatusLine hook (每次 tool use 后)
  │   → 读取 context_window.remaining_percentage
  │   → 写入 .gsd/.context-health
  │
  └─ PostToolUse hook (每次 tool use 后)
      → 读取 .gsd/.context-health
      → < 20% → 🛑 EMERGENCY 信号
      → < 40% → ⚠️ LOW 信号
      → >= 40% → null (静默)
```

---

## Test Case 1: StatusLine Hook 写入

### 1a. 正常写入

**Setup:** `.gsd/` 目录存在

**Action:** StatusLine hook 被调用，data = `{ context_window: { remaining_percentage: 72 } }`

**Verify:**
- [ ] `.gsd/.context-health` 文件被创建/更新
- [ ] 文件内容 = `"72"`
- [ ] 文件每次都被覆写（不是追加）

### 1b. 无 `.gsd/` 目录

**Action:** StatusLine hook 在无 `.gsd/` 目录时被调用

**Verify:**
- [ ] `.gsd/` 目录被自动创建（`mkdirSync recursive`）
- [ ] `.context-health` 写入正确

### 1c. 数据缺失

**Action:** StatusLine hook 被调用，data = `{}` 或 `null`

**Verify:**
- [ ] 静默返回，不崩溃
- [ ] `.context-health` 不更新

---

## Test Case 2: PostToolUse Hook — 正常范围 (≥ 40%)

**Setup:** `.gsd/.context-health` 内容 = `"72"`

**Action:** PostToolUse hook 被调用

**Verify:**
- [ ] 返回 `null`（无警告）
- [ ] 编排器继续正常执行
- [ ] 不触发状态保存

---

## Test Case 3: PostToolUse Hook — 低阈值 (20% ≤ x < 40%)

**Setup:** `.gsd/.context-health` 内容 = `"35"`

**Action:** PostToolUse hook 被调用

**Verify:**
- [ ] 返回: `"⚠️ CONTEXT LOW (35% remaining): Complete current task, save state, set workflow_mode = awaiting_clear. Tell user to /clear then /gsd:resume."`
- [ ] 编排器收到信号后:
  - [ ] 完成当前任务（如果可以快速完成）
  - [ ] 保存完整状态到 state.json
  - [ ] 设置 `workflow_mode = "awaiting_clear"`
  - [ ] 告知用户执行 `/clear` 然后 `/gsd:resume`
  - [ ] 停止派发新的子代理

---

## Test Case 4: PostToolUse Hook — 紧急阈值 (< 20%)

**Setup:** `.gsd/.context-health` 内容 = `"15"`

**Action:** PostToolUse hook 被调用

**Verify:**
- [ ] 返回: `"🛑 CONTEXT EMERGENCY (15% remaining): Save state NOW. Set workflow_mode = awaiting_clear. Tell user to /clear then /gsd:resume."`
- [ ] 编排器收到信号后:
  - [ ] 立即保存状态（不等待当前任务完成）
  - [ ] 设置 `workflow_mode = "awaiting_clear"`
  - [ ] 显示紧急消息
  - [ ] 立即停止所有操作

---

## Test Case 5: PostToolUse Hook — `.context-health` 不存在

**Setup:** `.gsd/.context-health` 文件不存在

**Action:** PostToolUse hook 被调用

**Verify:**
- [ ] 返回 `null`（静默处理 readFileSync 错误）
- [ ] 不崩溃
- [ ] 编排器继续正常执行

---

## Test Case 6: 阈值边界值

### 6a. 恰好 40%

**Setup:** `.context-health` = `"40"`

**Verify:**
- [ ] 返回 `null`（40 不 < 40）
- [ ] 不触发警告

### 6b. 恰好 39%

**Setup:** `.context-health` = `"39"`

**Verify:**
- [ ] 返回 ⚠️ LOW 警告

### 6c. 恰好 20%

**Setup:** `.context-health` = `"20"`

**Verify:**
- [ ] 返回 ⚠️ LOW 警告（20 不 < 20）
- [ ] 不是 EMERGENCY

### 6d. 恰好 19%

**Setup:** `.context-health` = `"19"`

**Verify:**
- [ ] 返回 🛑 EMERGENCY 警告

---

## Test Case 7: 编排器完整响应流

**Scenario:** 执行中上下文逐渐耗尽

### 7a. 正常执行 → LOW 警告

**Setup:** 项目正在执行 Phase 2, Task 2.3

**Trigger:** context_window.remaining_percentage 从 45% 降到 38%

**Verify:**
- [ ] StatusLine hook 写入 `"38"` 到 `.context-health`
- [ ] PostToolUse hook 返回 ⚠️ LOW 信号
- [ ] 编排器完成当前 task（如果快速可完成）
- [ ] state.json 被更新:
  - `workflow_mode = "awaiting_clear"`
  - `current_phase` = 当前值
  - `current_task` = 当前值或 null
  - `context.remaining_percentage` 更新
  - 所有 task lifecycle 正确
- [ ] 用户看到消息: 进度已保存，请 `/clear` 然后 `/gsd:resume`
- [ ] 不再派发新子代理

### 7b. 审查中 → LOW 警告

**Setup:** 正在进行 L1 阶段审查 (`workflow_mode: "reviewing_phase"`)

**Trigger:** 上下文降到 35%

**Verify:**
- [ ] `current_review` 保存（scope, scope_id, stage）
- [ ] `workflow_mode = "awaiting_clear"`
- [ ] Resume 后正确进入 `reviewing_phase` 而非 `executing_task`

### 7c. 研究中 → EMERGENCY

**Setup:** 正在执行研究刷新 (`workflow_mode: "research_refresh_needed"`)

**Trigger:** 上下文降到 15%

**Verify:**
- [ ] 立即保存状态
- [ ] 研究刷新进度（如果部分完成）记录在 state
- [ ] Resume 后重新开始研究刷新（部分研究不保存）

---

## Test Case 8: CLI 调用模式

### 8a. statusLine CLI

**Action:** `echo '{"context_window":{"remaining_percentage":50}}' | node hooks/context-monitor.js statusLine`

**Verify:**
- [ ] `.gsd/.context-health` 文件内容 = `"50"`
- [ ] 进程退出码 = 0

### 8b. postToolUse CLI — 正常

**Setup:** `.gsd/.context-health` = `"50"`

**Action:** `node hooks/context-monitor.js postToolUse`

**Verify:**
- [ ] stdout 无输出（null → 不打印）
- [ ] 进程退出码 = 0

### 8c. postToolUse CLI — LOW

**Setup:** `.gsd/.context-health` = `"30"`

**Action:** `node hooks/context-monitor.js postToolUse`

**Verify:**
- [ ] stdout 包含 ⚠️ CONTEXT LOW 消息
- [ ] 进程退出码 = 0

### 8d. postToolUse CLI — EMERGENCY

**Setup:** `.gsd/.context-health` = `"10"`

**Action:** `node hooks/context-monitor.js postToolUse`

**Verify:**
- [ ] stdout 包含 🛑 CONTEXT EMERGENCY 消息
- [ ] 进程退出码 = 0
