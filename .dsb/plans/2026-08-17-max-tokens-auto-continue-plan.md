# max_tokens 自动续轮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 单轮输出因 `max_tokens` 截断且无完整 tool_use 时，引擎自动续轮（保持 busy），半截 tool 写前丢弃，不误判 `done`。

**Architecture:** Provider 解析并透出 `stopReason`；纯函数判定是否续轮；`agentLoop` 在写前过滤半截 tool、push 定型 assistant + 固定续写 user（不发 `user_message`）、计数上限 8；全程只 append messages，不改 system。

**Tech Stack:** TypeScript、Vitest、现有 `AnthropicMessagesClient` / `AgentSession`

**Spec:** `.dsb/specs/2026-08-17-max-tokens-auto-continue-design.md`

## Global Constraints

- 遵守 `.dsb/rules/cache-prefix-stability.md`：messages 只 push；半截 tool 写前丢弃；续写文案常量；**禁止**改 system。
- 续写 user 规范常量（一字不差）：
  `[续写] 上一轮输出因长度上限中断。请从中断处继续；需要改文件或执行命令时直接发起完整工具调用，不要重复已完成的步骤。`
- 空 assistant 占位文本常量：`[输出中断]`
- info 文案：`输出达上限,继续…`
- 单次 `send` 内自动续轮上限：`N = 8`
- 不限制日常 tool 次数；不改默认 `kDefaultMaxOutputTokens=8192`
- 改变「无 content_block_stop 仍 flush 进 toolUses」的旧行为：半截 tool **不得**进入 `toolUses` / 落盘 `blocks`（与 spec 策略 A 对齐；旧测试须改写）

## File Structure

| 文件 | 职责 |
|------|------|
| `src/agent/maxTokensContinue.ts` | 常量 + `normalizeStopReason` + `needsMaxTokensContinue`（纯函数，易测） |
| `src/agent/provider/types.ts` | `ProviderRoundResult.stopReason?`；`ProviderStopReason` 类型 |
| `src/agent/provider/anthropicMessagesClient.ts` | 解析 `delta.stop_reason`；只保留完整 tool_use |
| `src/agent/agentLoop.ts` | 接入判定、续轮、计数；不发 `user_message` |
| `tests/maxTokensContinue.test.ts` | 纯函数单测 |
| `tests/anthropicMessagesClient.test.ts` | stopReason + 半截 tool 丢弃 |
| `tests/agentLoop.test.ts` | 续轮 / 上限 / 不 done / 无 user_message |

---

### Task 1: 纯函数模块 `maxTokensContinue.ts`

**Files:**
- Create: `src/agent/maxTokensContinue.ts`
- Test: `tests/maxTokensContinue.test.ts`

**Interfaces:**
- Produces:
  - `export type ProviderStopReason = "end_turn" | "tool_use" | "max_tokens" | "other"`
  - `export const kMaxTokensContinueUserText: string`（规范常量）
  - `export const kMaxTokensInterruptedAssistantText = "[输出中断]"`
  - `export const kMaxTokensContinueInfoText = "输出达上限,继续…"`
  - `export const kMaxTokensContinueLimit = 8`
  - `export function normalizeStopReason(raw: unknown): ProviderStopReason | undefined`
  - `export function needsMaxTokensContinue(input: { stopReason?: ProviderStopReason; outputTokens?: number; maxTokens: number; completeToolUseCount: number }): boolean`

- [ ] **Step 1: Write the failing test**

