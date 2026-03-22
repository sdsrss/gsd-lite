# 状态机图参考

## 1. Task 生命周期

### 状态转换表

| 当前状态 | 允许的目标状态 |
|----------|---------------|
| `pending` | `running`, `blocked` |
| `running` | `checkpointed`, `blocked`, `failed` |
| `checkpointed` | `accepted`, `needs_revalidation` |
| `accepted` | `needs_revalidation` |
| `blocked` | `pending` |
| `failed` | `pending` |
| `needs_revalidation` | `pending` |

### Mermaid 图

```mermaid
stateDiagram-v2
    [*] --> pending

    pending --> running : 编排器选中执行
    pending --> blocked : executor 报告阻塞

    running --> checkpointed : executor 完成 checkpoint
    running --> blocked : executor 运行时阻塞
    running --> failed : executor 执行失败

    checkpointed --> accepted : reviewer 审查通过 / L0 自动接受
    checkpointed --> needs_revalidation : 上游返工触发失效传播

    accepted --> needs_revalidation : 上游 contract 变更触发失效传播

    blocked --> pending : 阻塞解除 (用户干预/自动匹配 decision)

    failed --> pending : 重置后重试 (debugger 建议/用户干预)

    needs_revalidation --> pending : 重新排入执行队列
```

### 关键路径说明

- **正常路径**: `pending -> running -> checkpointed -> accepted`
- **阻塞路径**: `pending -> blocked -> pending -> running` (解除阻塞后重入)
- **失败-重试路径**: `running -> failed -> pending -> running` (retry_count 递增)
- **返工路径**: `accepted -> needs_revalidation -> pending -> running` (contract 变更触发)
- **审查返工**: `checkpointed -> needs_revalidation -> pending -> running` (reviewer 要求返工)

来源: `TASK_LIFECYCLE` in `src/schema.js`

---

## 2. Phase 生命周期

### 状态转换表

| 当前状态 | 允许的目标状态 |
|----------|---------------|
| `pending` | `active` |
| `active` | `reviewing`, `blocked`, `failed` |
| `reviewing` | `accepted`, `active` |
| `accepted` | *(终态，无后续转换)* |
| `blocked` | `active` |
| `failed` | *(终态，无后续转换)* |

### Mermaid 图

```mermaid
stateDiagram-v2
    [*] --> pending

    pending --> active : 前置 phase 完成 / 首个 phase 自动激活

    active --> reviewing : 所有 task 完成，触发 phase review
    active --> blocked : 外部依赖阻塞
    active --> failed : 不可恢复失败 (debugger 报告架构问题)

    reviewing --> accepted : reviewer 审查通过 + handoff gate 满足
    reviewing --> active : reviewer 发现 critical issues，需要返工

    blocked --> active : 阻塞解除

    accepted --> [*]
    failed --> [*]
```

### 关键路径说明

- **正常路径**: `pending -> active -> reviewing -> accepted`
- **返工路径**: `active -> reviewing -> active -> reviewing -> accepted` (最多循环)
- **失败路径**: `active -> failed` (终态，不可恢复)
- **Phase 推进**: 当前 phase `accepted` 后，下一个 `pending` phase 自动转为 `active`

来源: `PHASE_LIFECYCLE` in `src/schema.js`

---

## 3. Phase 审查状态

### 允许的状态值

```
pending -> reviewing -> accepted
                    \-> rework_required
```

| 状态 | 含义 |
|------|------|
| `pending` | 初始状态，尚未开始审查 |
| `reviewing` | 审查进行中 |
| `accepted` | 审查通过 |
| `rework_required` | 审查发现 critical issues，需要返工 |

### Mermaid 图

```mermaid
stateDiagram-v2
    [*] --> pending

    pending --> reviewing : 触发 phase review

    reviewing --> accepted : 无 critical issues
    reviewing --> rework_required : 有 critical issues

    rework_required --> reviewing : 返工完成后重新审查
```

### 与 Phase Lifecycle 的关系

