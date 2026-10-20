# 提示词审计 2026-10-17 的修复
状态：进行中（第三次复审的 BLOCKER 与 4 个 MEDIUM 已修；经用户同意再做一次增量复审，通过后发版）

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
- 不做：`~/.claude/` 下的已安装副本（会被 24 小时一次的自动更新覆盖）；服务端行为（例外：研究刷新的死循环，见决策与进展）；
  researcher 的 `tools` 列表（见决策与进展）。

## 验收标准

- [x] AC0：13 条在当前源码里逐条核实仍存在 — 验证：按审计原文 grep（见验证记录）
- [x] AC1：doctor 读 `runtime/update-notification.json`，按 hook 实际写出的每个 `kind` 报告 — 验证：`tests/prompt-layer.test.js`
- [x] AC2：doctor 只在 `package.json` 的 `name` 为 `gsd-lite` 时比较源码版本，`health.warning` 记 WARN — 验证：同上
- [x] AC3：doctor 的锁过期阈值与 `LOCK_STALE_MS` 一致 — 验证：同上（从 `src/utils.js` 取值）
- [x] AC4：随包文字不再让用户运行 `/plugin update` — 验证：同上
- [x] AC5：stop.md 只经 `state-update` 写状态；start.md 不再提 `codebase-retrieval`
- [x] AC6：reviewer 按 task 已有 level 审查，`review_level` 取值与 `src/schema.js` 一致，L3 流程与 `reviewer.js` 一致
- [x] AC7：四个代理的 description 写明由 GSD-Lite 编排器派发、返回什么、不用于什么
- [x] AC8：commands/agents 里没有 `<EXTREMELY-IMPORTANT>`；debugger/executor/reviewer 的重复施压段并成带理由的规则
- [x] AC9：debugger 不再写"添加日志"；researcher 不自己写 `.gsd/research/`
- [x] AC10：命令 description 不再枚举触发短语
- [x] AC11：reviewer 的输入协议与 `orchestrator-resume` 实际载荷一致
- [x] AC12：示例里的 `expires_at` 不再是会过期的字面日期
- [x] AC13：executor 的 TDD 例外写明不降低审查级别；计划阶段级别规则把迁移/CI/CD/部署配置定为至少 L2、涉及生产定为 L3
- [x] AC14：`npm test`、`npm run lint` 全绿；新增与改动的测试经 `scripts/gate-replay.js` 判定为 DISCRIMINATIVE
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

- [x] S1：新增 `tests/prompt-layer.test.js`（先红）— 覆盖 AC1–AC12 — 执行：主会话
- [x] S2：逐条修改，每个逻辑改动一个提交 — 执行：主会话
- [x] S3：全套测试 + lint + gate-replay — 覆盖 AC14
- [x] S4：独立 reviewer（新子代理，克隆仓库，不在本工作树里切换版本）— 两轮，见决策与进展
- [ ] S5：CHANGELOG + `npm version minor`（临时 `CLAUDE_CONFIG_DIR`）→ PR → CI → rebase 合并 → tag → 核对产物 — 覆盖 AC15

## 决策与进展

- 选 minor（0.16.0）而非 patch：命令与代理的 description 变化会改变 Claude Code 何时路由到它们，属于用户可感知的默认行为变化。
- 计划阶段级别规则同时存在于 `workflows/execution-flow.md` STEP 7、`references/review-classification.md` 的静态分类表和
  README 的 Review Levels 表，三处一起改，只改一处会互相矛盾。
- researcher 的 `data_not_instructions` 里"写入 `.gsd/research/` 之外的路径"与 A12 矛盾（暗示可以写 `.gsd/research/`），
  随 A12 一起改成"写入任何文件"；该段其余文字不动。
- researcher 的 `tools` 仍含 `Write`。去掉它能从机制上杜绝自行写文件，但审计没有要求，且改变代理的工具面 → 不改，列为遗留。
- `/plugin update gsd` 还出现在 hook 输出里（`hooks/gsd-session-init.cjs:309`、`hooks/gsd-auto-update.cjs:793,799`，
  各有测试钉住）。2026-10-20 问过用户，决定本次一并改（5d3b02d），门禁扩到 `hooks/`。
- `commands/resume.md` 的 reviewing_phase 写"收集该 phase 中所有 L1 task 的 checkpoint 信息"，绕开了服务端的形状校验；
  2026-10-20 问过用户，决定本次一并改（a348ca4）。同类的还有 reviewing_task 的"加载对应 task 的 checkpoint 信息"
  和 execution-flow.md 动作表的 dispatch_reviewer 行，属同一条指令，一起改。
