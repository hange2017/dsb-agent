import { describe, it, expect } from "vitest";
import { TurnSummaryStats, cacheHitRate, repeatWasteRate } from "../src/agent/turnSummary";

describe("TurnSummaryStats", () => {
  it("aggregates one send (rounds / tools / repeats / compaction / recall / tokens / duration)", () => {
    const s = new TurnSummaryStats();
    expect(s.isActive()).toBe(false);
    s.begin("sess-1", 42, 1_000);
    expect(s.isActive()).toBe(true);

    s.recordChatRound({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 50, roundMs: 300 });
    s.recordChatRound({ inputTokens: 50, outputTokens: 10, cacheReadTokens: 950, roundMs: 200 });
    s.recordTool("Read", true);
    s.recordTool("Read", true);
    s.recordTool("Bash", false);
    s.recordRepeat({ isWaste: true, redundantTokens: 120 });
    s.recordRepeat({ isWaste: false, redundantTokens: 30 });
    s.recordCompaction();
    s.recordCompaction();
    s.recordContextRecall();
    s.recordAppend();
    s.recordAppend(2);

    const sum = s.finish("done", 5_000);
    expect(sum.sessionId).toBe("sess-1");
    expect(sum.turnIndex).toBe(1);
    expect(sum.userTextLen).toBe(42);
    expect(sum.durationMs).toBe(4_000);
    expect(sum.rounds).toBe(2);
    expect(sum.toolCalls).toBe(3);
    expect(sum.toolErrors).toBe(1);
    expect(sum.distinctTools).toBe(2); // Read + Bash
    expect(sum.toolRepeatCount).toBe(2);
    expect(sum.toolRepeatWasteCount).toBe(1);
    expect(sum.redundantTokens).toBe(150);
    expect(sum.compactionCount).toBe(2);
    expect(sum.contextRecallCalls).toBe(1);
    expect(sum.appends).toBe(3);
    expect(sum.inputTokens).toBe(150);
    expect(sum.outputTokens).toBe(30);
    expect(sum.cacheReadTokens).toBe(1_850);
    expect(sum.cacheWriteTokens).toBe(50);
    expect(sum.chatMs).toBe(500);
    expect(sum.endReason).toBe("done");
    expect(s.isActive()).toBe(false);
  });

  it("increments turnIndex per begin and resets per-turn counters", () => {
    const s = new TurnSummaryStats();
    s.begin("s", 1, 0);
    s.recordTool("Read", true);
    const first = s.finish("done", 10);
    expect(first.turnIndex).toBe(1);
    expect(first.toolCalls).toBe(1);

    s.begin("s", 2, 20);
    expect(s.isActive()).toBe(true);
    const second = s.finish("error", 30);
    expect(second.turnIndex).toBe(2);
    expect(second.toolCalls).toBe(0); // 已重置,不继承上一轮
    expect(second.rounds).toBe(0);
    expect(second.endReason).toBe("error");
    expect(second.durationMs).toBe(10);
    expect(s.turnCount).toBe(2);
  });

  it("finish is idempotent: first endReason/endedAt win", () => {
    const s = new TurnSummaryStats();
    s.begin("s", 5, 100);
    const a = s.finish("maxRounds", 900);
    const b = s.finish("done", 9_999);
    expect(a.endReason).toBe("maxRounds");
    expect(b.endReason).toBe("maxRounds");
    expect(b.durationMs).toBe(800); // 不被第二次 endedAt 改写
  });

  it("never reports negative duration when end precedes start", () => {
    const s = new TurnSummaryStats();
    s.begin("s", 5, 5_000);
    const sum = s.finish("aborted", 1_000);
    expect(sum.durationMs).toBe(0);
  });

  it("defaults to zero rounds/tools when nothing was recorded", () => {
    const s = new TurnSummaryStats();
    s.begin("s", 0, 0);
    const sum = s.finish("done", 0);
    expect(sum.rounds).toBe(0);
    expect(sum.toolCalls).toBe(0);
    expect(sum.distinctTools).toBe(0);
    expect(sum.redundantTokens).toBe(0);
    expect(sum.endReason).toBe("done");
  });
});

describe("cacheHitRate (authoritative formula)", () => {
  it("uses cacheRead / (cacheRead + input), matching analyze-cache-prefix.py", () => {
    expect(cacheHitRate({ cacheReadTokens: 900, inputTokens: 100 })).toBeCloseTo(0.9, 6);
    expect(cacheHitRate({ cacheReadTokens: 0, inputTokens: 100 })).toBe(0);
    expect(cacheHitRate({ cacheReadTokens: 100, inputTokens: 0 })).toBe(1);
  });

  it("returns undefined when there is no usage (denominator 0)", () => {
    expect(cacheHitRate({ cacheReadTokens: 0, inputTokens: 0 })).toBeUndefined();
  });
});

describe("repeatWasteRate", () => {
  it("divides waste repeats by tool calls", () => {
    expect(repeatWasteRate({ toolRepeatWasteCount: 2, toolCalls: 8 })).toBeCloseTo(0.25, 6);
  });

  it("returns undefined when no tool calls happened", () => {
    expect(repeatWasteRate({ toolRepeatWasteCount: 0, toolCalls: 0 })).toBeUndefined();
  });
});
