# 统计大模块设计(2026-08-09)

## 定位

DSBAgent 的**统计大模块**:统一承载「通过统计用户使用方式改进 agent 体验、调整 agent 参数」所需的数据记录与查询能力。

> 扩展原则:今后任何「需要统计」的功能(使用频率、耗时、错误率、token 消耗、参数调优依据等),
> 一律接入本模块打点,而不是各自散落存储。打点只记录元信息/轻量负载,不落用户消息内容(隐私友好)。

## 模块组成(`src/stats/`)

| 文件 | 职责 |
|------|------|
| `statsStore.ts` | **通用事件日志**(基座):JSONL 按天分文件 `~/.dsb/stats/<projectKey>/events-YYYY-MM-DD.jsonl`,`record(type, data?)` 追加 / `list(type?, since?, limit?)` 倒序查询 / `count()` 计数 / 保留最近 30 天(抽样 prune)。事件类型如 `message_sent` / `provider_send` / `tool_completed` / `compaction` / `error`。 |
| `activityStats.ts` | **每日活动统计**:`ActivityStatsStore` 记录每天最后一次发送时间(单文件 `daily.json`),`computeDailyReminder` 按最近 5 个工作日平均收工时间提前 20 分钟(clamp ≥17:00,数据 <3 天不提醒),`DailySummaryReminder` 周期调度 + 当日去重;触发「生成本日工作总结并更新项目文档」。 |
| `agent/compactionStats.ts` | **压缩成本监控**(会话内):滑动窗口 100 记录「最近 N 次对话中 thinking 压缩次数」,agentUI header 徽章显示,频率 ≥20% 警示提示调高 `dsbAgent.compaction.triggerRatio`。 |
| `providerSendStats.ts` | **发送组成统计**(纯函数):`estimateProviderSendTokens(system, messages)` 把每次 `provider.round` 发送的一包消息按全部种类估算 token(只记数字不记内容)——system / 压缩块 / thinking 块 / user 文本 / tool_result / assistant 文本 / tool_use / assistant thinking 原文 / image / 当前轮 / tail(合计与条数)。`estimateTokens` 为 CJK≈1 token/字、其余≈1 token/4 字符的近似(±30% 可接受,用于占比分析)。 |

## 存储布局(按项目隔离)

```
~/.dsb/stats/<projectKey>/
├── daily.json                      # 每日最后发送时间(ActivityStatsStore)
└── events-YYYY-MM-DD.jsonl         # 通用事件日志(StatsStore,保留 30 天)
```

## 打点现状

- `ChatController.send()`:记录 `message_sent`(textLen)事件 + 更新当日最后发送时间(提醒器内部消息均不计入)。
- `AgentSession` 每轮 `provider.round` 发送前:记录 `provider_send` 事件,data 为 `ProviderSendBreakdown` 全字段(token 估算,不含任何用户内容)。**用于积累「历史 token 组成分布」数据,为「历史 token 预算分配(压缩块/thinking/tail 按比例)」提供依据**;不记录具体信息,隐私友好。
- **预算联动(2026-08-09)**:`dsbAgent.compaction.historyTokenBudget`(默认 10000)× `budgetSplit`(45/20/35)约束压缩产物;预算判定与打点共用 `estimateTokens`/`estimateMessageTokens`,保证「预算所见 = 发送所测」;独立参数面板 `dsbAgent.agentSettings` 可调。

## 扩展指南(新增统计功能怎么做)

1. **事件打点**:在产生数据的路径调用 `deps.statsStore?.record("my_event", { … })`(注入链路:extension → ChatViewProvider → ChatController / ToolExecutor)。
2. **分析/调参**:用 `statsStore.list({ type, since })` / `count()` 聚合;需要实时 UI 展示时,仿照 `compactionStats` 走 `AgentLoopEvent → postMessage → webview 徽章` 通道。
3. **落地建议**:新统计先写设计到 `.dsb/specs/`,实现后更新本文件「已有统计项」表与 `docs/architecture/agentarchitecture.md` 的 Stats 行。

## 验收

- 802 tests(90 files)全绿 + tsc + compile;
- StatsStore:JSONL 追加/倒序查询/类型过滤/30 天滚动/损坏行容错;
- 事件打点注入链可用且 fail-open(未注入不阻塞)。
