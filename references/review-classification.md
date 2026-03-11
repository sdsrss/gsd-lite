# 审查级别分类参考

## 静态分类 (计划时)

| 级别 | 适用场景 | 审查方式 |
|------|---------|---------|
| L0 | 无运行时语义变化 (docs/config/style) | checkpoint 后直接 accepted |
| L1 | 普通编码任务 (默认) | phase 结束后批量审查 |
| L2 | 高风险 (auth/payment/public API/DB migration) | checkpoint 后立即独立审查 |

## 运行时重分类

触发条件 (L1 -> L2 升级):
1. executor 报告 `contract_changed: true` 且 task name 匹配敏感关键词
2. executor decisions 中包含 `[LEVEL-UP]` 标注 (字符串或 `decision.summary` 中包含)

敏感关键词正则 (`SENSITIVE_KEYWORDS`):

```
/\b(auth|payment|security|public.?api|login|token|credential|session|oauth)\b/i
```

规则: 只升不降 (安全优先)。当前级别为 L2 或 L3 时直接保持不变。

## 决策树

```
task.level 当前值?
├── L2 或 L3 -> 保持不变 (不降级)
└── L0 或 L1
    ├── executor decisions 含 [LEVEL-UP]? -> 升级为 L2
    ├── contract_changed: true + task.name 匹配敏感关键词? -> 升级为 L2
    └── 否 -> 保持当前级别
```

来源: `reclassifyReviewLevel()` in `src/tools/state.js`

## 审查流程

### L0 流程

```
executor checkpointed
  -> handleExecutorResult 检测 reviewLevel === 'L0'
  -> auto_accepted = true
  -> 编排器直接 accepted (persist lifecycle: 'accepted', done +1)
  -> 释放下游依赖
```

不派发 reviewer。`review_required: false` 的 task 同样走此路径。

### L1 流程

```
executor checkpointed
  -> workflow_mode 保持 'executing_task'
  -> 继续执行其他 task
  -> phase 内所有 runnable task 完成后
  -> selectRunnableTask 返回 { mode: 'trigger_review' }
  -> 编排器设置 workflow_mode = 'reviewing_phase'
  -> 派发 reviewer (scope='phase', review_level='L1-batch')
  -> 批量审查所有 checkpointed task (排除 L0)
```

### L2 流程

```
executor checkpointed
  -> handleExecutorResult 检测 reviewLevel === 'L2' && review_required !== false
  -> 设置 current_review = { scope: 'task', scope_id: task.id, stage: 'spec' }
  -> workflow_mode = 'reviewing_task'
  -> 派发 reviewer (scope='task', review_level='L2')
  -> 审查通过后才释放下游依赖
```

## Reviewer 结果处理

| 审查结果 | 编排器行为 |
|----------|-----------|
| 无 critical issues | accepted_tasks 标记为 `accepted`; phase_review.status = `accepted` |
| 有 critical issues | rework_tasks 标记为 `needs_revalidation`; phase_review.status = `rework_required` |
| critical + `invalidates_downstream` | 触发 `propagateInvalidation`: 所有下游依赖 task -> `needs_revalidation` + 清空 evidence_refs |

来源: `handleReviewerResult()` in `src/tools/orchestrator.js`, `reviewer.md` in `agents/`
