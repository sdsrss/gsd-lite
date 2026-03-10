# Metrics Calibration Notes

运营默认值参考。所有阈值均为启发式，非硬性要求。根据实际项目遥测数据调整。

---

## 1. Context 健康度阈值

### 当前默认

| 阈值 | 行为 | 严重性 |
|------|------|--------|
| < 40% remaining | 保存状态 → `awaiting_clear` → 停止执行 | Warning |
| < 20% remaining | 紧急保存 → 立即停止 | Critical |

### 设计理由

- **40%** — 为当前 task 完成 + checkpoint 保存留出足够空间。低于此值继续执行存在写入不完整风险。
- **20%** — 紧急阈值。此时仅能完成状态序列化，不足以安全执行任何 agent 调用。

### 调整指南

- 若项目 task 粒度大 (单 task >3 次 agent 调用)，考虑将 warning 提高到 **50%**
- 若项目 task 粒度小 (单 task 通常 1 次 agent 调用)，可降至 **35%**
- Critical 阈值 **不建议低于 15%**，否则可能丢失状态
- 监控指标: 因 context 不足导致的 `awaiting_clear` 频率。每个 session 超过 3 次说明 task 粒度需要拆分

---

## 2. Research TTL 默认值

### 当前默认

| 领域 | 默认 TTL | 场景示例 |
|------|----------|----------|
| 高波动 (frontend/cloud/security) | 3 天 | React API, AWS SDK, CVE 数据 |
| 中等波动 (通用 Web 开发) | 7 天 | 通用最佳实践, 中间件兼容性 |
| 低波动 (stable backend/infra) | 14-30 天 | 数据库 schema 设计, OS 级配置 |

### 设计理由

7 天默认值平衡了两个目标:
- **避免过期研究导致错误决策** — 超过 7 天的技术调研在快速迭代项目中可靠性下降
- **避免重复调研浪费** — 设得太短会导致每次 resume 都重新 research

### 调整指南

- 若项目处于初始架构阶段 (技术选型未定)，建议 TTL **缩短到 3 天**
- 若项目处于维护阶段 (依赖版本锁定)，可延长至 **14 天**
- `package.json` 主依赖大版本变更 → **立即过期**，这是硬规则不可调
- 监控指标: research refresh 后结论变化的比率。若 >50% 刷新后结论不变，说明 TTL 偏短

---

## 3. Executor Retry Limit

### 当前默认

`MAX_RETRY = 3` (src/tools/state.js)

### 设计理由

- **1 次不够** — 首次失败可能是环境瞬态问题 (网络超时、锁竞争)
- **3 次足够** — 同一 task 连续失败 3 次几乎确定是逻辑问题，不是瞬态问题
- **超过 3 次有害** — 重复执行浪费 context 且可能产生副作用 (文件重复写入、状态污染)

### 调整指南

- 涉及外部 API 调用的 task (网络不稳定)，可考虑 **4-5 次**
- 纯本地计算 task，**2 次** 即可判定失败
- 若 retry 成功率统计显示第 3 次成功率 <5%，说明 3 次已偏多
- 监控指标: retry 成功分布。理想状态是 >80% 的成功在第 1-2 次

---

## 4. Batch Review 返工频率

### 观察

L1 batch review 存在已知的返工爆炸半径:
- checkpoint 释放下游 → batch review 发现 Critical → 多个下游 task 连锁 `needs_revalidation`
- 这是 L1 的设计 trade-off，不是 bug

### 缓解策略

- Planner 对有共享行为依赖的 L1 task 使用 `gate: accepted` (不等 batch，立即审查)
- 若单次 batch review 返工率 >30%，说明 task 的 review level 应该从 L1 提升到 L2
- 若连续 2 次 batch review 都有 Critical，考虑对该 phase 整体启用 L2 即时审查

### 监控指标

| 指标 | 健康范围 | 行动 |
|------|----------|------|
| 单次 batch review 返工率 | <20% | 正常 |
| 单次 batch review 返工率 | 20-30% | 关注，检查 task 粒度 |
| 单次 batch review 返工率 | >30% | 升级到 L2 审查 |
| 返工导致的 `needs_revalidation` 传播深度 | ≤2 层 | 正常 |
| 返工导致的 `needs_revalidation` 传播深度 | >2 层 | 重新评估依赖拓扑 |

---

## 更新日志

首次记录: 基于设计文档 v3.5 的默认值。待实际项目运行后补充遥测数据。
