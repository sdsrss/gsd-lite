# 分层审查循环

> 本文档是 reviewer 内联审查策略的扩展指南，按需加载。
> 冲突时以 `reviewer.md` 内联规则为准。

---

## 审查级别定义

### L0: 自审即可

**适用范围:** 配置修改、文档更新、CSS 样式、注释变更等无运行时语义变化的任务。

- executor 自审通过 → checkpoint commit = accepted
- **不启动 reviewer**
- 判定依据: 纯 docs/comment/style/config 且无运行时语义变化

### L1: 自审 + 阶段批量审查

**适用范围:** 大多数编码任务 (CRUD、UI 组件、工具函数等)。

- executor 自审 → checkpoint commit → 继续执行下一个 task
- phase 结束时 → 批量派发 reviewer，一次审查该 phase 所有 L1 task
- 批量审查通过 → 全部 accepted
- 批量审查发现 Critical → 返工相关 task

### L2: 即时独立审查

**适用范围:** 涉及认证、支付、数据安全、核心架构的关键任务。

- executor 完成 → 立即派发 reviewer (不等 phase 结束)
- reviewer 独立审查 (不信任 executor 报告)
- 审查通过 → accepted
- 审查不通过 → 立即返工

### L3: 即时独立审查 + 人工确认

**适用范围:** 最高风险任务 (auth/payment/security architecture)。

- 与 L2 相同的双阶段审查流程，外加:
- reviewer 必须检查 OWASP Top 10 相关问题
- reviewer 结果包含 `requires_human_confirmation: true` + `security_implications` 列表
- 审查通过后 → task 进入 `awaiting_user` (非直接 accepted)
- 编排器向用户展示审查摘要 + 安全影响
- 用户显式确认 → accepted，释放下游依赖
- 用户拒绝 → 返工

### 判定规则

```
改 auth/payment/permission/public API/DB migration/core architecture → L2
纯 docs/comment/style/config 且无运行时语义变化 → L0
其余 → L1
拿不准时 → 升一级处理
```

### 运行时重分类

planner 在计划阶段分配级别，但执行时可能发现实际影响面不同:

- executor 报告 `contract_changed: true` + 涉及 auth/payment/public API → 自动升级为 L2
- executor 标注 `[LEVEL-UP] 建议升级为 L2 因为 ...` → 编排器采纳
- **不主动降级** — planner 标了 L2 但实际很简单，仍按 L2 审查 (安全优先)
- **例外**: L1 + `confidence: 'high'` + `contract_changed: false` + 有 evidence 且无测试失败 → 自动降为 L0 (自审即可)

---

## Checkpoint ≠ Accepted 拓扑

```
L0: checkpoint commit = accepted (自审即可)
L1: checkpoint commit → [继续执行后续 task] → phase 批量 review → accepted
L2: checkpoint commit → [等待] → 即时独立 review → accepted
L3: checkpoint commit → [等待] → 即时独立 review → awaiting_user → 用户确认 → accepted
```

关键区别:
- **checkpoint** 是 executor 的"我完成了"信号
- **accepted** 是 reviewer 验证后的"确认合格"信号
- 下游 task 的依赖门槛 (`gate`) 决定它等待 checkpoint 还是 accepted

---

## 双阶段审查流程

### Stage 1: 规格审查 (Spec Review)

检查代码是否符合任务规格:

- [ ] 所有需求都实现了吗？
- [ ] 有没有多余的实现 (YAGNI)？
- [ ] 接口/API 是否符合计划？
- [ ] 测试是否覆盖了需求中的每个场景？

结果: PASS / FAIL (附具体不符合项 + 代码位置)

### HARD-GATE: 规格审查 → 质量审查

**规格审查必须通过后才能进入质量审查。**
不要浪费时间优化做错的代码。

### Stage 2: 质量审查 (Quality Review)

(仅在规格审查通过后执行)

检查代码质量:

- [ ] 测试覆盖是否充分？(运行测试 + 检查覆盖率)
- [ ] 有没有明显的 bug / 安全问题？
- [ ] 代码是否清晰可维护？
- [ ] 有无性能问题？

---

## 问题分级

| 级别 | 定义 | 处理方式 |
|------|------|----------|
| **Critical** | 安全漏洞 / 数据丢失 / 功能错误 | 必须修复，阻塞 accepted |
| **Important** | 性能问题 / 可维护性差 | 应该修复，转为后续 task 或记录为 deferred debt |
| **Minor** | 命名 / 风格 / 代码注释 | 建议修复，不阻塞 accepted |

判定规则:
- 有 Critical → 返回 FAIL，触发返工
- 只有 Important/Minor → 返回 PASS + 建议列表
- Important 必须转成后续 task 或显式记录为 deferred debt
- Minor 不阻塞，但必须进入 review report

---

## 审查报告模板

```json
{
  "scope": "task | phase",
  "scope_id": "2.3 | 2",
  "review_level": "L2 | L1-batch",
  "spec_passed": true,
  "quality_passed": false,
  "critical_issues": [
    {
      "task_id": "2.3",
      "reason": "描述具体问题",
      "invalidates_downstream": true
    }
  ],
  "important_issues": [],
  "minor_issues": [],
  "accepted_tasks": ["2.1", "2.2"],
  "rework_tasks": ["2.3"],
  "evidence": [
    {"id": "ev:test:phase-2", "scope": "task:2.3"},
    {"id": "ev:lint:phase-2", "scope": "task:2.3"}
  ]
}
```

---

## 返工流程

1. reviewer 返回 rework_tasks 列表 + 具体原因
2. 编排器将 rework task 退回 executor，附上审查反馈
3. executor 修复 → 重新 checkpoint → 重新提交 review
4. 若返工修改了 contract → 触发下游失效传播 (`needs_revalidation`)
5. 若返工只改了内部实现 → 下游 task 保持现状，但需重跑验证

**L1 批量审查返工的爆炸半径:**
- L1 允许 checkpoint 释放下游，batch review 时如发现 Critical，可能导致多个下游 task 连锁 `needs_revalidation`
- 这是 L1 的已知 trade-off — 缓解方法: planner 对有共享行为依赖的 L1 task 使用 `gate: accepted`