- `phase_review.status` 是 phase 对象内的子状态
- `phase_review.retry_count` 记录审查返工次数: 无 critical 时重置为 0，有 critical 时递增
- `handleReviewerResult` 中: 有 critical -> `rework_required`; 无 critical -> `accepted`
- 审查 accepted 且 scope 为 phase 时，同时设置 `phase_handoff.required_reviews_passed = true`

来源: `PHASE_REVIEW_STATUS` in `src/schema.js`, `handleReviewerResult()` in `src/tools/orchestrator.js`

---

## 4. Workflow Mode 状态机

### 所有模式

| 模式 | 含义 |
|------|------|
| `planning` | 计划阶段 |
| `executing_task` | 正在执行 task |
| `reviewing_task` | L2 task 即时审查中 |
| `reviewing_phase` | L1 phase 批量审查中 |
| `awaiting_clear` | 上下文不足，等待 /clear |
| `awaiting_user` | 等待用户干预 (阻塞/方向漂移) |
| `paused_by_user` | 用户主动暂停 |
| `reconcile_workspace` | git HEAD 不匹配，需要工作区协调 |
| `replan_required` | 计划文件被外部修改，需要重新规划 |
| `research_refresh_needed` | 研究缓存过期，需刷新 |
| `completed` | 所有 phase 完成 (终态) |
| `failed` | 工作流失败 (终态) |

### Mermaid 图 (主要转换)

```mermaid
stateDiagram-v2
    [*] --> planning

    planning --> executing_task : init 完成

    executing_task --> reviewing_task : L2 task checkpointed
    executing_task --> reviewing_phase : phase 内所有 task 完成
    executing_task --> awaiting_user : task blocked / 方向漂移
    executing_task --> awaiting_clear : 上下文 < 35%
    executing_task --> failed : debugger 报告架构问题

    reviewing_task --> executing_task : 审查完成 (通过或返工)
    reviewing_phase --> executing_task : 审查返工 (有 critical)
    reviewing_phase --> completed : 最终 phase 审查通过

    awaiting_clear --> executing_task : /clear + /resume 后恢复
    awaiting_user --> executing_task : 用户解除阻塞 / 自动匹配 decision

    state preflight_overrides <<choice>>
    executing_task --> preflight_overrides : resume 时 preflight 检测
    preflight_overrides --> reconcile_workspace : git HEAD 不匹配
    preflight_overrides --> replan_required : 计划文件被修改
    preflight_overrides --> research_refresh_needed : 研究缓存过期
    preflight_overrides --> awaiting_user : 方向漂移检测

    research_refresh_needed --> executing_task : 研究刷新完成
    research_refresh_needed --> reviewing_task : 刷新后恢复审查状态
    research_refresh_needed --> reviewing_phase : 刷新后恢复审查状态

    paused_by_user --> executing_task : 用户恢复

    completed --> [*]
    failed --> [*]
```

### 关键转换说明

**执行主路径**:
`planning -> executing_task -> reviewing_phase -> executing_task (next phase) -> ... -> completed`

**L2 审查分支**:
`executing_task -> reviewing_task -> executing_task`

**上下文耗尽路径**:
`executing_task -> awaiting_clear -> executing_task` (需要 /clear + /resume)

**Preflight 覆盖 (resume 时检测)**:
`resumeWorkflow()` 执行 `evaluatePreflight()` 检测以下条件 (按优先级):
1. git HEAD 不匹配 -> `reconcile_workspace`
2. 计划文件被外部修改 -> `replan_required`
3. 方向漂移 -> `awaiting_user`
4. 研究缓存过期 -> `research_refresh_needed`

**Research 刷新后恢复**:
`storeResearch()` 中: 如果 `workflow_mode === 'research_refresh_needed'`，调用 `inferWorkflowModeAfterResearch()` 根据 `current_review` 状态推断恢复到 `reviewing_phase` / `reviewing_task` / `executing_task`。

来源: `WORKFLOW_MODES` in `src/schema.js`, `resumeWorkflow()`, `evaluatePreflight()` in `src/tools/orchestrator.js`, `storeResearch()` in `src/tools/state/`