- 新门禁全部放在 `tests/prompt-layer.test.js`，每个修复提交带上自己的那部分断言；每个提交都先在去掉修复的树上确认变红。
- reviewer 载荷门禁从真实 `resumeWorkflow` 响应取字段；写的时候发现响应顶层还有 `summary`（resume 给编排器的展示块），
  归入编排器字段，不算 reviewer 输入。
- 每次提交的 pre-commit 钩子间歇失败，抓到完整输出后确认是 `tests/e2e-install.test.js:658`
  "Layer B: npx from tarball E2E"：用空的 npm 缓存从 registry 拉全部生产依赖，90 秒超时；单独跑 12 秒通过，
  负载高（另一个会话同时在跑发版检查，load 9–12）时超时。与本次改动无关，测试未改。超时只杀掉 `/bin/sh`，
  留下的 `npm exec` 孤儿进程和临时目录已清理。列为遗留。

- 2026-10-20 发版受阻于两件与本分支无关的事，问过用户后按"依赖 + 三步落地"处理：
  - `npm audit` 在 main 上也红（GHSA-6qxp-vccf-f47h、GHSA-jqcg-44mw-7w3h，main 上次绿之后才公布）；release.yml 的 validate 也跑它。
    用户授权依赖改动：PR #33（7f422d6）把 `@modelcontextprotocol/sdk` 升到 ^1.32.1、加 override `proxy-addr` ^2.0.8。
  - `tests/gate-replay-changed.test.js` 在 PR 检出里没有本地 `main`，四个 SHA 全报"不可达"。修复是改测试自身逻辑，
    在混合范围里必然被 vacuity 门禁判 VACUOUS，所以单独走纯测试 PR #32（cc85dd5）。
- 发版前独立评审跑了两轮（第一轮看 9a5ade6..9c742bf，第二轮看此后的修复与 #32/#33），每条发现都先在代码里核实再修：
  - 第一轮：HIGH 1（规划阶段研究无人写入）、MEDIUM 3（review_required:false 绕过审查、debugger 第 3 次失败两种说法、
    L3 测试只查词）、LOW 若干（11 个变异保持绿、CHANGELOG 6 处不准等）。修复见 81b2703…bfb48e5。
  - 第二轮：HIGH 1（交接测试截到文件末尾，删掉交接仍绿）、MEDIUM 6（STEP 8 读尚未写入的 PITFALLS、重新开始路径、
    研究过期这一用户可见变化未写进 CHANGELOG、review-classification 与代码矛盾、review-cycle 留着旧判定规则、
    15 个变异保持绿）。修复见 9efc959…d814202。
- 第三次复审（4ae8da3，增量）：BLOCKER 1，MEDIUM 4，LOW 若干。按评审规则复审最多两轮，第三次仍有问题就交给用户决定，不再自行修补。
  - BLOCKER（已复现）：研究刷新后项目可能永远回不到执行。`applyResearchRefresh` 规则 3 把新研究里没有的决策留在索引里，
    并保留它已过期的 `expires_at`（logic.js:493）；规则 1 在新条目不带 `expires_at` 时沿用旧值（logic.js:486）。
    `collectExpiredResearch`（helpers.js:58）逐条检查决策的 `expires_at`，于是下一次 `orchestrator-resume` 又返回
    `dispatch_researcher`。复现：scratchpad `repro/livelock.mjs`（去掉一个 ID）和 `repro/livelock-rule1.mjs`（ID 不变、不带 expires_at），
    各 3 轮，每轮都是 `dispatch_researcher ["decision:b"]` → `research_stored`。9a5ade6 上规划阶段的研究不进 state，走不到这条路径；
    0.16.0 让它可达。修它要改服务端，超出本 spec 的范围。
  - 2026-10-20 问过用户：BLOCKER 修服务端，4 个 MEDIUM 一并修，修完再做一次增量复审（超出两轮上限，用户同意）。
    - e3d5424：规则 3 保留条目但去掉 `expires_at`，规则 1 在新条目缺 `expires_at` 时取本次研究的值；TC8 先红（2/9）后绿，
      两个复现脚本都在第 2 轮回到 `dispatch_executor`。
    - 3dc41eb：三个门禁（收集门禁加回"读"、交接按指令句定位并数 STEP 10 之前的提及、INSTRUCTIONS 加两端边界和撤销检查）；
      变异回放：旧门禁 30/31 保持绿，新门禁 31/31 变红。
    - 1e1700c：STEP 5 不再因已有 `.gsd/research/` 跳过研究；STEP 8 没做研究时跳过陷阱检查；researcher 沿用仍然成立的 decision id。
  - MEDIUM（已对照代码核实）：c47cca9 去掉了收集门禁的"读取"（prompt-layer.test.js:455）；STEP 10 交接顺序断言会命中
    124 行的核对项，删掉或前移第 4 项仍绿（:510-512）；INSTRUCTIONS 表挡不住句外追加的否定；重新开始且跳过研究时，
    STEP 5（execution-flow.md:12）与 STEP 8（:68）互相矛盾。
