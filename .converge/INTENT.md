# INTENT — gsd-lite

> 项目宪法。由 converge 第一轮阅读 README / package.json / CLAUDE.md / 源码归纳生成。
> **只有人能改这个文件**；converge 轮次只读不写。有错请直接修改。

## 是什么

`gsd-lite` — 给 Claude Code 用的 AI 编排工具（npm 包 + Claude Code 插件）。
把一个多阶段项目拆成 phase / task，用一台 12 状态的工作流机推进：
派执行器写代码 → 自审 → 独立评审 → 验证 → 进入下一个 task/phase。
核心卖点是"讨论充分、执行自动"：人只在需求讨论和计划批准两处介入。

## 给谁用

使用 Claude Code 的开发者。通过 `/plugin install gsd`、`npx gsd-lite install`
或手动 `node cli.js install` 安装到 `~/.claude/`。

## 架构与主流程

```
用户 → /gsd:start 讨论需求 + 研究 → 批准计划 → 自动执行
                                        (code → review → verify → advance)
```

- **MCP 服务器**（`src/server.js`，stdio JSON-RPC，11 个工具）是唯一的状态入口。
- **状态单一真相**：项目根的 `.gsd/state.json`。白名单 canonical 字段 + schema 校验 +
  `_version` 乐观并发 + 文件锁 + 原子写。
- **编排层**（`src/tools/orchestrator/`）把 executor / reviewer / researcher / debugger
  四类子代理的结果落盘并决定下一步动作。
- **状态层**（`src/tools/state/`）负责 CRUD、计划增量 patch、任务调度与依赖传播。
- **钩子**（`hooks/*.cjs`）在用户真实会话里跑：SessionStart 注入项目状态、Stop 写崩溃标记、
  StatusLine 显示进度、PostToolUse 监控上下文、以及 24h 一次的自动更新检查。
- **安装器**（`install.js` / `uninstall.js`）幂等，区分 plugin 模式与 npx/手动模式。

## 功能清单（对外契约，不得擅自改动）

1. 6 个斜杠命令：`/gsd:start` `/gsd:prd` `/gsd:resume` `/gsd:status` `/gsd:stop` `/gsd:doctor`
2. 4 个子代理：executor / reviewer / researcher / debugger
3. 6 个 workflow + 8 个 reference 文档（随包分发，agent 运行时读取）
4. 11 个 MCP 工具：health, state-init, state-read, state-update, state-patch,
   phase-complete, orchestrator-resume, orchestrator-handle-{executor,reviewer,researcher,debugger}-result
5. 5 个钩子 + StatusLine（composite 模式与其它插件共存）
6. CLI：`gsd` / `gsd serve` / `gsd install` / `gsd uninstall` / `gsd update` / `gsd help`
7. 环境变量：`GSD_NO_CLAUDEMD_STATUS=1`、`GSD_DEBUG=1`
8. 错误码契约：`STATE_EXISTS` `INVALID_INPUT` `VALIDATION_FAILED` `HANDOFF_GATE`
   `VERSION_CONFLICT` `NO_PROJECT_DIR` 等结构化返回，不得退化成裸异常

## 必须保留的行为

- MCP 外部边界必须继续剥掉未声明参数（`sanitizeToolArgs`），远程调用方不能通过注入
  `basePath` 把服务器指向 `process.cwd()` 以外的目录。
- `state-init` 在已有 state.json 时必须拒绝（除非 `force: true`）。
- 安装器幂等：重复安装不需要先卸载；不覆盖用户已有的 statusLine / 其它插件的钩子。
- SessionStart 往项目 `CLAUDE.md` 注入的状态块是 marker 包裹的幂等替换，
  绝不能碰 marker 以外的用户内容；`GSD_NO_CLAUDEMD_STATUS=1` 可完全关闭。
- 钩子不得把非协议内容写进 stdout，不得因异常让用户会话失败。

## 明确不做的事

- 不在状态层执行外部命令（lint/test 由调用方跑完把结果传进来，`run_verify` 只做断言）。
- 不自动 push / 不自动发版 / 不碰生产数据。
- 不把 `docs/` 纳入版本控制（`.gitignore:65`，本地设计稿）。

## 验证命令

| 用途 | 命令 |
|------|------|
| test | `npm test`（node:test，`tests/*.test.js`） |
| lint | `npm run lint`（biome，覆盖 `src/ tests/ hooks/`） |
| typecheck | none（纯 JS，无 TS） |
| build | none |
| coverage | `npm run test:coverage`（c8 闸门：80% lines / 75% branches） |

## 已知边界

- `tests/*.md` 是人工 E2E 剧本，不进 `npm test`，无自动执行。
- `docs/` 被 gitignore，任何指向它的链接对读者都是 404。