创建 `tests/maxTokensContinue.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  kMaxTokensContinueUserText,
  kMaxTokensInterruptedAssistantText,
  kMaxTokensContinueInfoText,
  kMaxTokensContinueLimit,
  normalizeStopReason,
  needsMaxTokensContinue,
} from "../src/agent/maxTokensContinue";

describe("maxTokensContinue", () => {
  it("exports the exact continue user text from the spec", () => {
    expect(kMaxTokensContinueUserText).toBe(
      "[续写] 上一轮输出因长度上限中断。请从中断处继续；需要改文件或执行命令时直接发起完整工具调用，不要重复已完成的步骤。",
    );
    expect(kMaxTokensInterruptedAssistantText).toBe("[输出中断]");
    expect(kMaxTokensContinueInfoText).toBe("输出达上限,继续…");
    expect(kMaxTokensContinueLimit).toBe(8);
  });

  it("normalizeStopReason maps known strings", () => {
    expect(normalizeStopReason("max_tokens")).toBe("max_tokens");
    expect(normalizeStopReason("end_turn")).toBe("end_turn");
    expect(normalizeStopReason("tool_use")).toBe("tool_use");
    expect(normalizeStopReason("length")).toBe("max_tokens"); // OpenAI 风格兜底
    expect(normalizeStopReason("nope")).toBe("other");
    expect(normalizeStopReason(undefined)).toBeUndefined();
  });

  it("needsMaxTokensContinue: max_tokens + no tools → true", () => {
    expect(
      needsMaxTokensContinue({
        stopReason: "max_tokens",
        outputTokens: 100,
        maxTokens: 8192,
        completeToolUseCount: 0,
      }),
    ).toBe(true);
  });

  it("needsMaxTokensContinue: has complete tools → false", () => {
    expect(
      needsMaxTokensContinue({
        stopReason: "max_tokens",
        outputTokens: 8192,
        maxTokens: 8192,
        completeToolUseCount: 1,
      }),
    ).toBe(false);
  });

  it("needsMaxTokensContinue: end_turn near cap → false", () => {
    expect(
      needsMaxTokensContinue({
        stopReason: "end_turn",
        outputTokens: 8192,
        maxTokens: 8192,
        completeToolUseCount: 0,
      }),
    ).toBe(false);
  });

  it("needsMaxTokensContinue: tool_use stop → false", () => {
    expect(
      needsMaxTokensContinue({
        stopReason: "tool_use",
        outputTokens: 500,
        maxTokens: 8192,
        completeToolUseCount: 0,
      }),
    ).toBe(false);
  });

  it("needsMaxTokensContinue: undefined/other + ≥98% output → true", () => {
    expect(
      needsMaxTokensContinue({
        stopReason: undefined,
        outputTokens: 8030,
        maxTokens: 8192,
        completeToolUseCount: 0,
      }),
    ).toBe(true);
    expect(
      needsMaxTokensContinue({
        stopReason: "other",
        outputTokens: Math.floor(8192 * 0.98),
        maxTokens: 8192,
        completeToolUseCount: 0,
      }),
    ).toBe(true);
  });

  it("needsMaxTokensContinue: undefined + low output → false", () => {
    expect(
      needsMaxTokensContinue({
        stopReason: undefined,
        outputTokens: 100,
        maxTokens: 8192,
        completeToolUseCount: 0,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/maxTokensContinue.test.ts`

Expected: FAIL（模块不存在）

- [ ] **Step 3: Write minimal implementation**

Create `src/agent/maxTokensContinue.ts`:

```ts
export type ProviderStopReason = "end_turn" | "tool_use" | "max_tokens" | "other";

export const kMaxTokensContinueUserText =
  "[续写] 上一轮输出因长度上限中断。请从中断处继续；需要改文件或执行命令时直接发起完整工具调用，不要重复已完成的步骤。";

export const kMaxTokensInterruptedAssistantText = "[输出中断]";

export const kMaxTokensContinueInfoText = "输出达上限,继续…";

export const kMaxTokensContinueLimit = 8;

export function normalizeStopReason(raw: unknown): ProviderStopReason | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") return "other";
  if (raw === "end_turn" || raw === "tool_use" || raw === "max_tokens") return raw;
  if (raw === "length") return "max_tokens";
  return "other";
}

export function needsMaxTokensContinue(input: {
  stopReason?: ProviderStopReason;
  outputTokens?: number;
  maxTokens: number;
  completeToolUseCount: number;
}): boolean {
  if (input.completeToolUseCount > 0) return false;
  if (input.stopReason === "end_turn" || input.stopReason === "tool_use") return false;
  if (input.stopReason === "max_tokens") return true;
  if (input.stopReason === undefined || input.stopReason === "other") {
    const out = input.outputTokens ?? 0;
    const cap = Math.max(1, input.maxTokens);
    return out >= Math.floor(cap * 0.98);
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/maxTokensContinue.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**（若用户要求提交；否则跳过，工作区保留改动）

```bash
git add src/agent/maxTokensContinue.ts tests/maxTokensContinue.test.ts
git commit -m "$(cat <<'EOF'
feat: add max_tokens continue pure helpers

