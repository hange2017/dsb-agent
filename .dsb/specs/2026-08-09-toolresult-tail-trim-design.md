# tail 内 toolResult 精简设计

日期:2026-08-09
状态:已批准(待实现)

## 背景与目标

打点数据显示 tail 内部构成(427 次发送合计, 28.8M tokens):

| 种类 | tokens | 占 tail |
|---|---|---|
| toolResult | 10,313,004 | 35.9% |
| thinking 原文 | 8,662,842 | 30.1% |
| toolUse | 7,075,019 | 24.6% |
| assistantText | 2,048,856 | 7.1% |
| userText | 665,352 | 2.3% |

工具往返(toolResult + toolUse)占 tail 约 60%。其中 toolResult 是最大单类。目标:在不遗漏关键信息、不损害模型能力的前提下,压缩历史 toolResult 的重复传输成本。

## 处理时机(两阶段,B+C)

- **阶段 1(push 时)**:toolResult 进入 tail 时保留原文——本轮模型要基于最新结果决策。
- **阶段 2(每轮发送前)**:扫描 tail,把「已被模型消费过」的 toolResult 替换为精简版。

### 已消费判定

一条 `tool_result` 消息之后,若 messages 中已存在任何 `role=assistant` 消息,说明模型已看过该结果并输出过下一轮 → 精简;否则(最新未消费结果)保留原文。

### 时序与打点

```
每轮发送前:
  1. 精简已消费的 toolResult(替换 content)
  2. preSend 快照 / provider_send 打点   ← 打点反映精简后真实数字
  3. provider.round 发送
```

精简操作幂等,与 rollback 兼容。

## 工具分类策略

| 工具 | 分类 | 理由 |
|---|---|---|
| Read / Write / StrReplace / Delete / LS / Glob / Todo / Memory 系 | keep | 输出小或内容即关键信息 |
| Bash | trim(超长→summarize) | stdout 结论通常在尾部 |
| Grep | trim | 匹配列表可分组限量去重 |
| WebFetch | trim(超长→summarize) | 网页正文密度低 |
| WebSearch | trim | 结果列表本身小 |
| Workflow / Agent 子代理 | trim(超长→summarize) | 阶段执行记录冗余 |
| MCP(mcp__*) / 插件 | keep(超阈值才 summarize) | 未知工具保守对待 |

## 精简规则细节

### Bash
- 成功且行数少(≤ head+tail+余量)→ 原样
- 成功且超长 → 头 5 行 + 尾 30 行,中间折叠 `… (省略 N 行)`;去空行、去完全重复行
- 失败(非 0 / stderr 非空)→ stderr/错误行全文 + stdout 头 5 尾 30(错因绝不丢)
- trim 后仍 > 3000 tokens → 升级 summarize

### Grep
- 按文件分组,每文件最多 10 条,超出折叠 `… 还有 N 条匹配`
- 总输出上限 200 行;去重;始终保留 `path:line:` 定位前缀

### WebFetch
- 标题/首段(前 20 行)+ 尾部 20 行;超长 → summarize

### WebSearch / LS / Glob / Todo
- 原样保留

### Workflow / Agent 子代理
- 保留每个 `## 阶段` 标题行 + 阶段末尾结论行(各 2-3 行);超长 → summarize

## 阈值

| 阈值 | 值 |
|---|---|
| trimMinTokens | 800(低于原样) |
| trimMinLines | 20(低于原样) |
| summarizeAfterTrimTokens | 3000(trim 后仍超 → 摘要) |
| maxLine | 160(单行截断,复用现有) |
| Bash head / tail | 5 / 30 |
| Grep 每文件 / 总 | 10 / 200 |
| WebFetch head / tail | 20 / 20 |

## 摘要兜底

- 触发:trim 后仍 > 3000 tokens(仅低密度工具)
- 复用 agentLoop 已有 `summarizeMessages(text, maxTokens, rules)`,零新依赖
- prompt 强制保留:错误/exit code/stderr;`path:line` 定位;结论性内容(尾部)
- 结果标记 `[tool-result-summarized]`(与规则精简的 `[tool-result-trimmed]` 区分)

## 安全网(不遗漏关键信息)

1. 高密度工具永不精简
2. 错误信息永不丢(失败输出完整保留)
3. 模型可自救:精简版带标记,信息不足可重新调用该工具拿回全文

## 变更范围

| 文件 | 动作 |
|---|---|
| `src/agent/toolResultPolicy.ts` | 新增:分类 + 各工具规则 + 阈值常量(纯函数,无 vscode 依赖) |
| `src/agent/agentLoop.ts` | 发送前调用精简;复用 summarizeMessages |
| `tests/toolResultPolicy.test.ts` | 新增:分类/规则/边界单测 |
| `tests/agentLoop.test.ts` | 集成:已消费替换、最新未消费保留、打点反映精简后 |

不做:压缩块逻辑改动;toolUse 精简(单独议题);UI 改动;新依赖。

## 附录:toolUse 精简(姊妹功能,同一管道)

### 动机

