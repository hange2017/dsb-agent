# 压缩后首轮命中率优化 · 方向 2/3 实现计划

> 生成时间：2026-08-17
> 依据：`.dsb/docs/2026-08-17-压缩后首轮命中率恢复曲线分析.md`（压缩后首轮 54.8%，第 2 轮即 97.1% 恢复；6/184 次 <20% 均为会话重建/首次压缩）+ `.dsb/docs/system-analysis/06-performance-cost.md` 优化机会 #3/#4。
> 目标：在不牺牲近期细节可读性的前提下，把压缩后首轮 miss（平均 22K tokens）再压缩一档；并消除「apiHistory 缺失 → eventsToHistory 回退 → 压缩块全新生成」的最坏场景（7.6%）。

---

## 现状基线（真实口径，08-16）

```
总输入 48,803 = system+tools(~17.2K) + compacted(18.0K) + tail(13.7K)
命中 26,738   = system+tools(部分) + compacted(全命中)
未命中 22,065 ≈ tail 全 miss(13.7K) + system/tools 变化(~8.4K)
```

- **compacted（index 0）**：P2「只追加不重写」已生效，hash 100% 相同 → 全命中。
- **tail（index 1 起）**：hash 全不同 → 全 miss。原因：压缩折叠中间历史后，tail 消息前缀位置前移 → 字节流整体变化。这是**结构性成本**，但可通过「分级折叠」缩小 miss 的字节规模。

---

## 方向 2：tail 内容分级折叠（中等改动，收益第二）

### 问题

压缩后 tail 全 miss（平均 13.7K tokens）。tail 里既有**较旧的近期消息**（接近折叠边界，信息已被前文覆盖）也有**最新的几条**（模型决策真正需要的）。现状一刀切全部原样保留 → 全部 miss。

### 方案

把 tail 预算内保留的近期消息**分级**：较旧的 `tailFoldRatio` 比例也折叠进压缩块（走 stratify 摘要，追加到各轨末尾——遵循 P2 只追加规则），只保留最近 `(1 - tailFoldRatio)` 比例原样。

```
压缩后首轮发送 = system+tools + compacted(旧块 + 折叠增量) + tail(近期保留)
miss 变化       = tail 全量 13.7K  →  近期保留 + 折叠增量(摘要,~1-2K)
```

- 折叠段走既有 stratify 分轨 → 摘要行进入 compacted 各轨尾部（增量位置 = 块尾，P2 兼容）。
- 折叠边界不拆 `tool_use`/`tool_result` 对（复用现有 `isToolResultUserMessage` 前扫逻辑）。
- 折叠段若含 thinking 消息 → 走既有 thinking 独立管道（`collectThinking` 已覆盖 head 全段）。

### 改动点

| 文件 | 改动 |
|---|---|
| `src/agent/contextManager.ts` | `ContextManagerOptions` 增 `tailFoldRatio?: number`（undefined = 关闭，保持现状）；`compact()` 在 cut 计算后增加折叠段并入 head |
| `src/settings/configuration.ts` | 增 `compactionTailFoldRatio()`：默认 0.35，[0,1) 有效，非法回退 |
| `package.json` + `package.nls.json` | 注册 `dsbAgent.compaction.tailFoldRatio` 设置（含 i18n） |
| `src/agent/agentLoop.ts` | deps 增 `tailFoldRatio?: number`，构造 ContextManager 时传 `tailFoldRatio: this.deps.tailFoldRatio`（由调用方注入 configuration 值，默认 0.35） |
| `tests/contextManager.test.ts` | 新增：折叠进块 / 边界不拆对 / foldRatio=0 行为不变 |

### 默认值策略

- **ContextManager 层 `undefined` = 关闭**（分级折叠是调用方策略，与 `triggerPct`/`targetPct` 同模式）→ 现有 1000+ 测试直接构造 ContextManager 不受影响。
- **生产路径**：configuration 默认 0.35 → agentLoop 注入 → 开启。

### 收益预估

- 首轮 tail miss 13.7K × foldRatio 0.35 ≈ 4.8K 原文从「全量 miss」变「摘要增量 miss ≈ 0.8K」→ **每次压缩净省 ~4K tokens**。
- 折叠段是「tail 中最旧的部分」，模型可读性损失最小（最新 65% 仍原样保留）。

