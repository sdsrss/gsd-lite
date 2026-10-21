# 0.17.0：研究进入 state、刷新重设计，以及 0.16.0 的遗留
状态：完成（v0.17.0 已于 2026-10-21 发布）

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

- [x] AC1：规划研究在 STEP 10 `state-init` 之后经 `orchestrator-handle-researcher-result` 存入 state；executor 上下文里的 `research_decisions` 解析到摘要 — 验证：端到端测试
- [x] AC2：刷新是整体替换：存完后的 `decision_index` 等于新结果；摘要变了或 id 消失的决策让引用它的 task 失效 — 验证：单元测试
- [x] AC3：入口拒收早于现在的 `expires_at`（整体和每条决策），什么都不写 — 验证：单元测试
- [x] AC4：`storeResearch` 要么成功，要么磁盘上的文档、state 和提交标记都不变 — 验证：强制校验失败的测试
- [x] AC5：失效 task 所在的已验收 / 审查中 phase 重新打开，与 `propagateCrossPhaseInvalidation` 共用一个函数 — 验证：第四次复审的复现脚本走到 `dispatch_executor`
- [x] AC6：内容不变的刷新让流程回到刷新前的同一个动作，覆盖每个会跑 preflight 的 (workflow_mode, stage) 组合；`awaiting_user` 期间不因研究过期打断 — 验证：对照性质测试
- [x] AC7：同一份研究存两次，第二次不让任何 task 失效 — 验证：单元测试
- [x] AC8：阶段审查漏掉 checkpointed task 时计入 `retry_count`、不记 accepted，到上限转 `awaiting_user` — 验证：先红的测试
- [x] AC9：服务端自己数修复方向；三个方向都失败后 debugger 的结果按文档让 phase 失败 — 验证：先红的测试
- [x] AC10：`npm audit --omit=dev` 无告警
- [x] AC11：start.md:19、execution-loop.md 的级别说明、review-cycle.md 38 与 53–54、reviewer.md:59 与代码一致
- [x] AC12：`scripts/sync-versions.js` 遇到任何参数都报错退出，不写任何文件
- [x] AC13：e2e Layer B 超时时杀掉整个进程组
- [x] AC14：`npm test`、`npm run lint` 全绿；有源码改动的 PR 里改动的测试文件经 gate-replay 判 DISCRIMINATIVE
- [x] AC15：独立复审（克隆仓库，禁止运行 `scripts/sync-versions.js`）后发版，按 ship runbook 核对产物

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
- [x] PR2 `fix/deps-hono`：override `hono` `^4.13.11`。
- [x] PR3 `fix/0.17-loops-and-docs`：两个死循环；文档与代码对不上的几处；`sync-versions.js`。
- [x] PR4 `test/layer-b-budget`（纯测试）：Layer B 时间预算按实测放宽。
- [x] PR5 `feat/research-in-state`：研究存储重设计 + A12，以及两轮复审的修复。
- [x] 独立复审（全范围 v0.16.0..HEAD）→ 修复 → 发版分支（CHANGELOG + `npm version minor`，临时 `CLAUDE_CONFIG_DIR`）→ tag → 核对产物。

## 决策与进展

- 2026-10-20：用户选"做，发 0.17.0"、"提 hono"、"授权删分支"。三个本地分支删除前核实：每个提交在 origin/main 上都有补丁等价提交（`git cherry` 全为 `-`），
  没有测试或脚本引用它们的 SHA。
- PR1 的门禁改动各自在仓库临时副本里做变异对照（旧门禁 / 新门禁的失败数）：描述写 "Triggered whenever…" 0/1；
  "不读取 `checkpoint_commit`"、带语言标记的围栏、"不要忽略…"、"do not ignore" 均 1/0；对照 "（忽略这一条）"、"(ignore this)" 1/1。
  `storeResearch` 无项目检查：删掉守卫、改返回别的错误码，旧测试 0 失败，新测试 1 失败。
- e2e Layer B：第一次用 2 秒超时跑真实 npx 没复现孤儿（2 秒时 npm 还没派生子进程，SIGTERM 直接打在 npx 上），这个对照说明不了什么；
  改用会派生两个子进程的 shell 命令替换安装命令再超时：execSync 留下 2 个，进程组留下 0 个。

- PR1–PR4 已合并（#35 #36 #37 #38）。PR3 的四个提交各自在 `git stash --keep-index` 隔离下过 pre-commit 全套测试。
- 新发现并修复（研究进入 state 后被唤醒的读者）：
  - `phaseComplete` 推进 current_phase 只是 +1：回滚到更早的脏 phase、重做完后会落到一个已验收的 phase，`complete_phase` 无出口。改为推进到下一个未验收的 phase。
  - `paused_by_user` 时研究过期会被刷新接管，刷新后项目直接继续执行（对照性质测试发现）。与 `awaiting_user` 一并加入 `USER_HOLD_MODES`，preflight 不在这两种状态下刷新。
  - `tests/orchestrator.test.js` 的脏 phase 回滚测试注释写"phase 仍为 accepted，与 applyResearchRefresh 一致"，实际 setup 从未让 phase 进入 accepted（active → accepted 被拒，返回值未检查）。注释修正放在单独的纯测试 PR（只改注释的测试文件在混合范围里必然 VACUOUS）。
