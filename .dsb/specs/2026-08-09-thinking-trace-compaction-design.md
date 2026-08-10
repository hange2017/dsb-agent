# Thinking 独立压缩块设计（Thinking Trace Compaction）

> 状态:已确认待实施 · 日期:2026-08-09
> 关联:`.dsb/specs/2026-08-06-context-compaction-stratified-design.md`（分轨压缩，本设计在其上扩展）
> 需求来源:数学/长推理场景下,"被压缩历史只能提供部分详细结论和步骤",而 thinking(推理过程)在压缩时被直接丢弃,一旦滚出 tail 即永久消失;同时 tail 中 thinking 原文全量发送造成 token 浪费。

## 1. 背景与问题

现状（2026-08-06 分轨压缩）:

- 压缩触发:上一轮 `input_tokens / windowTokens ≥ 0.7`(默认阈值,可配)
- `stratify(fresh)` 把 head 分轨压缩:需求(原文)/结论(原文)/说明(LLM 摘要 ≤800 tokens)/工具履历(一行摘要)
- **thinking 块被直接剥离**:不进任何轨、不写冷存储、不可恢复
- tail(最近 ≥4 条消息)原样保留,thinking 原文全量发送(token 浪费),一旦滚出 tail 即丢失

两个核心矛盾:

1. **数学/长推理场景**:正确的推理链路是最值钱的信息,却在压缩时最先消失
2. **tail 侧**:thinking 原文全量保留,占 assistant 内容 3.7 倍于 text

## 2. 目标

1. thinking 不再丢弃:压缩时压成"推理脉络",独立成块随历史发送
2. 正确推理链保留完整、错误只留方向(分级预算)
3. thinking 块独立管理:独立预算/开关/失败兜底,不挤占常规压缩块
4. thinking 原文写冷存储可回查
5. 总量可控:滚动收缩 + 存储上限,防爆炸

## 3. 发送结构（核心变更）

```
input = system + tools 定义 + messages

messages = [
  { role: "user", content: 压缩块(常规四轨) },   ← 需求/结论/说明/工具履历,不含 thinking
  { role: "user", content: thinking块 },          ← ★ 独立:推理脉络,独立预算/开关
  ...tail(最近未压缩,原样)...
  ...本轮新消息...
]
```

- thinking 块作为**独立 user 消息**,位于压缩块之后、tail 之前
- 压缩块(常规四轨)不再包含 thinking;原 2026-08-06 spec 中"thinking 剥离"行为被本设计取代

## 4. 压缩块（常规,层次② 收缩）

- 四轨:需求 / 结论 / 说明 / 工具履历(**不含 thinking**)
- 收缩(ensureBlockFits):块 > 15% 窗口 → 最旧说明段再摘要 → 自适应扩容 → 超 30% 截断超长行
  - 推理轨不参与本层收缩(thinking 已独立,见 §5)

## 5. thinking 块（独立管道）

### 5.1 生成流程（每次上下文压缩触发时）

```
对 fresh 中所有 assistant 消息的 thinking 批量处理(一次 LLM 调用):
  每条 thinking 附配对上下文:
    thinking + 同消息 text + 该轮 tool_result 摘要 + 后续 1~2 轮 assistant text
      ↓ LLM 逐条标注并压缩(复用 summarizeMessages 机制, tools: [], 低预算)
  [正确] → 完整推导链路(关键步骤/公式/转折),每条 ≤300~500 tokens
  [错误] → 仅粗略方向 + 结论,≤40 字
  [中性] → 1~2 行概要,≤80 字
      ↓
  按判定分组追加进 thinking 块
```

- **批量一次调用**:所有 fresh thinking(含配对上下文)拼成一个 prompt,一次 LLM 调用,不是逐条调用
- 单次压缩 thinking 增量总预算 ≤ **3500 tokens**
- 判断上下文(方案 B):必须看到 thinking 的"后果"(工具结果/后续结论)才能标注正确/错误/中性

### 5.2 块格式（Markdown 分组式）

```markdown
[thinking]
## 正确
- [r9] 链路:观察到三次项系数 1 → 尝试因式分解 → 得(x+1)(x²−x+1) → 展开验证成立 → 采用此法
## 错误
- [r10] 方向:尝试配方法 | 结论:展开后二次项不符 → 放弃,改用因式分解(见 r9)
## 中性
- [r12] 概要:评估多种解法优劣,未形成明确结论
```

- `[thinking]` 标记(类似 `[compacted]`),程序可识别
- `- [r{n}]` 行标 = thinking 所在 assistant 消息 seq,与冷存储/ContextRecall 对应
- 字段:正确 `链路:...`;错误 `方向:...|结论:...`;中性 `概要:...`
- 增量合并:新行按判定追加进对应分组,旧行保留(按行去重)

### 5.3 滚动收缩（总量控制）

- thinking 块总量 > **3000 tokens** → 触发收缩(接近 3500 即收缩)
- 收缩方式:**丢弃最旧行**直至 ≤ **2000 tokens**(不重压、不额外 LLM 调用)
- 保新弃旧:最近 ~10~30 条 thinking 脉络常驻(取决于正确/错误比例:全正确 ~5~9 条,全错误/中性 ~66 条,混合 ~10~30 条),更旧的丢弃(冷存储原文仍可回查)
- 与常规块收缩(层次②)完全独立,互不影响