toolUse 占 tail 24.6%。其中 `Write.contents`、`StrReplace.old_string/new_string`、`Workflow.stages[].prompt`、`Agent.task/system` 属**瞬时参数**——模型自己刚写的内容,文件系统或执行状态已有副本(Write/StrReplace 真实写盘,Workflow 执行后状态已存在),下一轮无需完整重读。

### 判据:字段语义(而非工具名)

| 字段 | 类型 | 处理 |
|---|---|---|
| `path` / `command` / `pattern` / `query` / `glob` / `goal` / `id` / `dependsOn` | 语义参数 | 保留(模型要知道做了什么) |
| `Write.contents` | 瞬时参数 | 摘要替换(可 Read 重建) |
| `StrReplace.old_string` / `new_string` | 瞬时参数 | 摘要替换(定位用,标注用途) |
| `Workflow.stages[].prompt` | 瞬时参数 | 摘要替换 |
| `Agent.task` / `system` | 瞬时参数 | 摘要替换 |

### 规则

- 值 ≤ 200 字符的小参数不动
- 大字段替换为摘要字符串:`[瞬时参数已省略:N 字符;已写入磁盘/执行状态,如需可重新调用工具]`
- 保持 tool_use block 结构:`id` / `name` 与 input 对象形态不变(API 兼容 + tool_result 锚点)
- 已消费判定:该 tool_use 之后存在**同 id 的 tool_result(已执行)**且该 tool_result 之后存在 **assistant(已消费结果)**,两者都满足才精简
- 替换发生在每轮发送前,与 toolResult 同一管道;同步操作(无 LLM 成本)

### 变更

| 文件 | 动作 |
|---|---|
| `src/agent/toolUsePolicy.ts` | 新增:瞬时字段表 + planToolUseTrim + findConsumedToolUses |
| `src/agent/agentLoop.ts` | 发送前调用 trimConsumedToolUses(与 toolResult 并列) |
| `tests/toolUsePolicy.test.ts` | 新增单测 |
| `tests/agentLoop.test.ts` | 集成:已消费替换、未消费保留 |

## 附录 B:thinking 原文精简(第三大头的最后一块)

### 动机

tail 内 thinking 原文(assistant `{ type: "thinking" }` 块)占 tail 30.1%,每次发送固定带着最近一轮的 thinking 原文(实测 629 tokens)。thinking 是模型推理草稿:决策结果在 text 块,长期脉络在压缩时生成的 `[thinking]` 块——tail 里的 thinking 原文是"临时思维",下一轮无需完整重读。

### 手段(已批准:B 保留尾部结论)

- thinking ≤ 阈值(300 字符)→ 原样保留(小草稿不值得动)
- 超阈值 → 保留**尾部结论行**(thinking 结尾通常是"所以,我应该做 Y"),前面删除,加标记:
  ```
  [thinking-trimmed:推理过程已精简,保留结尾结论]
  ...尾部内容
  ```
- 保持块结构 `{ type: "thinking", thinking: string }`(API 要求,消息不会因此为空)
- 已消费判定:该 assistant 消息之后存在**另一条 assistant 消息** → 模型已基于它继续 → 可精简
- 同步操作,零 LLM 成本;精简后的尾部结论参与后续压缩时,脉络块更聚焦(正向影响)

### v2:条数上限(2026-08-09 数据驱动)

实测 160 次发送:单条已压 88%(629→74 tokens),但条数随轮次线性增长(124 条 × 74 ≈ 9.2K,占 msg 12%)。中位 16 tokens 说明一半短 thinking 未到 300 阈值。

| 规则 | 值 | 理由 |
|---|---|---|
| `THINKING_KEEP_RECENT_COUNT` | 3 | 只保留最近 3 条已消费 thinking 完整尾巴 |
| rank ≥ 3(旧) | 压成**最后一行非空结论** + `[thinking-old:已消费历史推理,仅留结论]` | 远古草稿无价值,结论锚点保留 |
| rank < 3(近) | ≤150 原样 / >150 尾部 150 字符 + trim 标记 | 短 thinking 常含关键决策,不误删 |
| `THINKING_TAIL_CHARS` | 300 → **150** | 配合收紧单条尾巴 |

效果:124 条时 ≈ 3×150 + 121×一行 ≈ 2K tokens(从 9.2K 再压 ~78%),且总量有界不随轮次线性涨。

### 变更

| 文件 | 动作 |
|---|---|
| `src/agent/thinkingPolicy.ts` | 新增:findConsumedThinking + planThinkingTrim |
| `src/agent/agentLoop.ts` | 发送前调用 trimConsumedThinking(与前两者并列) |
| `tests/thinkingPolicy.test.ts` | 新增单测 |
| `tests/agentLoop.test.ts` | 集成:已消费精简、未消费保留 |

## 测试计划

- 分类正确性:keep / trim / summarize 三分
- 每类规则:Bash 成功超长、Bash 失败(stderr 保留)、Grep 分组限量去重、WebFetch 首尾、小输出原样、空输出原样
- 已消费判定:tool_result 后有 assistant → 精简;无 → 原文
- 打点验证:精简后 messageBreakdown 的 tool_result tokens 变小
