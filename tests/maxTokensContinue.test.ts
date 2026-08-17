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