---

## 方向 3：减少 session 重建（针对 6/184 次雪崩最坏情况）

### 问题

`sessionService.loadSession` 恢复会话时：优先 `loadApiHistory(id)`（含压缩块，首轮可命中旧块）；**apiHistory 缺失/损坏时回退 `eventsToHistory(events)`**（纯文本 user/assistant，无压缩块）→ 首轮若触发压缩 → compacted 块**全新生成**（无旧块可命中）→ 命中率最低 7.6%。

### 方案：预置 compacted 快照（preset block）

在 `sessionStore` 新增**压缩块快照**文件（`.block.json`），`onPersist` 时若 messages[0] 是压缩块则同步保存其原文。恢复时若 apiHistory 回退但快照存在 → 把快照作为 `presetCompactedBlock` 注入 ContextManager → 压缩时新块 = **快照旧行 + 本次增量** → 快照部分字节与上次发送一致 → 命中。

```
正常恢复:   apiHistory 含块 → messages[0] 是块 → prev 正常(现状)
回退恢复:   apiHistory 空 + 快照存在 → preset 块 → 压缩时 prev = 快照
            → 输出块 = 快照旧行 + 增量 → 旧块命中,只 miss 增量
全新会话:   无 apiHistory 无快照 → 现状(无法避免,也无旧块可命中)
```

### 改动点

| 文件 | 改动 |
|---|---|
| `src/session/sessionStore.ts` | 增 `snapshotFileFor(id)`（`{id}.block.json`）+ `saveApiSnapshot(id, block)`（tmp+rename 原子写）+ `loadApiSnapshot(id)` + `delete(id)` 时清理快照 |
| `src/chat/sessionService.ts` | `loadSession`：加载快照存 `this.compactedPreset`；`newSession`/`deleteSession` 清空；`ensureSession`/`createStandalone` 透传 `compactedPreset`；`onPersist` 回调里若 messages[0] 是压缩块（content 含 `[compacted]`）→ `saveApiSnapshot` |
| `src/agent/agentLoop.ts` | deps 增 `compactedPreset?: string`；构造 ContextManager 传 `presetCompactedBlock` |
| `src/agent/contextManager.ts` | `ContextManagerOptions` 增 `presetCompactedBlock?: string`；`compact()` 中 prev 判定：`head[0]` 是块 → 用实际块（freshStart=1）；否则 preset 存在 → 用 preset（freshStart=0）；seq 推进复用现有 `maxUsed` 逻辑（preset 行也计入） |
| `tests/contextManager.test.ts` | 新增：preset 块 + 无实际块 → 输出块含 preset 旧行 + 增量，seq 不重叠 |
| `tests/sessionStore.test.ts` | 新增：save/load/delete 快照 |

### 边界与风险

- **preset 只在 apiHistory 回退时生效**（head[0] 无块）。apiHistory 正常时 messages[0] 是块 → preset 被忽略，无行为变化。
- **seq 不重叠**：preset 行通过现有 `maxUsed` 推进 `nextSeq`，fresh 行 seq 从 `maxUsed+1` 开始 → `assertNoSeqOverlap` 通过。
- **旧行内容**：preset 是上次发送的块原文（摘要），与 eventsToHistory 的纯文本消息信息重复度低 → 可接受。
- **快照文件生命周期**：随会话删除清理；不存在时所有调用 fail-open（`loadApiSnapshot` 返回 null）。

---

## 验收

1. `npx tsc --noEmit` 通过。
2. `npx vitest run` 全绿（新增方向 2/3 测试）。
3. 方向 2 默认关闭路径（foldRatio 未传）与改造前行为一致：现有 contextManager 测试不改动语义。
4. 文档同步：恢复曲线分析 / `06-performance-cost.md` 优化机会表标记方向 2/3 落地。

## 提交分组

1. `feat(compaction): tail 分级折叠(方向2)` — contextManager + configuration + package.json + nls + agentLoop + contextManager 测试
2. `feat(session): 压缩块快照预置减少会话重建首轮 miss(方向3)` — sessionStore + sessionService + agentLoop + contextManager 测试 + sessionStore 测试
3. `docs(stats): 记录方向2/3落地与收益预估` — 计划 + 分析文档更新
