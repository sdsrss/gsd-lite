# 偏差处理规则

> 本文档是 executor 内联 `<deviation_rules>` 的扩展指南，按需加载。
> 冲突时以 `executor.md` 内联规则为准。

---

## 决策树: 执行中遇到偏差时

```
执行 task 时发现偏差
  │
  ├── Bug (不影响架构)?
  │     └── AUTO-FIX: 直接修复，不中断
  │
  ├── 缺少导入/类型声明?
  │     └── AUTO-ADD: 直接补充，不中断
  │
  ├── 需要架构变更?
  │     └── ANNOTATE: 标注到 summary + decisions
  │         → 返回 orchestrator 决策
  │         → 不自行实施架构变更
  │
  └── 同一 task 3 次修复失败?
        └── STOP: 返回 outcome="failed"
            → 由编排器决定:
              ├── 派发 debugger 分析根因
              ├── 标记 task failed
              └── 标记 phase failed
```

---

## 四种偏差类型详解

### AUTO-FIX: 自动修复 Bug

**条件:** bug 不影响架构设计，是实现层的错误。

示例:
- off-by-one 错误
- 拼写错误导致的引用失败
- 逻辑条件反转 (`>` 写成 `<`)
- 异步函数忘记 `await`
- null/undefined 未检查

处理: 修复 → 运行测试 → checkpoint commit → 在 summary 中简要提及

### AUTO-ADD: 自动补充遗漏

**条件:** 缺少的是声明性内容，不涉及行为设计决策。

示例:
- 缺少 `import` 语句
- 缺少 TypeScript 类型声明
- 缺少 `export`
- 缺少必要的依赖声明 (`package.json`)

处理: 补充 → 验证编译/类型检查通过 → 不需要单独 checkpoint

### ANNOTATE: 架构变更标注

**条件:** 修改会影响系统架构、模块边界或共享契约。

示例:
- 需要新增数据库表/字段
- 需要修改 API 端点的 request/response 结构
- 需要引入新的依赖模块
- 需要改变模块间的调用关系
- 需要修改共享类型定义

处理:
1. **不自行实施** — 只标注，不改
2. 在 `decisions` 中添加: `[DECISION] 发现需要架构变更: ...`
3. 在 `summary` 中描述变更需求和理由
4. 返回给 orchestrator，由其决定是否批准并调整计划

### STOP: 3 次失败停止

**条件:** 同一错误指纹 (file+line 或 msg[:50]) 出现 3 次。

处理:
1. 返回 `outcome: "failed"`
2. 附上 3 次尝试的记录 (每次: 假设 + 修改 + 结果)
3. 编排器决定下一步:
   - 派发 debugger → 系统性根因分析
   - 标记 task failed → 跳过 (如非关键)
   - 标记 phase failed → 停止执行 (如关键路径)

---

## `contract_changed` 判定指南

executor 完成 task 后必须在 result 中报告 `contract_changed` 字段。

| 场景 | `contract_changed` | 理由 |
|------|---------------------|------|
| 改了函数/方法签名 (参数、返回类型) | `true` | 调用方需要适配 |
| 改了 API endpoint 的 request/response schema | `true` | 前端/客户端需要适配 |
| 改了数据库 schema (表结构、字段) | `true` | migration + 依赖代码需要适配 |
| 改了共享类型定义 / 接口 | `true` | 所有使用方需要适配 |
| 只改了内部实现逻辑，不影响外部调用方 | `false` | 封装边界内，无外部影响 |
| 拿不准时 | `true` | **安全优先** |

`contract_changed: true` 的后果:
- 编排器触发下游失效传播 (`needs_revalidation`)
- 如果涉及 auth/payment/public API → 审查级别自动升级为 L2

---

## 审查级别重分类规则

executor 执行时可能发现实际影响面与 planner 预判不同，可以建议重分类:

### 升级 (executor 可建议)

- 在 `decisions` 中标注: `[LEVEL-UP] 建议升级为 L2 因为 ...`
- 编排器采纳建议

### 自动升级 (编排器自动)

- `contract_changed: true` + 涉及 auth/payment/public API → 自动升级为 L2

### 降级 (不允许)

- 编排器不主动降级
- planner 标了 L2 但实际很简单 → 仍按 L2 审查
- 原则: **安全优先**
