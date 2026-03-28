# 研究工作流

> 本文档是 researcher 内联规则的扩展指南，按需加载。
> 冲突时以 `researcher.md` 内联规则为准。

---

## 源优先级 (与 researcher 一致)

```
1. Context7 MCP   — 最新文档，无幻觉 (最优先)
2. 官方文档       — Context7 覆盖不足时
3. WebSearch      — 对比和趋势 (补充)
```

选择原则:
- Context7 能回答 → 不查 WebSearch
- 官方文档有明确说明 → 不依赖社区经验
- 多个源矛盾 → 以版本最新、权威性最高的为准

---

## 研究触发规则 (智能判断)

| 场景 | 决策 | 理由 |
|------|------|------|
| 新项目 | **必须研究** | 技术栈选型需要依据 |
| 涉及新技术栈 | **必须研究** | 不熟悉的领域需要 pitfall 分析 |
| 简单 bug 修复 | **跳过研究** | 已有代码即上下文 |
| 已有研究且未过期 | **跳过研究** | 复用缓存 |
| 用户明确要求 | **研究** | 用户意图优先 |
| 已有研究但需求方向变了 | **增量研究** | 只研究新方向，不重做已有部分 |

编排器在 `/gsd:start` 或 `/gsd:prd` 流程中根据上述规则判断是否派发 researcher。

---

## 研究过期规则 (TTL)

**默认启发式，不是固定定律。**

| 领域 | 默认 TTL | 理由 |
|------|----------|------|
| 前端框架 / 云服务 / 安全 | 3 天 | 高波动，API 变化频繁 |
| 中等波动领域 (通用 Web 开发) | 7 天 | 默认值 |
| 稳定后端 / 企业内部 / 基础设施 | 14-30 天 | 低波动，变化缓慢 |

**立即过期触发:**
- `package.json` 主依赖大版本有变更 → 立即过期
- 用户说"重新研究" → 强制过期

**TTL 存储在** `state.json` 的 `research.expires_at` 字段。

---

## 缓存策略与 Decision ID

### Decision ID 生成

每个关键推荐生成一个 decision id，格式: `decision:<topic>`

示例:
- `decision:jwt-rotation` — JWT 刷新策略选型
- `decision:orm-choice` — ORM 工具选型
- `decision:deploy-platform` — 部署平台选型

Decision ID 供 plan/task 的 `research_basis` 字段引用，建立研究→计划的追溯链。

### 研究刷新后的 Decision ID 处理

| 场景 | 处理方式 |
|------|----------|
| 新研究 decision 与旧 ID 相同且结论一致 | 保留引用，更新 `expires_at` |
| 新研究 decision 与旧 ID 相同但结论变了 | 标记所有引用该 decision 的 task 为 `needs_revalidation` |
| 旧 decision ID 在新研究中不再存在 | 标记引用 task 为 `needs_revalidation` + 警告编排器 |
| 新研究产生了全新 decision ID | 不影响已有 task，供后续 planning 使用 |

---

## 输出结构

研究结果写入 `.gsd/research/` 目录:

### STACK.md — 技术栈推荐

- 推荐的技术栈组合 + 理由
- 版本建议 (具体版本号)
- 替代方案对比
- 每项标注置信度 + 来源

### ARCHITECTURE.md — 架构模式

- 推荐的架构模式 (标识 ⭐)
- 备选方案 + 优劣对比
- 与当前项目的适配分析

### PITFALLS.md — 领域陷阱

- 来自真实项目经验的陷阱
- 每个陷阱: 描述 + 规避方案 + 置信度
- 按严重程度排序

### SUMMARY.md — 研究摘要

- 关键发现摘要
- 路线图建议
- volatility 评估
- `expires_at` 过期时间
- key decision ids 索引

---

## 置信度标注

每个发现/推荐必须标注:

| 置信度 | 含义 | 来源要求 |
|--------|------|----------|
| **HIGH** | 可直接采用 | 官方文档 / Context7 明确说明 |
| **MEDIUM** | 建议采用，但需验证 | 社区广泛使用 / 多源一致 |
| **LOW** | 参考用，需要进一步调查 | 单一来源 / 经验推测 |

来源标注格式: `[Context7]` / `[官方文档]` / `[社区经验]`

---

## 结果契约 (与 researcher 一致，完整 3 参数调用契约见 `agents/researcher.md`)

```json
{
  "decision_ids": ["decision:jwt-rotation", "decision:orm-choice"],
  "volatility": "medium",
  "expires_at": "2026-03-17T10:30:00Z",
  "sources": [
    { "id": "src1", "type": "Context7", "ref": "Next.js auth docs" },
    { "id": "src2", "type": "官方文档", "ref": "Prisma migration guide" }
  ]
}
```
