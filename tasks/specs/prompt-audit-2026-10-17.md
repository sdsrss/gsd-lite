# 提示词审计 2026-10-17 的修复
状态：进行中

## 背景与目标

2026-10-17 对本机已安装副本（`~/.claude/commands/gsd/`、`~/.claude/agents/gsd/`，09-21 安装）做了一次提示词审计，
得出 13 条问题（A1–A13）、4 项待核实事项和两处冲突（ii、iii）。参考补丁在
`/home/ai/dev/claudemd/docs/prompt-audit-2026-10-17/patches/G-A*.patch`，行号对应已安装副本，只作写法参考。

目标：在本仓库源文件里修掉仍然存在的问题，让提示词说的和代码做的一致，并发一个版本。

级别：L3。命令与代理的 description、编排纪律、审查级别规则都是随包发布、会改变代理路由和行为的
LLM 可见元数据。用户的请求点名了范围并要求发版，按此作为进入实施和发版的授权。

## 范围

- 做：`commands/*.md`、`agents/*.md`、`workflows/*.md`、`references/*.md`、`README.md` 中审计点名的文字；
  钉住这些文字的测试；为这些缺陷类新增的提示词层门禁测试；CHANGELOG 与版本号。
- 不做：`~/.claude/` 下的已安装副本（会被 24 小时一次的自动更新覆盖）；服务端行为；
  researcher 的 `tools` 列表（见决策与进展）。

## 验收标准

- [x] AC0：13 条在当前源码里逐条核实仍存在 — 验证：按审计原文 grep（见验证记录）
- [ ] AC1：doctor 读 `runtime/update-notification.json`，按 hook 实际写出的每个 `kind` 报告 — 验证：`tests/prompt-layer.test.js`
- [ ] AC2：doctor 只在 `package.json` 的 `name` 为 `gsd-lite` 时比较源码版本，`health.warning` 记 WARN — 验证：同上
- [ ] AC3：doctor 的锁过期阈值与 `LOCK_STALE_MS` 一致 — 验证：同上（从 `src/utils.js` 取值）
- [ ] AC4：随包文字不再让用户运行 `/plugin update` — 验证：同上
- [ ] AC5：stop.md 只经 `state-update` 写状态；start.md 不再提 `codebase-retrieval`
- [ ] AC6：reviewer 按 task 已有 level 审查，`review_level` 取值与 `src/schema.js` 一致，L3 流程与 `reviewer.js` 一致
- [ ] AC7：四个代理的 description 写明由 GSD-Lite 编排器派发、返回什么、不用于什么
- [ ] AC8：commands/agents 里没有 `<EXTREMELY-IMPORTANT>`；debugger/executor/reviewer 的重复施压段并成带理由的规则
- [ ] AC9：debugger 不再写"添加日志"；researcher 不自己写 `.gsd/research/`
- [ ] AC10：命令 description 不再枚举触发短语
- [ ] AC11：reviewer 的输入协议与 `orchestrator-resume` 实际载荷一致
- [ ] AC12：示例里的 `expires_at` 不再是会过期的字面日期
- [ ] AC13：executor 的 TDD 例外写明不降低审查级别；计划阶段级别规则把迁移/CI/CD/部署配置定为至少 L2、涉及生产定为 L3
- [ ] AC14：`npm test`、`npm run lint` 全绿；新增与改动的测试经 `scripts/gate-replay.js` 判定为 DISCRIMINATIVE
- [ ] AC15：发版 — CI 绿、tag、npm 与 GitHub Release 按 ship runbook 核对产物

## 方案

逐条核实结果（2026-10-20，HEAD 9a5ade6）：

| 条目 | 当前源码 | 处理 |
|------|----------|------|
| A1 | `commands/doctor.md:93` 仍读 `.update-pending`；hook 写 `runtime/update-notification.json`，`kind` ∈ {available(+action), updated, failed}，字段 from/to | 修 |
| A2 | `doctor.md:86` 仍用当前项目 `package.json`；`health` 在漂移时带 `warning`（`src/server.js:330`） | 修 |
| A3 | `stop.md:46` 仍写"先写 .tmp 再 rename" | 修 |
| A4 | `start.md:28` 仍写 `codebase-retrieval` | 修 |
| A5 | `reviewer.md` "审查级别判定" 仍在；服务端按 task.level 持有 L3（`src/tools/orchestrator/reviewer.js:106-160`） | 修 |
| A6 | 四个 description 原文仍在 | 修 |
| A7 | prd/start/resume 仍用 `<EXTREMELY-IMPORTANT>` | 修 |
| A8 | debugger 铁律+红旗+HARD-GATE 仍在 | 修 |
| A9 | executor "铁律 (来自 Superpowers…)" 仍在 | 修 |
| A10 | reviewer 开头 `<EXTREMELY-IMPORTANT>` 仍在 | 修 |
| A11 | debugger "运行测试/添加日志" 仍在 | 修 |
| A12 | researcher "写入 .gsd/research/" 仍在 | 修 |
| A13 | prd/start description 仍枚举触发短语 | 修 |

