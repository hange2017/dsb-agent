# P2 实现计划：压缩块只追加不重写（雪崩根治）

> 生成时间：2026-08-11
> 相关需求：`.dsb/docs/2026-08-11-缓存前缀稳定性优化清单.md` 问题 2
> 依据：DeepSeek 独立缓存前缀单元机制（`.dsb/rules/cache-prefix-stability.md`）

## 目标

让压缩块在其生命周期内（两次 compact 之间 / 跨轮发送）**字节前缀稳定**，根治「压缩后首轮命中率 ~10%」的雪崩。

## 问题根源（现状）

`contextManager.ts` 每次 compact：
- `mergeCompactedTracks(prev, parts)` 后 `buildCompactedBlock()` 全量重建。
- `ensureBlockFits` 裁剪时从**解释轨最旧一半** re-summarize（改变/删除稳定段旧行），并 `trimTracksToBudget` 从 **seq 最旧**删行（中间删行 → 后续前移）。
- section 标题**非空才输出**（`track()`）→ 某 section 由空变非空时，后面所有行号后移。

三者都会造成高价值缓存前缀（压缩块是 messages 头部）字节变化 → 前缀断裂。

## 修复方向（三点全做，中等偏大）

### 1. `buildCompactedBlock`：4 个 section 标题恒输出
- `track(title, lines)`：lines 非空 → `["## title", ...lines]`；lines 为空 → `["## title"]`（标题恒有，无 body）。
- 空 section 仅含标题行，避免「由空变非空」在块中部**插入**标题行导致后续前移。
- `parseCompactedBlock` 通过标题行切分轨 → 空轨语义天然保留，无需改。

### 2. `trimTracksToBudget`：只删尾部（最新 seq），绝不删稳定段
- 改为从所有轨挑 **seq 最大**（最新）的行删，连删到 ≤ budget。
- 删尾部只影响块尾，更早（稳定段）行字节不动 → 前缀保持。

### 3. `ensureBlockFits` / `ensureBlockFitsTokens`：re-summarize 只动尾部（最新解释行）
- 新增 `collapseTailExplanations`：取**最新一半**解释行 re-summarize，**保留最旧一半**（稳定前段）。
- 替换两个 ensureBlockFits 中的 `collapseOldestExplanations` 调用。
- 首轮压缩（无 prev）全部为新增行，行为等价，既有测试不受影响；增量压缩时稳定段绝不被 re-summarize。

## 验证

- `npx tsc --noEmit` 通过。
- `npx vitest run tests/contextCompactor.test.ts tests/contextManager.test.ts` 通过（更新 2 处「空 section 无标题」断言）。
- 全量 `npx vitest run`（101 文件）通过。
- 新增测试：断言「同 seq 旧行在增量压缩后字节位置不变 / 尾增不破坏前缀 / 超限只删尾部」。

## 提交

- 代码（contextCompactor.ts + contextManager.ts + 新增/更新测试）一个提交。
- 文档（清单.md 标记 P2 已实施 + 本计划）一个提交。
