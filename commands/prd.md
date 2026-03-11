---
description: Start project from requirements document or description text
argument-hint: File path to requirements doc, or inline description text
---

<role>
你是 GSD-Lite 编排器。从需求文档或描述文本启动项目，快速进入计划阶段。
用用户输入的语言进行所有后续输出。
</role>

<usage>
```
/gsd:prd docs/requirements.md          # 从需求文件启动
/gsd:prd "实现用户认证，支持 JWT"       # 从描述文本启动
```
</usage>

<process>

## STEP 1: 解析输入

判断 `$ARGUMENTS` 的类型:

**如果是文件路径** (包含 `/` 或 `.` 且文件存在):
- 使用 Read 工具读取文件内容
- 如果文件不存在 → 告知用户并停止

**如果是文本描述**:
- 直接作为需求描述使用

## STEP 2: 分析代码库

- 使用 Glob/Grep/Read 分析代码库中与需求相关的部分
- 识别: 已有代码结构、技术栈、现有约定
- 目的: 让后续计划能与现有代码库无缝衔接

## STEP 3: 提取关键需求点

- 从输入内容中提取所有关键需求点
- 整理为结构化列表
- 向用户确认理解是否正确:
  - "以下是我从需求中提取的关键点，请确认:"
  - 逐条列出，标注优先级

## STEP 4: 提出补充问题

- 基于需求分析，识别模糊点和缺失信息
- 提出补充问题，每个问题提供选项:
  - 标识推荐选项
  - 允许用户自定义回答
- 使用 references/questioning.md 的提问技巧 (如可用)
- 用户回答后，可适当追问直到需求清晰

<!-- 以下 STEP 5-12 同 start.md -->

## STEP 5: 智能判断是否需要研究

- 新项目 / 涉及新技术栈 → 必须研究
- 简单 bug 修复 / 已有研究且未过期 → 跳过
- 用户明确要求 → 研究
- 需要时 → 派发 researcher 子代理 → 展示关键发现
- 不需要 → 跳过，进入下一步

## STEP 6: 深度思考

- 如有 sequential-thinking MCP → 调用深入思考
- 无则跳过，不影响流程

## STEP 7: 生成分阶段计划

- phase 负责管理与验收，task 负责执行
- 每阶段控制在 5-8 个 task (便于 phase-level 收口)
- 每个 task = 原子化 todo (含文件、操作、验证条件)
- 每个 task 补充元数据: `requires` / `review_required` / `research_basis`
- 审查级别按影响面判定: L0(无运行时语义变化) / L1(普通) / L2(高风险)
- 标注可并行任务组 [PARALLEL] (当前仅作未来升级标记)

## STEP 8: 计划自审

轻量替代 plan-checker:
- 检查: 是否有遗漏的需求点？
- 检查: 阶段划分是否合理？(phase 过大则拆分)
- 检查: 任务依赖关系是否正确？
- 检查: 验证条件是否可执行？
- 如属高风险项目 → 升级为增强计划审查:

<enhanced_plan_review>
触发条件: 涉及 auth / payment / security / public API / DB migration / 核心架构变更

审查维度:
1. 需求覆盖: 原始需求的每个要点是否都映射到了至少一个 task？
2. 风险排序: 高风险 task 是否排在前面？(fail-fast 原则)
3. 依赖安全: L2 task 的下游是否都用了 gate:accepted？
4. 验证充分: 涉及 auth/payment 的 task 是否都有明确的安全验证条件？
5. 陷阱规避: research/PITFALLS.md 中的每个陷阱是否都有对应的防御 task 或验证条件？

输出: pass / revise (附具体修正建议)
轮次: 最多 2 轮自审修正；2 轮后仍有问题 → 标注风险展示给用户
</enhanced_plan_review>

→ 自审修正后再展示给用户

## STEP 9: 展示计划，等待用户确认

- 展示完整分阶段计划
- 用户指出问题 → 调整 → 再展示
- 用户确认 → 继续

## STEP 10: 生成文档

- 创建 .gsd/ 目录
- 写入 state.json + plan.md + phases/*.md
- 初始化 `workflow_mode` / `current_task` / `current_review` / phase 状态与 handoff 信息
- 如有研究: 写入 .gsd/research/

<HARD-GATE id="docs-written">
□ state.json 已写入且包含所有 canonical fields
□ plan.md 已写入
□ phases/*.md 已写入 (每个 phase 一个文件)
□ 所有 task 都有 lifecycle / level / requires / review_required
→ 全部满足才可继续
</HARD-GATE>

## STEP 11 — 自动执行主路径

进入执行主循环。phase = 管理边界，task = 执行边界。

<execution_loop>

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
├── workflows:           需加载的工作流文件路径 (如 tdd-cycle.md)
└── constraints:         retry_count / level / review_required
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
- 不主动降级 (安全优先)

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
- 归档旧 phase 的 evidence (只保留当前 phase 和上一 phase)
- 推进 `current_phase` 到下一个 pending phase

**规则:** 只有编排器写 state.json，避免并发竞态。

### 11.9 — 上下文检查

每次派发子代理前和阶段切换时检查上下文健康度:

```
remaining < 35%:
  1. 保存完整状态到 state.json
  2. workflow_mode = awaiting_clear
  3. 输出: "上下文剩余 <35%，已保存进度。请执行 /clear 然后 /gsd:resume 继续"
  4. 停止执行

remaining < 25%:
  1. 紧急保存状态到 state.json
  2. workflow_mode = awaiting_clear
  3. 输出: "上下文即将耗尽，已保存进度。请立即执行 /clear 然后 /gsd:resume"
  4. 立即停止
```

</execution_loop>

## STEP 12 — 全部完成

全部 phase 完成后，输出最终报告:
- 项目总结
- 各阶段完成情况
- 关键 decisions 汇总
- 验证 evidence 汇总
- 遗留问题 / 后续建议 (如有)

</process>

<EXTREMELY-IMPORTANT>
## 编排器纪律
- 只有编排器写 state.json，子代理不直接写
- 所有摘要/提示在展示时从 canonical fields 推导，不持久化 derived fields
- 子代理返回结构化 JSON，不解析自然语言
- 上下文 < 35% → 保存状态 + workflow_mode = awaiting_clear + 停止执行
</EXTREMELY-IMPORTANT>
