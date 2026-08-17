# max_tokens 截断自动续轮设计

> 生成时间：2026-08-17  
> 状态：定稿（已实现）  
> 实现计划：`.dsb/plans/2026-08-17-max-tokens-auto-continue-plan.md`  
> 关联现场：CrobotpStudio 会话 `s_mso06ren_cqkd`（thinking 吃满 out≈8192 后误 `done` → UI 空闲）  
> 前缀约束：必须遵守 `.dsb/rules/cache-prefix-stability.md`

## 1. 背景与问题

单轮模型输出受 `max_tokens` 限制（默认 `kDefaultMaxOutputTokens = 8192`）。当 thinking 或未完成的 tool 参数写满配额时，网关硬停。

当前 `agentLoop` 在 `toolUses.length === 0` 时一律：

```ts
terminal = { type: "done" };
return;
```

于是：

- 引擎发 `busy: false` → UI 显示空闲与「发送」按钮；
- 任务实际未完成，且常无最终可执行工具 / 完整回复；
- Provider 未把 `stop_reason` 透出，无法区分「真结束」与「被上限打断」。

**用户目标（选项 A）**：任务不中断——单次 HTTP 响应仍可能在上限停下，但引擎自动多轮续跑，直到真正收工或发出可执行工具。不要求单次响应无限长。

## 2. 目标与非目标

### 目标

1. 识别 `max_tokens`（及可靠兜底）截断后**自动续轮**，保持 busy。
2. 半截不完整 `tool_use`：**写前丢弃**，不执行；完整 `thinking`/`text` 定型落盘。
3. 续写提示只追加在 **messages 尾部**（固定文案），**不**改 system。
4. 不限制日常工具调用次数（续轮上限只防死循环）。
5. 全程遵守缓存前缀稳定性六条规则。

### 非目标

- 不把默认 8192 作为本设计必改项（档案侧另议）。
- 不实现「半截 JSON 接着写完」。
- 不把用户输入 / 系统提示拆成多条假消息来「绕过」输出上限。
- 不靠提示词让模型自觉按 8000 拆分（不可靠；不做主路径）。
- **禁止**截断后动态改写 system（含「弱提示」）。

## 3. 架构

```
Provider 流 ──解析 stop_reason──► ProviderRoundResult.stopReason
                                         │
AgentLoop ◄── needsContinue? ── 半截 tool_use 写前丢弃
     │
     ├─ push 已定型 assistant（无半截 tool）
     ├─ push 固定续写 user（仅 messages 尾部）
     ├─ onEvent info:「输出达上限,继续…」（保持 busy）
     └─ 继续 for 下一 round（不 terminal done）
```

改动集中在引擎层（`provider` + `agentLoop`），可单测；宿主仅透传已有 `info`/`status` 事件。

## 4. 截断判定

### 4.1 Provider 透出停因

在 `anthropicMessagesClient` 的 `message_delta`（及供应商等价终态字段）解析停因，写入：

```ts
// ProviderRoundResult 增补
stopReason?: "end_turn" | "tool_use" | "max_tokens" | "other";
```

未知/缺失 → `undefined`（走兜底启发式）。

### 4.2 需要续轮的条件

在落盘与工具执行决策处，**需要续轮**当且仅当：

1. 本轮过滤后**没有**可安全执行的完整 `tool_use`；**并且**
2. `stopReason` **不是** `end_turn` / `tool_use`；**并且**满足以下之一：
   - `stopReason === "max_tokens"`；或
   - `stopReason` 为 `undefined` / `"other"`，且 `outputTokens >= floor(maxTokens * 0.98)`（本轮实际请求的 `maxTokens`）。

**不续轮**：

- `stopReason` 为 `end_turn` / `tool_use`（即使 output 贴近上限也不续，避免误伤「刚好写满就收工」）；
- 存在至少一个完整可执行 `tool_use`（走现有工具批处理；见 §5 混合情形）。

## 5. 半截 tool_use（策略 A）

**定义**：未收到完整 `content_block_stop`，或 input JSON 解析失败的 `tool_use` 块。

**处理（写前定型，规则 5/6）**：

| 块 | 动作 |
|----|------|
| 完整 tool_use | 保留，进入执行列表 |
| 半截 tool_use | **丢弃**，不执行、不写入 `messages` |
| 完整 thinking / text | 以收到内容为最终形态写入 assistant |

**混合**：同一轮既有完整 tool 又有半截 → 只执行完整；半截丢弃；**因已有可执行 tool，不走续轮**。

