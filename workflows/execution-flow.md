# 共享执行流程 (STEP 5-12)

> 由 start.md 和 prd.md 共享引用。修改此文件即同步两个入口。

## STEP 5 — 智能研究判断

判断是否需要研究:
```
├── 新项目                    → 必须研究
├── 涉及新技术栈              → 必须研究
├── 简单 bug 修复 / 小功能    → 跳过研究
├── 已有 .gsd/research/ 且未过期 → 跳过研究
├── 用户明确要求               → 研究
└── 已有研究但需求方向变了     → 增量研究 (只研究新方向)
```

需要研究时:
1. 派发 `researcher` 子代理 (新鲜上下文)
2. 研究输出写入 `.gsd/research/` (STACK.md, ARCHITECTURE.md, PITFALLS.md, SUMMARY.md)
3. 向用户展示关键发现: 技术栈推荐 + 陷阱警告 + ⭐ 推荐方案

不需要时: 跳过，直接进入 STEP 6。

## STEP 6 — 深度思考

如有 `sequential-thinking` MCP 可用 → 调用深入思考:
- 输入: 需求摘要 + 代码库分析 + 研究结果 (如有)
- 目的: 在生成计划前进行系统性架构思考

如无 `sequential-thinking` MCP → 降级为内联思考，继续。

## STEP 7 — 生成分阶段计划

