# Git Worktree 工作流参考 (Git Worktrees Reference)

> 本文档介绍 Git Worktree 在隔离开发中的用法。
> 适用场景: 需要在不影响当前工作的情况下创建独立开发环境。

---

## 1. 什么是 Worktree

Git Worktree 允许你从同一个仓库创建多个工作目录，每个目录关联不同分支。
好处: 切换任务时不需要 stash/commit 当前工作，每个 worktree 完全独立。

```
主仓库:  /project (main branch)
Worktree: /project-feat-auth (feat/auth branch)
Worktree: /project-fix-bug (fix/login-bug branch)
→ 三个目录独立工作，共享同一个 .git 数据
```

---

## 2. 何时使用

| 场景 | 推荐 |
|------|------|
| 紧急 bug 修复，但当前分支有未完成工作 | Worktree |
| 需要同时对比两个分支的运行结果 | Worktree |
| 长期特性开发 + 日常维护并行 | Worktree |
| 简单的分支切换 (无未提交修改) | `git checkout` 即可 |

---

## 3. 基本操作

```bash
# 创建 (基于现有分支)
git worktree add ../project-feat-auth feat/auth

# 创建 (新分支)
git worktree add -b feat/new-feature ../project-new-feature main

# 查看所有 worktree
git worktree list

# 在 worktree 中工作 (正常 git 操作)
cd ../project-feat-auth
git add . && git commit -m "feat(auth): add JWT validation"
git push -u origin feat/auth

# 删除 worktree
git worktree remove ../project-feat-auth       # 正常删除
git worktree remove --force ../project-feat-auth  # 有未提交修改时

# 清理无效引用 (手动删除目录后)
git worktree prune
```

---

## 4. 常见问题和解决方案

| 问题 | 原因 | 解决 |
|------|------|------|
| `fatal: 'branch' is already checked out` | 同一分支不能同时被两个 worktree checkout | 创建新分支，或先在另一个 worktree 切换分支 |
| Worktree 中 `node_modules` 缺失 | 每个 worktree 需要独立安装依赖 | 在 worktree 目录中运行 `npm install` (或对应包管理器) |
| Worktree 中 IDE 打开错误项目 | IDE 可能缓存了主仓库路径 | 用 `code ../project-feat-auth` 打开新窗口 |
| 删除 worktree 后分支还在 | `worktree remove` 不删除分支 | 按需手动删除: `git branch -d feat/auth` |

---

## 5. 最佳实践

- **命名规范:** worktree 目录名用 `项目名-分支描述`，便于识别
- **及时清理:** 分支合并后立即删除对应 worktree
- **独立依赖:** 每个 worktree 安装独立的 `node_modules` (不要软链接)
- **避免嵌套:** 不要在 worktree 内创建 worktree
- **用 list 检查:** 定期 `git worktree list` 清理废弃的 worktree
