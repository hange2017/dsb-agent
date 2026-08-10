# 实现计划:冷存储加固(8KB 上限 · 跨会话合并去重 · UI 浏览页)

> 日期:2026-08-08 · 前置:上下文分轨压缩 T1–T9 已完成(基线 662 tests / 81 files)
> 承接 spec 遗留待办:① 压缩块 8KB 上限与最旧解释段再摘要;② 冷存储跨会话合并/去重;③ 冷存储 UI 浏览页

## 目标

1. 压缩块过长时自动收缩:优先对最旧解释段再摘要(二次低预算 summarize),其次截断超长行,保持需求/结论原文优先。
2. 冷存储支持跨会话合并与内容去重:会话文件列表、只读合并视图(供 ContextRecall 跨会话检索)、物理合并/去重。
3. 提供冷存储浏览 Webview 面板:按会话浏览块、类型过滤、展开全文、清空/删除/合并去重操作。

## 改动清单

### T1:压缩块 8KB 上限与最旧解释段再摘要

**`src/agent/contextCompactor.ts`(新增纯函数)**
- `rSeqFromLine(line)`(已有 `rSeq` 在 manager,抽出共用?不改导出,新加纯函数 `explanationAge(line)` 或直接复用正则)。
- `splitByAge(lines: string[]): { oldest: string[]; newest: string[] }` — 按行 `[r{n}]` 排序,最旧一半为 oldest(≤50% 条数,至少 1 条),其余 newest。
- `collapseOldestExplanations(lines, budget?): { keep: string[]; oldestText: string; oldestSeq: number }` — 把 oldest 行去前缀(`- [r{n}] `)拼为纯文本,供 summarize;keep 为 newest 原样行。
- `truncateLongLines(lines, maxLine): string[]` — 超长行截断至 maxLine。
- `estimateBlockChars(parts): number` — 等价 `buildCompactedBlock(parts).length`(直接复用)。

**`src/agent/contextManager.ts`(收缩流程)**
- 新选项 `maxBlockChars?: number`(默认 8000)。
- `compact()` 构建 block 后:`ensureBlockFits(parts)` 循环:
  1. `block.length <= max` → 返回。
  2. 解释轨条数 ≥ 2 或最旧一条长度超阈值 → 取最旧一半,`summarize(oldestText, { maxTokens: Math.max(100, floor(maxCompactTextTokens/4)) })`,替换为单行 `- [r{oldestSeq}] 再摘要:{summary}`,重算。
  3. 仍超 → 各轨 `truncateLongLines(…, 240)`,重算。
  4. 仍超 → 接受(不破坏内容,不做再截断)。
- 冷存储写入发生在收缩前(stratify 内),收缩只影响块行,不回写冷存储(冷存储保存的是收缩前摘要,语义正确)。

**测试(`tests/contextManager.test.ts`)**
- 超长解释文本 → mock summarize 第一次返回原样(长)、第二次返回短文本 → 断言 summarize 调 2 次、第二次预算 ≈200、块长度 ≤ maxBlockChars、需求轨原文仍在。
- 收缩后 parseCompactedBlock 仍可解析、增量合并可继续。

### T2:冷存储跨会话合并/去重

**`src/context/contextStore.ts`**
- `ColdChunk` 加可选 `session?: string`(向后兼容,isColdChunk 不强制)。
- `listSessions(): string[]` — 列 `*.context.json` 文件名(去后缀),排序。
- `mergeView(sessionIds): { chunks: ColdChunk[]; sessionIds: string[] }` — 只读聚合:每条 chunk 附 `session` 来源;按 `type|role|summary|content` 去重(保留 ts 最早);不写盘。
- `dedupe(sessionId): number` — 单会话物理去重,返回删除条数。
- `merge(sessionIds, target): { merged: number; removed: number }` — 聚合去重后写 target(替换),删除其它源文件;target 自身保留参与去重。
- 去重 key 不含 seq/ts/session(不同会话 seq 冲突,内容才是唯一性依据)。

**`src/agent/tools/contextRecallTool.ts`(跨会话检索)**
- `CONTEXT_RECALL_TOOL_DEF.description` 补充:query 模式自动跨会话检索。
- `contextRecallExecute`:
  - seq 模式不变(会话内序号)。
  - 索引模式:本会话结果为空且带 query → 用 `store.mergeView(store.listSessions().filter(id => id !== sessionId))` 检索,命中行前缀 `[session] [r{seq}] (type/role) summary`。
