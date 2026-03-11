# GSD-Lite 设计方案 v3.5

> 目标: GSD 的管理外壳 + Superpowers 的质量内核，砍掉 65% 开销，实现低交互自动执行

---

## 一、核心设计理念

### 当前 GSD 的问题本质

```
当前: 用户 → 讨论 → 研究(等) → 计划 → 检查计划(等×3) → 执行 → 自检 → 验证(等) → UAT(等)
                     ↑              ↑                              ↑        ↑
                  用户等待        用户等待                        用户等待  用户等待
```

问题不是 GSD 的思路错了，而是**交互模型错了**——把"质量保障"实现为"人工检查站"，导致自动化链条被打断。

### GSD-Lite 的设计原则

```
Lite: 用户 → 讨论+研究(确认需求) → 审批方案 → 自动执行主路径(编码→自审→阶段审查→验证→推进)
               ↑                      ↑             ↑
            主交互1               主交互2        常态自动推进
            (可多轮)              (可调整)       (异常时少量补充交互)
```

**原则:**
1. **讨论充分，执行自动** — 需求讨论可多轮深入，方案确认后全自动执行
2. **研究先行，智能决策** — 保留生态系统研究能力 (技术栈/架构/陷阱)，用 sequential-thinking 深入思考
3. **上下文是弹药，不是记录** — 只加载当前阶段需要的内容，不加载历史
4. **JSON 状态，Markdown 计划** — 机器读 JSON（快），人读 Markdown（友好）
5. **phase 是管理边界，task 是执行边界** — 计划按 phase 组织，executor 按 task 执行
6. **分层审查循环** — task 先自审，phase 再按 L0/L1/L2 进入不同审查路径
7. **失败时停，blocked 时显式恢复** — 出错或关键不确定性时暂停并记录状态
8. **语言跟随用户** — 用户用什么语言输入，就用什么语言回复

---

## 二、与当前 GSD 的对比

| 维度 | 当前 GSD | GSD-Lite |
|------|----------|----------|
| **命令数** | 32 个 slash 命令 | 5 个 |
| **Agent 数** | 12 个子代理 | 4 个 (executor, reviewer, researcher, debugger) |
| **工作流文件** | 33 个 | 精简保留核心工作流 |
| **参考文档** | 14 个 | 精简保留核心参考 (questioning, tdd, verification) |
| **库模块** | 11 个 .cjs 文件 (~5,200行) | MCP Server + Bash 脚本 (~400行) |
| **状态格式** | STATE.md (YAML frontmatter + Markdown body 双编码) | state.json (纯 JSON) |
| **用户交互** | 6+ 次确认/审批 | 常态 2 次主交互；异常路径少量补充 |
| **状态更新** | 7 次 CLI 调用/计划 | 1 次批量写入/阶段 |
| **支持运行时** | 4 个 | 1 个 (Claude Code) |
| **安装方式** | `npx get-shit-done` | 插件安装 / npx / 手动 |
| **安装器** | 2465 行 | ~80 行 |
| **语言遵从** | 硬编码英文输出 | 跟随用户输入语言 |
| **研究能力** | ✅ 4 个并行研究子代理 | ✅ 保留 (智能调度) |
| **深度思考** | ❌ 无 | ✅ sequential-thinking MCP |
| **代码审查** | ⚠️ 基础 verifier | ✅ 独立双阶段审查 (规格→质量) |
| **TDD 支持** | ❌ 无 | ✅ 铁律 + tdd-cycle 工作流 |
| **反合理化** | ❌ 无 | ✅ 铁律+红旗 内联到每个 Agent |
| **质量纪律** | ❌ 无 | ✅ Superpowers 三层整合模型 |

---

## 三、架构设计