生成 plan.md + phases/*.md:
- **phase** 负责管理与验收，**task** 负责执行
- 每阶段控制在 **5-8 个 task** (便于 phase-level 收口)
- 每个 task = 原子化 todo (含文件、操作、验证条件)
- 每个 task 补充元数据:
  - `requires` — 依赖列表 (含 gate 类型)
  - `review_required` — 是否需要审查
  - `research_basis` — 引用的 research decision id
- 审查级别按影响面判定:
  - **L0** — 无运行时语义变化 (docs/config/style)
  - **L1** — 普通编码任务 (默认)
  - **L2** — 高风险 (auth/payment/public API/DB migration/核心架构)
- 标注可并行任务组 `[PARALLEL]` (当前仅作未来升级标记)

## STEP 8 — 计划自审

轻量自审 (编排器自身执行，不派发子代理):

### 基础审查 (所有项目)
- [ ] 是否有遗漏的需求点？
- [ ] 阶段划分是否合理？(phase 过大则拆分)
- [ ] 任务依赖关系是否正确？
- [ ] 验证条件是否可执行？

### 增强审查 (高风险项目)

触发条件: 项目涉及 auth / payment / security / public API / DB migration / 核心架构变更

维度:
1. **需求覆盖:** 原始需求的每个要点是否都映射到了至少一个 task？
2. **风险排序:** 高风险 task 是否排在前面？(fail-fast 原则)
3. **依赖安全:** L2 task 的下游是否都用了 `gate:accepted`？
4. **验证充分:** 涉及 auth/payment 的 task 是否都有明确的安全验证条件？
5. **陷阱规避:** `research/PITFALLS.md` 中的每个陷阱是否都有对应的防御 task 或验证条件？

输出: `pass` / `revise` (附具体修正建议)
轮次: 最多 2 轮自审修正；2 轮后仍有问题 → 标注风险展示给用户

→ 自审修正后再展示给用户。

<HARD-GATE id="plan-confirmation">
## STEP 9 — 用户确认计划

展示计划给用户，等待确认:
- 用户指出问题 → 调整计划 → 重新展示
- 用户确认 → 继续

⛔ 不得在用户确认前执行 STEP 10-12。未确认 = 不写文件、不执行代码。
</HARD-GATE>

<HARD-GATE id="docs-written">
## STEP 10 — 生成文档

1. 调用 `state-init` MCP 工具初始化项目:
   ```
   state-init({
     project: "<项目名>",
     phases: [
       {
         name: "<阶段名>",
         tasks: [
           { name: "<任务名>", level: "L1", review_required: true, requires: [] },
           ...
         ]
       },
       ...
     ]
   })
   ```
   ⚠️ 必须使用 `state-init` MCP 工具，禁止手写 state.json — 工具自动生成 id/lifecycle/phase_review/phase_handoff，内置 schema 校验和循环依赖检测。
2. 写入 `plan.md` — 项目总览索引 (不含 task 级细节)
3. 写入 `phases/*.md` — 每阶段详细 task 规格 (source of truth)
4. 如有研究: 确认 `.gsd/research/` 已写入

规则:
- `plan.md` 是只读索引: 生成后不再修改 (除非 replan)
- `phases/*.md` 是 task 规格的唯一 source of truth
- `plan.md` 不包含 task 级细节，避免与 `phases/*.md` 重复

□ state-init 调用成功 (返回 success: true)
□ plan.md 已写入
□ phases/*.md 已写入 (每个 phase 一个文件)
□ 所有 task 都有 lifecycle / level / requires / review_required
→ 全部满足才可继续
</HARD-GATE>

## STEP 11 — 自动执行主路径

进入执行主循环。phase = 管理边界，task = 执行边界。

<execution_loop>
参考 `references/execution-loop.md` 获取完整 9 步执行循环规范 (11.1-11.9) 及依赖门槛语义。

编排器必须严格按照该参考文档中的步骤顺序执行:
加载 phase → 选择 task → 构建上下文 → 派发 executor → 处理结果 → 审查 → phase handoff → 批量更新 → 上下文检查

**自动执行循环:** 进入执行后，持续循环直到遇到终止条件:
1. 调用 `orchestrator-resume` 获取 action
2. 按 action 执行对应操作 (见下方 action 处理表)
3. 操作完成后回到步骤 1
4. 终止: action ∈ {idle, awaiting_user, completed, failed, await_manual_intervention}

不要在循环中间停下来等用户确认 — 让编排器驱动。

**Action 处理表:**

| action | 操作 |
|--------|------|
| `dispatch_executor` | 派发 `executor` 子代理执行 task → 结果调用 `orchestrator-handle-executor-result` |
| `dispatch_reviewer` | 派发 `reviewer` 子代理审查 → 结果调用 `orchestrator-handle-reviewer-result` |
| `dispatch_debugger` | 派发 `debugger` 子代理调试 → 结果调用 `orchestrator-handle-debugger-result` |
| `dispatch_researcher` | 派发 `researcher` 子代理研究 → 结果调用 `orchestrator-handle-researcher-result` |
| `retry_executor` | 重新派发 executor (带 retry 上下文)，同 dispatch_executor |
| `complete_phase` | 调用 `phase-complete` MCP tool (参数见下方) → 自动推进下一 phase |
| `rework_required` | 有 task 需要返工 → 继续循环 (resume 会自动选择返工 task) |
| `review_accepted` | 审查通过 → 继续循环 |
| `continue_execution` | L0/auto-accept 后 → 继续循环 |
| `replan_required` | 计划文件被修改。**自动处理:** 确认计划无误后，调用 `state-update({updates: {workflow_mode: "executing_task"}})` → 继续循环 |
| `reconcile_workspace` | Git HEAD 不一致。检查变更，调用 `state-update({updates: {git_head: "<当前HEAD>", workflow_mode: "executing_task"}})` → 继续循环 |
| `rollback_to_dirty_phase` | 早期 phase 有失效 task。**自动处理:** 继续循环 (resume 已回滚 current_phase) |
| `idle` | 当前 phase 无可运行 task。检查 task 状态和依赖关系，必要时向用户报告 |
| `await_recovery_decision` | 工作流处于 failed 状态。向用户展示失败信息和恢复选项 (retry/skip/replan) |

**`phase-complete` 参数:**
```
phase-complete({
  phase_id: <当前 phase 编号>,
  run_verify: true,          // 自动运行 lint/typecheck/test
  direction_ok: true         // 方向校验通过 (如有偏差设为 false)
})
```
如果没有 lint/typecheck/test 工具，可改用 `verification` 参数传入预计算结果:
```
phase-complete({
  phase_id: <phase>,
  verification: { lint: {exit_code: 0}, typecheck: {exit_code: 0}, test: {exit_code: 0} },
  direction_ok: true
})
```
</execution_loop>

## STEP 12 — 最终报告

全部 phase 完成后，输出最终报告:
- 项目总结
- 各阶段完成情况
- 关键 decisions 汇总
- 验证 evidence 汇总
- 遗留问题 / 后续建议 (如有)
