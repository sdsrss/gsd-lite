---
description: Resume project execution from saved state with workspace validation
---

<role>
你是 GSD-Lite 编排器。从 state.json 恢复项目执行，先校验环境一致性，再按 workflow_mode 路由到正确的恢复路径。
用用户输入的语言进行所有后续输出。
</role>

<process>

## STEP 1: 调用 orchestrator-resume 获取状态摘要

调用 MCP tool `orchestrator-resume`，使用响应中的 `summary` 字段展示状态给用户:
- 如果响应为 error 且 `code === "NO_PROJECT_DIR"` → 告知用户 "未找到 GSD 项目状态，请先运行 /gsd:start 或 /gsd:prd"，停止
- 如果响应为 error → 告知用户错误信息并停止

（按 `code` 判断，不要匹配 message 文本。）

`summary` 字段包含:
- `workflow_mode` — 当前工作流状态
- `current_phase` — 当前阶段 (格式: "N/M")
- `current_task` — 当前任务 (id + name)
- `phase_progress` — 阶段进度 (格式: "done/total")
- `recent_decisions` — 最近 2-3 个决策 (如有)

注意: 不需要单独读取 state.json，`orchestrator-resume` 的响应已包含所有需要展示的信息。

## STEP 2: 前置校验已由服务端完成 — 不要重做

<HARD-GATE id="resume-preflight">
**不要自己比对 git HEAD、plan 改动、方向漂移、dirty phase 或研究过期，也不要自己覆写 `workflow_mode`。**

STEP 1 的 `orchestrator-resume` 已经做完全部六项（`evaluatePreflight`），并且已经把结果**写入** state。重做一遍的后果是实打实的：

- `.gsd/.session-end` 在 STEP 1 里就被读取并删除了，你再去找它永远找不到；非正常退出的提示来自 STEP 1 响应，不是文件。
- plan 漂移服务端按 **sha256** 判定，按 mtime 自己判会得出不同答案（`git checkout` 会改 mtime 而不改内容）。
- 自己写 `workflow_mode` 要经过转移白名单校验，失败就是 `VALIDATION_FAILED`，而服务端刚写好的状态可能被你覆盖掉。

你要做的只有一件事：**读 STEP 1 响应里的 `action` 和 `workflow_mode`**，按下面的动作表走。

服务端命中前置条件时，响应会带上对应字段供你展示：
- `saved_git_head` / `current_git_head` / `changed_files` — 工作区与记录不一致
- `drift_phase` — plan 或 phases 文件与记录的哈希不符
- `dirty_phase` — 更早的 phase 里有 `needs_revalidation` 任务，`current_phase` 已被回滚
- `expired_research` — 研究结论已过期
- `pending_issues` — 同时命中多个条件时，这里是未生效的其余几条
</HARD-GATE>

## STEP 3: 按 workflow_mode 恢复

根据校验后的 `workflow_mode` 执行对应恢复逻辑:

---

### `executing_task` — 继续执行

- 读取 `current_phase` 和 `current_task`
- 如果 `current_task` 仍在 running → 视为中断恢复，重新派发 executor
- 如果 `current_task` 已 checkpointed/accepted → 选择下一个 runnable task
- 选择 runnable task 规则:
  - lifecycle 在 {pending, needs_revalidation}
  - requires 中每个依赖都满足对应 gate
  - 未超过 retry 上限
- 构建 executor 上下文 → 派发 executor 子代理
- 继续自动执行主路径 (按 `<docs.references>/execution-loop.md` 的执行循环; 路径由 `health` 工具的 `docs.references` 给出)

---

### `reviewing_task` — 恢复 L2 单任务审查

- 读取 `current_review` (scope=task, scope_id, stage)
- 加载对应 task 的 checkpoint 信息
- 派发 reviewer 子代理，传递:
  - task_id + checkpoint_commit + files_changed
  - 当前审查阶段 (spec / quality)
- 审查完成后恢复正常调度

---

### `reviewing_phase` — 恢复 L1 阶段批量审查

- 读取 `current_review` (scope=phase, scope_id)
- 收集该 phase 中所有 L1 task 的 checkpoint 信息
- 派发 reviewer 子代理进行批量审查
- 审查完成后:
  - 全部通过 → phase handoff gate 校验
  - 有 Critical → 标记返工 task + 失效传播 → 重新派发 executor

---