待核实事项：

- 上下文阈值：`resume.md:99` 的 ≥40% 是 resume 时的服务端门槛 `CONTEXT_RESUME_THRESHOLD = 40`
  （`src/tools/orchestrator/helpers.js:15`，`resume.js:279` 强制），35% 是保存阈值，
  `references/execution-loop.md:151` 已写明两者区别 → 核实后不改。
- 锁：`.gsd/state.lock` 由 `withFileLock` 管理，`LOCK_STALE_MS = 10_000`，超过即被下一次写入打破；
  doctor 的 5 分钟会把 10 秒到 5 分钟之间的过期锁报成"正在操作" → 改为 10 秒，并说明无需手动删除。
- reviewer 输入：实际载荷是 `review_scope`、`phase_id`、`current_review{scope, scope_id, stage}`，
  phase 审查带 `review_targets[]`，task 审查带单个 `review_target`；每项 `{id, level, checkpoint_commit,
  files_changed, *_rejected}`；level 可为 L3；没有 `task_spec` → 改协议，规格从 `.gsd/phases/phase-<phase_id>.md` 读。
- 示例日期：`agents/researcher.md` 两处 `2026-03-16`、`workflows/research.md` 一处 `2026-03-17` 已过去；
  服务端只校验能否解析，`collectExpiredResearch` 会把过去的时间直接判为过期 → 改成占位符。

冲突 iii 的官方写法（https://code.claude.com/docs/en/discover-plugins，2026-10-20 读取）：
"open it on the Installed tab in `/plugin` during a session and select Update now, or run
`claude plugin update <plugin>@<marketplace>` in your shell"。marketplace 名为 `gsd`（`.claude-plugin/marketplace.json`）。

门禁测试放在新文件 `tests/prompt-layer.test.js`，按缺陷类断言（读真实来源取值，不手抄常量）：
通知文件名与 kind 集合取自 hook 源码，锁阈值取自 `src/utils.js`，`review_level` 集合取自 `src/schema.js`。

## 计划

- [ ] S1：新增 `tests/prompt-layer.test.js`（先红）— 覆盖 AC1–AC12 — 执行：主会话
- [ ] S2：逐条修改，每个逻辑改动一个提交 — 执行：主会话
- [ ] S3：全套测试 + lint + gate-replay — 覆盖 AC14
- [ ] S4：独立 reviewer（新子代理，克隆仓库，不在本工作树里切换版本）
- [ ] S5：CHANGELOG + `npm version minor`（临时 `CLAUDE_CONFIG_DIR`）→ PR → CI → rebase 合并 → tag → 核对产物 — 覆盖 AC15

## 决策与进展

- 选 minor（0.16.0）而非 patch：命令与代理的 description 变化会改变 Claude Code 何时路由到它们，属于用户可感知的默认行为变化。
- 计划阶段级别规则同时存在于 `workflows/execution-flow.md` STEP 7、`references/review-classification.md` 的静态分类表和
  README 的 Review Levels 表，三处一起改，只改一处会互相矛盾。
- researcher 的 `data_not_instructions` 里"写入 `.gsd/research/` 之外的路径"与 A12 矛盾（暗示可以写 `.gsd/research/`），
  随 A12 一起改成"写入任何文件"；该段其余文字不动。
- researcher 的 `tools` 仍含 `Write`。去掉它能从机制上杜绝自行写文件，但审计没有要求，且改变代理的工具面 → 不改，列为遗留。
- `/plugin update gsd` 还出现在 hook 输出里（`hooks/gsd-session-init.cjs:309`、`hooks/gsd-auto-update.cjs:793,799`，
  各有测试钉住）。用户点名的是 doctor.md 和 README 两处；hook 三处是否一并改，发版前问用户。

## 验证记录

- 基线 `npm test`（main 9a5ade6）→ 通过（1514/1514，exit 0）
- 基线 `npm run lint` → 通过（110 files，0 findings）
- 基线 `gh run list --branch main --limit 1` → success（run 35645263038）
