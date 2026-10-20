# 0.17.0：研究进入 state、刷新重设计，以及 0.16.0 的遗留
状态：进行中（2026-10-20 开始）

## 背景与目标

0.16.0（`tasks/specs/prompt-audit-2026-10-17.md`）把 A12 和研究刷新推迟了，并留下一批遗留项。2026-10-20 用户要求做完剩余工作后发版，
并授权：研究刷新重设计 + A12 放进 0.17.0（L3）；hono override 下限提到 `^4.13.11`；删除三个已 rebase 合并的本地分支（已删）。

核实到的现状（main 53e5476）：

- 规划阶段的研究从未进入 `state.json`：STEP 5 让 researcher 自写 `.gsd/research/`，STEP 10 不调用 handler。
  于是 `buildExecutorContext`（`src/tools/state/logic.js:299-302`）对每个 `research_basis` 都给出 `summary: 'not found'`，
  研究过期检查也从未触发。
- 研究刷新状态机在真实使用中从未跑过，已知缺陷（第三、四次复审）：
  1. 已验收 phase 里的 task 被判为 `needs_revalidation` 时 phase 不重开，`validateState` 拒收（schema.js:588），每次 resume 都派发 researcher；
  2. 规则 3 保留被删除的条目及其已过期的 `expires_at`，每次刷新都再次触发；规则 1 在新条目缺 `expires_at` 时沿用旧值；
  3. researcher 返回早于现在的 `expires_at` 时服务端照存，存完立即过期；
  4. `storeResearch` 先写四个文档、后校验 state，校验失败时文档已被覆盖、提交标记已删；
  5. researcher 不知道自己处在新研究 / 刷新哪种模式，resume.md 的刷新步骤没有 handler 报错时的处理。
- 本次读代码新发现：`inferWorkflowModeAfterResearch`（constants.js:126）只看 `current_review.scope`。从 `executing_task` 的调试阶段
  （`stage: debugging`，scope 为 task）进入刷新，存完变成 `reviewing_task`；从 `awaiting_user` 的 `review_retry_exhausted` /
  `direction_drift` 进入，存完变成 `reviewing_phase`，绕过了等用户决定的状态。
- 阶段审查漏掉任何一个已 checkpoint 的 task（不只 L3）都会无限绕圈：`handleReviewerResult` 把审查记为 accepted、`retry_count` 清零，
  task 仍是 checkpointed，`selectRunnableTask` 下一轮又返回 `trigger_review`。
- 调试轮数只靠 debugger 自报：`debug_context.fix_attempts` 原样存 debugger 返回的值，没有代码递增；新开的 debugger 报 0，
  "第 3 个修复方向仍无效 → phase 失败"（agents/debugger.md）就永远不触发。

级别：L3（服务端状态机、MCP 工具 schema、随包提示词，且研究会过期并触发刷新是用户可感知的默认行为变化）。
版本：0.17.0（minor）。

## 范围

- 做：研究存储与刷新（`src/tools/state/logic.js`、`constants.js`、`src/tools/orchestrator/helpers.js`、`resume.js`、`src/schema.js`、`src/server.js`）；
  规划研究交给 handler（A12）及相关提示词（execution-flow、researcher、research、resume、state-diagram 等）；两个服务端死循环；
  hono override；文档与代码对不上的几处；`scripts/sync-versions.js`；e2e Layer B 孤儿进程；门禁测试的 LOW；CHANGELOG 与版本号。
- 不做：用户本机的 `~/.claude/gsd/`（手动安装的 0.13.0，用户自己的环境）；tofu-trust-records（草稿 spec，不在本次遗留里）。

## 验收标准