- `src/agent/tools/executor.ts` 不变(已传 sessionId 与 store)。

**测试(`tests/contextStore.test.ts` / `tests/contextRecall.test.ts`)**
- listSessions 排序、mergeView 去重带 session、dedupe 物理去重、merge 跨会话合并并删源文件。
- ContextRecall query 命中其他会话内容;seq 模式仍只查本会话。

### T3:冷存储 UI 浏览页

**新 `src/settings/contextPanel.ts`**(与 memoryPanel 平行,面板消息路由)
- 协议:
  - host→webview:`{ type:"state"; sessions: SessionView[]; locale }`、`{ type:"toast"; message; error? }`
  - webview→host:`ready` / `browse {sessionId}` / `clear {sessionId}` / `delete {sessionId}` / `merge_all {}`
- `SessionView = { id; chunkCount; compacted; pruned }`;browse 返回该会话 chunks(seq/type/role/summary/content)。
- `ContextPanelServices`(可注入 ContextStore):`getLocale() / list() / browse(id) / clear(id) / delete(id) / mergeAll()`。
- `createContextPanel(panel, services)` + `handleMessage` 导出(供单测),同 memoryPanel 模式。
- renderHtml/fallbackHtml 同 memoryPanel(读 `dist/webview/contextPanel.html`)。

**新 `webview/contextPanel.ts` + `webview/contextPanel.html`**(纯 DOM,无框架)
- 顶部:会话下拉/列表 + 统计;按钮:刷新、合并去重(全部会话)。
- 块列表:类型过滤(全部/需求/结论/说明/工具履历),卡片 `[r{seq}] (type/role) summary`,`展开/收起`全文。
- 会话操作:清空、删除(confirm)。

**构建与装配**
- `esbuild.mjs`:`contextPanelBuild` 入口 + `copyWebviewStatic` 复制 `contextPanel.html`。
- `src/extension.ts`:注册命令 `dsbAgent.contextBrowse`(createWebviewPanel + createContextPanel,services 基于 `new ContextStore(contextRoot)`)。
- `src/i18n/strings.ts`:新增文案(冷存储/会话/块/合并去重/清空/删除/展开/收起/暂无等)。

**测试(新 `tests/contextPanel.test.ts`)**
- 仿 memoryPanel.test.ts:mock vscode + 真实 ContextStore;ready 下发 state、browse 返回 chunks、clear/delete/merge_all 生效并 toast。

### T4:验收
- `npm test`(基线 662 + 新增)全绿;`npm run typecheck`;`npm run compile`(含新 webview 产物)。
- 更新 `.dsb/specs/2026-08-06-context-compaction-stratified-design.md` 待办状态与 `docs/remaining-issues.md` / `docs/architecture/agentarchitecture.md` / changelog。

## 风险与取舍
- 8KB 收缩的再摘要是尽力而为:极端内容(需求轨本身超大)不再压,保证不丢用户需求原文。
- 跨会话 seq 冲突:seq 模式保持会话内;跨会话仅 query 模式,行前缀带 session。
- merge_all 物理删除源文件:UI 有 confirm;引擎层 merge 保留 target 自身内容。

## 实施状态(2026-08-08 全部完成)
- [x] T1 压缩块 8KB 上限 + 最旧解释段再摘要:`contextCompactor` 新增 `estimateBlockChars/collapseOldestExplanations/truncateParts/lineSeq/splitByAge`;`contextManager` 新增 `maxBlockChars`(默认 8000)与 `ensureBlockFits` 三段式收缩(再摘要→截断→放行)。**后续增强:自适应上限**——`maxBlockCharsHard`(默认 maxBlockChars×4),再摘要后未超硬上限直接返回(自动扩容,不截断),超过硬上限才截断超长行。
- [x] T2 冷存储跨会话合并/去重:`ContextStore.listSessions/mergeView/dedupe/merge`,`ColdChunk.session` 可选字段;`ContextRecall` query 模式跨会话 fallback(行前缀 `[session]`)。
- [x] T3 冷存储 UI 浏览页:`src/settings/contextPanel.ts` + `webview/contextPanel.ts/.html` + esbuild 入口 + 命令 `dsbAgent.contextBrowse` + i18n/package.nls 文案。
- [x] T4 验收:82 files / 675 tests 全绿(基线 662 + 13 新增);`tsc --noEmit` 通过;`npm run compile` 通过(dist/webview/contextPanel.* 产物存在)。
- 测试新增:contextStore(4)、contextManager(1)、contextRecall(2)、contextPanel(新文件 6)。