- 写新测试文件时用 Write 覆盖了已有的 `tests/research-refresh.test.js`（6 个 applyResearchRefresh 单元测试），提交前发现，已从 origin/main 恢复原文件，新测试改名为 `tests/research-in-state.test.js`。
- e2e Layer B 的 90 秒超时在负载 ~1.3 时也会触发：8 次运行 13 秒到 90 秒以上、两次超时，属于网络耗时分布的尾部，不只是负载。PR4 按实测放宽预算。
- 研究文档里"package.json 主依赖大版本变更 → 立即过期"、"用户说重新研究 → 强制过期"（workflows/research.md）没有对应代码，早于本次，未改，列为遗留。
- 发版前独立复审第一轮（v0.16.0..release/0.17.0，全范围）：BLOCKER 1（复审自评）、HIGH 2、MEDIUM 2、LOW 若干，均先复现再修：
  - BLOCKER：来源全部不可用时 researcher 的 `[BLOCKED]` 兜底结果在刷新时整体替换了记录 → 有研究记录时拒收（bfc52e7 的对应提交）。
  - HIGH：preflight 只排除 awaiting_user / paused_by_user，planning / reconcile_workspace / replan_required / awaiting_clear 被刷新接管后直接执行 →
    改为 `REFRESH_MODES`（可被打断的模式），测试按 `WORKFLOW_MODES` 全覆盖。又一次"列不可信集合"（见记忆 review-caught-what-i-missed 第 8 条）。
  - HIGH：`retry_failed` 不清 `debug_context`，服务端计数让重试后的 task 立即再失败 → 重试时清空。
  - MEDIUM：校验器拒收"自报 fix_attempts ≥ 3 但结论非 failed"，照抄派发计数的 debugger 被反复派发 → 不再校验自报值，由服务端计数决定。
  - MEDIUM：checkpointed 的 L0 task 不在审查对象里，阶段审查死循环 → 审查对象 = 所有 checkpointed task（触发条件同一集合）。
  - LOW：写到一半失败删掉提交标记、2 秒 TTL 被接受、CHANGELOG"5 次后"实为第 6 轮、两处注释。
  - 存活变异 3 个（全部后续阶段已验收时直接完成、reopenPhase 的重置、resume.md 的说明）补了测试。
- 发版前复审第二轮（增量，0d42cc4..release/0.17.0）：无 BLOCKER；HIGH 1、MEDIUM 1、LOW 若干：
  - HIGH：第一轮的 `[BLOCKED]` 拒收让"规划时就没有来源"的项目在占位过期后永远停在刷新 → 只在记录里有真实结论时拒收；resume.md 与报错写明出路（`research: null`）。
  - MEDIUM（未改，记为遗留）：`resumeAwaitingClear` 把 /clear 前被打断的审查留在 `current_review` 却持久化 `executing_task`，不刷新时这个审查被丢掉，
    刷新后 `inferWorkflowModeAfterResearch` 恢复了它。两条路径不一致，AC6 在这种遗留审查的边角不成立；刷新那条恢复被打断的审查，更接近意图。
    根因在 `resumeAwaitingClear`（早于本次），修它要动本次只是"碰到"的代码，按记忆第 10 条不在本次扩展。
  - LOW：失败的重试会删掉之前留下的标记 → 只删本次自己建的；两处"L0 不会派给你"；resume.md 两处措辞；state-diagram 门禁看不见 REFRESH_MODES 变化 → 改为比对预检列表；
    TTL 下限只被无关测试顺带挡住 → 受阻用例改用 24 小时；工具描述补上下限与拒收；CHANGELOG 措辞。
  - 早于本次（未改，记为遗留）：调试中被暂停的项目，resume 报告 `resume_to: reviewing_task`（resume.js 的 paused 分支同样只看 scope 不看 stage）。
