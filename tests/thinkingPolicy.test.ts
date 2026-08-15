import { describe, it, expect } from "vitest";
import {
  findConsumedThinking,
  planThinkingTrim,
  THINKING_TAIL_CHARS,
  THINKING_TRIM_MARKER,
  THINKING_OLD_MARKER,
  THINKING_KEEP_RECENT_COUNT,
  buildThinkingArchiveChunk,
  withRecallMarker,
} from "../src/agent/thinkingPolicy";
import type { ProviderMessage } from "../src/agent/provider/types";

const thinkingBlock = (id: number, thinking: string): ProviderMessage => ({
  role: "assistant",
  content: [{ type: "thinking", thinking }, { type: "text", text: `结论 ${id}` }],
});

function bigThinking(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `推理第 ${i} 行:` + "内容内容内容内容内容内容内容内容").join("\n");
}

describe("planThinkingTrim", () => {
  it("keeps small thinking", () => {
    expect(planThinkingTrim("短思考").action).toBe("keep");
    expect(planThinkingTrim("x".repeat(THINKING_TAIL_CHARS)).action).toBe("keep");
  });

  it("keeps empty thinking", () => {
    expect(planThinkingTrim("").action).toBe("keep");
    expect(planThinkingTrim("   ").action).toBe("keep");
  });

  it("trims big thinking keeping tail conclusion + marker", () => {
    const big = bigThinking(60); // ≈ 60 × 41 = 2460 字符 > 300
    const plan = planThinkingTrim(big);
    expect(plan.action).toBe("trim");
    expect(plan.trimmed).toContain(THINKING_TRIM_MARKER);
    // 保留的是尾部行(结论)
    expect(plan.trimmed).toContain("推理第 59 行");
    // 头部行被删除
    expect(plan.trimmed).not.toContain("推理第 0 行");
    // 长度显著变小且不超过阈值 + 标记行
    expect(plan.trimmed!.length).toBeLessThan(big.length / 4);
    expect(plan.trimmed!.length).toBeLessThan(THINKING_TAIL_CHARS + 100);
  });

  it("keeps full line integrity at tail boundary", () => {
    const big = bigThinking(60);
    const plan = planThinkingTrim(big);
    const lines = plan.trimmed!.split("\n");
    // 除标记行外,每行都是原 thinking 的完整行(无半行)
    for (const l of lines.slice(1)) {
      expect(l).toMatch(/^推理第 \d+ 行:/);
    }
  });
});

describe("findConsumedThinking", () => {
  it("finds thinking blocks in assistant messages followed by another assistant", () => {
    const msgs: ProviderMessage[] = [
      { role: "user", content: "需求" },
      thinkingBlock(1, "x".repeat(500)),
      { role: "user", content: "继续" },
      { role: "assistant", content: [{ type: "text", text: "第二轮" }] },
    ];
    expect(findConsumedThinking(msgs)).toEqual([{ index: 1, blockIndex: 0 }]);
  });

  it("keeps latest assistant thinking (no following assistant)", () => {
    const msgs: ProviderMessage[] = [
      { role: "user", content: "需求" },
      thinkingBlock(1, "x".repeat(500)),
    ];
    expect(findConsumedThinking(msgs)).toEqual([]);
  });

  it("does not count the same message as consumer", () => {
    const msgs: ProviderMessage[] = [
      thinkingBlock(1, "x".repeat(500)),
      { role: "user", content: "用户消息" },
      thinkingBlock(2, "y".repeat(500)),
    ];
    const found = findConsumedThinking(msgs);
    // index 0 之后有 assistant(index 2)→ 消费;index 2 之后无 assistant → 保留
    expect(found).toEqual([{ index: 0, blockIndex: 0 }]);
  });

  it("handles multiple thinking blocks in one message", () => {
    const msgs: ProviderMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "a".repeat(500) },
          { type: "text", text: "t" },
          { type: "thinking", thinking: "b".repeat(500) },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "下一轮" }] },
    ];
    const found = findConsumedThinking(msgs);
    expect(found).toEqual([
      { index: 0, blockIndex: 0 },
      { index: 0, blockIndex: 2 },
    ]);
  });
});

