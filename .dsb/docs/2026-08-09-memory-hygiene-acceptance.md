# 记忆卫生三件套验收(访问加权 + pinned + 相似检测 + Dream 双闸门)

> 日期:**2026-08-09**。对应任务:t55–t58(三个问题)。
> 测试基线:全量 **758** vitest(**85** files) + `npm run compile` + `npx tsc --noEmit` 通过。

## 一、问题 1:记忆索引加权排序 + pinned 常驻

### 改动

- `MemoryEntry` 新增 `accessCount?` / `lastAccessAt?` / `pinned?`(`memoryStore.ts`)
- `list()` 改为加权排序:加权分 = `min(accessCount,100) × 6h + (lastAccessAt ?? updatedAt)`;pinned 恒最前
- `touch(name)`:MemoryRead/MemoryList 命中时 `accessCount++`、`lastAccessAt=now`;文件缺失/损坏静默跳过
- `write()` 覆盖时保留既有访问统计与 pinned(未显式变更);显式 `pinned:false` / `accessCount:0` 可解除/清零
- `index()`:pinned 常驻——limit 截断时先纳入全部 pinned,再补非 pinned(pinned 超 limit 时仍按加权序截断,防滥用)
- `MemoryWrite` schema 新增可选 `pinned` 布尔(`memoryTools.ts` / `executor.ts`)

### 验收要点

| 检查 | 结果 |
|------|------|
| pinned 条目在 list/index 置顶 | ✅ `tests/memoryRanking.test.ts` |
| pinned 不受 index limit 截断(limit=1 仍含 pinned) | ✅ 同上 |
| 高频访问(10 次 touch)旧条目反超新条目 | ✅ 同上 |
| touch 递增 accessCount / 刷新 lastAccessAt;缺失条目不抛错 | ✅ 同上 |
| 普通覆盖保留 pinned+计数;显式 false/0 解除 | ✅ 同上 |
| MemoryWrite pinned=true 经工具层生效 | ✅ `tests/memoryToolsScope.test.ts` |
| MemoryRead 命中项目/全局分别触碰对应 store | ✅ 同上 |
| MemoryList 触碰计数 | ✅ 同上 |

## 二、问题 2:启发式相似检测(MemoryWrite 返回相似候选)

### 改动

- 新增 `src/agent/memory/memorySimilar.ts`:
  - `levenshtein` 编辑距离;name 相似度 = `1 - dist/maxLen`
  - description 相似度 = 词集 Jaccard(英文按词、中文整串,小写归一)
  - 组合分 = name×0.6 + desc×0.4;阈值默认 0.35;top 默认 2
  - 同名(slug 相同,即覆盖更新)不算重复,不提示
- `executor.ts` MemoryWrite 分支:写入后比对 `store.list()`,命中返回
  `⚠ 检测到相似记忆(可能重复…)` + 候选列表(name/description/相似度%)

### 验收要点

| 检查 | 结果 |
|------|------|
| 近似名称/描述命中候选且高分在前 | ✅ `tests/memorySimilar.test.ts` |
| 同名覆盖不触发提示 | ✅ 同上 + `tests/memoryToolsScope.test.ts` |
| 差异过大被阈值过滤;空池返回空;top/minScore 可调 | ✅ 同上 |
| 工具层返回内容含候选与相似度 | ✅ `tests/memoryToolsScope.test.ts` |

## 三、问题 3:Dream 双闸门 + SessionStart 提示注入

### 改动

- `MemoryStore.readDreamAt()/writeDreamAt()`:`<记忆目录>/meta.json` 存 `lastDreamAt`
  (list/index 的形状校验天然忽略该文件;目录惰性创建、损坏容错)
- `memoryDream.ts` 新增:
  - `dreamDue({entryCount, lastDreamAt, now, minEntries=5, cooldownMs=7d})`:双闸门——
    条数 ≥ 5 **且**(从未整合过 **或** 距上次整合 ≥ 7 天)
  - `buildDreamHint(memory, locale)`:达标返回提示文案(zh/en),否则 undefined
- `/memory dream` 成功后 `writeDreamAt(Date.now())`(`chatController.ts`)
- SessionStart(chatViewProvider createSession)把 `dreamHint` 传入 `buildSystemPrompt`,
  注入「## 记忆整理提示」段

### 验收要点

| 检查 | 结果 |
|------|------|
| 条数不足不提示;达标且从未整合 → 提示 | ✅ `tests/memoryDreamGate.test.ts` |
| 冷却期内不提示;超期恢复提示;自定义阈值生效 | ✅ 同上 |
| meta.json 不混入记忆清单/索引;损坏容错;目录不存在惰性建 | ✅ `tests/memoryRanking.test.ts` |
| dreamMemoryNow 成功后落 lastDreamAt | ✅ 代码审查 + `chatController.test.ts` 全绿 |
| buildSystemPrompt 注入 dreamHint 段 | ✅ `tests/promptBuilder.test.ts` 全绿 |

## 四、偏差与备注

- `MemoryList` 触碰全部列出条目(含全局):按需求"MemoryRead/MemoryList 触碰计数"字面实现;
  影响是列表浏览会让条目变"新鲜",但 accessCount 差异与 pinned 置顶仍保证排序有效。
- 相似检测纯本地启发式,不调 LLM;阈值保守(0.35),宁可少提示不可噪声轰炸。
- dream 提示只在满足双闸门时出现,不打扰;`/memory dream` 仍是唯一主动整合入口。
