# 历史信息 Token 预算设计（History Token Budget）

> 日期：2026-08-09 · 状态：已批准（用户确认 A 方案）· 关联：`.dsb/specs/2026-08-06-context-compaction-stratified-design.md`、`.dsb/specs/2026-08-09-thinking-trace-compaction-design.md`

## 1. 背景与目标

现状：发送给模型的历史 = `[压缩块(四轨) + thinking块(推理脉络) + tail(最近4条原样)]`，其中：

- 压缩块：默认目标 ≤8000 字符，超限后"自适应扩容"到 32K 字符（4×）——无脑放大；
- thinking 块：6000 字符触发线滚动收缩（拍脑袋常数）；
- tail：固定 4 条，**无 token 上限**，超大工具输出失控；
- **压缩后不校验总 token**，历史大小不可预测。

目标：给"发送给模型的历史信息"设置**总 token 预算**（默认 10K），压缩块 / thinking / tail 三块按比例分配，每块有明确上限，整体可预测、可调参。数据侧已先落地 `provider_send` 打点（commit `dc0cc20`），积累真实占比后校准默认比例。

## 2. 范围（用户确认 A 方案）

- **本次实现**：第一层 = 总预算 → 压缩块 / thinking / tail 三块比例；含 tail 丢弃优先级（纯逻辑，不依赖数据）。
- **预留不实现**：第二层 = 压缩块内部四轨（需求/结论/说明/履历）比例、thinking 分组（正确/错误/中性）配额、tail 消息类型配额。架构（配置 JSON 层级 + 面板分区占位）预留，待 `provider_send` 统计数据支撑后再填。

## 3. 页面形态：独立参数设置面板

新增「DSB Agent 参数设置」面板（`dsbAgent.agentSettings` 命令），复用 memoryPanel 模式：

| 层 | 文件 | 职责 |
|---|---|---|
| host | `src/settings/agentSettingsPanel.ts`（新） | 读配置下发 `state`、接收修改、写 VS Code 配置（Global） |
| webview | `webview/agentSettingsPanel.ts/.html`（新） | 分区卡片布局；本次只放「上下文预算」区，后续参数区直接加卡片 |
| 入口 | ⚙ 设置抽屉按钮「参数设置…」+ 命令面板 | 与记忆管理一致 |

面板「上下文预算」区：

```
┌─ 上下文预算 ────────────────────────────────┐
│ 历史信息总预算: [10000] tokens   (0 = 关闭)    │
│ ─────────────────────────────              │
│ 压缩块:  ████████████░░░░   45% (4500)      │
│ thinking:█████░░░░░░░░░░   20% (2000)      │
│ tail:    █████████░░░░░░   35% (3500)      │
│ (拖动任一滑块,其余等比例缩放,总和恒 100%)       │
│ ── 第二层(预留,待数据支撑) ──                 │
│   (压缩块内四轨 / thinking 分组 / tail 优先级   │
│     —— 架构已预留,UI 置灰占位)                │
└──────────────────────────────────────────┘
```

交互：总预算数字输入（≥0）；三个比例滑块（0-100），拖动一个其余等比例归一（总和恒 100%）；每块右侧显示换算 tokens。

## 4. 配置模型

```
dsbAgent.compaction.historyTokenBudget   number,默认 10000,0 = 关闭(回退现状)
dsbAgent.compaction.budgetSplit          JSON,默认 { "compacted": 0.45, "thinking": 0.20, "tail": 0.35 }
```

- `budgetSplit` 三项相加应 = 1；非法（缺项/非数/和为 0）→ 回退默认。
- 配置变更**实时生效**：面板保存 → 写 Global 配置 → 下次 `AgentSession` 创建时读取。会话内不做热更新（避免压缩中改预算的复杂状态），新会话立即生效。
- 第二层预留：未来在 `budgetSplit` 下加子字段（如 `"compacted": { "ratio": 0.45, "inner": { "demand": 0.4, ... } }`），JSON 层级天然兼容，无需迁移。