**禁止**：先 `push` 含半截的 assistant，再删改中部块。

## 6. 续轮协议

当判定需要续轮时：

1. 若 `persistBlocks.length > 0`：`messages.push({ role: "assistant", content: persistBlocks })`（已无半截 tool）。  
   若过滤后为空（例如仅半截 tool、无 thinking/text）：push 一条**固定**占位 assistant，保证 role 交替合法：

   ```
   [{ type: "text", text: "[输出中断]" }]
   ```

   （常量，写前定型；禁止事后改写。）
2. `messages.push({ role: "user", content: kMaxTokensContinueUserText })`，文案为**唯一规范常量**（实现不得改写措辞，除非改本 spec 并全量替换）：

   ```
   [续写] 上一轮输出因长度上限中断。请从中断处继续；需要改文件或执行命令时直接发起完整工具调用，不要重复已完成的步骤。
   ```

3. `onEvent({ type: "info", text: "输出达上限,继续…" })`（现有语义：保持 busy、transient 文案）。
4. **不**设置 `terminal = done`；进入 `for` 的下一 `round`。
5. UI：**不**把续写 user 展示为用户气泡（不发 `user_message` / 不 post 用户 message）；时间线可仅见 info 提示。占位 `[输出中断]` 可记入 api 历史，webview 可不单独渲染为蓝框（实现时与空 text 气泡策略对齐即可）。

### 6.1 续轮上限

- 每个用户发起的一次 `send` 内，因本机制触发的自动续轮最多 **N = 8** 次。
- 触顶：`terminal = { type: "error", message: "连续输出超限次数过多" }`（或等价 i18n），结束 busy。
- **不**因此限制正常 tool 轮次；现有 `maxRounds` 不变。

### 6.2 续写 = 新消息

截断得到的 thinking/text **只 push 一次**为最终形态。后续轮次模型产出为**新的** assistant 消息，禁止原地拼接/改写上一轮 thinking 块（规则 3/6）。

## 7. 缓存前缀稳定性（硬约束）

对照 `.dsb/rules/cache-prefix-stability.md`：

| 规则 | 本设计做法 |
|------|------------|
| 1 system 稳定 | **不**往 system 塞续写/弱提示；续写只在 messages 尾部 |
| 2 工具 def 稳定 | 不改 tools |
| 3 只追加 | 仅 `push` assistant + 续写 user；不重写中部 |
| 4 压缩块 | 不改压缩块结构 |
| 5 不删中部已发送块 | 半截 tool 仅写前丢弃 |
| 6 一种字节形态 | 落盘前定型；续写文案常量 |

验收：影响 messages 构造的改动落地后跑 `python3 scripts/analyze-cache-prefix.py`（含 `--self-test`）；稳定期命中率不降为硬门槛（基线见架构文档 §5.1）。

## 8. 错误与边界

| 情况 | 行为 |
|------|------|
| max_tokens 且无完整 tool | 续轮 |
| 完整 tool（可含已丢半截） | 执行工具，不续轮 |
| 真 end_turn | done |
| 续轮次数 ≥ N | error，busy 结束 |
| 用户停止 | abort，不续轮 |
| 续轮中 provider 抛错 | 与现网一致（rollback / error） |

## 9. 测试计划

1. `max_tokens` + 仅 thinking → 不 `done`；尾部出现固定续写 user；再发起 round。
2. 半截 tool_use → 不执行、不落盘；thinking 落盘；续轮。
3. 完整 tool_use → 不续轮，照常执行。
4. 续轮达 N → error。
5. 断言 messages 只 append；续写文案为常量。
6. client：从 `message_delta` 解析 `stopReason === "max_tokens"`。

## 10. 改动文件（预计）

- `src/agent/provider/types.ts` — `stopReason`
- `src/agent/provider/anthropicMessagesClient.ts` — 解析停因
- `src/agent/agentLoop.ts` — 判定、写前丢弃、续轮、计数
- `tests/agentLoop*.ts`、`tests/anthropicMessagesClient.test.ts`
- 常量：续写文案可放 `agentLoop.ts` 或小模块（会话内不变）

## 11. 成功标准

复现「仅 thinking、out≈8192」类场景时：

- UI 不因误 `done` 回到空闲「发送」；
- 自动续轮并最终出现可执行 tool 或真正 `end_turn`；
- 半截 tool 从不被执行；
- 前缀分析脚本验收通过（不降稳定期命中率）。
