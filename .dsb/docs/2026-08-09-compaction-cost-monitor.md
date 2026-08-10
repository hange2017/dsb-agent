# 压缩成本监控 + triggerRatio 默认 0.75(2026-08-09)

## 背景

thinking 独立压缩(2026-08-09)每次触发都是一次额外 LLM 调用(预算 ≤3500 tokens)。若 `dsbAgent.compaction.triggerRatio` 阈值过低,长会话会在每轮对话附近反复压缩,产生不可见的成本。需要:

1. 量化实际触发频率 ——「最近 100 次对话中,发生了几次 thinking 压缩」;
2. 在 agentUI header 直接可见,频率过高时提示调高阈值;
3. 同步把默认阈值从 0.7 上调到 0.75(用户建议方向:监控 + 必要时提高)。

## 设计

### 统计模块 `src/agent/compactionStats.ts`(纯 TS,无 vscode 依赖)

- `CompactionStats` 每会话一个实例(chatViewProvider 主会话注入;子代理不统计)。
- 滑动窗口 `COMPACTION_STATS_WINDOW = 100`:窗口数组每个元素 = 一次对话内发生的 thinking 压缩次数;满 100 挤出最旧对话。
- `beginConversation()`:send 入口调用,计入窗口 + 累计对话数。
- `recordThinkingCompaction()`:thinking 压缩发生(成功/失败都产生 LLM 成本,均计入),归入最近一次对话,累计压缩数。
- `snapshot()`:输出 `{ windowCompactions, windowConversations, windowSize, totalConversations, totalCompactions }`。

### 接线

- `ContextManager` 新增可选 `onThinkingCompaction` 回调,在 `collectThinking && thinkingSources.length > 0` 分支 **try 之前**触发(无论成功/失败都算一次成本)。
- `AgentSession`:
  - deps 新增 `stats?: CompactionStats`;自建 ContextManager 时注入 `onThinkingCompaction: () => this.recordThinkingCompaction()`。
  - `send()` 开头 `stats.beginConversation()` + 推送 `compaction_stats` 事件;压缩事件后经 `currentOnEvent` 推送快照。
  - `AgentLoopEvent` 新增 `{ type: "compaction_stats"; stats: CompactionStatsSnapshot }`。
- `ChatController.onAgentEvent` 转发 `compaction_stats` → webview。

### UI(webview)

- header `usageRing` 旁新增 `#compactionBadge`,显示 `思考压缩 {x}/{N}`(N = 窗口内实际对话数,满 100 即 /100)。
- title 提示累计次数与配置项 `dsbAgent.compaction.triggerRatio`(默认 0.75)。
- 窗口 ≥20 次对话且压缩频率 ≥20% → `.hot` 警示色(`--vscode-editorWarning-foreground`)。
- `reset` 时清空徽章。

### 默认阈值 0.7 → 0.75

- `src/settings/configuration.ts`:fallback 与注释。
- `src/agent/agentLoop.ts`:`DEFAULT_TRIGGER_RATIO = 0.75`。
- 测试同步:`tests/configuration.test.ts` 4 处断言;`tests/agentLoop.test.ts` 依赖默认阈值触发压缩的用例 inputTokens 180000(0.703)<0.75 不再触发 → 改 200000(0.781)。

## 关键文件

- 新增:`src/agent/compactionStats.ts`、`tests/compactionStats.test.ts`
- 修改:`src/agent/contextManager.ts`(onThinkingCompaction)、`src/agent/agentLoop.ts`(事件/deps/计数)、`src/chat/chatController.ts`(转发)、`src/chat/protocol.ts`(消息类型)、`src/chat/chatViewProvider.ts`(注入 stats)、`src/settings/configuration.ts`(默认 0.75)、`webview/index.html`、`webview/styles.css`、`webview/main.ts`、`src/i18n/strings.ts`、`tests/configuration.test.ts`、`tests/agentLoop.test.ts`、`docs/remaining-issues.md`、`docs/architecture/agentarchitecture.md`

## 验收证据

- `npm test`:780 passed(88 files),含新增 CompactionStats 4 例 + AgentSession 统计接线 2 例。
- `npx tsc --noEmit`、`npm run compile` 通过。
- UI:header 徽章随对话/压缩实时刷新;`reset` 归零;频率 ≥20% 变警示色。

## 取舍与边界

- 压缩计数按「发生即计」(成功/失败都算),因为成本发生在调用 `compressThinkingSources` 时。
- 对话计数按 `send()` 一次 = 一次对话(失败/取消也计入,用户确实发了一条消息)。
- 手动 `/compact`(`compactNow`)不计对话轮次,但 thinking 压缩计入成本;事件推送经上次 send 的通道,无害。
- 注入自定义 ContextManager 的调用方需自行接 `onThinkingCompaction`(测试注入的 fake 不接)。
