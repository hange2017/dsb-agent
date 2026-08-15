# ContextRecall 回查利用率提升 — P0 统计埋点 + P1 引导(实施计划)

> 生成时间:2026-08-15
> 状态:**已实施**(2026-08-15,1090 tests 全绿 + TSC 通过)
> 背景:压缩后的信息(50MB 冷存储)模型很少主动回查 → 先量化使用情况(P0),再用引导手段(P1)提升回查率;若有效,后续扩展"保存更多工具输出"(想法 3)。

## P0:ContextRecall 统计埋点(可统一关闭)✅

### 关闭机制(复用现成总开关,不新增配置)
- `dsbAgent.stats.enabled=false` → `extension.ts:337` 注入 `statsStore = undefined` → 所有打点经 `?.` 静默跳过。
- 新增埋点**只经 `statsStore?.record(...)`**,关闭无需逐点改。

### 落地改动
1. `src/agent/tools/contextRecallTool.ts`
   - ✅ 导出 `RecallStat`:`{ mode: "seq_hit"|"seq_miss"|"index_hit"|"index_empty"|"cross_session"|"unavailable", seq?, queryLen?, queryHash?, results? }`
   - ✅ `contextRecallExecute` 追加可选第 4 参 `onStat?`,各返回点上报;queryHash 用 `contentHash`(sha1 16hex,复用 providerSendStats)。
2. `src/agent/tools/executor.ts`
   - ✅ 构造追加 `statsStore?: StatsStore`(末位);case "ContextRecall" 传 onStat 包装 `this.statsStore?.record("context_recall", s)`;无 store 时 record `{mode:"unavailable"}`。
3. `src/chat/chatViewProvider.ts`:✅ executor 构造传 `this.statsStore`(contextStore 之后,platform 占位 undefined)。
4. 测试:✅ `tests/contextRecall.test.ts` 补 onStat 断言(seq_hit/seq_miss/index_hit/index_empty/cross_session/unavailable+executor 注入)。

## P1:引导回查

### P1a 工具描述强化 ✅
- `CONTEXT_RECALL_TOOL_DEF.description` 加"何时该查"启发式(看到压缩块 [r{n}] 摘要需细节时 / 历史结论 / 错误信息 / 跨会话经验)。

### P1b 压缩块尾部固定提示行 ✅
- `contextCompactor.ts` 导出 `RECALL_HINT_LINE`(固定 ASCII 短文本 ~10 tokens,恒输出,字节稳定 → 不破坏缓存前缀);
- `buildCompactedBlock` sections 末尾追加;
- `parseCompactedBlock` 精确跳过该行(防并入 ledger 轨、防 merge 膨胀);
- 测试:✅ 包含提示行 + parse 不并入轨(含空 parts 恒输出)。
- 预算适配:✅ `contextManager.test.ts` "compacts with compacted block already present" 预算 400→430,注释说明为提示行固定开销(P2 验收语义"保留 r1/删 r13"不变)。

### P1c 新增技能 ✅
- `skills/context-recall-usage/SKILL.md`(原创,随扩展分发):何时回查、seq/query 用法、回查策略(压缩块细节优先 seq,模糊经验用 query 跨会话)。
- `tests/bundledSkills.test.ts` 技能数 37→38。

## 验证 ✅
- `npx tsc --noEmit` 通过;
- `npx vitest run` 全绿:**107 files / 1090 tests**(净增 7:contextRecall +6、contextCompactor +1);
- 缓存前缀:RECALL_HINT_LINE 恒输出、工具描述为发版级一次性变化,均不破坏跨轮前缀。

## 后续(未实施)
- 想法 3:若回查率提升有效,扩展"保存更多工具输出"到冷存储。
- queryHash 展示层过滤:detailLevel=basic 时 UI 侧不展示(存储层已全量,与 provider_send 同模式)。
