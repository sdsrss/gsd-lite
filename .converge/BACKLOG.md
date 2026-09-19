# BACKLOG

格式：`- [P0|P1|P2] [未复现|已复现] 一句话描述 (文件:行)`
P0 = 数据丢失 / 崩溃 / 安全；P1 = 功能错误；P2 = 其他。
`未复现` 超过 2 轮没人复现就删掉——它是一条没人证实过的传闻。

## 待办

- [P1] [未复现] 自动更新的回滚路径在唯一会自动安装的模式（manual）下是死代码：
  `currentPkgPath` 指向 `pluginRoot/package.json`，而真实安装里 `pluginRoot` 是
  `~/.claude`，版本标记却写在 `~/.claude/gsd/package.json`，
  于是 `backedUp` 永远为 false，下载安装失败时无从回滚
  (hooks/gsd-auto-update.cjs:584-605)。来源：scout-hooks，报告被截断，
  主线程尚未独立复现，**R3 首选核验对象**。
- [P1] [未复现] `update()` 接受结构非法的 task id，且没有全局唯一性检查：
  `crud.js:306-310` 直接把调用方给的 task 推进 `phase.todo`，
  而 `validateState` 只要求 `task.id` 是非空字符串 (src/schema.js:576-578)；
  `createInitialState` 两样都校验。跨 phase 重名 id 会让 `remove_task`
  命中第一个匹配项，删掉调用方没点名的任务 (crud.js:913)。来源：scout-state。
- [P2] [未复现] 没有 `todo` 数组的 phase 会让 `add_task` / `reorder_tasks`
  抛出无错误码的 `Tool execution failed`，而同文件的其它 op 都用了 `p.todo?.`
  (src/tools/state/crud.js:866, :949)。来源：scout-state。
- [P2] [已复现] `state-read {fields:['不存在的字段']}` 静默返回 `{}`，
  调用方分不清"字段不存在"和"字段值为空" (src/tools/state/crud.js:154)。
- [P2] [未复现] `phase-complete {run_verify:true}` 在 handoff gate 未满足时先返回
  `HANDOFF_GATE`，而工具描述承诺"缺 verification 对象时返回 INVALID_INPUT"
  (src/server.js:145-148)。
- [P2] [已复现] README 的 8 个 reference / 6 个 workflow 表格只有名字没有链接。
- [P2] [已复现] `cli.js` 不在 lint 范围内（`biome check src/ tests/ hooks/`），
  它是 `bin` 入口，改动没有任何静态检查覆盖。

## 已关闭

- R1 [P1] `state-patch add_task` 跳过 task 类依赖的全部校验 → `c9a3103`
- R1 [P1] `scripts/pre-commit.sh` 以 100644 入库，仓库闸门从未生效 → `fcabb0b`
- R1 [P1] README 三个 `docs/` 链接对所有读者 404 → `68e524c`
- R2 [P0] 安装器用 `{}` 覆写不可解析的 settings.json → `bcad406`
- R2 [P1] SessionStart 把软链形式的 CLAUDE.md 换成普通文件 → `829a09e`
- R2 [P1] `gsd update` 把 6 种未比较结局都说成"已是最新" → `aea176a`
- R2 [P1] add_task 索引递推被污染后 phase 永久无法加任务 → `fb61e34`