- [ ] AC1：规划研究在 STEP 10 `state-init` 之后经 `orchestrator-handle-researcher-result` 存入 state；executor 上下文里的 `research_decisions` 解析到摘要 — 验证：端到端测试
- [ ] AC2：刷新是整体替换：存完后的 `decision_index` 等于新结果；摘要变了或 id 消失的决策让引用它的 task 失效 — 验证：单元测试
- [ ] AC3：入口拒收早于现在的 `expires_at`（整体和每条决策），什么都不写 — 验证：单元测试
- [ ] AC4：`storeResearch` 要么成功，要么磁盘上的文档、state 和提交标记都不变 — 验证：强制校验失败的测试
- [ ] AC5：失效 task 所在的已验收 / 审查中 phase 重新打开，与 `propagateCrossPhaseInvalidation` 共用一个函数 — 验证：第四次复审的复现脚本走到 `dispatch_executor`
- [ ] AC6：内容不变的刷新让流程回到刷新前的同一个动作，覆盖每个会跑 preflight 的 (workflow_mode, stage) 组合；`awaiting_user` 期间不因研究过期打断 — 验证：对照性质测试
- [ ] AC7：同一份研究存两次，第二次不让任何 task 失效 — 验证：单元测试
- [ ] AC8：阶段审查漏掉 checkpointed task 时计入 `retry_count`、不记 accepted，到上限转 `awaiting_user` — 验证：先红的测试
- [ ] AC9：服务端自己数修复方向；三个方向都失败后 debugger 的结果按文档让 phase 失败 — 验证：先红的测试
- [ ] AC10：`npm audit --omit=dev` 无告警
- [ ] AC11：start.md:19、execution-loop.md 的级别说明、review-cycle.md 38 与 53–54、reviewer.md:59 与代码一致
- [ ] AC12：`scripts/sync-versions.js` 遇到任何参数都报错退出，不写任何文件
- [x] AC13：e2e Layer B 超时时杀掉整个进程组
- [ ] AC14：`npm test`、`npm run lint` 全绿；有源码改动的 PR 里改动的测试文件经 gate-replay 判 DISCRIMINATIVE
- [ ] AC15：独立复审（克隆仓库，禁止运行 `scripts/sync-versions.js`）后发版，按 ship runbook 核对产物

## 方案

### 研究存储（`storeResearch` / `applyResearchRefresh`）

- 刷新 = 整体替换。researcher 每次返回完整的决策集（仍然成立的沿用原 id），服务端每次整份覆盖四个文档，
  所以合并后的索引就是新索引。规则只决定失效：摘要变了（规则 2）或 id 消失（规则 3）的决策，引用它的 task 失效。
  被删除的条目不再保留，规则 3 不会反复触发，也不会留下过期的 `expires_at`。
- 入口校验（只在 store 入口，不在 `validateState`：已存的研究本来就会随时间过期）：`result.expires_at` 和每条决策自带的
  `expires_at` 必须能解析且晚于现在。
- 顺序：校验输入 → 加锁读 state → 在副本上算出新 state（失效、重开 phase、done、workflow_mode）→ `validateState` →
  通过后才写提交标记、四个文档、state，最后删标记。校验失败时什么都不写。
- 重开 phase：抽出 `reopenPhase(phase)`（accepted / reviewing → active，`phase_review` 重置，`phase_handoff.required_reviews_passed = false`），
  `propagateCrossPhaseInvalidation` 与研究刷新共用。研究刷新不级联到依赖它的后续 phase：失效的是引用该决策的 task，
  契约是否变化由重新执行后的审查（`invalidates_downstream`）判断，与现有规则一致。早于 current_phase 的脏 phase 由已有的
  dirty-phase 回滚处理。
- 存完的 workflow_mode：仍在 `research_refresh_needed` 时才改。刷新让任何 task 失效 → 清掉审查类 `current_review`，回到 `executing_task`；
  否则按阶段恢复：`debugging` → `executing_task`（保留 current_review），phase 审查 → `reviewing_phase`，task 审查 → `reviewing_task`，其余 → `executing_task`。
- `awaiting_user` 期间 preflight 不因研究过期改写模式（与 human_confirmation 的处理同理：用户决定优先，过期在之后的 resume 里处理）。
- `dispatch_researcher` 响应带上当前的 `decision_index`，researcher 据此沿用仍然成立的 id。
- handler 对 `research_basis` 引用了新索引里没有的 id 的 task 给出警告（不拒收）。

### 规划研究（A12）