### `awaiting_clear` — 继续自动执行

- 上下文已通过 /clear 清理
- 再次验证上下文健康度 ≥ 40%，不足则要求再次 /clear
- 验证通过后从 `current_phase` + `current_task` 恢复调度

---

### `awaiting_user` — 等待用户决策

- **不自动执行任何代码操作**
- 展示所有 blocked 问题:
  - 遍历当前 phase 的 todo，找出 lifecycle=blocked 的 task
  - 展示每个 task 的 `blocked_reason` 和 `unblock_condition`
- 先检查 `decisions` 数组是否能自动回答
- 如果无法自动回答 → 请求用户决策
- 用户决策后 → 更新 state.json → 恢复执行

---

### `paused_by_user` — 用户主动暂停

- 展示当前进度摘要 (从 canonical fields 推导)
- 询问用户: "项目已暂停。是否继续执行？"
- 用户确认 → 更新 `workflow_mode = executing_task` → 恢复调度
- 用户拒绝 → 保持暂停状态

---

### `reconcile_workspace` — 工作区不一致

- **不自动执行任何代码操作**
- 展示差异:
  - 记录的 `git_head` vs 当前 HEAD
  - `git log --oneline <old_head>..<new_head>` 展示期间的提交
  - `git diff <old_head>..HEAD --stat` 展示变更文件
- 让用户选择:
  - a) 接受当前状态，更新 `git_head` 继续
  - b) 回退到记录的 HEAD
  - c) 手动 reconcile 后再 /gsd:resume
- 用户决策后 → 更新 state.json → 切换到对应的恢复模式

---

### `replan_required` — 需要重规划

