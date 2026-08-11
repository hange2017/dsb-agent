import { describe, it, expect } from "vitest";
import {
  prepareRound,
  dynamicMaxTokens,
  sanitizeOutbound,
  repairToolUseResultPairs,
} from "../src/agent/capabilityGate";
import type { ProviderMessage } from "../src/agent/provider/types";

describe("dynamicMaxTokens", () => {
  it("equals cap when plenty of room", () => {
    expect(
      dynamicMaxTokens({ windowTokens: 100_000, lastInputTokens: 1_000, maxOutputTokens: 8192 }),
    ).toBe(8192);
  });

  it("shrinks when remaining is small", () => {
    // window 10000, last 9000, reserve min(1024,100)=100 → remaining-reserve=900
    expect(
      dynamicMaxTokens({ windowTokens: 10_000, lastInputTokens: 9_000, maxOutputTokens: 8192 }),
    ).toBe(900);
  });

  it("never goes below 1", () => {
    expect(
      dynamicMaxTokens({ windowTokens: 100, lastInputTokens: 200, maxOutputTokens: 8192 }),
    ).toBe(1);
  });
});

describe("prepareRound", () => {
  it("strips thinking when unsupported and exposes parallel defaults", () => {
    const messages: ProviderMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "x" },
          { type: "text", text: "hi" },
        ],
      },
    ];
    const out = prepareRound({
      caps: { supportsVision: false, supportsThinking: false, maxOutputTokens: 4096 },
      messages,
    });
    expect(out.outbound[0]).toEqual({ role: "assistant", content: [{ type: "text", text: "hi" }] });
    expect(out.maxTokens).toBe(4096);
    expect(out.maxParallelTools).toBe(8);
    expect(out.toolParallelMode).toBe("read_safe");
  });

  it("passes budget and respects parallel caps", () => {
    const out = prepareRound({
      caps: {
        supportsVision: true,
        supportsThinking: true,
        thinkingBudgetTokens: 2048,
        maxParallelTools: 2,
        toolParallelMode: "serial",
        contextWindowTokens: 50_000,
        maxOutputTokens: 8192,
      },
      messages: [{ role: "user", content: "a" }],
      lastInputTokens: 49_000,
    });
    expect(out.thinkingBudgetTokens).toBe(2048);
    expect(out.maxParallelTools).toBe(2);
    expect(out.toolParallelMode).toBe("serial");
    expect(out.maxTokens).toBeLessThan(8192);
  });

  it("derives thinkingBudgetTokens from thinkingLevel when not explicit", () => {
    const out = prepareRound({
      caps: { supportsVision: true, supportsThinking: true, thinkingLevel: "high" },
      messages: [{ role: "user", content: "a" }],
      lastInputTokens: 100,
    });
    expect(out.thinkingBudgetTokens).toBe(16384);
  });

  it("explicit thinkingBudgetTokens wins over thinkingLevel", () => {
    const out = prepareRound({
      caps: { supportsVision: true, supportsThinking: true, thinkingBudgetTokens: 2048, thinkingLevel: "low" },
      messages: [{ role: "user", content: "a" }],
      lastInputTokens: 100,
    });
    expect(out.thinkingBudgetTokens).toBe(2048);
  });
});

describe("sanitizeOutbound", () => {
  it("strips historical images when vision unsupported", () => {
    const messages: ProviderMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
          { type: "text", text: "see" },
        ],
      },
    ];
    expect(sanitizeOutbound({ supportsVision: false, supportsThinking: true }, messages)).toEqual([
      { role: "user", content: "see" },
    ]);
  });

  it("repairs orphan tool_use before send (API 400: tool_use without tool_result immediately after)", () => {
    const messages: ProviderMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_00_orphan", name: "Read", input: { path: "a.ts" } }],
      },
      { role: "user", content: "继续" }, // 紧随其后的是普通文本,不是 tool_result
    ];
    const out = sanitizeOutbound({ supportsVision: true, supportsThinking: true }, messages);
    expect(out).toHaveLength(4);
    expect(out[2]).toMatchObject({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_00_orphan",
        },
      ],
    });
    expect(out[3]).toEqual({ role: "user", content: "继续" });
  });
});

describe("repairToolUseResultPairs", () => {
  it("leaves valid tool_use/tool_result pairs unchanged", () => {
    const messages: ProviderMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: {} },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a" }] },
          { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "b" }] },
        ],
      },
    ];
    expect(repairToolUseResultPairs(messages)).toEqual(messages);
  });

  it("appends synthetic tool_result when history ends on orphan tool_use", () => {
    const messages: ProviderMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t9", name: "Read", input: { path: "z" } }],
      },
    ];
    const out = repairToolUseResultPairs(messages);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t9" }],
    });
  });

  it("fills missing tool_result ids into the following tool_result user message", () => {
    const messages: ProviderMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: {} },
          { type: "tool_use", id: "t2", name: "Read", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "only t1" }] }],
      },
    ];
    const out = repairToolUseResultPairs(messages);
    expect(out).toHaveLength(2);
    const results = (out[1].content as Array<{ type: string; tool_use_id: string }>).filter(
      (b) => b.type === "tool_result",
    );
    expect(results.map((r) => r.tool_use_id).sort()).toEqual(["t1", "t2"]);
  });

  it("splits mixed tool_result+text user so tool_use is followed by pure tool_result only", () => {
    // injectTodo 曾把清单 text 前置进 tool_result 消息 → DeepSeek 报 400
    const messages: ProviderMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_00_Brz", name: "Bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "## 任务清单\n- [ ] a" },
          { type: "tool_result", tool_use_id: "call_00_Brz", content: [{ type: "text", text: "ok" }] },
        ],
      },
    ];
    const out = repairToolUseResultPairs(messages);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_00_Brz", content: [{ type: "text", text: "ok" }] }],
    });
    expect(out[2]).toEqual({
      role: "user",
      content: "## 任务清单\n- [ ] a",
    });
  });
});