## 5. 引擎逻辑（ContextManager）

### 5.1 预算开关

`historyTokenBudget <= 0` → 完全回退现状（`keepTail=4`、压缩块 8K 字符自适应、thinking 6000→4000 字符）。

### 5.2 预算开启时的 compact 流程

```
compact(history):
  ① tail 预算 = total × tail%
     tail = 从消息尾部向前累加 estimateTokens 的【连续消息 slice】(消息顺序不可打乱,不能跳留)
     —— 当前轮(最后一条 user)必留:即使超出 tail 预算也至少保留 1 条(无当前轮对话无意义);
     —— 不得拆散 tool_use/tool_result 对(cut 点向前扫描,复用现有 isToolResultUserMessage);
     —— 预算内尽量装满:从最新向前累加,能放几条放几条;并入压缩的必然是最旧的
        (历史 user 文本 / 最旧 assistant 回复),天然符合"高优先级在尾、低优先级先并压缩"
  ② 剩余历史 → 压缩块,在 compacted 预算内三段式收缩:
     最旧解释段再摘要 → 截断超长行(240) → 按 seq 最旧截断轨道行
     (取消现有 4× 自适应扩容;硬上限 = compacted 预算)
  ③ thinking 块在 thinking 预算内滚动收缩(丢弃最旧脉络行,不重压)
```

### 5.3 估算口径

复用 `src/stats/providerSendStats.ts` 的 `estimateTokens`（CJK≈1 token/字、其余≈1/4 字符），保证"预算所见 = 发送所测"；与 `provider_send` 打点同口径，统计可直接校准。

### 5.4 传递链路

```
configuration.ts(新 getter) → chatViewProvider(读取) → AgentSession deps
  → ContextManagerOptions { historyTokenBudget, budgetSplit }
```

`ContextManagerOptions` 新增：

```
historyTokenBudget?: number;   // 0/缺省 = 关闭(现状)
budgetSplit?: { compacted: number; thinking: number; tail: number };  // 缺省 45/20/35
```

## 6. 数据流

```
面板 UI 滑块/输入 → agentSettingsPanel(host) → vscode.workspace.getConfiguration().update(Global)
                                        ↓
configuration.ts getter ← 读取
        ↓
chatViewProvider.createSession → AgentSession deps → ContextManagerOptions
        ↓
compact() 按预算分块处理
        ↓
provider.round 前 onProviderSend 打点(现有) ← 统计验证 tail ≤ 预算
```

## 7. 测试计划

| 层 | 用例 |
|---|---|
| `tests/contextManager.test.ts` | 预算开启：tail 条数随预算缩放；当前轮必留（预算极小也保留）；防拆散 tool_use/tool_result；tail 为连续 slice 且并入压缩的必然是最旧消息；压缩块预算内三段式收缩（不再 4× 扩容）；thinking 预算内收缩；预算关闭回退现状（keepTail=4 / 8K / 6000） |
| `tests/configuration.test.ts` | 默认值 10000 / 45-20-35；非法比例回退；0 关闭 |
| `tests/agentSettingsPanel.test.ts`（新） | 状态下发；修改写回 Global；比例归一化（和为 100%） |
| 冒烟 | 真实会话压缩后 `provider_send.tailTokens ≤ 预算×35%` |

## 8. 验收标准

1. 参数设置面板可打开（⚙ 按钮 + 命令），总预算与三块比例可改并持久化；
2. 压缩行为按预算执行：三块各自 ≤ 预算×比例；
3. `historyTokenBudget=0` 时行为与现状完全一致（回归测试证明）；
4. 全量测试绿 + tsc + compile + dist 同步。

## 9. 后续迭代（预留）

- `provider_send` 数据积累后：统计各类实际占比 → 校准默认比例；实现第二层（四轨/分组/优先级比例 UI）。
- 可选：预算与窗口联动 clamp（`预算 ≤ 窗口×0.7 - system 预留`），当前默认 10K 远小于 256K 窗口，先不做。
