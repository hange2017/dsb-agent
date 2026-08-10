# 冷存储偏移索引 + 增量合并 seq 断言 验收

> 日期:**2026-08-09**。测试基线:全量 **774** vitest(**87** files) + `npm run compile` + `npx tsc --noEmit` 通过。

## 一、冷存储 IO 开销(按 seq 回查免整文件解析)

### 问题

ContextRecall 按 seq 回查时,`ContextStore.get()` 每次 `read()` 整个 `.context.json`
再 filter;单会话冷存储达数十 MB 时,一次回查就要整文件 JSON.parse。

### 方案(分段偏移索引,不引入 SQLite 依赖)

- `serializeWithOffsets()`:写盘时手工序列化紧凑 JSON,同时记录**每个 chunk 的 UTF-8 字节偏移 + 字节长度**;
  `write()` 返回偏移,`persist()` 把偏移并入 `.index.json` 每条索引(`ColdIndexEntry.offset/length`)。
- `get()` 优先偏移直读:索引带偏移时只 `fs.openSync + fs.readSync` 对应字节区间 + `JSON.parse` 单条,
  大文件回查从「整文件解析」降为「读几百字节」。
- 兼容与自愈:
  - 旧格式索引(无偏移)→ `get()` 回退整文件解析,**顺带重建带偏移索引**(惰性升级,下次走直读);
  - 区间读失败/内容不一致(外部手改原文)→ 回退整文件解析,结果仍正确;
  - 索引损坏 → 原 `readIndex` 重建逻辑不变。
- 写路径(append/updateSummaries/prune/dedupe/merge)频率低,仍整读整写,不做偏移优化。

### 关键坑

- **偏移必须用 UTF-8 字节位置**:`text.length` 是 UTF-16 字符数,中文(3 字节/字符)会错位;
  用 `Buffer.byteLength(text, "utf8")` 换算(`fs.readSync` 按字节读)。
- vitest ESM 下不能 `vi.spyOn(fs, ...)`,改用 `vi.mock("fs")` 包装 `readFileSync/readSync` 为 `vi.fn` 断言。

### 验收要点

| 检查 | 结果 |
|------|------|
| 写盘后索引条目带 offset/length | ✅ `tests/contextStoreOffsets.test.ts` |
| 按 seq 回查内容正确 | ✅ 同上 |
| 300 条(≈600KB)大文件回查 **0 次 readFileSync(.context.json)**,仅 readSync 小段(总量 < 文件 1/10) | ✅ 同上 |
| 旧格式(去 offset)首次 get 回退全量 + 重建,第二次走直读 | ✅ 同上 |
| 原文被外部改坏偏移错位 → 回退全量仍正确 | ✅ 同上 |
| 未知 seq 返回空,不触发读取 | ✅ 同上 |
| 既有 append/load/index/prune/merge/dedupe/recall 全绿 | ✅ `tests/contextStore.test.ts` 等 7 文件 90 例 |

## 二、增量合并复杂度(seq 重叠断言)

### 问题

增量压缩(新压缩块 + 旧压缩块合并)是正确性关键;新旧 seq 重叠会让模型看到两条
同 `[r{n}]` 的不同内容(重复/矛盾)。

### 方案

- `contextCompactor.ts` 新增:
  - `assertNoSeqOverlap(prevLines, nextLines, label)`:前置断言,旧块行 seq ∩ 新段行 seq 必须为空;
  - `assertUniqueSeqLines(lines, label)`:严格模式工具(默认不接入主流程)。
- `contextManager.compact()` 在**合并前**对轨道(需求/结论/说明/履历)与 thinking 分别调用
  `assertNoSeqOverlap`;断言失败抛错 → agentLoop 既有 fail-open 兜底(提示"上下文压缩失败,继续原对话")。
- seq 推进防御链:`nextSeq` 从旧块行 `maxUsed+1` 起步,断言兜底验证。

### 设计边界(重要)

- **同消息多行共享消息级 seq 是既有设计**:一条 assistant 消息的开场结论/结尾结论/工具履历/
  解释摘要都带 `[r{消息seq}]`;按 seq 回查返回该消息全部侧面,语义自洽。
  `assertUniqueSeqLines` 的块级唯一性检查会误伤该设计,故**不接入主流程**;
  `assertNoSeqOverlap` 只拦「新旧来源跨源重叠」,是用户诉求的核心。
- 若未来改造为「每行独立 seq」,可启用 `assertUniqueSeqLines` 作为回归门禁。

### 验收要点

| 检查 | 结果 |
|------|------|
| 新旧 seq 不重叠 → 通过;重叠 → 抛错并列重叠序号 | ✅ `tests/contextMergeAssert.test.ts` |
| 旧块无带 seq 行(纯文本摘要)→ 不误报 | ✅ 同上 |
| thinking 合并同样受保护 | ✅ 同上 |
| 正常增量合并流程(现有测试)全绿,断言不误伤 | ✅ `tests/contextManager.test.ts` 全绿 |
| 同消息多行共 seq 不触发前置断言 | ✅ 同上新增用例 |

## 三、偏差与备注

- 未引入 SQLite(项目规则:优先标准能力/已有依赖);偏移索引在"读高频、写低频"场景下
  等价达到 SQLite 按 offset 随机读的效果,且不改变 `.context.json` 格式(纯 JSON,可人工查看)。
- 大文件写路径(append 整读整写)未优化:压缩频率低,收益小;若未来单会话冷存储持续增长,
  可再评估分片文件(每 100 条一个 `.part.json`)或 node:sqlite。