- researcher 不写文件，只返回 `result` / `decision_index` / `artifacts`；去掉 `tools` 里的 `Write`（Bash 仍可写，这是提示词约束 + 去掉最直接的路径）。
- STEP 5 保留三项；STEP 8 的陷阱检查读保留的 `artifacts["PITFALLS.md"]`；STEP 10 `state-init` 之后调用 handler，报错就展示并停下。
- STEP 5 不再因已有 `.gsd/research/` 跳过研究（重新开始的项目，`state-init` 会清掉研究记录）。
- `state-init` 的输入 schema 声明 task 的 `research_basis`。
- 起点：`07e3484` 撤回的提示词（researcher.md、execution-flow.md），e3d5424、1e1700c 的分析。

### 两个死循环

- 审查：phase 审查、未要求返工时，若审查对象（`getReviewTargets`）里有 checkpointed task 既不在 `accepted_tasks` 也不在 `rework_tasks`：
  这一轮算未完成 —— 已列出的照常处理，`phase_review` 记 `pending`、`retry_count + 1`、不设 `required_reviews_passed`，
  超过 `MAX_PHASE_REVIEW_RETRY` 转 `awaiting_user`（`review_retry_exhausted`）；响应带 `unreviewed_tasks`。reviewer.md 的
  "一直漏掉就一直绕圈" 随之改写。
- 调试：服务端在 `debug_context.fix_attempts` 记录已给出的修复方向数（每个非 failed 结果 +1，忽略自报值）；
  已给出 3 个方向后又回到 debugger，无论它报什么都按 `failed` + `architecture_concern` 处理（phase 失败），与 debugger.md 的规则一致。

### 停止规则

复审第二轮若仍在研究刷新状态机里发现 BLOCKER，撤出研究这部分（A12 与刷新），其余照发（0.16.0 的教训）。

## 计划

- [x] PR1 `test/0.17-gates`（纯测试）：本 spec；门禁 LOW（描述门禁放过 "Triggered…"、带语言标记的围栏、"不读取…"/"不要忽略…" 误判）；
  补回 `storeResearch` 无项目检查的测试；e2e Layer B 进程组。
- [ ] PR2 `fix/deps-hono`：override `hono` `^4.13.11`。
- [ ] PR3 `fix/0.17-loops-and-docs`：两个死循环；文档与代码对不上的几处；`sync-versions.js`。
- [ ] PR4 `feat/research-in-state`：研究存储重设计 + A12。
- [ ] 独立复审（全范围 v0.16.0..HEAD）→ 修复 → 发版分支（CHANGELOG + `npm version minor`，临时 `CLAUDE_CONFIG_DIR`）→ tag → 核对产物。

## 决策与进展

- 2026-10-20：用户选"做，发 0.17.0"、"提 hono"、"授权删分支"。三个本地分支删除前核实：每个提交在 origin/main 上都有补丁等价提交（`git cherry` 全为 `-`），
  没有测试或脚本引用它们的 SHA。
- PR1 的门禁改动各自在仓库临时副本里做变异对照（旧门禁 / 新门禁的失败数）：描述写 "Triggered whenever…" 0/1；
  "不读取 `checkpoint_commit`"、带语言标记的围栏、"不要忽略…"、"do not ignore" 均 1/0；对照 "（忽略这一条）"、"(ignore this)" 1/1。
  `storeResearch` 无项目检查：删掉守卫、改返回别的错误码，旧测试 0 失败，新测试 1 失败。
- e2e Layer B：第一次用 2 秒超时跑真实 npx 没复现孤儿（2 秒时 npm 还没派生子进程，SIGTERM 直接打在 npx 上），这个对照说明不了什么；
  改用会派生两个子进程的 shell 命令替换安装命令再超时：execSync 留下 2 个，进程组留下 0 个。

## 验证记录

- 基线 `gh run list --branch main --limit 1` → success（run 39477719256，53e5476）
- 基线 `npm test`（main 53e5476，load 1.4）→ 通过（1567/1567，exit 0，103 秒）；`npm run lint` → 通过（111 files）
- PR1：`node --test --test-name-pattern="Layer B" tests/e2e-install.test.js` → 通过（11/11，真实网络）；三个提交的 pre-commit 全套测试 → 通过（fail 0）
