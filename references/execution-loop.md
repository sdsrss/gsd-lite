# Execution Loop -- Canonical Specification

本文件是执行循环的唯一 source of truth。所有 command 文件 (start.md, prd.md, resume.md) 引用此文件。

---

### 11.1 — 加载 phase 计划

```
for each pending phase:
  加载 phase 计划 + todo DAG
```

### 11.2 — 选择 runnable task

选择条件:
- `lifecycle` 属于 `{pending, needs_revalidation}`
- `requires` 中每个依赖都满足对应 gate
- 不被 unresolved blocker 阻塞
- 未超过 retry 上限

如果 0 个 runnable task 且 phase 未完成:
```
├── 全部 blocked → workflow_mode = awaiting_user，展示所有 blocker
└── 全部等待 review → 触发 batch review (L1) 或等待 L2 review 完成
```

### 11.3 — 构建 executor 上下文 + 串行派发

executor 上下文传递协议 (orchestrator → executor):
```
├── task_spec:           从 phases/*.md 提取当前 task 的规格段落
├── research_decisions:  从 research_basis 引用的 decision 摘要
├── predecessor_outputs: 前置依赖 task 的 files_changed + checkpoint_commit
├── project_conventions: CLAUDE.md 路径 (executor 自行读取)
├── workflows:           需加载的工作流文件路径 (如 tdd-cycle.md, deviation-rules.md; retry 时追加 debugging.md; 有 research_basis 时追加 research.md)
├── constraints:         retry_count / level / review_required
├── debugger_guidance:   debugger 分析结果 (root_cause / fix_direction / fix_attempts / evidence)，仅在 debug_context 存在时提供，否则 null
└── rework_feedback:     reviewer 返工反馈 (issue 描述数组)，仅在 last_review_feedback 存在时提供，否则 null
```

派发 `executor` 子代理执行单个 task。

### 11.4 — 处理 executor 结果

严格按 agent result contract 处理:
```
├── checkpointed → 写入 checkpoint commit + evidence refs → 进入审查 (11.5)
├── blocked      → 写入 blocked_reason / unblock_condition
│                  → 编排器检查 decisions 数组，能自动回答则重新派发
│                  → 不能回答 → workflow_mode = awaiting_user，向用户转达
├── failed       → retry_count + 1
│                  → 未超限 → 重新派发 executor
│                  → 超限 (3次) 或返回 [FAILED] 且错误指纹重复
│                    或修复尝试未收敛 → 触发 debugger (见下方)
```

**Debugger 触发流程:**
1. 编排器派发 `debugger` 子代理，传入: 错误信息 + executor 修复尝试记录 + 相关代码路径
2. debugger 返回: 根因分析 + 修复方向建议
3. 编排器决定:
   - 带修复方向重新派发 executor
   - 标记 task failed
   - 标记 phase failed

**Decisions 累积:**
- executor 返回 `[DECISION]` → 编排器追加到 `state.json` 的 `decisions` 数组
- 每条 decision 记录: `id` / `task` / `summary` / `phase`
- decisions 跨 task、跨 phase、跨 `/clear` + `/gsd:resume` 持久保留
- 编排器收到 `[BLOCKED]` 时，先查 `decisions` 数组尝试自动回答

### 11.5 — 分层审查

```
├── L0: checkpoint commit 后可直接 accepted (无需 reviewer)
├── L1: phase 结束后批量 reviewer 审查
│       → 派发 reviewer 子代理，scope = phase
└── L2: checkpoint commit 后立即独立审查
        → 派发 reviewer 子代理，scope = task
        → 未 accepted 前不释放其下游依赖
```

**审查级别运行时重分类:**
- executor 报告 `contract_changed: true` + 涉及 auth/payment/public API → 自动升级为 L2
- executor 标注 `[LEVEL-UP]` → 编排器采纳
- 不主动降级 (安全优先)，L1 + high confidence + 有 evidence 且无测试失败 → L0 例外

### 11.6 — 处理 reviewer 结果

```
├── 无 Critical → 更新 accepted 状态 + evidence refs
└── 有 Critical → 标记返工 task + 失效传播 → 重新审查 (最多 3 轮)
```

**返工失效传播规则:**
- 返工修改了 contract / schema / shared behavior:
  → 所有直接和间接依赖 task → `needs_revalidation`
  → 清空其旧 `evidence_refs`
  → 已 accepted 则退回到 `checkpointed` 或 `pending_review`
- 返工只影响局部实现、外部契约未变:
  → 下游 task 保持现状
  → 但受影响验证范围必须重跑并刷新 evidence
- 触发判定: `contract_changed` (executor 运行时报告) 是主触发源
  `invalidate_downstream_on_change` (planner 静态标记) 是预判辅助
  → executor 报告 `contract_changed: true` → 一定传播
  → planner 标记但 executor 报告 false → 不传播 (以运行时实际为准)

### 11.7 — Phase handoff gate

<HARD-GATE id="phase-handoff">
所有条件必须满足才能进入下一 phase:
- [ ] 所有 required task = `accepted`
- [ ] required review = `passed`
- [ ] critical issues = 0
- [ ] tests/lint/typecheck 满足计划验证条件
- [ ] 方向校验: 当前阶段产出是否仍与 plan.md 中的项目目标一致？

→ 全部满足 → 自动进入下一阶段
→ 任一不满足 → 标注问题，尝试修复，3 次失败停止
→ 方向漂移 → workflow_mode = awaiting_user，展示偏差让用户决定
</HARD-GATE>

### 11.8 — 批量更新 state.json

阶段完成后，编排器批量更新 state.json:
- 更新 phase lifecycle → `accepted`
- 更新 phase_handoff 信息
- 归档旧 phase 的 evidence (仅保留当前 phase)
- 推进 `current_phase` 到下一个 pending phase

**规则:** 只有编排器写 state.json，避免并发竞态。

### 11.9 — 上下文检查

每次派发子代理前和阶段切换时检查上下文健康度:

```
remaining <= 35%:
  1. 保存完整状态到 state.json
  2. workflow_mode = awaiting_clear
  3. 输出: "上下文剩余 <=35%，已保存进度。请执行 /clear 然后 /gsd:resume 继续"
  4. 停止执行

remaining <= 25%:
  1. 紧急保存状态到 state.json
  2. workflow_mode = awaiting_clear
  3. 输出: "上下文即将耗尽，已保存进度。请立即执行 /clear 然后 /gsd:resume"
  4. 立即停止
```

> **Note:** 上述 35%/25% 阈值为编排器主动发起上下文保存的建议阈值。Resume 时的恢复阻断阈值为 `CONTEXT_RESUME_THRESHOLD = 40`（服务端强制校验），低于 40% 时 resume 会拒绝恢复并要求 /clear。

---

## 依赖门槛语义 (Gate-aware dependencies)

```json
{ "kind": "task",  "id": "2.2", "gate": "checkpoint" }     // 低风险内部串接
{ "kind": "task",  "id": "2.3", "gate": "accepted" }        // 默认安全门槛
{ "kind": "phase", "id": 2,     "gate": "phase_complete" }  // 跨 phase 依赖
```

- `checkpoint` — 允许依赖未独立验收的实现检查点；只适合低风险内部串接
- `accepted` — 默认安全门槛；适合共享行为、公共接口、L2 风险任务
- `phase_complete` — 跨 phase 依赖；只有 phase handoff 完成后才释放
- 默认值: 如果 planner 没显式放宽，则依赖按 `accepted` 处理
