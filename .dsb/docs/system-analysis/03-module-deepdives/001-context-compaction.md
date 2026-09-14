# contextCompactor / contextManager deep-dive(压缩子系统)

> 状态:✅ 已完成(2026-08-17;2026-09-14 增补任务地图/需求轨保护)
> 关联文件:src/agent/contextCompactor.ts / src/agent/contextManager.ts / src/agent/taskMap.ts / src/agent/compactionStats.ts
> 关联文档:06-performance-cost.md(数据)、.dsb/rules/cache-prefix-stability.md(约束)、
> `.dsb/specs/2026-09-14-任务地图与需求轨保护-design.md`(设计)、
> `.dsb/docs/2026-09-14-压缩目标漂移修复与96k预算实测.md`(工作日志)

## 职责边界

- **contextCompactor.ts**:纯函数层(无状态)——解析/合并/构建压缩块、分轨提取、行裁剪、re-summarize、标题恒输出。可单测。
- **contextManager.ts**:有状态编排——触发判定(窗口/预算双轨)、调用 LLM 摘要、四轨归并、预算分摊(compacted/tail/thinking 三段)、Q A。
- 边界:compactor 只操作 `CompactBlockParts` 与字符串;manager 负责与 provider/messages 交互。

## 内部结构

```
CompactBlockParts { demands[], conclusions[], explanations[], ledger[], map[] }  // map 轨置块首,永不裁剪
parseCompactedBlock(content)      // 解析 `## 轨道` 小节 → 四轨(标题恒输出后仍能判空)
mergeCompactedTracks(prev, parts) // 旧行前、新行后(天然「稳定段 + 增量段」)
buildCompactedBlock(parts)        // 4 标题恒输出;空轨仅标题
track(title, lines, includeEmptyTitle)  // thinking 块传 false 保持旧行为
splitByAge / lineSeq(rSeq)        // 按 [r{seq}] 排序、分新旧
collapseTailExplanations(lines)   // 只对该次新增(尾部)一半再摘要,旧行永不重写
truncateParts(parts, 240)         // 截断超长行(map 轨原样保留)
```

> buildCompactedBlock 段序:`[前文摘要]` / `[compacted]` / **map 轨(块首,永不裁)** /
> 需求 / 结论 / 说明 / 工具履历 / `RECALL_HINT_LINE`(恒输出)。

```
ContextManager
├─ needsCompaction()   // window_ratio(triggerRatio 0.75)或 budget_ratio(预算触发)
├─ compact()           // 合并 prev 块 + 新消息 → 分轨 → 任务地图 → LLM 摘要 → buildCompactedBlock
├─ buildResidentMap(parts, prevMap)  // 常驻任务地图(确定性;累积式近期需求)
├─ pickTrimVictim(parts, softProtect) // 裁剪候选:非需求轨按 seq 最新优先;需求轨最后动
├─ ensureBlockFits / ensureBlockFitsTokens  // 三段式:① tail 再摘要 ② 截断长行 ③ 裁剪轨道
└─ budgetInfo()        // thinking 开:三段;关:归一化两段
```

## 与外部模块交互

- 依赖:`providerSendStats`(token 估算同口径)、`summaryClient`(LLM 摘要)。
- 被依赖:`agentLoop`(压缩触发与 QA)、`chatViewProvider`(onCompaction 打点)、`contextStore`(被替换原文入冷存储)。

## 关键实现细节与坑

1. **标题恒输出**(P2):空轨也输出 `## 轨道` 标题 → section 边界字节固定;`parseCompactedBlock` 用标题后无 `- [rN]` 行判空,兼容。
2. **裁剪候选分轨**(2026-09-14):`pickTrimVictim` 取代「一律删最大 seq」——非需求轨(结论/说明/履历)仍按 seq 最新优先删(删块尾,旧稳定段前缀字节不变);**需求轨最后才动且首条(最初目标)永不删**,只删中间。两阶段收敛:软保护(首条+末尾 N 条)→ 放开(仅首条)保证极端预算可收敛。`collapseTailExplanations` 仍只 re-summarize 新增行。
3. **常驻任务地图**(P2,2026-09-14;**2026-09-15 三补**):`taskMap.ts` 纯函数产出 `## 任务地图`(目标/最新要求/近期需求/更早的需求/已做/结果),置于压缩块首段;`ensureBlockFits` 的裁剪候选**不含 map 轨** → 永不删。灰度开关 `taskMapEnabled`(默认开),关闭时块字节与旧版完全一致。
   - **三补**:地图曾经用「需求轨较早的中间需求」填 `### 下一步` —— 历史需求**没有完成度信息**,会把**已完成**事项显示为待办(现场:地图把已实现的建议列为下一步),诱导模型重复劳动。改为:①该段更名「更早的需求」(`EARLIER_DEMANDS_TITLE`),语义诚实;②**块内不再生成「下一步」**,真实「下一步」由任务锚 `buildNextStepSection`(只吃 `done=false` 项)注入。
4. **累积式近期需求**(B4/B5):`buildResidentMap(parts, prevMap)` 从上一轮地图 `extractMapSectionItems` 取「近期需求」并 `accumulateRecentDemands` 合并 —— 中期「目标澄清/修正」一旦进地图即**粘住**,不随需求轨中间行被裁掉。
5. **运行时合成文本不入语义轨**(2026-09-14):`maxTokensContinue` 注入的续写提示(以 user 落盘,`agentLoop.ts`)会被 `isRuntimeContinueMessage` 在入轨前跳过;`INTERRUPTED_ASSISTANT_TEXT` 不参与结论/解释轨;`isRuntimeSyntheticText` 在重建地图时剔除历史遗留污染条目。**否则续写提示会顶掉地图「最新要求/更早的需求」位,加重目标语义污染。**
6. **写前定型**(P1,agentLoop):trim 类 tool_result 在 push 前定型最终字节,避免发送前改写。
7. **坑**:曾出现「旧行重写 → 前缀断裂 → 压缩后首轮 ~10% 命中」;修复后真实首轮 49~54%,第 2 轮即恢复到 97%。
8. **坑**:thinking 块空轨无标题(旧语义),与压缩块恒输出不同——`track` 第 3 参控制,勿混用。
9. **坑**:`budgetInfo` 在 thinking 关闭时两段份额需重新归一化,否则 compacted/tail 占比和 <1。
10. **坑**:`assertNoSeqOverlap` 前置断言——新旧段 seq 重叠说明序号推进 bug,合并会造成两条同 `[r{n}]` 不同内容,由 agentLoop 的 compact fail-open 兜底。

## 已知问题/改进空间

- 压缩后首轮 tail 结构性全 miss(06 优化机会 #1:调 triggerRatio 摊薄)。
- 会话首轮(重建)命中 7.6%(频次低,优化 #4)。
- re-summarize 的新增行可能仍包含较长旧引文,可进一步按 seq 边界收紧(低优先)。
- **`context_recall` 调用率尚未量化**:可用 `statsStore` 的 `context_recall` 事件统计「压缩后 N 轮内回查率」,验证模型是否真去读了压缩块指向的原文。
- **阶段 C(96k / 3:7)成本加剧**:每轮 effCostIdx +45.8% / $ +62.9%,主因 tail ×2.15 —— 权衡见 06 与工作日志。