EOF
)"
```

---

### Task 2: ProviderRoundResult.stopReason + client 解析与半截 tool 丢弃

**Files:**
- Modify: `src/agent/provider/types.ts`
- Modify: `src/agent/provider/anthropicMessagesClient.ts`
- Test: `tests/anthropicMessagesClient.test.ts`

**Interfaces:**
- Consumes: `normalizeStopReason` from `../maxTokensContinue`（或在 types 复用同名 union；推荐 types 里定义 `ProviderStopReason` 并从 maxTokensContinue re-export / 或 types 为权威、maxTokensContinue import 自 types——**采用：类型放 `provider/types.ts`，`maxTokensContinue.ts` 从 types import `ProviderStopReason`，Task 1 实现时若已本地定义则本任务改为 types 权威并改 import**）
- Produces: `ProviderRoundResult.stopReason?: ProviderStopReason`

**类型放置（锁定）：**
1. 在 `src/agent/provider/types.ts` 增加 `export type ProviderStopReason = ...` 与 `stopReason?` 字段。
2. 改 `maxTokensContinue.ts`：删除本地 type，改为 `import type { ProviderStopReason } from "./provider/types"` 并 re-export。
3. 更新 `tests/maxTokensContinue.test.ts` 若需。

- [ ] **Step 1: Write the failing tests**（追加到 `tests/anthropicMessagesClient.test.ts`）

```ts
  it("parses stop_reason max_tokens from message_delta.delta", async () => {
    const stream = sseBody([
      ["content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "long…" } }],
      ["content_block_stop", { index: 0 }],
      [
        "message_delta",
        {
          delta: { stop_reason: "max_tokens", stop_sequence: null },
          usage: { input_tokens: 10, output_tokens: 8192 },
        },
      ],
    ]);
    const client = new AnthropicMessagesClient({
      apiKey: "sk-test",
      baseUrl: "https://x",
      model: "m",
      fetchImpl: makeFetch(200, stream),
    });
    const result = await client.round([{ role: "user", content: "hi" }], { system: "s", tools: TOOLS }, () => {});
    expect(result.stopReason).toBe("max_tokens");
    expect(result.usage?.outputTokens).toBe(8192);
  });

  it("drops incomplete tool_use (no content_block_stop) from blocks and toolUses", async () => {
    const stream = sseBody([
      ["content_block_start", { index: 0, content_block: { type: "thinking", thinking: "x" } }],
      ["content_block_stop", { index: 0 }],
      ["content_block_start", { index: 1, content_block: { type: "tool_use", id: "t3", name: "Read", input: {} } }],
      ["content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"c" } }],
      // 无 content_block_stop → 半截
      ["message_delta", { delta: { stop_reason: "max_tokens" }, usage: { input_tokens: 1, output_tokens: 8192 } }],
    ]);
    const client = new AnthropicMessagesClient({
      apiKey: "sk-test",
      baseUrl: "https://x",
      model: "m",
      fetchImpl: makeFetch(200, stream),
    });
    const result = await client.round([{ role: "user", content: "read" }], { system: "s", tools: TOOLS }, () => {});
    expect(result.toolUses).toEqual([]);
    expect(result.blocks.every((b) => b.type !== "tool_use")).toBe(true);
    expect(result.blocks.some((b) => b.type === "thinking")).toBe(true);
    expect(result.stopReason).toBe("max_tokens");
  });
```

并把旧测试 `flushes tool_use into toolUses when content_block_stop is missing` **改写为**与上相同语义（标题改为 `drops incomplete tool_use when content_block_stop is missing`），断言 `toolUses=[]` 且 blocks 无该 tool_use。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/anthropicMessagesClient.test.ts -t "stop_reason|incomplete|content_block_stop is missing"`

Expected: FAIL（无 stopReason / 旧 flush 行为）

- [ ] **Step 3: Implement**

`types.ts` — 在 `ProviderRoundResult` 增加：

```ts
export type ProviderStopReason = "end_turn" | "tool_use" | "max_tokens" | "other";

export type ProviderRoundResult = {
  blocks: ProviderBlock[];
  toolUses: ProviderToolUse[];
  usage?: { ... unchanged ... };
  stopReason?: ProviderStopReason;
};
```

`anthropicMessagesClient.ts`：

1. `import { normalizeStopReason } from "../maxTokensContinue"`
2. `let stopReason: ProviderStopReason | undefined`
3. `message_delta` 分支扩展：

```ts
case "message_delta": {
  const md = data as {
    delta?: { stop_reason?: string | null };
    usage?: { ... };
  };
  if (md.delta?.stop_reason != null) {
    stopReason = normalizeStopReason(md.delta.stop_reason);
  }
  // usage 解析保持原样
  break;
}
```

4. **删除**「流结束把未 stop 的 tool_use flush 进 toolUses」循环；改为：
   - 用 `Set<number>` 记录在 `content_block_stop` 里成功关闭的 tool_use index（仅当 JSON 解析成功或 raw 为空且沿用 start input 对象时算完整——与现 stop 分支一致：只有走完 stop 才入 `toolUses`）。
   - `denseBlocks` 时：**过滤掉**未进入 `toolUses` 的 `type==="tool_use"` 块（半截丢弃）；thinking/text 保留。
5. `return { blocks: denseBlocks, toolUses, usage, ...(stopReason ? { stopReason } : {}) }`

注意：`content_block_stop` 现有逻辑已 `toolUses.push`；半截从未 push → 从 blocks 剔除即可。不要再补 flush。

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/anthropicMessagesClient.test.ts tests/maxTokensContinue.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**（用户要求时）

```bash
git add src/agent/provider/types.ts src/agent/provider/anthropicMessagesClient.ts src/agent/maxTokensContinue.ts tests/anthropicMessagesClient.test.ts tests/maxTokensContinue.test.ts
git commit -m "$(cat <<'EOF'
feat: parse stop_reason and drop incomplete tool_use blocks

EOF
)"
```

---

### Task 3: AgentSession 自动续轮（核心）

**Files:**
- Modify: `src/agent/agentLoop.ts`（`send` 主循环内 `toolUses.length === 0` 分支附近，约 723–733 行及前后）
- Test: `tests/agentLoop.test.ts`

**Interfaces:**
- Consumes: `needsMaxTokensContinue`, `kMaxTokensContinueUserText`, `kMaxTokensInterruptedAssistantText`, `kMaxTokensContinueInfoText`, `kMaxTokensContinueLimit` from `./maxTokensContinue`
- Produces: 行为变更——截断时不 `done`，push 续写 user，再 round；不发 `user_message`

- [ ] **Step 1: Write the failing tests**（追加 `tests/agentLoop.test.ts`）

```ts
  it("max_tokens with thinking only auto-continues instead of done", async () => {
    let round = 0;
    const calls: ProviderMessage[][] = [];
    const provider: ProviderClient = {
      capabilities: { supportsVision: true, supportsThinking: true, maxOutputTokens: 8192 },
      async round(messages, opts): Promise<ProviderRoundResult> {
        calls.push(JSON.parse(JSON.stringify(messages)));
        if (round === 0) {
          round++;
          return {
            blocks: [{ type: "thinking", thinking: "planning Task 9…" }],
            toolUses: [],
            stopReason: "max_tokens",
            usage: { inputTokens: 100, outputTokens: 8192 },
          };
        }
        round++;
        return {
          blocks: [{ type: "text", text: "ok" }],
          toolUses: [],
          stopReason: "end_turn",
          usage: { inputTokens: 120, outputTokens: 10 },
        };
      },
    };
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
    });
    const events: Array<{ type: string; text?: string }> = [];
    await session.send("继续", (ev) => {
      if (ev.type === "info" || ev.type === "user_message" || ev.type === "done" || ev.type === "error") {
        events.push({ type: ev.type, text: "text" in ev ? (ev as { text?: string }).text : "message" in ev ? (ev as { message?: string }).message : undefined });
      } else {
        events.push({ type: ev.type });
      }
    });
    expect(calls.length).toBe(2);
    const mid = calls[1];
    expect(mid[mid.length - 1]).toEqual({
      role: "user",
      content:
        "[续写] 上一轮输出因长度上限中断。请从中断处继续；需要改文件或执行命令时直接发起完整工具调用，不要重复已完成的步骤。",
    });
    // 续写不对 UI 发 user_message
    expect(events.filter((e) => e.type === "user_message")).toEqual([]);
    expect(events.some((e) => e.type === "info" && e.text === "输出达上限,继续…")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("max_tokens continue hits limit then errors", async () => {
    const provider: ProviderClient = {
      capabilities: { supportsVision: true, supportsThinking: true, maxOutputTokens: 100 },
      async round(): Promise<ProviderRoundResult> {
        return {
          blocks: [{ type: "thinking", thinking: "still…" }],
          toolUses: [],
          stopReason: "max_tokens",
          usage: { inputTokens: 1, outputTokens: 100 },
        };
      },
    };
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
    });
    const events: string[] = [];
    await session.send("go", (ev) => events.push(ev.type));
    expect(events).toContain("error");
    expect(events).not.toContain("done");
  });

  it("complete tool_use does not auto-continue even if stopReason max_tokens", async () => {
    const bash = vi.fn(() => ({ ok: true, content: "ok" }));
    let rounds = 0;
    const provider: ProviderClient = {
      capabilities: { supportsVision: true, supportsThinking: true, maxOutputTokens: 8192 },
      async round(): Promise<ProviderRoundResult> {
        rounds++;
        if (rounds === 1) {
          return {
            blocks: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi" } }],
            toolUses: [{ id: "t1", name: "Bash", input: { command: "echo hi" } }],
            stopReason: "max_tokens",
            usage: { inputTokens: 1, outputTokens: 8192 },
          };
        }
        return { blocks: [{ type: "text", text: "done" }], toolUses: [], stopReason: "end_turn" };
      },
    };
    const session = new AgentSession({
      provider,
      tools: fakeTools({ Bash: bash }).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
    });
    await session.send("run", () => {});
    expect(bash).toHaveBeenCalled();
    expect(rounds).toBe(2);
  });
```

（第三个测试：第一轮有完整 tool → 执行 → 第二轮 end_turn；`rounds===2` 来自 tool 后的正常下一轮，不是续写 user。断言第二轮 messages **末尾不是**续写常量。）

在第三个测试里加强：

```ts
    const calls: ProviderMessage[][] = [];
    // 在 round 内 calls.push(messages)
    // ...
    expect(calls[1][calls[1].length - 1]).not.toEqual({
      role: "user",
      content: "[续写] 上一轮输出因长度上限中断。请从中断处继续；需要改文件或执行命令时直接发起完整工具调用，不要重复已完成的步骤。",
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agentLoop.test.ts -t "max_tokens"`

Expected: FAIL（立刻 done / 无续写）

- [ ] **Step 3: Implement in `agentLoop.ts`**

在 `send()` 循环顶部（`for (let round = 0; ...)` 前）增加：

```ts
let maxTokensContinueCount = 0;
```

在拿到 `result` 后，已有 `assistantBlocks` / `toolUses` / `persistBlocks` 构建逻辑**之后**，替换：

```ts
if (persistBlocks.length === 0) {
  terminal = { type: "done" };
  return;
}
this.messages.push({ role: "assistant", content: persistBlocks });

if (toolUses.length === 0) {
  terminal = { type: "done" };
  return;
}
```

为类似逻辑（保持 thinkingProcessEnabled 剥离等既有行为）：

```ts
import {
  needsMaxTokensContinue,
  kMaxTokensContinueUserText,
  kMaxTokensInterruptedAssistantText,
  kMaxTokensContinueInfoText,
  kMaxTokensContinueLimit,
} from "./maxTokensContinue";

// ... after building persistBlocks & toolUses from result ...

const completeToolUseCount = toolUses.length;
const shouldContinue = needsMaxTokensContinue({
  stopReason: result.stopReason,
  outputTokens: result.usage?.outputTokens,
  maxTokens: prepared.maxTokens, // 本轮 prepareRound 的 maxTokens；若作用域不够，在 round 内保存 const roundMaxTokens = prepared.maxTokens
  completeToolUseCount,
});

if (persistBlocks.length === 0 && !shouldContinue) {
  terminal = { type: "done" };
  return;
}

const assistantContent =
  persistBlocks.length > 0
    ? persistBlocks
    : [{ type: "text" as const, text: kMaxTokensInterruptedAssistantText }];

this.messages.push({ role: "assistant", content: assistantContent });

if (completeToolUseCount === 0) {
  if (shouldContinue) {
    if (maxTokensContinueCount >= kMaxTokensContinueLimit) {
      terminal = { type: "error", message: "连续输出超限次数过多" };
      return;
    }
    maxTokensContinueCount += 1;
    this.messages.push({ role: "user", content: kMaxTokensContinueUserText });
    // 不 onEvent user_message（避免假用户气泡）
    onEvent({ type: "info", text: kMaxTokensContinueInfoText });
    continue; // 下一 for round
  }
  terminal = { type: "done" };
  return;
}

// 否则走现有 tool 执行批处理...
```

**作用域注意：** `prepared` 目前在 `try` 内；把 `prepared.maxTokens` 赋给 `roundMaxTokens` 供后面使用。

**记录：** `this.record` 对续写 user —— 可选不写 UI jsonl 用户气泡；若 `record` 会进会话时间线，则**不要** `record({ kind: "user", text: kMaxTokensContinueUserText })`，或 record 但不 post。与 spec「不展示用户气泡」一致：跳过 record 或只记 api 历史（`messages` 已含）。推荐：**不**调用 `this.record` 写续写 user（api 侧靠 `persistNow` 的 messages）。

占位 `[输出中断]`：可 `record({ kind: "assistant", text: "...", final: false })` 或跳过以减少噪点；优先跳过 UI record，仅 messages 落盘。

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/agentLoop.test.ts tests/maxTokensContinue.test.ts tests/anthropicMessagesClient.test.ts`

Expected: PASS；既有 `finishes immediately when no tool use` 仍 PASS（无 stopReason、低 output → done）

- [ ] **Step 5: Commit**（用户要求时）

```bash
git add src/agent/agentLoop.ts tests/agentLoop.test.ts
git commit -m "$(cat <<'EOF'
feat: auto-continue agent loop on max_tokens truncation

EOF
)"
```

---

### Task 4: 全量验证 + 前缀脚本自检

**Files:** 无新文件（或更新 spec 状态一行）

- [ ] **Step 1: 全量测试**

Run: `npx vitest run`

Expected: PASS（若有无关失败，仅修本功能引入的）

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`

Expected: 无 error

- [ ] **Step 3: 前缀分析自检**

Run: `python3 scripts/analyze-cache-prefix.py --self-test`

Expected: self-test 通过

（有真实 stats 样本时再跑命中率对比；本任务不强制改基线文档）

- [ ] **Step 4: 更新 spec 状态**

在 `.dsb/specs/2026-08-17-max-tokens-auto-continue-design.md` 头部将状态改为：`定稿（已实现）` 或 `定稿（实现中）`（按是否全部完成）。

- [ ] **Step 5: Commit**（用户要求时）

---

## Plan Self-Review

| Spec 条目 | 对应 Task |
|-----------|-----------|
| stopReason 透出 | Task 2 |
| needsContinue 判定（含 98% 兜底、end_turn 不续） | Task 1 + 3 |
| 半截 tool 写前丢弃 | Task 2（client）+ Task 3（只信 complete toolUses） |
| 固定续写 user / 占位 assistant / info | Task 1 常量 + Task 3 |
| 不发 user_message | Task 3 测试断言 |
| 续轮上限 8 → error | Task 3 |
| 有完整 tool 不续轮 | Task 3 |
| 不改 system / 前缀规则 | Global Constraints + Task 4 self-test |
| 不改默认 8192 | 无任务改 profiles |

无 TBD/TODO 占位；类型名 `ProviderStopReason` 以 `provider/types.ts` 为权威。
