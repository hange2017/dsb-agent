# 实现计划:冷存储会话索引(A+C:每会话索引文件 + 内存缓存)

> 日期:2026-08-08 · 前置:冷存储加固(8KB 上限/跨会话合并去重/浏览面板)已完成(677 tests/82 files)
> 动机:跨会话检索目前是「读全部会话原文 + 全量字符串匹配」,会话多时每次 query 解析数 MB JSON;浏览面板列会话也要 load 全文。

## 目标

1. **检索快**:跨会话 query / 会话列表只读小索引,不读原文;命中后才按需取原文。
2. **增量维护**:append/clear/prune/dedupe/merge/delete 写全文时同步维护索引,原子写入(fail-open)。
3. **向后兼容**:旧会话只有 `.context.json` 无 `.index.json` → 惰性迁移(首次读时从原文构建索引)。
4. **缓存**:ContextStore 实例内按 mtime 缓存索引,高频读取零读盘。

## 设计

### 索引文件布局

每个会话旁新增 `<session>.index.json`(不含 content,约原文 1/10):

```json
{
  "version": 1,
  "compacted": 3,
  "pruned": 1,
  "chunks": [
    { "seq": 1, "type": "demand", "role": "user", "summary": "…", "ts": 1723000000000, "hash": "a1b2c3…" }
  ]
}
```

- `hash` = `contentHash(content)`(djb2,16 位 hex),用于跨会话去重(去重 key = `type|role|summary|hash`),索引不存 content 仍能准确去重。
- 检索匹配字段:`seq/type/role/summary`(与现有本会话 query 行为一致;跨会话不再做 content 全文匹配,该维度本来就是额外召回)。

### 改动清单

#### 1. `src/context/contextStore.ts`(核心)
- 新增 `contentHash(content: string): string`(导出,供测试)。
- 新增 `ColdIndexEntry = Omit<ColdChunk, "content"> & { hash: string }`。
- `fileForIndex(sessionId)` / `readIndex(sessionId)`(缺失→从原文惰性构建并写盘;损坏→从原文构建)。
- `writeIndex(sessionId, data)`:tmp+rename 原子写。
- 统一写路径 `persist(sessionId, shape)`:写全文 + 写索引 + 清内存缓存;append/clear/prune/dedupe/merge 全部改走。
- `delete(sessionId)`:同时删全文与索引文件。
- `index(sessionId)`:改读索引(缺 content);带 mtime 缓存(`Map<sessionId,{mtimeMs,data}>`,每次读先 stat 比较,变了重读)。
- `stats(sessionId)`:改从索引读 compacted/pruned(无索引时回退全文)。
- `mergeView(sessionIds)`:基于各会话索引聚合去重(`type|role|summary|hash`),条目附 `session`,不读原文。
- `get(sessionId, seqs)` / `load` / `merge` 不变(merge 内部已读全文)。

#### 2. `src/agent/tools/contextRecallTool.ts`
- 跨会话分支:改用 `mergeView`(现在返回无 content 索引条目),匹配 `summary/type`,移除 content 匹配;输出格式不变。
- 本会话分支不变(本来只匹配 summary/type)。

#### 3. `src/settings/contextPanel.ts`
- `contextPanelServicesFromStore.list()`:chunkCount/stats 从索引读(不 load 全文)。
- `browse` 不变(点进去才读全文取 content)。

#### 4. 测试
- `tests/contextStore.test.ts` 新增:append 后索引文件存在且 `index()` 无 content;`contentHash` 稳定性;旧文件惰性迁移;delete 删索引;dedupe/merge 后索引同步;索引损坏回退全文;mtime 缓存(写后重读)。
- `tests/contextRecall.test.ts` / `tests/contextPanel.test.ts` / `tests/smokeContextCompaction.test.ts`:跑通不改(行为兼容)。
- 全量 `npm test` + `tsc --noEmit` + `npm run compile`。

#### 5. 文档
- 新 plan 全勾;`.dsb/specs/2026-08-06-…` §6 追加;`docs/architecture/agentarchitecture.md` ContextStore 行;`docs/remaining-issues.md` 新增一行;`docs/changelog-2026-08-06.md` 追加。

## 风险与取舍
- 跨会话检索不再匹配 content 全文:召回略降(summary=首行,覆盖要点),换索引体积与速度;本会话行为不变。
- 缓存按 mtime 失效:跨进程写入也能感知;单进程内写路径统一清缓存。
- 索引损坏 fail-open:回退从原文构建,不抛异常。

## 实施状态(2026-08-08 全部完成)
- [x] 1. `contextStore.ts`:新增 `contentHash`(djb2 8hex)、`ColdIndexEntry`、`fileForIndex/readIndex/writeIndex`(tmp+rename)、统一 `persist`(原文+索引同步写)、`delete` 连删索引、`index()/stats()` 改读索引、`mergeView` 基于索引聚合去重(`type|role|summary|hash`)、mtime+size 缓存。
- [x] 2. `contextRecallTool.ts`:跨会话分支改用 `mergeView` 索引条目,匹配 summary/type,移除 content 全文匹配。
- [x] 3. `contextPanel.ts`:`list()` 的 chunkCount 改从 `index()` 读(不 load 全文)。
- [x] 4. 测试:contextStore +8(索引文件生成/惰性迁移/损坏重建/delete 连删/同步/dedupe 去重/缓存刷新/mergeView 无 content/contentHash);contextRecall 跨会话查询词调整(匹配 summary);全量 **685 tests/82 files** + tsc + compile 全绿。
- [x] 5. 文档:spec §6 追加、architecture ContextStore 行、remaining-issues 新增一行、changelog 追加。
