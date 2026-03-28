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
- 如果响应为 error 且 message 包含 "No .gsd directory" → 告知用户 "未找到 GSD 项目状态，请先运行 /gsd:start 或 /gsd:prd"，停止
- 如果响应为 error → 告知用户错误信息并停止

`summary` 字段包含:
- `workflow_mode` — 当前工作流状态
- `current_phase` — 当前阶段 (格式: "N/M")
- `current_task` — 当前任务 (id + name)
- `phase_progress` — 阶段进度 (格式: "done/total")
- `recent_decisions` — 最近 2-3 个决策 (如有)

注意: 不需要单独读取 state.json，`orchestrator-resume` 的响应已包含所有需要展示的信息。

## STEP 2: 前置校验

<HARD-GATE id="resume-preflight">
必须在恢复执行前完成所有校验，按以下优先级顺序:

0. **Session End 检查:**
   - 检查 `.gsd/.session-end` 文件是否存在
   - 如果存在:
     - 读取内容，向用户展示: "⚠️ 上次 session 在 {ended_at} 非正常结束，当时处于 {workflow_mode_was} (Phase {current_phase} / Task {current_task})"
     - 删除 `.session-end` 文件
     - 继续后续校验 (不覆写 workflow_mode — 由下面的校验决定)
   - 如果不存在 → 跳过，继续后续校验

1. **Git HEAD 校验:**
   - 运行 `git rev-parse HEAD` 获取当前 HEAD
   - 如果与 state.json 中的 `git_head` 不同:
     - 检查工作区是否与 state.json 记录一致
     - 不一致 → 覆写 `workflow_mode = reconcile_workspace`

2. **计划版本校验:**
   - 如果本地 plan.md 或 phases/*.md 被手动修改 (mtime > last_session)
   - → 覆写 `workflow_mode = replan_required`

3. **方向漂移校验:**
   - 如果当前或任何未完成 phase 的 `phase_handoff.direction_ok === false`
   - → 覆写 `workflow_mode = awaiting_user`

4. **Dirty-phase 回滚检测:**
   - 检查 `current_phase` 之前的 phase (`p.id < current_phase`) 中是否有 `needs_revalidation` 状态的 task
   - 如有 → 回滚 `current_phase` 到最早的 dirty phase
   - → 覆写 `workflow_mode = executing_task`

5. **研究过期校验:**
   - 如果 `research.expires_at` 已过期 (早于当前时间)
   - 或 research.decision_index 中有条目的 expires_at 已过期
   - → 覆写 `workflow_mode = research_refresh_needed`

6. **全部通过:**
   - 保持原 `workflow_mode` 不变

校验顺序: 1→2→3→4→5，首个命中的覆写生效 (不累积)
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
- 继续自动执行主路径 (按 references/execution-loop.md 执行循环)

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
- 让用户选择:
  - a) 重试失败的 task
  - b) 跳过失败的 task，继续后续
  - c) 重新规划

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

     dispatch_executor:
       → 使用 Agent tool 派发 executor 子代理 (subagent_type: gsd:executor)
       → 传入 orchestrator 返回的 executor_context
       → 收到 executor 结果后 → 调用 MCP tool `orchestrator-handle-executor-result`
       → 回到步骤 1

     dispatch_reviewer:
       → 使用 Agent tool 派发 reviewer 子代理 (subagent_type: gsd:reviewer)
       → 传入 review_targets / current_review
       → 收到 reviewer 结果后 → 调用 MCP tool `orchestrator-handle-reviewer-result`
       → 回到步骤 1

     dispatch_researcher:
       → 使用 Agent tool 派发 researcher 子代理 (subagent_type: gsd:researcher)
       → 传入过期的研究信息
       → 收到 researcher 结果后 → 调用 MCP tool `orchestrator-handle-researcher-result`
       → 回到步骤 1

     dispatch_debugger:
       → 使用 Agent tool 派发 debugger 子代理 (subagent_type: gsd:debugger)
       → 传入 debug_target
       → 收到 debugger 结果后 → 调用 MCP tool `orchestrator-handle-debugger-result`
       → 回到步骤 1

     trigger_review:
       → 直接派发 reviewer，scope 和 targets 从 action 响应中获取
       → 回到步骤 1

     complete_phase:
       → 调用 MCP tool `phase-complete`，传入 phase_id + run_verify: true
       → 回到步骤 1 (编排器会自动推进到下一 phase)

     retry_executor:
       → 重新调用 orchestrator-resume 获取更新后的 executor 上下文
       → 回到步骤 1

     rollback_to_dirty_phase:
       → 编排器已自动回滚 current_phase，输出回滚通知
       → 回到步骤 1

     continue_execution:
       → 直接回到步骤 1

  3. 终止条件 — 遇到以下 action 时退出循环:

     idle              → 输出 "无可执行任务"，停止
     awaiting_user     → 展示 blockers / drift 信息，等待用户输入
     await_manual_intervention → 展示需要人工干预的信息，停止
     noop (completed)  → 展示完成报告，停止
     await_recovery_decision (failed) → 展示失败信息和恢复选项，停止

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
- 前置校验必须在恢复执行前完成，不可跳过
- 校验覆写 workflow_mode 时，首个命中生效，不累积
- awaiting_user / reconcile_workspace / replan_required 模式下不自动执行代码
- 只有编排器写 state.json，子代理不直接写
- 上下文 < 35% → 保存状态 + workflow_mode = awaiting_clear + 停止执行
- **进入自动执行循环后，不要在循环中间停下来等用户 — 让编排器驱动**
</EXTREMELY-IMPORTANT>