### 3.1 整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                         用户层                                │
│  /gsd:start  /gsd:prd  /gsd:resume  /gsd:status  /gsd:stop  │
├──────────────────────────────────────────────────────────────┤
│                    编排层 (命令 Markdown)                      │
│  start.md: 交互式讨论→研究→计划→自动执行                       │
│  prd.md: 从需求文档/描述启动→研究→计划→自动执行                 │
│  resume.md: 从 state.json 恢复执行                            │
├──────────────────────────────────────────────────────────────┤
│                    执行层 (子代理)                              │
│  gsd-executor.md: 执行单任务 (当前串行调度, 未来可并行)          │
│  gsd-reviewer.md: 双阶段审查 (规格+质量)                       │
│  gsd-researcher.md: 生态系统研究 (技术栈/架构/陷阱)             │
│  gsd-debugger.md: 系统性调试 (根因分析)                        │
├──────────────────────────────────────────────────────────────┤
│                    工具层 (MCP Server + Bash)                   │
│  MCP: state.json CRUD + 批量更新 (结构化输入输出)              │
│  Bash: verify.js 验证脚本 (测试/lint/类型检查)                 │
├──────────────────────────────────────────────────────────────┤
│                   外部 MCP 集成 (可选)                          │
│  sequential-thinking: 深度思考 (计划前调用, 无则降级)           │
│  context7: 技术文档查询 (研究时调用, 无则 WebSearch)            │
├──────────────────────────────────────────────────────────────┤
│                   监控层 (Hook)                                │
│  StatusLine: 读取 remaining_percentage → .gsd/.context-health  │
│  PostToolUse: <40% 注入警告 / <20% 注入紧急停止                │
├──────────────────────────────────────────────────────────────┤
│                  数据层 (.gsd/)                                │
│  state.json + plan.md + phases/*.md + research/               │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 文件结构

```
gsd-lite/
├── package.json
├── README.md
├── install.js               # 插件安装脚本
├── uninstall.js              # 插件卸载脚本
├── src/
│   ├── server.js            # 轻量 MCP Server (状态管理工具)
│   ├── tools/
│   │   ├── state.js         # 状态管理 (JSON CRUD + 批量更新)
│   │   └── verify.js        # 验证脚本 (测试/lint/类型检查, Bash 调用)
│   └── utils.js             # 共享工具 (slug, git, paths)
├── commands/
│   ├── gsd-start.md         # 交互式启动: 讨论→研究→计划→执行
│   ├── gsd-prd.md           # 文档启动: 需求文档→研究→计划→执行
│   ├── gsd-resume.md        # 恢复: 从断点继续
│   ├── gsd-status.md        # 状态: 进度概览
│   └── gsd-stop.md          # 停止: 保存状态暂停
├── agents/
│   ├── gsd-executor.md      # 执行器: 执行单 task
│   ├── gsd-reviewer.md      # 审查器: 规格审查 + 质量审查
│   ├── gsd-researcher.md    # 研究器: 生态系统/技术栈研究
│   └── gsd-debugger.md      # 调试器: 系统性根因分析
├── workflows/
│   ├── research.md          # 研究流程 (Context7→官方文档→WebSearch)
│   ├── review-cycle.md      # 分层审查循环 (task 自审→L2 即时审查/L1 阶段批量审查)
│   ├── tdd-cycle.md         # RED-GREEN-REFACTOR 循环 (来自 Superpowers TDD)
│   ├── debugging.md         # 4阶段根因分析流程 (来自 Superpowers systematic-debugging)
│   └── deviation-rules.md   # 偏差处理规则 (自动修/停止/标注)
├── references/
│   ├── questioning.md       # 提问技巧 (来自 GSD 原版)
│   ├── anti-rationalization-full.md  # 完整合理化表 (来自 Superpowers, 按需读取)
│   ├── git-worktrees.md     # Git Worktree 工作流 (可选, 来自 Superpowers)
│   └── testing-patterns.md  # 测试模式 + 覆盖率指南
└── hooks/
    └── context-monitor.js   # 上下文监控 + clear/resume 提示信号
```

**总计: ~27 个文件，对比当前 100+ 个文件 (精简 73%，功能更强)**

**工作流文件 vs agent 内联规则的分工:**
- agent 内联 (`<rules>` / `<EXTREMELY-IMPORTANT>` 等): 核心纪律，每次执行必须遵守
- 工作流文件 (workflows/*.md): 扩展指南，agent 按需加载
  - tdd-cycle.md: TDD 边界案例处理、mock 策略、测试粒度指南 (超出铁律的实操细节)
  - review-cycle.md: 批量审查的组织方式、审查报告模板
  - debugging.md: 4 阶段根因分析的详细步骤、日志分析技巧
  - research.md: 研究源优先级的详细判定、缓存策略
  - deviation-rules.md: 偏差分类与处理决策树
- 规则: 如果工作流文件内容与 agent 内联规则冲突，以 agent 内联为准



### 3.3 数据目录结构

```
.gsd/                           # 项目级数据目录 (替代 .planning/)
├── state.json                  # 机器状态 (JSON, 非 Markdown)
├── plan.md                     # 项目总览 (只读索引，不含 task 规格)
├── research/                   # 研究输出 (保留 GSD 原版能力)
│   ├── STACK.md               # 技术栈推荐
│   ├── ARCHITECTURE.md        # 架构模式
│   ├── PITFALLS.md            # 领域陷阱
│   └── SUMMARY.md             # 研究摘要 + 路线图建议
└── phases/
    ├── 01-setup-auth.md        # 阶段详细规格 (task 规格的 source of truth)
    ├── 02-user-api.md          # (完成后追加执行摘要到同一文件)
    └── 03-frontend.md

**plan.md vs phases/*.md 的关系:**

plan.md 是**项目总览索引**，phases/*.md 是**阶段详细规格**。两者不重叠：

| 文件 | 内容 | 用途 | 谁读 |
|------|------|------|------|
| plan.md | 项目目标、阶段列表、阶段间依赖、全局约束 | 用户审批、方向校验 | 用户 + orchestrator |
| phases/*.md | 每个 task 的详细规格、验收条件、技术约束 | executor 执行依据 | orchestrator + executor |

规则:
- plan.md 是只读索引：生成后不再修改（除非 replan）
- phases/*.md 是 task 规格的 **唯一 source of truth**
- executor 上下文协议中的 `task_spec` 从 phases/*.md 提取，不从 plan.md 提取
- 阶段完成后，执行摘要追加到对应 phases/*.md 末尾（不覆盖规格部分）
- plan.md 不包含 task 级细节，避免与 phases/*.md 内容重复导致不一致
```

**state.json 结构 (v3.5 完整协议版):**

```json
{
  "project": "my-app",
  "workflow_mode": "reviewing_task",
  "plan_version": 4,
  "git_head": "abc1234",
  "current_phase": 2,
  "current_task": "2.3",
  "current_review": { "scope": "task", "scope_id": "2.3", "stage": "spec" },
  "total_phases": 5,
  "phases": [
    {
      "id": 1,
      "name": "setup-auth",
      "lifecycle": "accepted",
      "tasks": 4,
      "done": 4,
      "phase_handoff": {
        "required_reviews_passed": true,
        "tests_passed": true,
        "critical_issues_open": 0
      }
    },
    {
      "id": 2,
      "name": "user-api",
      "lifecycle": "active",
      "phase_review": { "status": "pending", "retry_count": 0 },
      "tasks": 6,
      "done": 2,
      "todo": [
        {
          "id": "2.1",
          "name": "Create user model",
          "lifecycle": "accepted",
          "level": "L1",
          "requires": [],
          "retry_count": 0,
          "review_required": true,
          "verification_required": true,
          "checkpoint_commit": "c1a2b3",
          "research_basis": ["decision:jwt-rotation"],
          "evidence_refs": ["ev:test:user-model", "ev:typecheck:phase-2"]
        },
        {
          "id": "2.3",
          "name": "Create user update endpoint",
          "lifecycle": "blocked",
          "level": "L2",
          "requires": [
            { "kind": "task", "id": "2.2", "gate": "accepted" }
          ],
          "retry_count": 1,
          "review_required": true,
          "verification_required": true,
          "checkpoint_commit": null,
          "blocked_reason": "Need decision on optimistic locking",
          "unblock_condition": "orchestrator answers from plan or user confirms strategy",
          "evidence_refs": [],
          "invalidate_downstream_on_change": true
        }
      ],
      "phase_handoff": {
        "required_reviews_passed": false,
        "tests_passed": false,
        "critical_issues_open": 1
      }
    }
  ],
  "decisions": [
    { "id": "d:auth-strategy", "task": "2.1", "summary": "选择 JWT 而非 session", "phase": 2 },
    { "id": "d:db-choice", "task": "1.1", "summary": "PostgreSQL for DB", "phase": 1 }
  ],
  "context": {
    "last_session": "2026-03-09T10:30:00Z",
    "remaining_percentage": 31
  },
  "research": {
    "completed": true,
    "stack": "Next.js + PostgreSQL + Prisma",
    "volatility": "medium",
    "expires_at": "2026-03-16T10:30:00Z",
    "key_pitfalls": ["N+1 queries with Prisma", "JWT refresh token rotation"],
    "decision_index": {
      "decision:jwt-rotation": {
        "summary": "Use refresh token rotation",
        "source": "Context7",
        "expires_at": "2026-03-16T10:30:00Z"
      }
    }
  },
  "evidence": {
    "ev:test:user-model": {
      "command": "pnpm test user-model",
      "scope": "task:2.1",
      "exit_code": 0,
      "timestamp": "2026-03-09T10:25:00Z",
      "summary": "user model tests passed"
    }
  }
}
```

**为什么用 JSON 不用 Markdown:**
- 解析: `JSON.parse()` 一行代码 vs 45+ 个正则表达式
- 无歧义: 不会因格式变化而解析失败
- 批量更新: 一次 `writeFileSync()` 替代 7 次 CLI 调用
- 可恢复: `/gsd:resume` 不用猜测当前停在哪个工作流状态
- 单一真相: 生命周期字段只保留一份 canonical state，避免 accepted/status 双写漂移
- 原子化 todo 清单: 每个任务有独立状态、依赖门槛、重试计数与证据引用
- AI 同样能读懂 JSON

**canonical fields vs derived fields:**
- canonical: `workflow_mode` / `current_phase` / `current_task` / `current_review` / `task.lifecycle` / `phase.lifecycle` / `phase_review.status` / `decisions` / `context.last_session` / `context.remaining_percentage`
- derived (展示时动态推导，不持久化): 总进度、blocked 摘要、下一步提示、stopped_at 描述、next_action 描述、状态面板展示文本
- 规则: 编排器只写 canonical fields；所有摘要/提示在展示时从 canonical 推导，避免多份真相漂移
- 示例: `stopped_at` 可从 `current_phase + current_task` 推导；`next_action` 可从 `workflow_mode + todo DAG` 推导

**decisions 累积规则:**
- executor 返回 `[DECISION]` 时，编排器追加到 `decisions` 数组
- 每条 decision 记录: `id` / `task` (来源 task) / `summary` / `phase`
- decisions 跨 task、跨 phase、跨 `/clear` + `/gsd:resume` 持久保留
- 编排器收到 `[BLOCKED]` 时，先查 `decisions` 数组尝试自动回答
- phase handoff 时不清理 decisions；项目完成时归档到最终报告

**关键状态机模式:**
- `planning` — 讨论/研究/计划阶段
- `executing_task` — 正在派发某个 task 给 executor
- `reviewing_task` — 正在做 L2 单任务审查
- `reviewing_phase` — 正在做 L1 阶段批量审查
- `awaiting_clear` — 因上下文阈值暂停，等用户 `/clear`
- `awaiting_user` — 有 `[BLOCKED]` 且编排器无法自动决策
- `paused_by_user` — 用户主动 `/gsd:stop`
- `reconcile_workspace` — 恢复时发现 Git/workspace 与记录不一致
- `replan_required` — plan_version 已失配
- `research_refresh_needed` — 研究缓存已过期或失效
- `completed` / `failed` — 工作流结束

**task lifecycle 合法值:**
`pending` → `running` → `checkpointed` → `accepted`
                    ↘ `blocked` (可从 pending/running 进入)
                    ↘ `failed` (超过 retry 上限)
`accepted` → `needs_revalidation` (被返工失效传播触发) → `pending`

**phase lifecycle 合法值:**
`pending` → `active` → `reviewing` → `accepted`
                   ↘ `blocked` (所有 task 都 blocked)
                   ↘ `failed` (关键 task 失败且无法恢复)

**evidence pruning 策略:**
- state.json 只保留当前 phase 和上一 phase 的 evidence
- 更早 phase 的 evidence 归档到 `.gsd/evidence-archive.json`
- 归档在 phase handoff 完成后自动执行

---

## 四、核心流程设计

### 4.1 两种启动方式

**方式一: `/gsd:start` — 交互式启动**
```
/gsd:start
    │
    ├── STEP 1: 讨论 (用户交互 — 可多轮)
    │   ├── "你想做什么？" (开放式)
    │   ├── 分析代码库相关部分
    │   ├── 向用户提出问题选项 (标识 ⭐推荐选项)
    │   ├── 用户回答 → 跟进追问 → 直到需求清晰
    │   └── 整理需求摘要，确认理解
    │
    ├── STEP 2: 研究 (自动)
    │   ├── 智能判断是否需要研究 (简单任务跳过)
    │   ├── 需要时: 派发 gsd-researcher 子代理
    │   │     ├── Context7 查询技术文档
    │   │     ├── 分析生态系统 (技术栈/架构/陷阱)
    │   │     └── 输出 .gsd/research/ 文件
    │   └── 研究结果反馈给用户 (关键发现 + 推荐)
    │
    ├── STEP 3: 深度思考 + 计划 (用户审批)
    │   ├── 如有 sequential-thinking MCP → 调用深入思考
    │   ├── 生成分阶段计划 (含 todo 原子化清单)
    │   ├── 展示计划给用户
    │   ├── 用户指出问题 → 调整方案 → 再次展示
    │   └── 用户确认 → 生成文档 + 路线图 → 进入执行
    │
    └── STEP 4: 自动执行主路径 (常态低交互)
        (见 4.3 执行流程)
```

**方式二: `/gsd:prd <需求文档或描述>` — 文档启动**
```
/gsd:prd "docs/requirements.md"
/gsd:prd "实现一个用户认证系统，支持 JWT + OAuth2"
    │
    ├── STEP 1: 解析需求 (自动)
    │   ├── 读取需求文档或解析描述文本
    │   ├── 分析代码库相关部分
    │   ├── 提取关键需求点
    │   └── 向用户确认理解 + 提出补充问题 (标识 ⭐推荐选项)
    │
    ├── STEP 2-4: 同 /gsd:start 的 STEP 2-4
    └── ...
```

### 4.2 研究流程 (保留 GSD 核心能力)

```
研究触发条件 (智能判断):
  ├── 新项目 → 必须研究
  ├── 涉及新技术栈 → 必须研究
  ├── 简单 bug 修复 → 跳过研究
  ├── 已有研究且未过期 → 跳过研究
  ├── 用户明确要求 → 研究
  └── 已有研究但需求方向变了 → 增量研究 (只研究新方向)

研究过期规则 (默认启发式，不是固定定律):
  ├── 中等波动领域默认 TTL = 7 天
  ├── 前端/云服务/安全领域 → TTL 更短 (如 3 天)
  ├── 稳定后端/企业内部领域 → TTL 可更长 (如 14-30 天)
  ├── package.json 主依赖大版本有变更 → 立即过期
  └── 用户说 "重新研究" → 强制过期

研究刷新后的 decision ID 处理:
  ├── 新研究产生的 decision 与旧 ID 相同且结论一致 → 保留引用，更新 expires_at
  ├── 新研究产生的 decision 与旧 ID 相同但结论变了 → 标记所有引用该 decision 的 task 为 needs_revalidation
  ├── 旧 decision ID 在新研究中不再存在 → 标记引用 task 为 needs_revalidation + 警告编排器
  └── 新研究产生了全新 decision ID → 不影响已有 task，供后续 planning 使用

研究执行:
  ├── 派发 gsd-researcher 子代理 (新鲜上下文)
  │     ├── 源层级: Context7 → 官方文档 → WebSearch
  │     ├── 输出: STACK.md, ARCHITECTURE.md, PITFALLS.md, SUMMARY.md
  │     └── 每个发现标注置信度 (HIGH/MEDIUM/LOW) + 失效时间
  │
  └── 研究结果摘要展示给用户:
        "研究发现: Next.js 14+ 推荐 App Router，
         ⚠️ 陷阱: Prisma 在 serverless 环境有连接池问题
         ⭐ 推荐: 使用 Prisma Accelerate 或连接池中间件"
```

### 4.3 执行流程 (自动)

```
for each pending phase:
  │
  ├── 1. 加载 phase 计划 + todo DAG
  │     phase = 管理边界
  │     task  = 执行边界
  │
  ├── 2. 选择 runnable task:
  │     - lifecycle ∈ {pending, needs_revalidation}
  │     - requires 中每个依赖都满足对应 gate
  │     - 不被 unresolved blocker 阻塞
  │     - 未超过 retry 上限
  │     - 如果 0 个 runnable task 且 phase 未完成:
  │       → 全部 blocked → workflow_mode = awaiting_user，展示所有 blocker
  │       → 全部等待 review → 触发 batch review (L1) 或等待 L2 review 完成
  │
  ├── 3. 构建 executor 上下文 + 串行派发 (当前实现)
  │     ⚠️ Claude Code 当前按串行调度设计。
  │     [PARALLEL] 只作为未来升级标记，不影响当前正确性。
  │
  │     executor 上下文传递协议 (orchestrator → executor):
  │     ├── task_spec: 从 phases/*.md 提取当前 task 的规格段落
  │     ├── research_decisions: 从 research_basis 引用的 decision 摘要
  │     ├── predecessor_outputs: 前置依赖 task 的 files_changed + checkpoint_commit
  │     ├── project_conventions: CLAUDE.md 路径 (executor 自行读取)
  │     ├── workflows: 需加载的工作流文件路径 (如 tdd-cycle.md)
  │     └── constraints: retry_count / level / review_required
  │
  ├── 4. 单 task 执行结果 (严格按 agent result contract 处理):
  │     ├── ✅ checkpointed → 写入 checkpoint commit + evidence refs
  │     ├── ⛔ blocked      → 写入 blocked_reason / unblock_condition
  │     ├── ❌ failed       → retry_count +1，超限则派发 debugger (见下方)
  │     └── 🔍 debugger 触发: executor 连续 3 次 failed 或返回 [FAILED]
  │           → 编排器派发 gsd-debugger 子代理
  │           → debugger 返回根因分析 + 修复建议
  │           → 编排器决定: 重新派发 executor (带修复方向) / 标记 phase failed
  │
  ├── 5. 分层审查:
  │     ├── L0: checkpoint commit 后可直接 accepted
  │     ├── L1: phase 结束后批量 reviewer 审查
  │     └── L2: checkpoint commit 后立即独立审查，
  │              未 accepted 前不释放其下游依赖
  │
  ├── 6. reviewer 返回 Critical？
  │     ├── 否 → 更新 accepted 状态 + evidence refs
  │     └── 是 → 标记返工 task + 失效传播 → 重新审查 (最多 3 轮)
  │
  ├── 7. phase handoff gate:
  │     - 所有 required task = accepted
  │     - required review = passed
  │     - critical issues = 0
  │     - tests/lint/typecheck 满足计划验证条件
  │
  ├── 8. 阶段完成 → 编排器批量更新 state.json
  │     (只有编排器写 state.json，避免并发竞态)
  │
  └── 9. 上下文检查 (见 §4.4)
```

**依赖门槛语义 (gate-aware dependencies):**

```json
{ "kind": "task", "id": "2.2", "gate": "checkpoint" }
{ "kind": "task", "id": "2.3", "gate": "accepted" }
{ "kind": "phase", "id": 2, "gate": "phase_complete" }
```

规则:
- `checkpoint` — 允许依赖未独立验收的实现检查点；只适合低风险内部串接
- `accepted` — 默认安全门槛；适合共享行为、公共接口、L2 风险任务
- `phase_complete` — 跨 phase 依赖；只有 phase handoff 完成后才释放
- 默认值: **如果 planner 没显式放宽，则依赖按 `accepted` 处理**

**返工失效传播规则:**
- 若返工修改了 contract / schema / shared behavior:
  - 所有直接和间接依赖 task → `needs_revalidation`
  - 清空其旧 `evidence_refs`
  - 如已 accepted，则退回到 `checkpointed` 或 `pending_review`
- 若返工只影响局部实现、外部契约未变:
  - 下游 task 保持现状
  - 但受影响验证范围必须重跑并刷新 evidence
- 失效传播由 orchestrator 根据依赖图完成，不由 executor 自行决定
- 失效传播的触发判定:
  - `contract_changed` (executor 运行时报告) 是主触发源
  - `invalidate_downstream_on_change` (planner 静态标记) 是预判辅助
  - 规则: executor 报告 `contract_changed: true` → 一定传播；planner 标记 `invalidate_downstream_on_change: true` 但 executor 报告 `contract_changed: false` → 不传播 (以运行时实际为准)

**L1 批量审查的返工爆炸半径 (已知 trade-off):**

L1 的设计是"延迟审查 + 允许 checkpoint 释放下游"。这意味着：
- task A (L1) checkpoint → task B (依赖 A, gate:checkpoint) 开始执行 → ... → phase 结束 batch review 发现 A 有 Critical
- 此时 B、C 等下游 task 可能全部 `needs_revalidation`

这是 L1 的已知 trade-off，不是 bug。缓解策略:
- planner 应对 L1 内部有共享行为依赖的 task 使用 `gate: accepted` 而非 `gate: checkpoint`
- 如果 L1 task 之间用了 `gate: accepted`，则下游 task 会等到 batch review 通过后才开始 → 退化为类似 L2 的等待行为，但仍然只用 1 个 batch reviewer
- 如果 planner 显式用了 `gate: checkpoint`，则接受 batch review 失败时的连锁返工风险
- 编排器在 batch review 返工后，应优先重跑被 invalidated 的 task，而非继续新 task

**审查级别运行时重分类:**

planner 在计划阶段分配 L0/L1/L2，但 executor 实现时可能发现实际影响面与预判不同。

规则:
- executor result contract 中的 `contract_changed: true` + 涉及 auth/payment/public API → 编排器自动升级为 L2 即时审查
- executor 可在 decisions 中标注 `[LEVEL-UP] 建议升级为 L2 因为 ...` → 编排器采纳
- 降级: 编排器不主动降级；如果 planner 标了 L2 但实际很简单，仍按 L2 审查 (安全优先)

**验证证据模型:**
- 每条 evidence 至少包含:
  - `command`
  - `scope`
  - `exit_code`
  - `timestamp`
  - `summary`
- `fresh verification evidence` = 与当前 checkpoint/review 关联、且未被后续返工失效的 evidence

### 4.4 上下文管理

**核心规则: 任务在子代理中执行，主会话只做编排**

```
主会话职责:
  ├── 编排 phase 顺序与 task 调度
  ├── 派发子代理 (每次 1 个 task / 1 次审查)
  ├── 监控上下文健康度 (通过 StatusLine hook 获取百分比)
  └── 管理状态持久化 (只有编排器写 state.json)

子代理职责:
  ├── 执行具体任务 (新鲜上下文，无历史包袱)
  ├── 审查-测试-修复循环
  └── 返回执行结果 (不直接写 state.json)
```

**上下文监控机制 (基于 GSD 已验证的方案):**

```
StatusLine hook (每次工具调用后触发):
  ├── 读取 data.context_window.remaining_percentage
  ├── 写入 .gsd/.context-health (临时文件)
  └── 编排器每次派发子代理前检查该文件

PostToolUse hook (兜底):
  ├── 读取 .gsd/.context-health
  ├── remaining < 40% → 注入警告到 AI 上下文
  └── remaining < 20% → 注入紧急停止指令
```

**上下文不足时的处理:**

```
remaining <= 35% (校准后阈值，原设计 40% 经运营调整):
  1. 编排器保存完整状态到 state.json (含 todo 进度)
  2. 写入 workflow_mode = awaiting_clear
  3. 输出: "⚠️ 上下文剩余 <=35%，已保存进度。
            请执行 /clear 然后 /gsd:resume 继续"
  4. 停止执行，等待用户操作

remaining <= 25% (校准后紧急阈值，原设计 20% 经运营调整):
  1. Hook 注入紧急信号
  2. 编排器立即保存状态
  3. 写入 workflow_mode = awaiting_clear
  4. 输出: "🛑 上下文即将耗尽，已保存进度。
            请立即执行 /clear 然后 /gsd:resume"
```

**⚠️ 设计约束:** `/clear` 是用户交互命令，不能被程序自动调用。
因此上下文清理需要用户手动执行 `/clear` + `/gsd:resume`。
但由于子代理隔离了大部分上下文消耗，主会话的上下文压力远小于当前 GSD。
`35% / 25%` 是校准后的运营默认值 (原 40%/20%)；后续可根据真实项目 telemetry 进一步调整。

**为什么这个设计足够好:**
- 子代理每次获得新鲜上下文 → 主会话只有编排开销
- 大多数项目在主会话耗尽前就能完成 (因为重活在子代理中)
- 需要 clear 时，只需 2 步: `/clear` + `/gsd:resume`，state.json 保证零状态丢失

### 4.5 效率对比: 单阶段执行

**当前 GSD:**
```
init execute-phase → 读取 5 个参考文档 →
生成 executor 子代理 → 子代理读取 5-12 个必读文件 → 执行任务 →
self-check → 7 次状态更新 → 生成 verifier 子代理
= 2-3 个子代理 + 10 CLI 调用 + 20+ 文件读取
```

**GSD-Lite:**
```
读取阶段计划 → 构建 runnable task 集合 → 串行派发 executor →
checkpoint commit → 分层审查 → accepted → 批量更新状态
= task 粒度精准加载 + phase 粒度统一收口
```

**设计目标:** 用 task 粒度执行换取更稳定的恢复与更低的主会话负担；
~75% 开销下降属于目标估算，需在实现后用 E2E 数据验证。

### 4.6 Superpowers 质量体系整合

#### 核心矛盾与解法

两个系统运行模式有根本性冲突:

```
GSD:          编排器控制一切 → 子代理只执行 → 自动化优先
Superpowers:  AI 自主判断   → Skill 引导行为 → 纪律优先
```

**解法: 不是二选一，而是作用在不同层面。**

#### 三层整合模型

```
┌─────────────────────────────────────────────────────────┐
│              Superpowers 质量体系三层整合                  │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  第一层: 内联规则 (始终生效, ~50行/Agent)                 │
│  ├── 铁律 3 条 (6行)                                    │
│  │   NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST     │
│  │   NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST     │
│  │   NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION     │
│  ├── 红旗列表 (~15行)                                    │
│  │   "就这一次跳过" → 停止，你在合理化                    │
│  │   "太简单了不需要测试" → 简单代码也会出错              │
│  │   "我已经手动测试过了" → 手动 ≠ 可重复验证            │
│  └── 验证规则 (~10行)                                    │
│      完成前必须有 FRESH 验证证据                          │
│  → 内联到每个 Agent 的 <EXTREMELY-IMPORTANT> 标签中       │
│  → 成本: 每个子代理多 ~50行，完全可接受                   │
│                                                          │
│  第二层: 工作流 (按需加载, ~100-200行/个)                 │
│  ├── tdd-cycle.md — RED-GREEN-REFACTOR 循环              │
│  ├── review-cycle.md — 分层审查循环 (task 自审 + L1/L2 review) │
│  ├── debugging.md — 4 阶段根因分析                       │
│  ├── research.md — 生态系统研究流程                       │
│  └── deviation-rules.md — 偏差处理规则                    │
│  → 编排器根据当前阶段加载到子代理提示词                    │
│  → 成本: 每次只加载 1-2 个，可控                          │
│                                                          │
│  第三层: 参考文档 (仅按需读取)                             │
│  ├── questioning.md — 提问技巧                            │
│  ├── anti-rationalization-full.md — 完整合理化表           │
│  ├── git-worktrees.md — Git Worktree 工作流 (可选)        │
│  └── testing-patterns.md — 测试模式                       │
│  → 子代理在需要时用 Read 工具读取                          │
│  → 成本: 按需，最低                                       │
└─────────────────────────────────────────────────────────┘
```

#### 为什么不用 Skill-First 模式

| Superpowers 方式 | 问题 | GSD-Lite 的替代 |
|------------------|------|-----------------|
| 1% 原则: 每条消息检查所有 Skill | 自动执行模式下无意义，编排器已知当前任务 | 编排器按阶段加载相关工作流 |
| 14 个 Skill 全部加载 (~11,000行) | 直接违反"上下文是弹药"原则 | 三层按需加载 (~50+150行) |
| AI 自主判断用哪个 Skill | 自动化程度低，需要 AI 决策 | 编排器决定，零决策开销 |
| using-superpowers 元技能 | GSD 编排器已替代其功能 | 不需要 |

#### 为什么不全转子代理

| 方案 | 问题 |
|------|------|
| 14 个 Skill → 14 个 Agent | 过度碎片化，简单任务启动 5 个子代理 |
| 铁律放在独立 Agent 中 | 铁律必须始终在场，不能"按需加载" |
| TDD 放在独立 Agent 中 | executor 如果不知道 TDD 规则就不会遵循 |

#### 各功能整合决策

| Superpowers 功能 | 整合方式 | 理由 |
|-----------------|---------|------|
| 铁律 (3条) | ✅ 内联到 Agent | 6行，必须始终生效 |
| 反合理化 (红旗列表) | ✅ 核心内联 + 完整版参考 | 核心15行内联，完整版按需读 |
| TDD 驱动 | ✅ 工作流 (tdd-cycle.md) | ~30行核心规则，executor 编码时加载 |
| 双阶段审查 | ✅ reviewer Agent | 独立子代理，规格→质量 |
| 系统性调试 | ✅ debugger Agent | 独立子代理，4阶段根因 |
| 验证模式 | ✅ 内联到 Agent | ~10行，完成前必须验证 |
| CSO 优化 | ✅ 应用到 Agent 描述 | Description 只写触发条件 |
| `<HARD-GATE>` 标签 | ✅ 用于关键检查点 | 防止 AI 跳过验证步骤 |
| 元提示工程 (1%原则) | ❌ 不整合 | 与自动化模式冲突 |
| using-superpowers | ❌ 不整合 | GSD 编排器替代 |
| writing-skills | ❌ 不整合 | 不需要创建新 Skill |
| 3 个命令 | ❌ 不整合 | 已被 GSD 命令覆盖 |
| Skill 流转关系 | ⚠️ 概念整合 | 流转已被 GSD 流程覆盖，但"交接协议"整合 |
| SDD 子代理驱动开发 | ✅ 简化整合 | 3个子代理 → 2个 (executor+reviewer) |
| Git Worktrees | ⚠️ 可选工作流 | 参考文档，用户选择是否使用 |
| finishing-branch | ⚠️ 可选工作流 | 完成时提供选项 |
| 子代理提问机制 | ✅ 整合到 executor | executor 可以提问，不盲目执行 |

#### SDD 简化整合

Superpowers 的 SDD 用 3 个独立子代理:
```
implementer → spec-reviewer → quality-reviewer (3个子代理)
```

GSD-Lite 简化为 2 种角色 + 分级策略:
```
executor (单 task 实现+TDD+自审+checkpoint commit)
    → reviewer (独立双阶段审查, 分级触发)
    → orchestrator 标记 accepted
```

简化点:
- spec-reviewer 和 quality-reviewer 合并为 1 个 reviewer (双阶段顺序执行)
- 分级审查 (L0/L1/L2) 避免成本爆炸 (详见 §6.2)
- L2 关键任务: 单任务独立 review
- L1 普通任务: 阶段结束批量 review
- L0 配置任务: executor 自审即可

审查循环:
```
阶段内所有 executor 完成 → 分级 review
  ├── L2 已在执行中单独审查
  ├── L1 批量 reviewer 审查
  │     ├── ✅ 通过 → 继续
  │     └── ❌ Critical → 新 executor 修复 → 重新 review (最多 3 轮)
  └── L0 无需 review
```

#### 交接协议 (来自 Skill 流转关系)

每个阶段完成时，编排器执行交接检查:
```
<HARD-GATE id="phase-handoff">
  □ 阶段计划中的所有 todo 都完成了
  □ 所有 required review 都通过了
  □ 所有测试通过了
  □ 无未解决的 Critical 问题
  □ 方向校验: 当前阶段产出是否仍与 plan.md 中的项目目标一致？
    (orchestrator 对比阶段产出 vs 原始需求，检查是否漂移)
  → 全部满足 → 自动进入下一阶段
  → 任一不满足 → 标注问题，尝试修复，3次失败停止
  → 方向漂移 → workflow_mode = awaiting_user，展示偏差让用户决定
</HARD-GATE>
```

---

## 五、命令详细设计

### 5.1 `/gsd:start` — 交互式启动

**职责:** 讨论需求 → 研究 → 深度思考 → 计划 → 用户审批 → 自动执行

```markdown
<process>
1. 用户输入语言 = 后续所有输出语言 (不需要读 CLAUDE.md)
2. 分析代码库相关部分 (codebase-retrieval)
3. 开放式提问: "你想做什么？"
4. 用户回答后，跟进追问:
   - 使用 questioning.md 技巧 (挑战模糊、具象化、发现边界)
   - 每个问题提供选项，标识 ⭐推荐选项
   - 多轮对话直到需求清晰
5. 智能判断是否需要研究:
   - 需要 → 派发 gsd-researcher 子代理 → 展示关键发现
   - 不需要 → 跳过
6. 如有 sequential-thinking MCP → 调用深入思考
7. 生成分阶段计划:
   - phase 负责管理与验收，task 负责执行
   - 每阶段控制在 5-8 个 task (便于 phase-level 收口)
   - 每个 task = 原子化 todo (含文件、操作、验证条件)
   - 每个 task 补充元数据: `requires` / `review_required` / `research_basis`
   - 审查级别按影响面判定: L0(无运行时语义变化) / L1(普通) / L2(高风险)
   - 标注可并行任务组 [PARALLEL] (当前仅作未来升级标记)
8. 计划自审 (轻量替代 plan-checker，不宣称等价):
   - 检查: 是否有遗漏的需求点？
   - 检查: 阶段划分是否合理？(phase 过大则拆分)
   - 检查: 任务依赖关系是否正确？
   - 检查: 验证条件是否可执行？
   - 如属高风险项目 → 升级为增强计划审查 (见下方)
   → 自审修正后再展示给用户

**增强计划审查 (高风险项目):**

触发条件: 项目涉及 auth / payment / security / public API / DB migration / 核心架构变更

```
输入: plan.md + phases/*.md + research/SUMMARY.md + research/PITFALLS.md
审查者: orchestrator 自身 (不派发独立子代理，避免额外成本)
维度:
  1. 需求覆盖: 原始需求的每个要点是否都映射到了至少一个 task？
  2. 风险排序: 高风险 task 是否排在前面？(fail-fast 原则)
  3. 依赖安全: L2 task 的下游是否都用了 gate:accepted？
  4. 验证充分: 涉及 auth/payment 的 task 是否都有明确的安全验证条件？
  5. 陷阱规避: research/PITFALLS.md 中的每个陷阱是否都有对应的防御 task 或验证条件？
输出: pass / revise (附具体修正建议)
轮次: 最多 2 轮自审修正；2 轮后仍有问题 → 标注风险展示给用户
```
9. 展示计划，等待用户确认
   - 用户指出问题 → 调整 → 再展示
   - 用户确认 → 继续
10. 生成文档:
    - 创建 .gsd/ 目录
    - 写入 state.json + plan.md + phases/*.md
    - 初始化 `workflow_mode` / `current_task` / `current_review` / phase 状态与 handoff 信息
    - 如有研究: 写入 .gsd/research/
11. 进入自动执行主路径 (见 4.3)
12. 全部完成 → 输出最终报告
</process>
```

### 5.2 `/gsd:prd` — 文档启动

**职责:** 从需求文档或描述启动，快速进入计划阶段

```markdown
用法:
  /gsd:prd docs/requirements.md          # 从文件
  /gsd:prd "实现用户认证，支持 JWT"       # 从描述

<process>
1. 解析输入:
   - 如果是文件路径 → 读取文件内容
   - 如果是文本 → 直接作为需求描述
2. 分析代码库相关部分
3. 提取关键需求点，向用户确认理解
4. 提出补充问题 (标识 ⭐推荐选项)
5. 后续流程同 /gsd:start 的 STEP 5-11
</process>
```

### 5.3 `/gsd:resume` — 恢复命令

```markdown
<process>
1. 读取 .gsd/state.json
2. 前置校验 (必须在恢复执行前完成):
   - git_head 改变且工作区不一致 → workflow_mode = reconcile_workspace
   - plan_version 不匹配         → workflow_mode = replan_required
   - research 已过期             → workflow_mode = research_refresh_needed
   - 存在冲突或脏工作区          → workflow_mode = awaiting_user
   - 全部通过 → 保持原 workflow_mode 不变
3. 按校验后的 `workflow_mode` 恢复:
   - executing_task      → 继续调度当前或下一个 runnable task
   - reviewing_task      → 恢复 L2 单任务审查
   - reviewing_phase     → 恢复 L1 阶段批量审查
   - awaiting_clear      → 继续自动执行主路径
   - awaiting_user       → 先展示 blocked 问题，不直接运行
   - paused_by_user      → 询问是否继续执行
   - reconcile_workspace → 展示 Git/workspace 差异，先做 reconcile
   - replan_required     → 停止自动执行，要求重规划或确认兼容
   - research_refresh_needed → 先刷新研究再继续
4. 显示当前进度 + 下一动作
</process>
```

### 5.4 `/gsd:status` — 状态命令

```markdown
<process>
1. 读取 .gsd/state.json
2. 展示: 项目名、总进度、各阶段状态、todo 清单进度、下一步操作
</process>
```

### 5.5 `/gsd:stop` — 停止命令

```markdown
<process>
1. 保存完整状态到 state.json (含当前 todo / review / blocked 状态)
2. 写入 workflow_mode = paused_by_user
3. 输出: "已暂停。运行 /gsd:resume 继续"
</process>
```

---

## 六、Agent 设计

### 6.1 `gsd-executor` — 执行器

**设计原则:** 最小化必读文件，最大化编码时间，按单 task 工作，内置质量纪律

````markdown
---
name: gsd-executor
description: Execute one task with TDD/self-review and return structured result
tools: [Read, Write, Edit, Bash, Grep, Glob]
---

<role>
你是精确的代码执行器。一次只接收 1 个 task，完成后返回结构化结果。
遵从 CLAUDE.md 中的编码规范。用用户的语言输出。
</role>

<EXTREMELY-IMPORTANT>
## 铁律 (来自 Superpowers — 不可违反)
- NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST (有例外，见下方)
- NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE

## TDD 例外 (这些任务不需要先写失败测试)
- 配置文件修改 (package.json, tsconfig, .env.example)
- CSS/样式/布局变更
- 数据库迁移脚本 (用迁移工具自身的验证)
- 纯文档/注释/README
- CI/CD 配置
- 环境变量/部署配置
→ 这些任务改为: 实现 → 验证生效 → checkpoint commit

## 红旗 (想到这些时必须停止)
- "太简单了不需要测试" → 简单代码也会出错。除非是上方例外列表中的任务。
- "我先写完再测试" → 后写的测试立即通过，证明不了任何东西。
- "就这一次跳过" → 你在合理化。停止。回到正确流程。
- "我已经手动测试过了" → 手动 ≠ 可重复验证。写自动测试。
</EXTREMELY-IMPORTANT>

<rules>
1. 逐任务执行:
   a. 判断是否需要 TDD (见例外列表)
   b. 需要 TDD → RED(写失败测试) → GREEN(最小实现) → REFACTOR → checkpoint commit
   c. 不需要 TDD → 实现 → 验证生效 → checkpoint commit
2. 每个任务完成后自审:
   a. 代码是否符合任务规格？
   b. 需要测试的任务: 测试覆盖是否充分？
   c. 有无明显 bug？
3. 遇到 bug → 先调查根因，再修复 (最多 3 次)
4. 任务完成后返回: `outcome / evidence / checkpoint_commit / decisions / blockers`
5. 架构变更 → 标注到摘要，不自行决定
</rules>

<result_contract>
```json
{
  "task_id": "2.3",
  "outcome": "checkpointed | blocked | failed",
  "summary": "Implemented PUT /api/users/:id endpoint",
  "checkpoint_commit": "a1b2c3d",
  "files_changed": ["src/api/users.ts", "tests/users.test.ts"],
  "decisions": ["[DECISION] use optimistic locking by version column"],
  "blockers": [],
  "contract_changed": true,
  "evidence": ["ev:test:users-update", "ev:typecheck:phase-2"]
}
```
`contract_changed` 判定指南:
- 改了函数/方法签名 (参数、返回类型) → true
- 改了 API endpoint 的 request/response schema → true
- 改了数据库 schema (表结构、字段) → true
- 改了共享类型定义 / 接口 → true
- 只改了内部实现逻辑、不影响外部调用方 → false
- 拿不准时 → true (安全优先)
</result_contract>

<uncertainty_handling>
## 遇到不确定性时
子代理不能直接与用户交互。遇到不确定性时:
1. 能自主判断的 → 做出合理决策 + 在摘要中标注 "[DECISION] 选择了X因为Y"
2. 缺少前置条件或影响架构的不确定性 → 返回 "[BLOCKED] 需要确认: ..."
3. 同一错误指纹重复 3 次 → 返回 "[FAILED]"，由编排器决定 phase 是否停止

编排器收到 [BLOCKED] 后:
  ├── 能从计划/研究中回答 → 自动回答，重新派发 executor
  └── 不能回答 → 暂停执行，向用户转达问题
</uncertainty_handling>

<deviation_rules>
- 自动修复 bug (不影响架构)
- 自动补充遗漏的导入/类型
- 架构变更 → 标注到摘要，返回 orchestrator 决策
- 单个任务 3 次修复失败 → 返回 FAILED，由编排器决定是否终止 phase
</deviation_rules>
````

### 6.2 `gsd-reviewer` — 审查器 (来自 Superpowers 双阶段审查)

#### 审查策略: 分级审查 (平衡质量与成本)

每个任务都启动独立 reviewer 的成本过高 (8 个任务 = 16+ 个子代理)。
采用分级策略:

```
审查级别判定:

L0 配置/文档任务 → executor 自审即可，不启动 reviewer
   (配置修改、文档更新、CSS 样式等)

L1 普通编码任务 → executor 自审 + 阶段结束时批量 review
   (大多数 CRUD、UI 组件、工具函数等)

L2 关键任务 → 单任务独立 review
   (涉及认证/支付/数据安全/核心架构的任务)

判定规则按影响面，不按关键词猜测:
  - 改 auth/payment/permission/public API/DB migration/core architecture → L2
  - 纯 docs/comment/style/config 且无运行时语义变化 → L0
  - 其余 → L1
  - 拿不准时 → 升一级处理
```

**提交与验收拓扑:**

```
checkpoint commit ≠ accepted

L0: checkpoint commit = accepted
L1: checkpoint commit → phase batch review 通过 → accepted
L2: checkpoint commit → immediate independent review 通过 → accepted
```

这样做的目的:
- 保留任务级可恢复检查点
- 避免把 "已提交" 误写成 "已通过独立质量门禁"
- 让 `/gsd:resume` 能准确知道任务是在 checkpoint 后待审，还是已 accepted
- 让返工时可以精确撤销 accepted，而不是回滚整个 phase

**实际成本对比:**

```
方案A (每任务审查): 8 个任务 = 8 executor + 8 reviewer = 16 子代理 ❌
方案B (分级审查):   8 个任务 = 8 executor + 1 批量 reviewer + 1-2 个 L2 = 10-11 子代理 ✅
                    成本降低 ~35%，关键任务保持独立审查
```

#### Agent 定义

````markdown
---
name: gsd-reviewer
description: Two-stage code review after executor completes
tools: [Read, Bash, Grep, Glob]
---

<EXTREMELY-IMPORTANT>
## 铁律
- NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
- 你独立阅读代码。不信任 executor 的报告。自己验证。

## 红旗
- "executor 说测试通过了" → 自己运行测试验证
- "看起来没问题" → 不够。需要具体证据。
</EXTREMELY-IMPORTANT>

<role>
你是独立代码审查器。独立阅读代码 (不信任 executor 的报告)，进行双阶段审查。
你可能收到单任务审查 (L2) 或批量审查 (L1 合并)，流程相同。
</role>

<stage_1_spec_review>
检查代码是否符合任务规格:
- 所有需求都实现了吗？
- 有没有多余的实现 (YAGNI)？
- 接口/API 是否符合计划？
- 测试是否覆盖了需求中的每个场景？
结果: ✅ 通过 / ❌ 列出不符合项 (附具体代码位置)
</stage_1_spec_review>

<HARD-GATE id="spec-before-quality">
规格审查必须通过后才能进入质量审查。
不要浪费时间优化做错的代码。
</HARD-GATE>

<stage_2_quality_review>
(仅在规格审查通过后执行)
检查代码质量:
- 测试覆盖是否充分？ (运行测试 + 检查覆盖率)
- 有没有明显的 bug/安全问题？
- 代码是否清晰可维护？
- 有无性能问题？
结果: ✅ 通过 / ❌ 列出问题 (Critical/Important/Minor)

Critical = 必须修复 (安全/数据丢失/功能错误)
Important = 应该修复 (性能/可维护性)
Minor = 建议修复 (命名/风格)
→ 有 Critical → 返回 ❌
→ 只有 Important/Minor → 返回 ✅ + 建议列表
</stage_2_quality_review>

<result_contract>
```json
{
  "scope": "task | phase",
  "scope_id": "2.3 | phase-2",
  "review_level": "L2 | L1-batch",
  "spec_passed": true,
  "quality_passed": false,
  "critical_issues": [
    {
      "task_id": "2.3",
      "reason": "Public API contract mismatch",
      "invalidates_downstream": true
    }
  ],
  "important_issues": [],
  "minor_issues": [],
  "accepted_tasks": [],
  "rework_tasks": ["2.3", "2.4"],
  "evidence": ["ev:test:phase-2", "ev:lint:phase-2"]
}
```
</result_contract>

规则补充:
- `Important` 必须转成后续 task 或显式记录为 deferred debt
- `Minor` 不阻塞 accepted，但必须进入 review report
````

### 6.3 `gsd-researcher` — 研究器 (来自 GSD 原版)

````markdown
---
name: gsd-researcher
description: Research domain ecosystem before planning
tools: [Read, Write, Bash, WebSearch, WebFetch, mcp__context7__*]
---

<role>
你是生态系统研究器。回答 "这个领域的技术生态是什么样的？"
用用户的语言输出。
</role>

<source_hierarchy>
1. Context7 MCP (最新文档，无幻觉)
2. 官方文档 (Context7 覆盖不足时)
3. WebSearch (对比和趋势)
</source_hierarchy>

<output>
写入 .gsd/research/:
- STACK.md — 技术栈推荐 + 理由 + 版本建议
- ARCHITECTURE.md — 架构模式 + 推荐方案 (标识 ⭐)
- PITFALLS.md — 领域陷阱 + 规避方案 (来自真实项目经验)
- SUMMARY.md — 摘要 + 路线图建议 + volatility / expires_at / key decision ids

每个发现标注置信度: HIGH / MEDIUM / LOW
每个推荐标注来源: [Context7] / [官方文档] / [社区经验]
关键推荐生成 decision id，供 plan/task 的 `research_basis` 引用

<result_contract>
```json
{
  "decision_ids": ["decision:jwt-rotation"],
  "volatility": "medium",
  "expires_at": "2026-03-16T10:30:00Z",
  "sources": [
    { "id": "src1", "type": "Context7", "ref": "Next.js auth docs" }
  ]
}
```
</result_contract>
</output>
````

### 6.4 `gsd-debugger` — 调试器 (来自 Superpowers 系统性调试)

**触发条件 (由编排器决定):**
- executor 对同一 task 连续 3 次返回 `failed`
- executor 返回 `[FAILED]` 且错误指纹重复
- 编排器判断 executor 的 bug 修复尝试没有收敛

**编排器流程:**
1. 派发 debugger，传入: 错误信息 + executor 的修复尝试记录 + 相关代码路径
2. debugger 返回: 根因分析 + 修复方向建议
3. 编排器决定: 带修复方向重新派发 executor / 标记 task failed / 标记 phase failed

```markdown
---
name: gsd-debugger
description: Systematic debugging with root cause analysis
tools: [Read, Write, Edit, Bash, Grep, Glob]
---

<EXTREMELY-IMPORTANT>
## 铁律
- NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
- 如果你还没完成 Phase 1，你不能提出修复方案

## 红旗
- "快速修一下先" → 停止。你在跳过根因调查。
- "应该是 X 的问题" → 没有证据的假设。先调查。
- "再试一个修复" (已尝试 2+) → 停止。质疑架构。
</EXTREMELY-IMPORTANT>

<four_phases>
Phase 1 根因调查 (必须完成后才能进入 Phase 2):
  1. 仔细阅读错误信息 (不要跳过)
  2. 可靠复现 (每次都能触发)
  3. 检查最近变更 (git diff, 新依赖, 配置)
  4. 追踪数据流 (坏数据从哪里来？)

Phase 2 模式分析:
  1. 找到类似的可工作代码
  2. 对比差异，列出所有不同点
  3. 不要假设"那个不重要"

Phase 3 假设测试:
  1. 明确陈述: "我认为 X 是根因，因为 Y"
  2. 最小变更测试 (一次只改一个变量)
  3. 验证: 有效 → Phase 4 / 无效 → 新假设

Phase 4 实施修复:
  1. 写失败测试 (复现 bug)
  2. 修复根因 (不是症状)
  3. 验证测试通过 + 无回归
  → 3 次修复失败 → 停止。质疑架构。报告给编排器。
</four_phases>
```

### 6.5 Agent 设计总结

| Agent | 行数 | 内联铁律 | 关键能力 |
|-------|------|---------|---------|
| gsd-executor | ~90行 | TDD铁律(含例外) + 验证铁律 + 红旗 | TDD编码 + 自审 + 不确定性处理 |
| gsd-reviewer | ~90行 | 验证铁律 + 红旗 | 分级审查(L0/L1/L2) + 双阶段 + HARD-GATE |
| gsd-researcher | ~40行 | — | 三级源查询 + 置信度标注 |
| gsd-debugger | ~60行 | 根因铁律 + 红旗 | 4阶段根因分析 + 3次失败停止 |

**对比:**
- 当前 GSD: 1 个 executor (~1200行) + 11 个其他 agent = 12 个
- Superpowers: 1 个 code-reviewer + 3 个子代理模板 = 4 个
- GSD-Lite v3.5: 4 个精简 agent，每个 ~40-90 行，内置质量纪律

---

## 七、工具层设计

### 7.1 安装方式

**方式一: Claude Code 插件 (推荐)**
```bash
/plugin marketplace add sdsrss/gsd-lite
/plugin install gsd-lite

# 卸载
/plugin uninstall gsd-lite
```

**方式二: npx 脚本安装**
```bash
npx gsd-lite install    # 安装
npx gsd-lite uninstall  # 卸载
```

**方式三: 手动安装**
```bash
git clone https://github.com/sdsrss/gsd-lite.git
cd gsd-lite && node install.js
```

**install 做什么 (~80行):**
```
1. 复制 commands/*.md     → ~/.claude/commands/gsd/
2. 复制 agents/*.md       → ~/.claude/agents/
3. 复制 workflows/*.md    → ~/.claude/workflows/gsd/
4. 复制 references/*.md   → ~/.claude/references/gsd/
5. 复制 hooks/*.js        → ~/.claude/hooks/
6. 注册 hooks             → ~/.claude/settings.json (StatusLine + PostToolUse)
7. 注册 MCP server        → ~/.claude/settings.json
```

**~80 行安装脚本 vs 当前 2465 行。**

### 7.2 工具层 (MCP Server + Bash 脚本)

Claude Code 支持两种自定义工具: MCP Server 和 Bash 命令。GSD-Lite 混合使用:

**MCP Server (状态管理 — 需要结构化输入输出):**
```javascript
// src/server.js — 轻量 MCP Server

tools = {
  "gsd-state-read":     // 读取 state.json → 返回结构化 JSON
  "gsd-state-init":     // 初始化 .gsd/ 目录 + state.json + plan.md
  "gsd-state-update":   // 批量更新 state.json (含 todo 状态)
  "gsd-phase-complete": // 标记阶段完成 + 更新状态
}
```

**Bash 脚本 (验证 — 直接运行项目命令):**
```bash
# AI 通过 Bash tool 直接调用:
node ~/.claude/hooks/gsd-verify.js    # 运行测试 + lint + 类型检查
```

### 7.3 外部 MCP 集成 (可选，增强能力)

| MCP | 用途 | 降级方案 |
|-----|------|---------|
| sequential-thinking | 计划前深度思考 | 不用则直接规划 |
| context7 | 技术文档查询 (研究时) | 不用则 WebSearch |

**智能检测:** 启动时检查可用 MCP，有则用，无则降级。如用户已安装 context7 skill 则直接使用。

---

## 八、语言遵从设计

### 8.1 规则

**简单直接: 用户用什么语言输入，就用什么语言回复。**

不需要读取 CLAUDE.md，不需要配置文件，不需要语言检测库。

### 8.2 实现

每个命令和 Agent 的提示词中加入一行:

```
用用户的语言回复。用户用中文就用中文，用英文就用英文。
```

---

## 九、砍掉了什么、保留了什么、新增了什么

### 9.1 砍掉的

| 砍掉 | 原因 |
|------|------|
| 计划检查器 (plan-checker) + 修订循环 (×3) | 轻量计划自审替代 (编排器展示前自审 4 项检查) |
| 验证子代理 (verifier) | 审查-测试-修复循环替代 |
| 路线图 (ROADMAP.md) | plan.md + state.json 已包含 |
| 需求追踪 (REQUIREMENTS.md) | 需求在 plan.md 中 |
| 里程碑系统 (milestone) | 直接用阶段管理 |
| UAT 人工验证 | 自动审查循环替代 |
| 多运行时支持 (OpenCode/Gemini/Codex) | 只支持 Claude Code |
| 2465 行安装器 | ~80 行插件安装脚本 |
| Frontmatter 解析器 (300行) | JSON 不需要自研解析器 |
| STATE.md 双编码 | JSON 单一编码 |
| 7 次状态更新调用 | 1 次批量写入 |
| 大量冗余工作流文件 | 精简为 5 个核心工作流 |

### 9.2 保留的核心价值

| 保留 | 来源 | 原因 |
|------|------|------|
| ✅ 上下文腐败防护 | GSD | 子代理隔离 + task 边界 + StatusLine 监控 |
| ✅ 规格驱动开发 | GSD | 先计划后执行，计划即可执行提示词 |
| ✅ 分阶段执行 | GSD | phase 做管理边界，task 做执行边界 |
| ✅ 子代理编排 | GSD | executor 子代理获得新鲜上下文 |
| ✅ 文件系统即数据库 | GSD | .gsd/ 目录持久化，Git 友好 |
| ✅ 偏差规则 | GSD | 自动修 bug，3 次失败停止，架构变更标注 |
| ✅ 原子提交 | GSD | task 级 checkpoint commit + phase 级 accepted |
| ✅ 会话连续性 | GSD | state.json 支持跨 session 恢复 |
| ✅ 生态系统研究 | GSD | 技术栈/架构/陷阱研究 |
| ✅ 提问技巧 | GSD | questioning.md 参考文档 |

### 9.3 新增的 (来自 Superpowers 质量内核 + 新设计)

| 新增 | 来源 | 整合方式 | 价值 |
|------|------|---------|------|
| ✅ 铁律 (3条) | Superpowers | 内联到每个 Agent (~6行) | 不可违反的质量底线 |
| ✅ 反合理化 (红旗列表) | Superpowers | 核心内联 (~15行) + 完整版参考 | 封堵 AI 跳过流程的借口 |
| ✅ 双阶段审查 | Superpowers SDD | reviewer Agent (规格→质量) | 先做对再做好 |
| ✅ TDD 循环 (含例外) | Superpowers | tdd-cycle.md 工作流 (按需) + 例外清单 | RED-GREEN-REFACTOR (配置/CSS/迁移等豁免) |
| ✅ 系统性调试 | Superpowers | debugger Agent + debugging.md | 4 阶段根因分析 |
| ✅ 验证铁律 | Superpowers | 内联到 Agent | 完成前必须有 FRESH 证据 |
| ✅ `<HARD-GATE>` 标签 | Superpowers | 用于关键检查点 | 防止跳过验证步骤 |
| ✅ CSO 优化 | Superpowers | Agent 描述只写触发条件 | 强制读全文，不走捷径 |
| ✅ 不确定性处理 | Superpowers SDD | executor 返回 [BLOCKED]，编排器决策或转用户 | 不盲目执行也不打破自动化 |
| ✅ 交接协议 | Superpowers 流转 | 阶段完成时 HARD-GATE 检查 | 确保阶段真正完成 |
| ✅ /gsd:prd 命令 | 新设计 | 新命令 | 从需求文档快速启动 |
| ✅ sequential-thinking | 新设计 | 可选 MCP 集成 | 计划前深度思考 |
| ✅ 分级审查 | 新设计 | L0/L1/L2 三级策略 | 平衡质量与子代理成本 (-35%) |
| ✅ 计划自审 | 新设计 | 展示前 4 项自审检查 | 轻量替代 plan-checker |
| ⚠️ 并行子代理 | 新设计 | 计划标注 [PARALLEL]，当前串行降级 | Claude Code 支持后自动升级 |
| ✅ 上下文保护 | 新设计 | StatusLine+PostToolUse hook 监控 | <40% 提示用户 clear+resume |
| ✅ todo 原子化清单 | 新设计 | state.json | 每个任务独立跟踪状态 |
| ✅ 状态机恢复 | 新设计 | workflow_mode/current_task/current_review | `/gsd:resume` 可确定恢复点 |
| ✅ agent 结果契约 | 新设计 | executor/reviewer/researcher JSON contract | 编排器不用解析自然语言 |
| ✅ 依赖门槛语义 | 新设计 | checkpoint / accepted / phase_complete | 调度更安全 |
| ✅ 返工失效传播 | 新设计 | needs_revalidation + downstream invalidation | 避免返工污染下游 |
| ✅ 验证证据模型 | 新设计 | evidence store + evidence refs | “fresh evidence” 可操作化 |
| ✅ executor 上下文协议 | 新设计 | task_spec + research_decisions + predecessor_outputs | 精确控制子代理输入 |
| ✅ debugger 触发机制 | 新设计 | executor 3x failed → debugger 介入 | 调试不再悬空 |
| ✅ 审查级别运行时重分类 | 新设计 | contract_changed + 高风险领域 → 升级 L2 | 弥补 planner 预判偏差 |
| ✅ 全 blocked 死锁处理 | 新设计 | 0 runnable task → awaiting_user | 避免调度空转 |
| ✅ 研究刷新 decision 处理 | 新设计 | decision ID 变更 → 引用 task needs_revalidation | 研究刷新不丢引用 |
| ✅ lifecycle 形式化 | 新设计 | task/phase lifecycle 状态转换图 | 状态转换有据可查 |
| ✅ decisions 持久化 | 新设计 | decisions 数组跨 task/phase/session 累积 | blocked 自动回答 + 决策可追溯 |
| ✅ plan/phases 分工 | 新设计 | plan.md=索引, phases/*.md=规格 source of truth | 避免双源不一致 |
| ✅ 增强计划审查 | 新设计 | 高风险项目 5 维度自审 (最多 2 轮) | 计划阶段拦截风险 |
| ✅ 方向校验 | 新设计 | phase handoff 时对比产出 vs 原始需求 | 防止执行期方向漂移 |
| ✅ 工作流分工 | 新设计 | agent 内联=核心纪律, workflows/*.md=扩展指南 | 避免重复 + 冲突时内联优先 |

---

## 十、量化目标与待验证指标

> 下面的数字分为“设计目标”和“待验证估算”，不是已实测结论。

| 指标 | 当前 GSD | v3.5 设计目标 | 说明 |
|------|----------|---------------|------|
| **用户主交互次数** | 6+ 次 | 常态 2 次；异常路径 +1~2 次 | clear/resume 或 blocked 澄清时增加 |
| **主会话状态更新** | 7 次 CLI | 目标 1 次批量写入 / phase | 需实现后验证 |
| **执行粒度** | 混合 | 1 task = 1 executor | 恢复更稳定 |
| **审查拓扑** | verifier 1 次 | L0 自审 / L1 phase-batch / L2 immediate | 平衡质量与成本 |
| **上下文用于编码比例** | ~35% | 目标提升到 ~60-75% | 取决于真实项目复杂度 |
| **总源文件数** | 100+ | ~27 | 结构性目标 |
| **安装器行数** | 2465 | ~80 | 结构性目标 |
| **研究缓存命中** | 无显式策略 | 默认 TTL + volatility 调整 | 需真实项目观察 |
| **开销下降** | 基线 | 目标约 -50% 到 -75% | 属设计估算，需 E2E 实测 |

---

## 十一、实施路线

### Phase 1: 基础设施 (Day 1)
- [ ] 创建 `gsd-lite/` 目录结构
- [ ] 实现 state.json CRUD + 状态机字段 (`src/tools/state.js`)
- [ ] 实现 canonical/derived 字段边界，禁止双写状态
- [ ] 实现 task/phase lifecycle 状态转换验证
- [ ] 实现 evidence store + pruning (当前+上一 phase，更早归档)
- [ ] 实现验证工具 (`src/tools/verify.js`)
- [ ] 实现插件安装/卸载脚本

### Phase 2: Agent + 工作流 + 参考文档 (Day 2)
- [ ] 编写 `gsd-executor.md` (含内联铁律+红旗+提问机制)
- [ ] 编写 `gsd-reviewer.md` (含内联铁律+HARD-GATE+双阶段审查)
- [ ] 编写 `gsd-researcher.md` (三级源查询+置信度标注)
- [ ] 编写 `gsd-debugger.md` (含内联铁律+红旗+4阶段根因)
- [ ] 固化 executor / reviewer / researcher 的 result contracts
- [ ] 编写核心工作流 (tdd-cycle, review-cycle, debugging, research, deviation-rules)
- [ ] 编写核心参考文档 (questioning, anti-rationalization-full, git-worktrees, testing-patterns)

### Phase 3: 命令 (Day 3)
- [ ] 实现 `/gsd:start` 命令 (讨论→研究→计划→执行)
- [ ] 实现 `/gsd:prd` 命令 (文档→研究→计划→执行)
- [ ] 实现 `/gsd:resume` 命令 (先校验再按 workflow_mode 恢复)
- [ ] 实现 `/gsd:status` 和 `/gsd:stop` 命令

### Phase 4: 自动化 (Day 4)
- [ ] 实现 context-monitor hook (上下文 <40% 保存 + 提示手动 clear/resume)
- [ ] 实现 gate-aware 依赖调度逻辑 (`requires.gate` / `retry_count` / 全 blocked 死锁检测)
- [ ] 实现返工失效传播 (`contract_changed` 触发 + downstream invalidation)
- [ ] 实现审查级别运行时重分类 (executor 报告 contract_changed + auth/payment → 升级 L2)
- [ ] 实现 debugger 触发逻辑 (executor 3x failed → 派发 debugger)
- [ ] 实现研究刷新后 decision ID 引用处理
- [ ] 实现 executor 上下文构建 (task_spec + research_decisions + predecessor_outputs)
- [ ] 保留 [PARALLEL] 标记，未来再接真实并行执行能力
- [ ] 实现 sequential-thinking MCP 集成 (可选)

### Phase 5: 测试与打磨 (Day 5)
- [ ] 端到端测试: start → research → plan → execute → review → accepted
- [ ] 端到端测试: prd → plan → execute → context-clear → resume → complete
- [ ] 恢复测试: reviewing_task / reviewing_phase / awaiting_user / paused_by_user
- [ ] 恢复冲突测试: reconcile_workspace / replan_required / research_refresh_needed
- [ ] 返工传播测试: contract change → downstream needs_revalidation
- [ ] result contract 测试: 编排器只消费结构化结果，不解析自然语言
- [ ] 审查级别重分类测试: executor 报告 contract_changed → L1 升级为 L2
- [ ] debugger 触发测试: executor 3x failed → debugger 介入 → 修复方向回传
- [ ] 全 blocked 死锁测试: 0 runnable task → awaiting_user
- [ ] 研究刷新测试: decision ID 变更 → 引用 task needs_revalidation
- [ ] evidence pruning 测试: phase handoff → 旧 evidence 归档
- [ ] 指标校准: 40%/20% 阈值与研究 TTL 是否合理
- [ ] 插件发布配置

---

*方案完 v3.5 — GSD 管理外壳 + Superpowers 质量内核 (完整协议版：decisions 持久化 / plan-phases 分工 / 增强审查 / 方向校验 / 工作流分工已补齐)*