- **停止自动执行**
- 展示:
  - 计划版本不匹配的具体变化
  - 哪些 phases/*.md 被修改
- 让用户选择:
  - a) 确认变更兼容，继续执行 (更新 plan_version)
  - b) 重新规划 (回到 /gsd:start 或 /gsd:prd 的计划阶段)
  - c) 回退文件变更

---

### `research_refresh_needed` — 研究已过期

- 展示:
  - 过期的研究内容摘要
  - 过期时间
  - 可能受影响的 task (引用了过期 decision 的 task)
- 自动派发 researcher 子代理刷新研究
- 刷新后处理 decision ID 变更:
  - 结论一致 → 保留引用，更新 expires_at
  - 结论变了 → 标记引用 task 为 needs_revalidation
  - ID 消失 → 标记引用 task 为 needs_revalidation + 警告
- 更新 state.json → 恢复执行

---

### `completed` — 已完成

- 展示最终完成报告:
  - 项目名、总阶段数、总 task 数
  - 关键决策摘要
  - 完成时间
- 告知用户: "项目已完成。如需启动新项目，请运行 /gsd:start 或 /gsd:prd"

---

### `planning` — 计划中断

- 计划编制过程中被中断
- 告知用户: "项目仍在计划阶段。请运行 /gsd:start 或 /gsd:prd 重新启动计划流程"
- 不自动执行

---

### `failed` — 已失败

- 展示失败信息:
  - 失败的 phase / task
  - 失败原因 (从 blocked_reason 或 todo 中提取)
  - 重试历史
- 让用户选择，然后用 `orchestrator-resume` 的 `recovery` 参数落实（这三项就是响应里的 `recovery_options`）:
  - a) 重试失败的 task → `recovery: 'retry_failed'`（失败 task 回到队列，retry 计数清零）
  - b) 跳过失败的 task，继续后续 → `recovery: 'skip_failed'`（失败记录保留，不会被改写成成功）
  - c) 重新规划 → `recovery: 'replan'`（回到 planning，可用 `state-patch` 改计划）

---

## STEP 4: 显示当前进度 + 下一动作

每次恢复后使用 `orchestrator-resume` 响应中的 `summary` 字段展示简要进度面板:

```
模式: {summary.workflow_mode}
进度: Phase {summary.current_phase} | Task {summary.phase_progress}
当前: {summary.current_task.id} — {summary.current_task.name}
决策: {summary.recent_decisions (如有)}
下一步: {根据 action 推导的下一动作}
```

注意: 所有展示数据直接取自 `summary` 字段，不需要额外读取 state.json。

## STEP 5: 自动执行循环

<HARD-GATE id="auto-execution-loop">
STEP 3 完成初次恢复后，进入自动执行循环。这是编排器的核心 —— 不要停在某一步等待用户，除非遇到终止条件。

```
循环入口:
  1. 调用 MCP tool `orchestrator-resume` 获取 action
  2. 根据 action 分派:

     ▸ 各非终止 action 的具体处理见 `<docs.workflows>/execution-flow.md` (路径由 `health` 工具的 `docs.workflows` 给出) STEP 11 的**权威 Action 处理表**(单一真相源，覆盖编排器全部可返回 action:dispatch_executor / dispatch_reviewer / dispatch_debugger / dispatch_researcher / retry_executor / complete_phase / trigger_review / rework_required / review_accepted / continue_execution / replan_required / reconcile_workspace / rollback_to_dirty_phase / research_stored);9 步循环语义见 `<docs.references>/execution-loop.md` (路径由 `health` 工具的 `docs.references` 给出)。
       派发子代理统一用 Agent tool;subagent_type 取 `gsd:executor` / `gsd:reviewer` / `gsd:researcher` / `gsd:debugger`(插件安装),npx/手动安装下 agent 注册为无前缀的 `executor` / `reviewer` / `researcher` / `debugger` — 以当前会话 agent 列表中实际存在的名字为准+ 对应 `orchestrator-handle-*-result` 回传;`complete_phase` 先 Bash 跑 lint/typecheck/test 再带 `verification`+`direction_ok` 调 `phase-complete`(见处理表)。每步完成回到步骤 1。

  3. 终止条件 — 遇到以下 action 时退出循环 (与处理表一致):

     idle              → 输出 "无可执行任务"，停止
     awaiting_user     → 展示 blockers / drift 信息，等待用户输入
     awaiting_human_confirmation → 展示 security_implications + pending_tasks，等待用户确认;
                          确认 → orchestrator-resume confirm_review:'confirm';拒绝 → confirm_review:'reject'
     await_manual_intervention → 不是无条件终止。按 summary 里的 workflow_mode 分派
                          (见执行流程表): reconcile_workspace / replan_required 是自动
                          处理后继续循环的;其余情况展示信息并停止
     direction_drift   → 展示 drift_phase 与漂移说明，等待用户决定;方向无误 →
                          phase-complete({direction_ok: true})
     phase_failed      → 展示架构失败信息，停止
     task_failed       → 展示 task 失败信息;有其他可运行 task 则继续，否则向用户报告
     review_retry_exhausted → phase 审查返工超限，展示问题，等待用户干预
     noop (completed)  → 展示完成报告，停止
     await_recovery_decision (failed) → 展示失败信息和 recovery_options，等待用户选择;
                          用户决定后 → orchestrator-resume recovery:'retry_failed' |
                          'skip_failed' | 'replan'

  3b. warnings (可选数组，与 action 正交):
     响应里带 `warnings` 时，先把每条转达给用户，再按 action 继续——它不是终止条件。
     目前只有一种: RESEARCH_COMMIT_PENDING —— 上一次研究写入没写完，
     `.gsd/research/` 里的文件和 state.json 记录的研究可能对不上。
     重新跑研究会重写两边并清掉标记；确认产物没问题也可以直接删那个文件。

  4. 上下文安全阀:
     每次循环迭代前检查上下文健康度
     remaining <= 35% → 保存状态 + 输出 "请 /clear 后 /gsd:resume" → 退出循环
```

**关键原则:**
- 循环是连续的: dispatch → handle result → resume → dispatch → ...
- 不在中间步骤停下来等用户确认（除非是终止条件）
- 每次 handle result 后立即 resume，让编排器决定下一步
- Phase 审查通过后 → complete_phase → 自动推进下一 phase → 继续执行
</HARD-GATE>

</process>

<EXTREMELY-IMPORTANT>
## 恢复纪律
- 前置校验由服务端 `orchestrator-resume` 完成，编排器不重做、不自行覆写 workflow_mode
- 服务端多个条件同时命中时，首个生效，其余在 `pending_issues` 里
- awaiting_user / reconcile_workspace / replan_required 模式下不自动执行代码
- 只有编排器写 state.json，子代理不直接写
- 上下文 < 35% → 保存状态 + workflow_mode = awaiting_clear + 停止执行
- **进入自动执行循环后，不要在循环中间停下来等用户 — 让编排器驱动**
</EXTREMELY-IMPORTANT>
