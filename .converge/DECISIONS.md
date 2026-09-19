# DECISIONS

只放三问闸门判出来的**不可逆事项**——改对外契约、或有树外副作用的。
人回答后标 ✅，下一轮优先执行。

---

## D1 —「上次会话异常结束」警告在每次正常退出后都会出现

**背景**：Stop 钩子在任何非终态（非 completed/failed/paused_by_user）的项目里，
每次停止都会写 `.gsd/.session-end`。SessionStart 只要看到这个文件，就打印
`⚠️ GSD: Previous session ended unexpectedly at <时间> … Run /gsd:resume to recover`，
并把同样一行写进用户的 `CLAUDE.md`。清除它的地方全仓只有一处：
`src/tools/orchestrator/resume.js:308`，也就是 `/gsd:resume` 本身。

结果是：正常退出 → 下次启动报「异常结束」；`/clear` 和 `/compact` 也触发
（matcher 是 `startup|clear|compact`），而唯一的消除办法就是去跑它催你跑的那个恢复流程。

还有一层：真正的崩溃里 Stop 钩子根本不会执行，所以这个 marker 的存在恰恰证明了
**是受控停止**，而不是崩溃。文案断言的事实与机制相反。

**我的推荐：选项 B。**

- **选项 A —— 只改文案，不动机制**：把 stdout 那行改成陈述事实的说法
  （「上次会话在任务进行中停止，运行 /gsd:resume 继续」），marker 生命周期不变。
  改动最小，但 `/clear` 之后仍然会每次都看到它。
- **选项 B（推荐）—— 改文案 + 让 SessionStart 消费掉 marker**：报过一次就删掉。
  代价是 `/gsd:resume` 的 preflight 不再能靠这个文件判断（`commands/resume.md:33` 写了它会检查），
  需要同步改那条命令文档，或者让 SessionStart 把信息转存到一个 resume 专用的字段里。
  收益是：一次提醒，不再每次 `/clear` 都喊狼来了。
- **选项 C —— 保持现状**：不动。

**影响范围**：`hooks/gsd-session-stop.cjs`、`hooks/gsd-session-init.cjs`、
`commands/resume.md`、`tests/session-stop.test.js`（现有测试把当前行为编码成了断言，
`:62` `:146` `:165` 都断言 marker **会被**写入，改机制就要一起改）。

**为什么不自己拍板**：这是业务规则变更（marker 的生命周期归谁管）+ 用户可见文案含义变更，
两项都落在三问闸门的第 ② 问上。

---

## D2 —— 检查失败时 `gsd update` 是否该返回非零退出码

**背景**：本轮已修掉「检查失败却说『✓ 已是最新』」（提交 aea176a）。
但退出码仍然一律为 0，脚本化使用的人依然分不清「已最新」和「没连上 GitHub」。

**我的推荐：暂不改。** 退出码是 CLI 对外契约的一部分，
现在改会让已有的包装脚本行为变化。若你认可，下一轮改成
「检查失败 → 退出码 1」，并在 README 的环境变量表附近写明。

**影响范围**：`cli.js`、`tests/cli.test.js:83`（现断言 `status === 0`）。
