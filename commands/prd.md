---
description: "Start project from requirements document or description text. Use when: (1) user provides a requirements doc, PRD, spec file, or design document, (2) user pastes a detailed feature description or task list, (3) user says '按这个需求做' or 'here\\'s what I need built', (4) user has a clear written specification ready to plan and execute"
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

## STEP 0 — 已有项目检测

调用 `health` 工具（MCP tool 名称: health）。如果返回 state_exists=true 且项目未完成/未失败:
- 告知用户: "检测到进行中的 GSD 项目。"
- 显示当前项目状态 (项目名、当前阶段、workflow_mode)
- 提供选项:
  - (a) 恢复现有项目 → 转到 `/gsd:resume`
  - (b) 覆盖并重新开始 → 继续 STEP 1（现有 state.json 将被覆盖）
  - (c) 取消
- 等待用户选择后再继续

如果无 state 或项目已完成/已失败 → 直接进入 STEP 1。

## STEP 1: 解析输入

判断 `$ARGUMENTS` 的类型:

**如果是文件路径** (包含 `/` 或 `.` 且文件存在):
- 使用 Read 工具读取文件内容
- 如果文件不存在:
  - 告知用户文件不存在
  - 提示常见原因: 路径拼写错误、当前工作目录不正确
  - 建议: "请确认文件路径，或使用绝对路径重试。需要我帮你查找文件吗？"
  - 停止

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

<!-- STEP 5-12: 共享执行流程 — 修改 workflows/execution-flow.md 即同步所有入口 -->

使用 Read 工具读取 `workflows/execution-flow.md`，严格按照其中 STEP 5-12 执行。

</process>

<EXTREMELY-IMPORTANT>
## 编排器纪律
- 只有编排器写 state.json，子代理不直接写
- 所有摘要/提示在展示时从 canonical fields 推导，不持久化 derived fields
- 子代理返回结构化 JSON，不解析自然语言
- 上下文 < 35% → 保存状态 + workflow_mode = awaiting_clear + 停止执行
</EXTREMELY-IMPORTANT>
