---
name: gsd-status
description: Display project progress overview derived from canonical state fields
---

<role>
你是 GSD-Lite 状态展示器。从 state.json 读取 canonical fields，推导并展示项目进度概览。
用用户输入的语言进行所有后续输出。
</role>

<process>

## STEP 1: 读取状态

读取 `.gsd/state.json`:
- 如果文件不存在 → 告知用户 "未找到 GSD 项目状态，请先运行 /gsd:start 或 /gsd:prd"，停止
- 如果文件损坏 → 告知用户并停止

## STEP 2: 展示进度面板

从 canonical fields 实时推导所有展示数据 (不使用任何 derived/cached 值):

### 项目概览

```
项目: {project}
工作流模式: {workflow_mode}
计划版本: {plan_version}
```

### 总体进度

- 从 `phases` 数组推导:
  - 总 phase 数: `total_phases`
  - 已完成 phase 数: lifecycle=accepted 的 phase 数量
  - 总 task 数: 所有 phase 的 `tasks` 之和
  - 已完成 task 数: 所有 phase 的 `done` 之和
  - 进度百分比: `已完成 task / 总 task * 100`

```
进度: ████████░░░░ {done}/{total} tasks ({percentage}%)
阶段: {completed_phases}/{total_phases} phases
```

### 各阶段状态

遍历 `phases` 数组，展示每个 phase:

```
Phase {id}: {name}
  状态: {lifecycle}
  任务: {done}/{tasks}
  审查: {phase_review.status} (如有)
  交接: {phase_handoff 各项状态}
```

### 当前活跃任务

- 从 `current_phase` + `current_task` 推导:

```
当前任务: {current_task} — {task_name}
任务状态: {task.lifecycle}
审查级别: {task.level}
重试次数: {task.retry_count}
```

### 审查状态

- 如果 `current_review` 存在:

```
审查中: {current_review.scope} — {current_review.scope_id}
审查阶段: {current_review.stage}
```

### Blocked 摘要

- 遍历当前 phase 的 todo，找出 lifecycle=blocked 的 task:

```
Blocked 任务:
  - {task_id}: {blocked_reason}
    解除条件: {unblock_condition}
```

如无 blocked task → 不显示此段

### 下一步操作建议

根据 `workflow_mode` 推导:

| workflow_mode | 建议 |
|---|---|
| executing_task | "自动执行中，等待完成" |
| reviewing_task | "L2 审查进行中" |
| reviewing_phase | "L1 阶段审查进行中" |
| awaiting_clear | "请执行 /clear 然后 /gsd:resume 继续" |
| awaiting_user | "有 blocked 问题需要用户决策，运行 /gsd:resume 查看详情" |
| paused_by_user | "已暂停，运行 /gsd:resume 继续" |
| reconcile_workspace | "工作区不一致，运行 /gsd:resume 进行 reconcile" |
| replan_required | "计划需要更新，运行 /gsd:resume 查看详情" |
| research_refresh_needed | "研究已过期，运行 /gsd:resume 刷新" |
| completed | "项目已完成" |
| failed | "项目执行失败，运行 /gsd:resume 查看详情" |

</process>

<rules>
- 只读操作: 不修改 state.json，不修改任何文件
- 只使用 canonical fields: 所有展示数据从 canonical fields 实时推导
- 不展示 derived/cached 值: 每次执行时重新计算
- 不展示敏感信息: evidence 中的命令输出仅展示摘要
</rules>
