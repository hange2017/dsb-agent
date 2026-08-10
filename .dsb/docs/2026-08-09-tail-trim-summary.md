# Tail 三大头 Token 优化 · 今日总结(2026-08-09)

> 数据驱动 → 打点增强 → 三大头精简 → 链路梳理,一次完成。
> 关联设计:`specs/2026-08-09-toolresult-tail-trim-design.md`;相关记忆:`deepseekagent-tail-optimization-series`。

## 1. 背景:数据驱动的结论

以 427 次 `provider_send` 打点(旧会话,合计 39.9M messages tokens)为基线,按 tail 内部口径重算:

| 种类 | tokens | 占 tail | 本质 |
|---|---|---|---|
| **toolResult** | 10,313,004 | **35.9%** | 工具输出结果(user 侧) |
| **thinking 原文** | 8,662,842 | **30.1%** | tail 里未压缩的 assistant thinking |
| **toolUse** | 7,075,019 | **24.6%** | 工具调用声明+参数(assistant 侧) |
| assistantText | 2,048,856 | 7.1% | 模型回复正文 |
| userText | 665,352 | 2.3% | 用户输入 |
| **三大头合计** | | **90.6%** | |

合并口径:**工具往来 60.5%**(toolResult + toolUse)、**思考过程 30.1%**、**对话本身 9.4%**。
优化优先级:工具 > thinking > 对话(对话无需优化)。

关键事实修正:thinking 单条固定 ~629 tokens/发送,是"两代 thinking"问题——每轮新 thinking 原文进入 tail,要等下次压缩才收走,导致每次发送重复付最近一轮的思考。

## 2. 统计基础设施增强(让数据可见)

### 2.1 压缩事件打点 `115a839`
- 新增 `src/stats/compactionEvents.ts`:`CompactionPosition = "tail" | "block" | "thinking" | "thinking_block"`,`CompactionReason = "window_ratio" | "tail_self_driven" | "manual"`
- ContextManager 增加 `onCompaction` 回调,4 个上报点记录 before/after tokens + 预算快照
- reason 优先级:window_ratio(安全阀)> tail_self_driven > manual;一次 compact 内共享同一预算快照
- 链路:agentLoop:118 透传 → chatViewProvider:373 记录 → contextManager:425 回调 → `~/.dsb/stats/<项目>/events-*.jsonl`

### 2.2 每次发送逐条明细 `d7c8923`
- `provider_send` 新增 `messageBreakdown` 数组:每条消息(或块)一条 `{ index, role, kind, tokens }`
- 8 类 kind:`compacted` / `thinking_block` / `user_text` / `tool_result` / `image` / `text` / `tool_use` / `assistant_thinking`
- 只记数字不记内容;`sum(breakdown) === messagesTokens` 有测试保证

## 3. 三大头精简(同一管道:发送前精简已消费内容)

统一架构:**消息 push 进 tail 时保持原文**(模型基于最新结果决策),**每轮发送前**在 `prepareRound` / 打点**之前**扫描已消费内容并替换为精简版 → 打点反映真实发送。

| 提交 | 对象 | 方案 | 已消费判定 | 成本 |
|---|---|---|---|---|
| `8660623` | toolResult | 按工具类型规则裁剪(Bash 头5尾30+错误行全文保留 / Grep 按文件分组每文件10条总200行去重 / WebFetch 头尾20 / Workflow 阶段标题+前3行 / 未知工具通用头尾6);trim 后仍 >3000 tokens 升级 LLM 摘要兜底 | tool_result 之后已有 assistant 消息 | 规则零成本;超阈值摘要一次 LLM |
| `5d78053` | toolUse | **瞬态参数(可重建)摘要**:Write contents / StrReplace old+new / Workflow stages.prompt / Agent task;语义参数(path/command/goal/id/name)保留;≤200 字符不动 | 存在同 id tool_result(已执行)+ 其后有 assistant(已看过结果) | 零(纯同步操作) |
| `a517078` | thinking 原文 | 保留尾部结论 ~300 字符(完整行边界),前面删除,标记 `[thinking-trimmed:推理过程已精简,保留结尾结论]` | 该 assistant 消息之后另有 assistant 消息 | 零 |
| `f1bb3a8`+`507b74b` | thinking 条数上限 v2 | 已消费 thinking 只保留**最近 N=10 条**完整尾巴(≤150 字符原样 / >150 保留尾部结论),更早压成一行 `[thinking-old:已消费历史推理,仅留结论]` + 末行结论;总量有界,不随轮次线性增长 | 同上 | 零 |

