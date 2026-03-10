---
name: gsd-prd
description: Start project from requirements document or description text
arguments:
  path_or_description: File path to requirements doc, or inline description text
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

<!-- 以下 STEP 5-12 同 gsd-start.md -->

## STEP 5: 智能判断是否需要研究

- 新项目 / 涉及新技术栈 → 必须研究
- 简单 bug 修复 / 已有研究且未过期 → 跳过
- 用户明确要求 → 研究
- 需要时 → 派发 gsd-researcher 子代理 → 展示关键发现
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

## STEP 11: 进入自动执行主路径

按 §4.3 执行流程自动推进:
- 加载 phase 计划 + todo DAG
- 选择 runnable task → 构建 executor 上下文 → 派发 gsd-executor 子代理
- 处理执行结果 (checkpointed / blocked / failed)
- 分层审查 (L0/L1/L2)
- phase handoff gate 校验
- 批量更新 state.json
- 上下文健康度检查 (< 40% → 保存状态暂停)

## STEP 12: 全部完成

- 输出最终报告: 项目名、完成阶段数、总 task 数、关键决策摘要
- 写入 workflow_mode = completed

</process>

<EXTREMELY-IMPORTANT>
## 编排器纪律
- 只有编排器写 state.json，子代理不直接写
- 所有摘要/提示在展示时从 canonical fields 推导，不持久化 derived fields
- 子代理返回结构化 JSON，不解析自然语言
- 上下文 < 40% → 保存状态 + workflow_mode = awaiting_clear + 停止执行
</EXTREMELY-IMPORTANT>
