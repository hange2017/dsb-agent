# 流水线式预算压缩设计 v2（Tail 活动 + 压缩块滚动）

> 日期：2026-08-09 · 状态：已批准（用户确认 5 节设计）· 前置：`.dsb/specs/2026-08-09-history-token-budget-design.md`（v1 预算比例，本设计在其上重构压缩机制）

## 1. 背景与目标

v1（已实现）引入历史 token 预算：总预算 10000 × 三块比例（压缩块 45 / thinking 20 / tail 35），每块有上限。但**压缩触发仍基于窗口比例**（`input_tokens / window(256K) ≥ 0.75`），与三块预算无直接关联：

- 历史短时可能永不压缩（窗口占比低）；
- 压缩是"事件驱动的一次性重建"（compact 遍历 head 重建/合并压缩块）；
- 无滞回：压缩后目标 = 预算 100%，反复压缩边界不明确；
- tail 是软上限（当前轮/tool 对可超）。

目标（用户确认）：改为**流水线式**——tail 是唯一"活"的未压缩缓冲区，压缩块是被动接收的**滚动压缩产物**；每块按「额定 × 触发线 → 压缩 → 额定 × 目标线」滞回循环；窗口仅作安全兜底。

## 2. 范围

### 本次实现（大框架）

1. 压缩触发源改为 **tail 自驱动**：tail token ≥ tail 额定 × triggerPct → 压缩；
2. **压缩块滚动语义**：压缩产物**追加**到压缩块轨道尾部；超触发线**剔除最旧**压缩行到目标线；
3. **窗口兜底保留**：整个 messages ≥ contextWindowTokens × 0.75 仍触发压缩（安全阀 1）；
4. **压缩块剔除优先级**：工具履历 → 说明 → 结论 → 需求（安全阀 3）；
5. **设置面板扩展**：窗口总长度、触发比例、目标比例三个新参数；
6. thinking 块跟随同一触发/目标滞回（丢弃最旧脉络行，现滚动收缩机制适配为 75/50）。

### 本次不做（后续迭代）

- tail 内部硬截断优先级细化（当前轮及工具结果完整保留、超限内容截断策略）——本次沿用现有预算模式 tail 逻辑（安全阀 2 后置）；
- 触发线按块独立（本次全局统一）；
- 基于 `provider_send` 数据的比例/参数校准。

## 3. 配置模型

| 配置项 | 默认 | 说明 |
|---|---|---|
| `dsbAgent.contextWindowTokens`（新） | 0 = 跟随模型(256K) | **给大模型的输入最大长度**；>0 覆盖模型默认（`effectiveContextWindowTokens` 结果被覆盖）；影响窗口兜底触发（×0.75）与输出 max_tokens 预算 |
| `dsbAgent.compaction.historyTokenBudget`（已有） | 10000 | 历史信息总预算；0 = 关闭（回退现状） |
| `dsbAgent.compaction.budgetSplit`（已有） | `{compacted:0.45, thinking:0.2, tail:0.35}` | 三块比例（归一化） |
| `dsbAgent.compaction.triggerPct`（新） | **0.75** | 每块触发线（0~1）：tail 涨到额定×75% 触发压缩；压缩块追加后超 75% 剔除 |
| `dsbAgent.compaction.targetPct`（新） | **0.5** | 每块压缩后目标（0~1）：压缩/剔除后回到额定×50%，留 25% 余量膨胀 |

约束：`0 < targetPct < triggerPct ≤ 1`，非法回退默认。

## 4. 引擎机制（ContextManager 重构 compact 语义）

### 4.1 每轮检查（触发任一即压缩）

```
① tail token ≥ tail额定 × triggerPct(0.75)      ← 主触发(自驱动)
② lastInput ≥ contextWindowTokens × 0.75        ← 窗口兜底(安全阀1)
```

其中：

- tail token = 当前 tail 消息的 `estimateMessageTokens` 累加；tail 额定 = `floor(historyTokenBudget × split.tail)`；
- 窗口兜底沿用 provider 返回的 `usage.inputTokens`（**lastInput 口径，含 system**，与现状 `needsCompaction` 一致）；
- 触发后执行 §4.2 的压缩动作；若压缩后仍超窗（极端：system 极大），后续轮次循环中会再次触发，渐进收敛（每轮检查一次，不保证单次压到位）。

### 4.2 压缩动作（流水线）