### 5.4 压缩规则（前置常量）

`THINKING_COMPACTION_RULES` 代码常量,每次 thinking 压缩调用注入 system prompt 最前:

```text
1. 对每条 thinking 标注结果: [正确]/[错误]/[中性],判断依据为该 thinking 之后的工具执行结果与后续结论
2. [正确] 保留完整推导链路(关键步骤、公式、转折),每条 ≤300~500 tokens
3. [错误] 仅保留粗略方向性描述和最终结论,≤40 字
4. [中性] 保留 1~2 行概要,≤80 字
5. 输出长度按"关键步骤/转折点"提取,不是按原文比例浓缩——勿凑字数、勿重复原文
6. 单次压缩总输出 ≤3500 tokens 是硬上限,不是目标
7. 若原 thinking ≤500 tokens,脉络不应超过原文的 60%
8. 输出格式:按 §5.2 分组,每行 `- [r{n}] 字段:内容`
```

### 5.5 开关（C 方案）

- 全局默认**开**(设置按钮可关闭,新增 `dsbAgent.compaction.thinking` 配置项)
- `plan` / `ask` 模式自动**关**(省一次 LLM 调用)
- 关闭时:thinking 回退为剥离丢弃(等价现状),不产生 thinking 块

### 5.6 失败兜底

- thinking 摘要 LLM 调用失败 → 占位行 `- [r{n}] 推理:(原文已省略)`
- 不影响常规压缩、不阻断主循环(fail-open)
- 冷存储原文仍写入(失败只影响脉络行)

## 6. 冷存储

- 新增 chunk 类型 `thinking`
  - `summary`:推理脉络行(ContextRecall 列表显示)
  - `content`:thinking 原文(回查用)
- **原文默认全量写入**(本地磁盘成本低)
- 上限:**2MB/会话**;超限时按 ts 淘汰最旧 thinking 原文
- thinking chunk 不挤占其他轨道(独立计数/独立淘汰)
- `ContextRecall` 按 seq 回查原文;索引可命中推理内容

## 7. 窗口与上限

| 参数 | 值 | 说明 |
|---|---|---|
| 默认窗口 `kDefaultContextWindowTokens` | 128K → **256K** | 用户模型 1M,256K 是成本/频率平衡点 |
| `maxBlockChars`(常规块目标) | `windowTokens × 15%` | 动态生效(窗口热更新后重算) |
| `hardMax`(常规块硬顶) | `windowTokens × 30%` | 超 30% 才截断超长行 |
| 压缩触发阈值 | 0.7(不变) | `input_tokens / window ≥ 0.7` |
| thinking 单次增量预算 | ≤3500 tokens | 每次压缩的新 thinking |
| thinking 滚动收缩 | 接近 3500 → 丢旧行至 2000 | 独立于常规块 |

## 8. 测试计划

单元测试(`tests/contextManager.test.ts` / `tests/contextCompactor.test.ts` 扩展):

1. thinking 收集与配对上下文构造(thinking + text + tool_result 摘要 + 后续 1~2 轮)
2. `THINKING_COMPACTION_RULES` prompt 构造与注入
3. thinking 块格式:生成/解析(`[thinking]` + 三分组)、增量合并(行去重)
4. 滚动收缩:接近 3500 → 丢最旧行至 ≤2000,不调 LLM
5. 失败兜底:占位行写入,不阻断
6. 开关:关闭时无 thinking 块;plan/ask 模式自动关
7. 冷存储:thinking chunk 写入/回查/2MB 淘汰;不挤占其他轨道
8. 窗口上限:maxBlockChars/hardMax 动态随窗口变化
9. 冒烟:含 thinking 的真实消息序列压缩(对比原 100:1 摘要)

## 9. 实施要点(代码落点)

| 文件 | 改动 |
|---|---|
| `src/agent/contextManager.ts` | stratify 收集 thinking + 配对;独立 thinking 块组装;滚动收缩;开关判断 |
| `src/agent/contextCompactor.ts` | `THINKING_COMPACTION_RULES` 常量;thinking 块生成/解析/合并纯函数 |
| `src/context/contextStore.ts` | `ColdChunkType` 增 `thinking`;2MB 上限淘汰;独立计数 |
| `src/agent/agentLoop.ts` | summarizeMessages 支持规则注入;thinking 块位置;窗口默认 256K 相关 |
| `src/settings/configuration.ts` | `dsbAgent.compaction.thinking` 配置项 |
| `src/agent/modePolicy.ts` | plan/ask 模式关闭 thinking 压缩 |
| `src/providers/capabilities.ts` | `kDefaultContextWindowTokens` 128K → 256K |

## 10. 修订历史

| 日期 | 内容 |
|---|---|
| 2026-08-09 | 初版:brainstorm 确认全部决策后编写 |

## 11. 范围外(后续)

- tail 优化:tail 中 thinking/tool_result 的预算与分级(用户最初 A 方向)
- 任务感知冷存储:按任务(TodoWrite taskId)划分 thinking 保留
- 语言感知 token 估算:字符上限按中英文折算(当前固定字符数,中文 token 占比为英文 2.5 倍)
