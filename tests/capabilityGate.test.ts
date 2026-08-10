import { describe, it, expect } from "vitest";
import { prepareRound, dynamicMaxTokens, stripThinkingBlocks, sanitizeOutbound } from "../src/agent/capabilityGate";
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
});
