# contextCompactor / contextManager deep-dive(压缩子系统)

> 状态:✅ 已完成(2026-08-17)
> 关联文件:src/agent/contextCompactor.ts / src/agent/contextManager.ts / src/agent/compactionStats.ts
> 关联文档:06-performance-cost.md(数据)、.dsb/rules/cache-prefix-stability.md(约束)

## 职责边界

- **contextCompactor.ts**:纯函数层(无状态)——解析/合并/构建压缩块、分轨提取、行裁剪、re-summarize、标题恒输出。可单测。
- **contextManager.ts**:有状态编排——触发判定(窗口/预算双轨)、调用 LLM 摘要、四轨归并、预算分摊(compacted/tail/thinking 三段)、Q A。
- 边界:compactor 只操作 `CompactBlockParts` 与字符串;manager 负责与 provider/messages 交互。

## 内部结构

```
CompactBlockParts { demands[], conclusions[], explanations[], ledger[] }  // 四轨
parseCompactedBlock(content)      // 解析 `## 轨道` 小节 → 四轨(标题恒输出后仍能判空)
mergeCompactedTracks(prev, parts) // 旧行前、新行后(天然「稳定段 + 增量段」)
buildCompactedBlock(parts)        // 4 标题恒输出;空轨仅标题
track(title, lines, includeEmptyTitle)  // thinking 块传 false 保持旧行为
splitByAge / lineSeq(rSeq)        // 按 [r{seq}] 排序、分新旧
collapseTailExplanations(lines)   // 只对该次新增(尾部)一半再摘要,旧行永不重写
truncateParts / trimTracksToBudget // 只删尾部(最大 seq)
```

```
ContextManager
├─ needsCompaction()   // window_ratio(triggerRatio 0.75)或 budget_ratio(150K 预算)
├─ compact()           // 合并 prev 块 + 新消息 → 分轨 → LLM 摘要 → buildCompactedBlock
├─ ensureBlockFits / ensureBlockFitsTokens  // 三段式:① tail 再摘要 ② 截断长行 ③ 只删尾部
└─ budgetInfo()        // thinking 开:三段 {0.45,0.2,0.35};关:归一化两段 {0.5625,0.4375}
```

## 与外部模块交互

- 依赖:`providerSendStats`(token 估算同口径)、`summaryClient`(LLM 摘要)。
- 被依赖:`agentLoop`(压缩触发与 QA)、`chatViewProvider`(onCompaction 打点)、`contextStore`(被替换原文入冷存储)。

## 关键实现细节与坑

1. **标题恒输出**(P2):空轨也输出 `## 轨道` 标题 → section 边界字节固定;`parseCompactedBlock` 用标题后无 `- [rN]` 行判空,兼容。
2. **只删尾部**(P2):`trimTracksToBudget` 从最大 seq 删(删最新),保留旧稳定段;`collapseTailExplanations` 只 re-summarize 新增行。
3. **写前定型**(P1,agentLoop):trim 类 tool_result 在 push 前定型最终字节,避免发送前改写。
4. **坑**:曾出现「旧行重写 → 前缀断裂 → 压缩后首轮 ~10% 命中」;修复后真实首轮 49~54%,第 2 轮即恢复到 97%。
5. **坑**:thinking 块空轨无标题(旧语义),与压缩块恒输出不同——`track` 第 3 参控制,勿混用。
6. **坑**:`budgetInfo` 在 thinking 关闭时两段份额需重新归一化,否则 compacted/tail 占比和 <1。

## 已知问题/改进空间

- 压缩后首轮 tail 结构性全 miss(06 优化机会 #1:调 triggerRatio 摊薄)。
- 会话首轮(重建)命中 7.6%(频次低,优化 #4)。
- re-summarize 的新增行可能仍包含较长旧引文,可进一步按 seq 边界收紧(低优先)。