- 本次不改、留给后续的（审计未点名、属于代码改动，或超出本次范围）：
  - researcher 的 `tools` 仍含 `Write`（去掉它能从机制上保证不自写）。
  - `fix_attempts` 没有代码递增，`architecture_concern` 也不由服务端强制，"第 3 次失败 → phase 失败"只靠提示词。
  - reviewer 反复漏掉通过的 L3 task 时会无限绕圈（审查记为 accepted、retry_count 每轮清零）。
  - STEP 5 保留的研究只在上下文里，STEP 10 之前 `/clear` 或压缩会丢。
  - researcher 返回早于现在的 `result.expires_at` 时服务端照存（`validateResearcherResult` 只查非空），下一次 resume 又派发
    researcher，是同一类死循环；触发条件是 researcher 不按提示词计算 TTL。服务端拒收过去的时间会牵动一批用固定日期的测试，未做。
  - `npm audit` 新出现 1 个 moderate（hono GHSA-5r4p-p66f-jhc7，经 SDK 引入）；门禁是 high，不阻塞。
  - 第三次复审的 LOW 未改：几处修复没有测试钉住（STEP 10 核对项、resume.md:167 等）；researcher 自写门禁漏"写到"/"由你写入"；
    description 门禁 `/Triggers?:/` 放过 "Triggered whenever…"；`prompt-layer.test.js` 的级别代码块只认裸 ``` 围栏；
    reviewer.md:59 "(L2/L3 只升不降)" 与 L0 可升 L2 的代码不完全对应；review-cycle.md:38 把 auth/payment 放在 L3，
    同文件 53–54 放在 L2；`state-init` 的输入 schema 不声明 `research_basis`；CHANGELOG 第 75 行仍写"多一轮审查"、第 40 行未折行。
  - `storeResearch` 校验 `expires_at` 失败前已覆盖部分文档并删掉提交标记（logic.js:633-636）。
  - `references/execution-loop.md:72-80` 的级别说明没有 L3；`commands/start.md:19` 写"STEP 3 的 `state-init`"，实际在 STEP 10。
  - `scripts/sync-versions.js:98,110` 写 `claude plugin update gsd`（没带 `@gsd`）；scripts/ 不随包发布。
  - e2e-install Layer B 用空 npm 缓存从 registry 装依赖、90 秒超时，机器负载高时超时，超时后会留下孤儿 `npm exec` 进程；
    本次跑过的孤儿与临时目录都已清理，测试未改。
  - 本地分支 `fix/ci-pr-main-ref`、`fix/deps-audit-2026-10` 已经 rebase 合并，`git branch -d` 拒绝删除（SHA 不同），保留。

## 验证记录

- 基线 `npm test`（main 9a5ade6）→ 通过（1514/1514，exit 0）
- 基线 `npm run lint` → 通过（110 files，0 findings）
- 基线 `gh run list --branch main --limit 1` → success（run 35645263038）
- `node scripts/gate-replay-changed.sh main HEAD`（a348ca4）→ 通过：prompt-layer.test.js DISCRIMINATIVE（29/30 在 9a5ade6 上失败，
  唯一通过的是语料存在性检查），auto-update.test.js、session-init.test.js 均 DISCRIMINATIVE
- `npm run lint`（a348ca4）→ 通过（111 files，0 findings）
- `npm test`（a348ca4，load 12）→ 1540/1544 通过，exit 1：失败只有 e2e-install Layer B 超时（4 个子测试被取消），见上
- `npm test`（1ff63dd 之前各提交的 pre-commit）→ 通过，多次；单独运行 `--test-name-pattern="npx from tarball"` → 通过（4/4，12 秒）
- 第三次复审修复后（1e1700c）：`npm test` → 通过（1581/1581，exit 0）；`npm run lint` → 通过（111 files）；
  `npm audit --omit=dev --audit-level=high` → 通过（exit 0，1 moderate 见遗留）；
  `bash scripts/gate-replay-changed.sh origin/main HEAD` → 通过（4 个测试文件均 DISCRIMINATIVE）；
  `bash scripts/gate-replay-changed.sh 4ae8da3 HEAD` → 通过（e2e-research-integration 2/9、prompt-layer 4/65 在 4ae8da3 上失败）