新模块(纯函数、无 vscode 依赖、可单测):
- `src/agent/toolResultPolicy.ts`:`classifyToolResult` / `planToolResultTrim` / `findConsumedToolResults` / `toolResultText`
- `src/agent/toolUsePolicy.ts`:`planToolUseTrim`(瞬态字段声明式)/ `findConsumedToolUses`
- `src/agent/thinkingPolicy.ts`:`planThinkingTrim` / `findConsumedThinking`

agentLoop 接线点:`trimConsumedToolResults`(async,摘要兜底)/ `trimConsumedToolUses` / `trimConsumedThinking`(同步),全部 try/catch 包裹、幂等、失败不阻塞主循环。

### 安全网三条原则(贯穿三版)
1. **最新结果永不精简**——模型要基于它决策
2. **已消费才精简**——已看到过的历史往返才替换
3. **可重建/可回退**——精简带标记,模型可重新调用工具拿回全文;错误与 `path:line` 定位信息永不丢;API 结构(id/block 形态)不变

## 4. 链路理解(tail → 压缩 → 块)

```
消息逐条 push → tail(原始消息区)
  │ 发送前:三版精简已消费内容(压缩的上游优化)
  ▼
needsCompaction? ── 双触发(OR):
  • 窗口安全阀:整体占用 ≥ 窗口 × triggerRatio(0.75)
  • tail 自驱动:tail token ≥ tail额定 × triggerPct(0.5)
  ▼
compact():
  head(旧消息)→ [compacted] 块(四轨:需求/结论/解释/账本)
  thinking 原文 → LLM 压缩 → [thinking] 脉络块(正确/错误/中性三组)
    → mergeThinkingBlocks 与旧块合并(seq 去重)
    → ensureThinkingFits 滚动收缩(按 seq 丢最旧,保最新一行)
  tail(最近 keepTail 条)→ 保留原文
```

- `[compacted]` 与 `[thinking]` 是压缩产物(两条独立 user 消息,位于开头)
- `[thinking]` 块是压缩链路的子链路(只在 compact() 时产生),非独立链路
- 三版精简在压缩上游:tail 变小 → 压缩触发频率下降、压缩产物更聚焦
- thinking 精简(保留尾部结论)与 thinking 块(脉络)互补:精简版进入压缩时,`compressThinkingSources` 收到的即尾部结论,脉络块质量不降

## 5. 量化验证(重载后实际运行数据)

> 口径:事件文件 `~/.dsb/stats/<项目>/events-*.jsonl`,新代码发送 = 带 `messageBreakdown` 的 `provider_send`。

| 指标 | 优化前(旧代码 424 次) | 优化后(最近 30 次新代码) | 降幅 |
|---|---|---|---|
| 平均每次发送 total tokens | 96,729 | **36,719** | **-62%** |
| tool_result 占 messages | 35.9% | 17.5% | -51% |
| tool_use 占 messages | 24.6% | 10.0% | -59% |
| assistant_thinking 占 messages | 30.1% | 7.5% | **-75%** |
| 最近 1 次发送 tail(≈) | — | 13.2K | 低于 16.8K 触发线 |

- 三大头全部收口,thinking 降幅最大(单条 88% 压缩 + 条数上限)
- 64K 预算下稳态 ~36.7K/次,与设计预期(~35K)吻合
- 全部 206 次新代码平均 62.8K/次(含前期 256K 预算阶段),最近 30 次反映 64K 预算稳态

## 6. 参数调整(配套)

- `historyTokenBudget` 256K → **64K**(用户设置,写程序任务甜点位;稳态成本减半)
- `clampHistoryTokenBudget`(`53973dc`):预算 ≤ 窗口×0.7−4096 防呆,避免误设 1M 超窗
- `THINKING_KEEP_RECENT_COUNT` 3 → **10**(`507b74b`,保留更多近期推理锚点)

## 7. 验证状态

| 项 | 结果 |
|---|---|
| `npm test` | ✅ **927 tests**(96 files)全绿 |
| `tsc --noEmit` / `npm run compile` | ✅ |
| dist | 已同步(重载后生效) |
| 提交 | `115a839` → `d7c8923` → `8660623` → `5d78053` → `a517078` → `53973dc` → `f1bb3a8` → `507b74b`(+docs `d60b204` / `0d4e5e3` / `592d2b4`) |

## 8. 后续待做

1. **compaction 频率分析**:4 位置 before/after 已积累,统计谁最常被压、压掉多少
2. **toolUse 泛化**:扩展瞬态参数判据到更多工具(TodoWrite/Subagent/WebFetch 等)
3. **行为验证**:观察模型是否出现"漏看历史结果/思考"→ 调安全网
4. 对话本身(9.4%)不优化;压缩块逻辑不改(明确不做,YAGNI)
