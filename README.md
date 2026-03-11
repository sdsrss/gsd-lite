# GSD-Lite

> GSD 的管理外壳 + Superpowers 的质量内核，砍掉 65% 开销，实现低交互自动执行

GSD-Lite 是一个面向 Claude Code 的 AI 编排工具，将 [GSD](https://github.com/sdsrss/get-shit-done-cc) 的项目管理能力与 Superpowers 的质量纪律整合为一个精简、科学、高效的自动化开发系统。

## 核心理念

```
用户 → 讨论+研究(确认需求) → 审批方案 → 自动执行(编码→自审→审查→验证→推进)
         ↑                      ↑             ↑
      主交互1               主交互2        常态自动推进
```

**讨论充分，执行自动。** 需求讨论可多轮深入，方案确认后全自动执行。

## 与当前 GSD 的对比

| 维度 | GSD | GSD-Lite |
|------|-----|----------|
| 命令数 | 32 个 | **5 个** |
| Agent 数 | 12 个 | **4 个** |
| 源文件 | 100+ 个 | **~27 个** |
| 安装器 | 2465 行 | **~80 行** |
| 用户交互 | 6+ 次确认 | **常态 2 次** |
| TDD / 反合理化 / 质量纪律 | ❌ | ✅ |

## 5 个命令

| 命令 | 用途 |
|------|------|
| `/gsd:start` | 交互式启动：讨论→研究→计划→自动执行 |
| `/gsd:prd <需求>` | 从需求文档/描述快速启动 |
| `/gsd:resume` | 从断点恢复执行 |
| `/gsd:status` | 查看项目进度 |
| `/gsd:stop` | 保存状态并暂停 |

## 4 个 Agent

| Agent | 职责 | 内置纪律 |
|-------|------|---------|
| **executor** | 执行单 task (TDD + 自审 + checkpoint) | 铁律 + 红旗 + 偏差规则 |
| **reviewer** | 双阶段审查 (规格→质量) | 独立验证 + HARD-GATE |
| **researcher** | 生态系统研究 (Context7→官方文档→WebSearch) | 置信度标注 |
| **debugger** | 4 阶段系统性根因分析 | 根因铁律 |

## 核心能力

- **上下文腐败防护** — 子代理隔离 + task 边界 + StatusLine 监控 + `/clear` + `/gsd:resume`
- **规格驱动开发** — plan.md 索引 + phases/*.md 规格 → executor 精确执行
- **分阶段执行** — phase 管理边界 + task 执行边界 + gate-aware 依赖调度
- **分层审查** — L0 自审 / L1 阶段批量 / L2 即时独立审查
- **TDD 铁律** — NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST (含合理例外)
- **反合理化** — 红旗列表内联到每个 Agent，封堵跳过流程的借口
- **返工失效传播** — contract_changed → 下游 task 自动 needs_revalidation
- **状态机恢复** — state.json 持久化，11 种 workflow_mode 精确恢复

## 安装

```bash
# 方式一：Claude Code 插件市场 (推荐)
/plugin marketplace add sdsrss/gsd-lite
/plugin install gsd

# 方式二：npx
npx gsd-lite install

# 方式三：手动
git clone https://github.com/sdsrss/gsd-lite.git
cd gsd-lite && npm install && node cli.js install
```

**方式一** 通过 Claude Code 内置插件系统，自动注册命令、Agent、工作流、MCP Server 和 Hooks。

**方式二/三** 通过安装脚本，把组件写入 `~/.claude/` 并注册 MCP Server 到 settings.json。卸载：`node cli.js uninstall`

## 更新 / 升级

```bash
# 插件方式
/plugin update gsd

# 源码方式
git pull && npm install && node cli.js install

# npx 方式
npx gsd-lite install
```

- 安装器支持重复执行，通常**不需要先卸载**
- 从旧版 (gsd-lite) 升级会自动清理旧文件
- 更新后建议重启 Claude Code 或重开会话，以加载最新 MCP server / hooks

## 快速开始

```bash
# 交互式启动
/gsd:start

# 从需求文档启动
/gsd:prd docs/requirements.md

# 从描述启动
/gsd:prd "实现用户认证系统，支持 JWT + OAuth2"
```

## 项目结构

```
gsd-lite/
├── .claude-plugin/         # Claude Code 插件元数据
│   ├── plugin.json         # 插件清单
│   └── marketplace.json    # 插件市场目录
├── .mcp.json               # MCP Server 配置 (插件系统)
├── src/                    # MCP Server + 工具层 (~1100行)
│   ├── server.js           # MCP Server (4 tools 注册)
│   ├── schema.js           # State schema + lifecycle 校验
│   ├── utils.js            # 共享工具 (原子写入, 路径, git)
│   └── tools/
│       ├── state.js        # State CRUD + evidence + 传播逻辑
│       └── verify.js       # lint/typecheck/test 验证
├── commands/               # 5 个 slash 命令 (~850行 Markdown)
├── agents/                 # 4 个子代理 (~325行 Markdown)
├── workflows/              # 5 个核心工作流 (~760行 Markdown)
├── references/             # 4 个参考文档 (~400行 Markdown)
├── hooks/                  # 上下文监控 (StatusLine + PostToolUse)
│   ├── context-monitor.js  # Hook 实现
│   └── hooks.json          # Hook 配置 (插件系统)
├── cli.js                  # 安装/卸载 CLI 入口
├── tests/                  # 456 个测试 (387 单元 + 69 E2E)
├── install.js              # 安装脚本 (手动/npx 方式)
└── uninstall.js            # 卸载脚本
```

**~29 个交付文件 | ~1100 行代码 | ~2300 行 Markdown | 109 个测试**

## 文档

- [设计方案 v3.5](docs/gsd-lite-design.md) — 完整架构与协议规范
- [工程任务清单](docs/gsd-lite-engineering-tasks.md) — 38 个实施任务 (5 Phase, 全部完成)
- [指标校准记录](docs/calibration-notes.md) — 上下文阈值与 TTL 校准

## License

MIT

