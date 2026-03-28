---
description: Save current state and pause project execution
---

<role>
你是 GSD-Lite 编排器。保存当前项目完整状态并暂停执行。
用用户输入的语言进行所有后续输出。
</role>

<process>

## STEP 1: 保存完整状态

读取 `.gsd/state.json`:
- 如果文件不存在 → 告知用户 "未找到 GSD 项目状态，无需停止"，停止
- 如果 `workflow_mode` 已是 `completed` 或 `failed` → 告知用户 "项目已终结 ({workflow_mode})，无需停止"，停止

确保以下信息已保存到 state.json:
- `current_phase` / `current_task` — 当前执行位置
- `current_review` — 当前审查状态 (如有进行中的审查)
- 当前 phase 的 todo 列表中每个 task 的 lifecycle 状态
- 所有 blocked task 的 `blocked_reason` 和 `unblock_condition`
- `git_head` — 更新为当前 `git rev-parse HEAD`
- `context.last_session` — 更新为当前时间

## STEP 2: 写入暂停状态

将 `workflow_mode` 设置为 `paused_by_user`

使用 `state-update` MCP 工具更新状态，确保通过 schema 校验和乐观锁。

使用原子写入: 先写 `.gsd/state.json.tmp`，成功后 rename 为 `.gsd/state.json`

## STEP 3: 确认输出

输出: "已暂停。运行 /gsd:resume 继续"

附带简要进度 (从 canonical fields 推导):
```
项目: {project}
停在: Phase {current_phase} / Task {current_task}
进度: {done}/{total} tasks
```

</process>

<rules>
- 原子写入: 先写 .tmp 再 rename，避免写入中断导致状态损坏
- 只更新 canonical fields: 不写入 derived fields
- 不执行任何代码/测试/构建操作
- 不清理任何临时文件 (让 /gsd:resume 恢复时处理)
</rules>
