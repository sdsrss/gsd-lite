# converge LOG

## ROUND 1 找bug/测功能（用户路径：安装 → MCP 主流程 → 钩子） STATUS=DONE 2026-09-19

- 分支 `converge/20260919-user-flows`（从 main@1f32362 切出）。
- 基线：`npm test` 1142 pass / 0 fail（29.4s）；`npm run lint` 81 files, no fixes。基线为绿。
- 生成 `.converge/INTENT.md`（首轮产物，**待人确认**）。
- 沙箱实跑安装：`CLAUDE_CONFIG_DIR=<scratch> node cli.js install` 成功，
  settings.json 写入 mcpServers.gsd + statusLine + 3 个钩子，路径全部正确。
- 沙箱实跑 MCP：真实 stdio JSON-RPC 驱动已安装的 server，
  initialize → tools/list(11) → health → state-init → resume → executor result →
  reviewer accept → resume，主流程全部返回预期动作。
- 13 组边界/错误输入全部返回结构化错误码，无裸异常、无 stdout 污染。
- 派出 3 个只读侦察（安装/CLI、MCP 状态层、钩子）。
- 修复 3 条 P1，每条一个提交，各自跑过全套验证：
  - `c9a3103` add_task 跳过 task 类依赖校验 → 排序约束被静默丢弃
  - `fcabb0b` pre-commit 钩子以 100644 入库 → 仓库自带闸门从未生效
  - `68e524c` README 三个 docs/ 链接对所有读者 404
- 新增两条闸门均做过变异验证（植入坏链接变红；把链接删空触发防空转断言）。

## ROUND 2 修队列（P0 + P1） STATUS=DONE 2026-09-19

- 三个侦察全部回报，其中两个报告被截断——按规则「报告截断 = 没有结论」，
  已 SendMessage 索要剩余部分，未采信截断处的半截结论。
- 队列优先：先修 P0，再按登记顺序修 P1。4 个提交：
  - `bcad406` **P0** 安装器在 settings.json 不可解析时以 `{}` 覆写用户全部配置
    （model / permissions.allow / **permissions.deny** / env / enabledPlugins /
    其它插件的钩子），退出码 0 且无备份。改为解析失败即拒绝安装，文件零字节改动。
  - `829a09e` SessionStart 用 rename 覆盖 `CLAUDE.md`，把软链换成普通文件，
    dotfiles/共享源静默失效。改为 realpath 后写穿软链。
  - `aea176a` `gsd update` 把 checkForUpdate 的 6 种 null 结局一律翻译成
    「✓ 已是最新」；节流缓存结局被报成「安装失败」。改为只说自己知道的事。
  - `fb61e34` add_task 索引递推被 MAX_SAFE_INTEGER 或无点 id 污染后，
    该 phase 永久无法再加任务，且 `1.NaN` 会被当真实 id 落盘。
- 子代理断言核验：4 条自己复现通过（add_task 依赖、settings.json P0、
  符号链接、索引 wedge），0 条证伪。截断处的断言未计入。
- 写入 `DECISIONS.md` 两条需人拍板的事项（D1 假崩溃警告、D2 update 退出码）。
- 覆盖游标：已覆盖「安装/CLI」「MCP 工具主流程 + 错误路径」「CLAUDE.md 注入」
  「自动更新结果解释」；**下轮从「自动更新的下载/回滚路径」和
  「update() 对 task id 结构的校验缺口」继续**。

## ROUND 3 修队列（安装/卸载生命周期） STATUS=DONE 2026-09-19

- 两个被截断的侦察报告已补齐并入队。
- 2 个提交，每条独立跑过全套验证：
  - `c843c12` `gsd uninstall` 对不存在的目录打印「✓ GSD-Lite uninstalled.」并退出 0。
    全部删除动作都被 existsSync 门控、全部注册表编辑都在裸 catch 里，
    所以目录写错时它什么都没删、什么都没说，然后宣布成功。
    复现：typo 的 CLAUDE_CONFIG_DIR → 真实安装原封不动、settings.json 仍注册 gsd、
    钩子继续触发。install.js 从一开始就有这个守卫，卸载器没有。
  - `2abef9b` 重装时 `gsd/runtime/` 的保留逻辑用「拷出到 ~/.claude/.gsd-runtime-backup-<pid>
    → 无条件 wipe → 拷回」实现。staging 失败时 catch 丢掉的是句柄不是已建目录，
    于是 wipe 照常执行、承诺保留的状态丢失、孤儿目录留在用户配置目录里（每次失败一个新 pid）。
    改为原地删除受管条目、跳过 runtime/，并清扫旧版本遗留的 staging 目录。
- 子代理断言核验：本轮 2 条自己复现通过，0 条证伪。
  未核验的（F3 自动更新回滚、F4 statusline 同步超时、`update()` task id 校验缺口）
  已登记 BACKLOG 标 `未复现`，下轮优先。
- 覆盖游标：安装/卸载/重装生命周期已扫完；
  **下轮从「自动更新的下载 → 安装 → 回滚路径」开始**（BACKLOG 第一条）。

## 停止原因

达到用户设定的 3 轮上限，且提交数到 10——按第五步请求一次合并授权。
