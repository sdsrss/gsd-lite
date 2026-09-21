# 暂停 — v0.15.0 发版,卡在合并前的独立评审

生成于 2026-09-21,会话 21a08cd8。**没有任何一步被当作已完成上报。**

## 已完成且已验证

- 5 个提交从 `main` 移到 `feat/write-boundary-and-ci-gate`,本地 `main` 已退回
  `origin/main`(`62e812c`)。分支已推。
- PR #28 已开:https://github.com/sdsrss/gsd-lite/pull/28
- CI 绿:`test (20)` / `test (22)` / `test (24)` 全过。
- 新的 `gate-replay` job 第一次真实运行,**读过日志而不是只看颜色**:
  base `62e812c`、head `4e3f508`(PR 的 merge commit),
  `tests/statusline.test.js` 与 `tests/untrusted-checkout.test.js` 都是
  DISCRIMINATIVE。10 秒是 node_modules 命中缓存,不是跳过。

## 未完成

1. **两个独立评审的结论**(合并前的硬门,§12 Author ≠ reviewer)。
   - `ship-reviewer-security` —— `commitRefIsInert` 是否真的 inert;写侧
     故意放宽的门槛是站得住还是在合理化;存下来的字段有没有绕过
     `taskRefsForAgent` 的投递路径;写侧 `getProjectRoot` 是否正确;
     整体拒绝会不会让已提交的工作变孤儿;`src/schema.js` →
     `src/agent-payload.js` 的循环引用与 `install.js` 分发副本。
   - `ship-reviewer-gates` —— 新 CI job 是否真的在把关:`${{ ... && ... || ... }}`
     那个 BASE 表达式在 PR / push / 新分支 / force-push / fork 五种情况下的取值,
     `pull_request` 事件下 HEAD 是 merge commit 的影响,所有"退 0 但什么都没查"
     的路径在现实中多久触发一次,以及再找一个空转断言。
   - 有 blocker → 在分支上修 + 重跑,**不要先合并**。
2. 合并:`gh pr merge 28 --rebase`
3. 发版分支,只带 CHANGELOG(Unreleased → 0.15.0)与版本号:
   `CLAUDE_CONFIG_DIR=<一次性目录> npm version minor --no-git-tag-version`
   —— runbook 明确:直接跑会写进真实的 `~/.claude`。
4. PR → CI 绿 → rebase 合并 → **打标签前确认三个版本文件都读到新版本**
5. `git tag -a v0.15.0` → 推标签(推标签才触发 release.yml)
6. 按产物验证,不看绿勾:资产 `sha256sum` == release body 里的 `sha256:`;
   七个签名对照(Trap 11 —— 翻最后一个字符是空转的负对照);
   解包 tarball grep 真正的改动而不是版本号(Trap 10)。
7. 发版后 smoke:装进一次性 `CLAUDE_CONFIG_DIR`。

## 恢复时先跑

```bash
git -C /home/ai/dev/gsd-lite status --short --branch
gh pr checks 28
gh pr view 28 --json mergeStateStatus,mergeable
```

版本现状:`package.json` = 0.14.0,目标 0.15.0(minor —— 含一个破坏性变更,
但本仓库 0.x 的惯例是 minor,v0.14.0 同样如此)。