- 发版前复审第三轮（增量，第二轮修复 + CHANGELOG）：无 BLOCKER / HIGH；S1–S4 实际运行成立（32 组合矩阵、SIGKILL 崩溃模拟），CHANGELOG 未发现不实句子。
  - MEDIUM：混合记录 / 混合结果的拒收没有测试钉住（两个变异保持绿）→ 补测试（c453e2f）。
  - LOW 已改：researcher.md 一句话在收窄后不准且被测试钉死；resume.md 两条指令重叠（受阻拒收会多派一次）；出路与 L0 的说明未钉住；工具描述未写出路（29fbb05 的提交说明说写了）。
  - LOW 未改（记为遗留，属于未经复审的行为改动）：受阻识别是精确前缀，前面多一个空格就识别不到；结果的 `decision_index` 为空时会抹掉真实记录。两者都要 researcher 偏离提示词。
  - LOW 未改（早于本次）：`state-update` 的增量校验允许写入格式不对的 `decision_index` 条目（null、无 summary），其上的真实刷新会抛 TypeError。
  - 环境：在全新 HOME 下 install 类 e2e 测试冷缓存超时；本机 pre-commit 钩子也两次在 e2e install 处失败（负载 3–4.6），之后同一份代码在钩子环境变量下和真实钩子里都完整通过。
- 2026-10-21 用户在第三轮复审后选"发布 0.17.0"（此前约定第三轮仍有发现就交给用户决定）。

## 验证记录

- 发版（v0.17.0）：
  - PR #39、#40、#41 rebase 合并；main 9981daf，`git diff 5768a88 origin/main` 为空；三处版本号与 package-lock 两处均为 0.17.0
  - main CI run 39547556637 → 通过（gate-replay、test 20/22/24）
  - release run 39547707303 → 通过（validate、publish）；日志含 `All versions consistent: 0.17.0`、`Packed gsd-lite-0.17.0.tgz — sha256=64280315…`、`Signed checksum (Ed25519)`、
    `Embedded public key pairs with the signing secret ✓`、provenance logIndex=3350054794、`+ gsd-lite@0.17.0`
  - `npm view gsd-lite version --prefer-online` → 第 3 次轮询为 0.17.0（前两次 0.16.0）；`dist.attestations` predicateType slsa provenance v1
  - Release 资产 `sha256sum` == 正文 `sha256:` == 发布日志 sha256；`verifyReleaseSignature` 8/8 符合预期（真对 true，7 个反例 false，翻转取中间字符）
  - 解包：13 项改动 grep 命中；`scripts/` `tests/` `tasks/` `docs/` 不在包内
  - 冒烟：一次性 `CLAUDE_CONFIG_DIR` 里 marketplace add + `claude plugin install gsd@gsd` → `gsd@gsd 0.17.0`，Skills 6、Agents 4、Hooks 3、MCP servers 1；
    真实 `~/.claude.json`、`~/.claude/settings.json` md5 不变，`~/.claude` 条目 51 → 51；冒烟目录已删除
- 第三轮修复后：`npm test` → 通过（1641/1641）；`npm run lint` → 通过（112 files）；gate-replay 9 个测试文件均 DISCRIMINATIVE；PR #39 CI run 39505634315 → 通过

- 基线 `gh run list --branch main --limit 1` → success（run 39477719256，53e5476）
- 基线 `npm test`（main 53e5476，load 1.4）→ 通过（1567/1567，exit 0，103 秒）；`npm run lint` → 通过（111 files）
- PR1：`node --test --test-name-pattern="Layer B" tests/e2e-install.test.js` → 通过（11/11，真实网络）；三个提交的 pre-commit 全套测试 → 通过（fail 0）
- PR2：`npm audit --omit=dev` → 1 moderate → 0；锁文件 hono 4.13.8 → 4.13.13，integrity 与 `npm view` 一致
- PR3：`bash scripts/gate-replay-changed.sh origin/main HEAD` → 4 个测试文件均 DISCRIMINATIVE；动作表门禁在父提交上无缺口（构造上为绿），删掉 `review_incomplete` 行即变红；
  审查漏审测试在修复前 4/4 红（第 1 轮即被记为通过）；调试计数测试修复前 6 轮全是 `dispatch_executor`
- PR5：`tests/research-in-state.test.js` 17 个用例在父提交的 src 上 17/17 红；16 个变异各至少让 1 个用例变红（`mutate-research.py`，在仓库副本上逐个应用）；
  0.16.0 的三个复现脚本（accepted-phase、livelock、livelock-rule1）第 2 轮即回到 `rollback_to_dirty_phase` / `dispatch_executor`（修复前各 3 轮 `dispatch_researcher`）；
  `npm test` → 通过（1612/1612，exit 0，load 3.3）；`npm run lint` → 通过（112 files）；
  `bash scripts/gate-replay-changed.sh origin/main HEAD` → 5 个测试文件均 DISCRIMINATIVE
- 两轮复审修复后（feat/research-in-state）：`npm test` → 通过（1633/1633，exit 0）；`npm run lint` → 通过（112 files）；
  `bash scripts/gate-replay-changed.sh origin/main HEAD` → 9 个测试文件均 DISCRIMINATIVE；变异 26 个，各至少让 1 个用例变红；
  新增红测试在修复前均失败（第一轮 7 + TC12/TC13 + L0，第二轮 2）
