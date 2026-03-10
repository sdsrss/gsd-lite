# CLAUDE.md — GSD-Lite

## 项目概述

GSD-Lite: AI 编排工具，面向 Claude Code。GSD 管理外壳 + Superpowers 质量内核。

## 技术栈

- **运行时:** Node.js (ES Modules)
- **协议:** MCP Server (状态管理)
- **目标平台:** Claude Code
- **状态格式:** JSON (state.json)
- **提示词格式:** Markdown (commands/agents/workflows)

## 目录结构

```
src/           → MCP Server + 工具 (server, schema, state CRUD, verify, utils)
commands/      → 5 个 slash 命令 (start, prd, resume, status, stop)
agents/        → 4 个子代理 (executor, reviewer, researcher, debugger)
workflows/     → 5 个工作流 (tdd-cycle, review-cycle, debugging, research, deviation-rules)
references/    → 4 个参考文档
hooks/         → 上下文监控 (StatusLine + PostToolUse)
tests/         → 227 个单元测试 + 11 个 E2E checklist
docs/          → 设计文档 + 工程任务清单 + 校准记录
```

## 核心约定

- **状态单一真相:** 只有编排器写 state.json；canonical fields 白名单控制
- **Agent 结果契约:** executor/reviewer/researcher 返回结构化 JSON，不解析自然语言
- **依赖门槛:** checkpoint (低风险) / accepted (默认) / phase_complete (跨阶段)
- **审查分级:** L0 自审 / L1 阶段批量 / L2 即时独立
- **lifecycle 状态机:** task: pending→running→checkpointed→accepted; phase: pending→active→reviewing→accepted

## 编码规范

- 使用 ES Modules (`import/export`)
- 原子写入 JSON (先写 .tmp 再 rename)
- 错误处理: 返回结构化错误，不抛异常到调用方
- 包管理器: 从 lockfile 自动检测 (pnpm/yarn/npm)

## 测试

```bash
npm test                    # 运行全部 227 个单元测试
node --test tests/state.test.js  # 运行单个测试文件
```

测试覆盖: schema 校验、state CRUD、lifecycle 转换、evidence 存储、gate 调度、返工传播、审查重分类、decisions 累积、研究刷新、上下文构建、result contract、verify 工具

## 关键设计文档

- `docs/gsd-lite-design.md` — v3.5 完整设计方案 (1482行)
- `docs/gsd-lite-engineering-tasks.md` — 38 个工程任务 (5 Phase, 全部完成)
- `docs/calibration-notes.md` — 上下文阈值与 TTL 校准记录

## 不要做

- 不要手动编辑 state.json 的 derived fields
- 不要让子代理直接写 state.json (只有编排器写)
- 不要跳过 lifecycle 状态转换校验
- 不要在 plan.md 中放 task 级细节 (那是 phases/*.md 的职责)

<!-- claude-mem-lite: auto-updated context. To avoid git noise, add CLAUDE.md to .gitignore -->
<claude-mem-context>
### Last Session
Request: /clear

### Key Context
- [bugfix] Error while working on utils.test.js, evidence.test.js, propagation.test.js +4 … (#1712)
- [refactor] Make runTypeCheck async and clarify verify.js configuration (#1710)
- [change] Modified agents, utils.js, schema.js (#1707)
- [bugfix] Skill: {"success":true,"commandName":"superpowers:reques… (#1692)
- [change] Project finalization: update repo metadata and verify test suite (#1691)

</claude-mem-context>