describe("planThinkingTrim v2: 条数上限(rank)", () => {
  it("old thinking (rank >= N) collapses to one-line conclusion even if short", () => {
    const plan = planThinkingTrim("第一行草稿\n第二行\n所以改用方案 B", THINKING_KEEP_RECENT_COUNT + 2);
    expect(plan.action).toBe("trim");
    expect(plan.trimmed).toContain("所以改用方案 B");
    expect(plan.trimmed).not.toContain("第一行草稿");
  });

  it("old thinking keeps newest-conclusion line + old marker", () => {
    const plan = planThinkingTrim("先试 A\nA 不行,换 B", THINKING_KEEP_RECENT_COUNT);
    expect(plan.action).toBe("trim");
    expect(plan.trimmed!.startsWith("[thinking-old:")).toBe(true);
    expect(plan.trimmed).toContain("A 不行,换 B");
  });

  it("recent thinking (rank < 3) short keeps as-is (decision safety)", () => {
    expect(planThinkingTrim("短思考", 2).action).toBe("keep");
  });

  it("recent thinking (rank < 3) big trims to tail conclusion", () => {
    const big = bigThinking(60);
    const plan = planThinkingTrim(big, 1);
    expect(plan.action).toBe("trim");
    expect(plan.trimmed).toContain(THINKING_TRIM_MARKER);
    expect(plan.trimmed).toContain("推理第 59 行");
  });

  it("rank boundary: rank === KEEP_RECENT_COUNT counts as old", () => {
    const plan = planThinkingTrim("旧草稿\n最终选择 C", THINKING_KEEP_RECENT_COUNT);
    expect(plan.action).toBe("trim");
    expect(plan.trimmed!.startsWith("[thinking-old:")).toBe(true);
  });

  it("old thinking with only blank lines keeps as-is", () => {
    expect(planThinkingTrim("  \n\n ", 5).action).toBe("keep");
  });

  it("P3: already-trimmed text (marker present) is idempotent, never re-trimmed", () => {
    // 写前定型后的 thinking 已含精简标记:后续兜底(无论 rank 新旧)必须 keep,
    // 否则「精简 → 再精简」两种字节形态会断裂缓存前缀。
    const alreadyTrimmed = `${THINKING_TRIM_MARKER}\n所以改用方案 B`;
    expect(planThinkingTrim(alreadyTrimmed, THINKING_KEEP_RECENT_COUNT + 2).action).toBe("keep");
    expect(planThinkingTrim(alreadyTrimmed, 0).action).toBe("keep");
    const alreadyOld = `${THINKING_OLD_MARKER}\n旧结论`;
    expect(planThinkingTrim(alreadyOld, THINKING_KEEP_RECENT_COUNT + 2).action).toBe("keep");
    expect(planThinkingTrim(alreadyOld, 0).action).toBe("keep");
    // 长文本一旦已标记也不会再被截断
    const bigTrimmed = `${THINKING_TRIM_MARKER}\n` + bigThinking(60);
    expect(planThinkingTrim(bigTrimmed, 1).action).toBe("keep");
    // 冷存储回查标记同样幂等
    expect(planThinkingTrim(`${THINKING_TRIM_MARKER}\n结论\n[r12]`, 0).action).toBe("keep");
  });
});

describe("thinking archive helpers", () => {
  it("buildThinkingArchiveChunk packs original text", () => {
    const c = buildThinkingArchiveChunk("推理原文很长");
    expect(c.type).toBe("thinking");
    expect(c.content).toBe("推理原文很长");
    expect(c.summary.length).toBeGreaterThan(0);
  });

  it("withRecallMarker appends [r{seq}] once", () => {
    expect(withRecallMarker("tail", 7)).toBe("tail\n[r7]");
    expect(withRecallMarker("tail\n[r7]", 7)).toBe("tail\n[r7]");
  });
});