```
1. 取 tail 中【较旧】消息(当前轮必留;防拆 tool_use/tool_result 对,复用 isToolResultUserMessage)
   → 分轨压缩(四轨) + thinking 独立管道(如有 thinking 原文,失败占位 fail-open)
2. 压缩产物【追加】到压缩块对应轨道尾部(新在尾,seq 继续推进)
3. tail 移除已压缩的旧消息(剩最近部分)
4. 压缩块若超 额定×75% → 剔除最旧压缩行到 额定×50%
   剔除优先级: 工具履历 → 说明 → 结论 → 需求(最后才动核心)(安全阀3)
5. thinking 块同样按 75/50 滞回滚动(丢弃最旧脉络行,至少留 1 行)
```

### 4.3 压缩块存储形态

保持**单条 user 消息**（`[compacted]` + 四轨 sections）。内部以 `CompactBlockParts`（轨道数组）管理：

- **追加** = 新压缩行 push 到对应轨道数组尾部 → rebuild 字符串；
- **剔除** = 按优先级从最旧（seq 最小）行 shift → rebuild；
- seq 单调推进（复用 `nextSeq` + `assertNoSeqOverlap` 防碰撞）。

### 4.4 每块滞回循环

```
50% → 75% → 压缩/剔除 → 50%
```

- tail：从 50% 涨到 75% → 压缩较旧部分 → 回 50%；
- 压缩块：追加后超 75% → 剔除最旧 → 回 50%；
- thinking：同 75/50。

## 5. 设置面板扩展（agentSettingsPanel）

```
┌─ 上下文预算 ────────────────────────────────────┐
│ 窗口总长度:     [256000] tokens  (0 = 跟随模型)     │
│ 历史信息总预算: [10000] tokens  (0 = 关闭)         │
│ 压缩块: 45% (5400) / thinking: 20% (2400) / tail: 35% (4200) │
│ 触发比例: [75]%  压缩后目标: [50]%  (全局,作用于三块) │
│ [恢复默认参数]  [保存]                             │
└──────────────────────────────────────────────────┘
```

- 新增字段：窗口总长度（数字输入，0=跟随模型）、触发比例（0-100 输入）、目标比例（0-100 输入）；
- 校验：目标 < 触发；保存时归一化写配置；
- `reset_defaults` 恢复全部默认（含新参数）。

## 6. 数据流

```
面板 → configuration.ts(getters) → chatViewProvider(createSession) → AgentSession deps
  → ContextManagerOptions { historyTokenBudget, budgetSplit, triggerPct, targetPct, windowTokensOverride }
ContextManager: 每轮检查 tail 大小 + 窗口兜底 → 压缩 → 压缩块追加/滚动 → thinking 滚动
provider_send 打点复用(可观测每块实际 token,验证 ≤ 额定)
```

`contextWindowTokens` 覆盖生效点：`effectiveContextWindowTokens(caps)` 结果被配置值替换（>0 时）；agentLoop 自建 ContextManager 的 `windowTokens` 与 CapabilityGate 预算同步使用该值。

## 7. 测试计划

| 层 | 用例 |
|---|---|
| `tests/contextManager.test.ts` | tail 涨到额定×75% 触发（不看窗口占比）；压缩后 tail 回目标线；压缩产物追加到压缩块尾部（新行在尾）；压缩块超 75% 剔除最旧（优先级：先履历后需求/结论）；窗口兜底（messages ≥ 窗口×0.75 仍触发）；当前轮必留；防拆 tool 对；triggerPct/targetPct 自定义值生效；预算关闭回退现状 |
| `tests/configuration.test.ts` | contextWindowTokens 默认 0 / 覆盖；triggerPct/targetPct 默认 75/50、非法（≥触发/≤0/非数）回退 |
| `tests/agentLoop.test.ts` | 配置透传（windowTokensOverride/triggerPct/targetPct） |
| `tests/agentSettingsPanel.test.ts` | 新参数 state 下发 / budget_update 携带 / reset 恢复 |
| 冒烟 | 真实会话：provider_send 统计每块 ≤ 额定，tail 触发行为符合滞回 |

## 8. 验收标准

1. 设置面板可调：窗口总长度、总预算、三块比例、触发比例、目标比例，保存后新会话生效；
2. tail 自驱动触发：tail ≥ 额定×75% 即压缩（无需窗口占比达标）；
3. 压缩块滚动：追加 + 剔除最旧（优先级正确），每块 ≤ 额定；
4. 窗口兜底：messages ≥ 窗口×75% 仍触发；
5. `historyTokenBudget=0` 或 `contextWindowTokens=0` 时行为不劣化（回退现状/跟随模型）；
6. 全量测试绿 + tsc + compile + dist 同步。

## 9. 后续迭代

- tail 内部硬截断优先级（安全阀 2）：当前轮及工具结果完整、超限内容截断策略；
- 触发线按块独立配置；
- `provider_send` 数据积累后校准默认比例与滞回参数。
