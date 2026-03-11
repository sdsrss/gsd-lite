# Evidence 系统规格参考

## 概述

Evidence 是 GSD-Lite 的验证证据系统，用于记录 task 和 phase 的执行/审查证据。存储在 `state.json` 的 `evidence` 字段中，以 key-value 对象形式组织。

## Evidence 对象结构

`state.evidence` 是一个扁平对象，key 为 evidence ID，value 为 evidence 数据对象。

```json
{
  "evidence": {
    "ev:test:phase-1": {
      "id": "ev:test:phase-1",
      "scope": "task:1.2",
      "type": "test",
      ...
    },
    "ev:lint:2.3": {
      "id": "ev:lint:2.3",
      "scope": "task:2.3",
      "type": "lint",
      ...
    }
  }
}
```

### 必需字段

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | string | 非空 | evidence 唯一标识符 |
| `scope` | string | 非空 | 作用域标识，格式见下方 |

### 验证规则

`addEvidence()` 入参校验:
- `id` 必须是非空字符串
- `data` 必须是非 null 的普通对象
- `data.scope` 必须是字符串

`state.evidence` 整体校验 (`validateState()`):
- 必须是普通对象 (isPlainObject)

## ID 格式约定

Evidence ID 采用 `ev:<type>:<scope>` 格式:

```
ev:test:phase-1       # phase 级测试证据
ev:lint:phase-2       # phase 级 lint 证据
ev:test:users-update  # task 级测试证据
ev:typecheck:phase-2  # phase 级类型检查证据
```

此格式为约定 (convention)，由 executor/reviewer 生成时遵守。系统不强制校验 ID 格式。

## Scope 格式

Scope 标识 evidence 所属的作用域。核心格式为 `task:X.Y`:

```
task:1.2   -> phase 1, task 2
task:2.3   -> phase 2, task 3
task:3.1   -> phase 3, task 1
```

### parseScopePhase 解析

`parseScopePhase(scope)` 从 scope 字符串提取 phase 编号:

- 正则: `/^task:(\d+)\./`
- `"task:1.2"` -> 返回 `1`
- `"task:2.3"` -> 返回 `2`
- `"phase:1"` -> 返回 `null` (不匹配 task: 前缀)
- `null`/`undefined` -> 返回 `null`

此函数用于 evidence 归档时判断 evidence 所属 phase。

来源: `parseScopePhase()` in `src/tools/state.js`

## 容量限制与自动裁剪

### MAX_EVIDENCE_ENTRIES

- 硬限制: `200` 条
- 定义位置: `src/tools/state.js` 顶层常量

### 自动裁剪触发

`addEvidence()` 每次添加 evidence 后检查:

```
if (Object.keys(state.evidence).length > MAX_EVIDENCE_ENTRIES) {
  -> 调用 _pruneEvidenceFromState(state, currentPhase, gsdDir)
}
```

### 裁剪逻辑

`_pruneEvidenceFromState(state, currentPhase, gsdDir)`:

1. 遍历所有 evidence 条目
2. 对每条 evidence 调用 `parseScopePhase(entry.scope)` 提取 phase 编号
3. 如果 `phaseNum !== null && phaseNum < currentPhase` -> 标记为待归档
4. 其余保留 (包括 scope 无法解析的条目)

规则: 仅保留当前 phase 的 evidence，归档所有更早 phase 的 evidence。

## 归档生命周期

### 归档路径

`.gsd/evidence-archive.json`

### 归档流程

```
_pruneEvidenceFromState()
  -> 分离 toArchive / toKeep
  -> 读取现有 evidence-archive.json (不存在则 {})
  -> Object.assign(archive, toArchive) 合并
  -> writeJson(archivePath, archive) 写入归档文件
  -> state.evidence = toKeep 更新内存中的 state
```

### 触发时机

1. `addEvidence()` — 当 evidence 数量超过 MAX_EVIDENCE_ENTRIES 时自动触发
2. `phaseComplete()` — phase 完成后主动触发 (在 phase lifecycle 转换为 accepted 之后)
3. `pruneEvidence()` — 显式调用的外部接口

### 归档特性

- 归档是追加式的: 新归档条目与已有归档 merge
- 归档后 state.evidence 中的对应条目被移除
- 归档文件持久保存，不会被自动清理

## Evidence 来源

### Executor 结果

`handleExecutorResult()` 处理 executor 返回的 evidence:

1. `result.evidence` 数组写入 task 的 `evidence_refs`
2. 对数组中每个符合条件的条目 (有 `id` 和 `scope` 字符串字段) 调用 `addEvidence()` 存入 `state.evidence`
3. outcome 为 `checkpointed` / `blocked` / `failed` 时均会保存 evidence_refs

### Reviewer 结果

`handleReviewerResult()` 处理 reviewer 返回的 evidence:

1. 同样遍历 `result.evidence` 数组
2. 对符合条件的条目调用 `addEvidence()` 存入 `state.evidence`

### Task 上的 evidence_refs

每个 task 对象有 `evidence_refs` 数组字段:
- 类型: `Array` (validateState 要求)
- 初始值: `[]`
- 更新时机: executor checkpointed / blocked / failed 时从 result.evidence 覆写
- 清空时机: `propagateInvalidation()` 或 reviewer 标记 rework 时清空为 `[]`

来源: `addEvidence()`, `_pruneEvidenceFromState()`, `pruneEvidence()`, `phaseComplete()` in `src/tools/state.js`; `handleExecutorResult()`, `handleReviewerResult()` in `src/tools/orchestrator.js`
