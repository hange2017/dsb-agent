import { describe, it, expect } from "vitest";
import {
  classifyAssistantText,
  summarizeToolUse,
  extractKeyLines,
  buildCompactedBlock,
  isCompactedBlock,
  parseCompactedBlock,
  mergeCompactedTracks,
  THINKING_COMPACTION_RULES,
  buildThinkingBlock,
  parseThinkingBlock,
  isThinkingBlock,
  mergeThinkingBlocks,
  estimateThinkingChars,
  trimThinkingBlock,
  type ThinkingBlockParts,
} from "../src/agent/contextCompactor";

describe("classifyAssistantText", () => {
  it("keeps short replies entirely as conclusion", () => {
    const r = classifyAssistantText("已完成,606 个测试全绿。", false);
    expect(r.conclusion.length).toBeGreaterThan(0);
    expect(r.explanation).toEqual([]);
  });

  it("keeps headings, lists, code and tables as conclusion", () => {
    const text = [
      "## 方案",
      "采用分轨压缩方案。",
      "",
      "- 优点:信息保留率高",
      "- 缺点:实现量大",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "| 项 | 值 |",
      "|---|----|",
      "| a | 1  |",
    ].join("\n");
    const r = classifyAssistantText(text, true);
    expect(r.conclusion.length).toBeGreaterThan(0);
    expect(r.explanation).toEqual([]);
  });

  it("splits a long reply: first/last paragraphs are conclusion, middle paragraphs are explanation", () => {
    const para = (n: string, len = 50) => `解释段落${n} ` + "原因分析".repeat(len);
    const text = ["开头结论段:我们决定采用方案 B。", para("A"), para("B"), "末尾总结段:因此分轨压缩是合适的。"].join("\n\n");
    const r = classifyAssistantText(text, true);
    expect(r.conclusion.some((c) => c.includes("开头结论段"))).toBe(true);
    expect(r.conclusion.some((c) => c.includes("末尾总结段"))).toBe(true);
    expect(r.explanation.some((e) => e.includes("解释段落A"))).toBe(true);
    expect(r.explanation.some((e) => e.includes("解释段落B"))).toBe(true);
  });

  it("treats a short no-tool reply wholly as conclusion even when long-ish", () => {
    const text = "方案:" + "A".repeat(200) + " 结论:选 A。";
    const r = classifyAssistantText(text, false);
    expect(r.explanation).toEqual([]);
  });
});

describe("summarizeToolUse", () => {
  it("maps file tools to path", () => {
    expect(summarizeToolUse("Read", { path: "src/a.ts" })).toBe("Read: src/a.ts");
    expect(summarizeToolUse("StrReplace", { path: "src/b.ts", old: "x", new: "y" })).toBe("StrReplace: src/b.ts");
  });
  it("truncates Bash command to 80 chars", () => {
    const cmd = "npm test " + "-".repeat(200);
    const s = summarizeToolUse("Bash", { command: cmd });
    expect(s).toMatch(/^Bash: npm test/);
    expect(s.length).toBeLessThanOrEqual(90);
  });
  it("maps search/query tools", () => {
    expect(summarizeToolUse("Grep", { pattern: "needsCompaction", path: "src" })).toBe("Grep: needsCompaction src");
    expect(summarizeToolUse("WebSearch", { query: "how to x" })).toBe("WebSearch: how to x");
  });
  it("maps agent/workflow to task/goal", () => {
    expect(summarizeToolUse("Agent", { task: "写测试" })).toBe("Agent: 写测试");
    expect(summarizeToolUse("Workflow", { goal: "优化" })).toBe("Workflow: 优化");
  });
  it("maps memory tools to name", () => {
    expect(summarizeToolUse("MemoryRead", { name: "foo" })).toBe("MemoryRead: foo");
  });
  it("falls back to keys for unknown tools", () => {
    expect(summarizeToolUse("FooTool", { a: 1, b: 2 })).toBe("FooTool: a,b");
  });
});

describe("extractKeyLines", () => {
  const short = ["ok", "done"].join("\n");
  it("returns short output as-is", () => {
    expect(extractKeyLines(short, true)).toBe(short);
  });
  const long = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
  it("keeps head 6 + tail 2 for long success output", () => {
    const out = extractKeyLines(long, true);
    expect(out).toContain("line0");
    expect(out).toContain("line5");
    expect(out).toContain("line28");
    expect(out).toContain("line29");
    expect(out).not.toContain("line10");
    expect(out).toContain("truncated");
  });
  it("keeps error lines for failed output", () => {
    const fail = ["line0", "ERROR: boom", "line2", "FAIL: nope"].join("\n");
    const out = extractKeyLines(fail, false);
    expect(out).toContain("ERROR: boom");
    expect(out).toContain("FAIL: nope");
  });
  it("truncates over-long lines", () => {
    const out = extractKeyLines("x".repeat(500), true);
    expect(out.length).toBeLessThanOrEqual(180);
  });
});

describe("buildCompactedBlock / isCompactedBlock", () => {
  it("builds structured block with all tracks", () => {
    const block = buildCompactedBlock({
      demands: ["- [r1] 用户需求原文"],
      conclusions: ["- [r3] 结论段"],
      explanations: ["- [r3] 解释摘要"],
      ledger: ["- [r2] Read: src/a.ts"],
    });
    expect(block.startsWith("[前文摘要]")).toBe(true);
    expect(block).toContain("[compacted]");
    expect(block).toContain("## 需求");
    expect(block).toContain("## 结论");
    expect(block).toContain("## 说明");
    expect(block).toContain("## 工具履历");
    expect(isCompactedBlock(block)).toBe(true);
  });
  it("omits empty tracks", () => {
    const block = buildCompactedBlock({ demands: [], conclusions: [], explanations: [], ledger: ["- [r2] Bash: npm test"] });
    expect(block).not.toContain("## 需求");
    expect(block).not.toContain("## 结论");
    expect(block).toContain("## 工具履历");
  });
  it("rejects plain text as compacted block", () => {
    expect(isCompactedBlock("普通文本")).toBe(false);
  });
});

describe("parseCompactedBlock / mergeCompactedTracks", () => {
  it("parses tracks back from a built block", () => {
    const block = buildCompactedBlock({
      demands: ["- [r1] 需求"],
      conclusions: ["- [r3] 结论"],
      explanations: ["- [r3] 解释摘要"],
      ledger: ["- [r2] Read: a.ts"],
    });
    const parsed = parseCompactedBlock(block);
    expect(parsed.demands).toEqual(["- [r1] 需求"]);
    expect(parsed.conclusions).toEqual(["- [r3] 结论"]);
    expect(parsed.explanations).toEqual(["- [r3] 解释摘要"]);
    expect(parsed.ledger).toEqual(["- [r2] Read: a.ts"]);
  });

  it("merge keeps order and dedupes identical lines", () => {
    const prev = { demands: ["- [r1] a"], conclusions: [], explanations: [], ledger: ["- [r2] x"] };
    const next = { demands: ["- [r1] a", "- [r5] b"], conclusions: [], explanations: [], ledger: [] };
    const merged = mergeCompactedTracks(prev, next);
    expect(merged.demands).toEqual(["- [r1] a", "- [r5] b"]);
    expect(merged.ledger).toEqual(["- [r2] x"]);
  });
});

describe("thinking block pure functions", () => {
  const sample = (): ThinkingBlockParts => ({
    correct: ["- [r9] 链路:读取 src/a.ts 后确认导出名", "- [r10] 链路:定位到 src/b.ts 调用点"],
    wrong: ["- [r11] 方向:先改 B 模块 | 结论:应改 A 模块"],
    neutral: ["- [r12] 概要:两种方案的取舍待验证"],
  });

  it("provides THINKING_COMPACTION_RULES for injection", () => {
    expect(THINKING_COMPACTION_RULES).toContain("[thinking]");
    expect(THINKING_COMPACTION_RULES).toContain("## 正确");
  });

  it("builds a thinking block with three sections", () => {
    const block = buildThinkingBlock(sample());
    expect(block.split("\n")[0]).toBe("[thinking]");
    expect(block).toContain("## 正确");
    expect(block).toContain("## 错误");
    expect(block).toContain("## 中性");
    expect(block).toContain("- [r9]");
  });

  it("omits empty sections when building", () => {
    const block = buildThinkingBlock({ correct: [], wrong: [], neutral: ["- [r1] x"] });
    expect(block).not.toContain("## 正确");
    expect(block).not.toContain("## 错误");
    expect(block).toContain("## 中性");
  });

  it("isThinkingBlock detects the marker", () => {
    expect(isThinkingBlock("[thinking]\n## 正确\n- [r1] x")).toBe(true);
    expect(isThinkingBlock("[compacted]")).toBe(false);
    expect(isThinkingBlock("")).toBe(false);
    expect(isThinkingBlock(undefined as unknown as string)).toBe(false);
  });

  it("parses a thinking block back into parts", () => {
    const parts = parseThinkingBlock(buildThinkingBlock(sample()));
    expect(parts.correct).toEqual(sample().correct);
    expect(parts.wrong).toEqual(sample().wrong);
    expect(parts.neutral).toEqual(sample().neutral);
  });

  it("parses tolerates non-thinking content", () => {
    const parts = parseThinkingBlock("普通文本\n## 结论\n- [r1] a");
    expect(parts.correct).toEqual([]);
    expect(parts.wrong).toEqual([]);
    expect(parts.neutral).toEqual([]);
  });

  it("merges thinking blocks with per-section dedupe", () => {
    const merged = mergeThinkingBlocks(
      { correct: ["- [r1] a"], wrong: [], neutral: [] },
      { correct: ["- [r1] a", "- [r2] b"], wrong: [], neutral: ["- [r3] c"] },
    );
    expect(merged.correct).toEqual(["- [r1] a", "- [r2] b"]);
    expect(merged.neutral).toEqual(["- [r3] c"]);
  });

  it("estimates thinking chars from the built block", () => {
    expect(estimateThinkingChars(sample())).toBe(buildThinkingBlock(sample()).length);
  });

  it("keeps everything when already within maxChars", () => {
    expect(trimThinkingBlock(sample(), 10000)).toEqual(sample());
  });

  it("trims oldest rows first to fit maxChars", () => {
    const parts: ThinkingBlockParts = {
      correct: ["- [r1] 第一行", "- [r2] 第二行", "- [r3] 第三行"],
      wrong: [],
      neutral: [],
    };
    // 全量 48 字符;保留最新两行后 ≈38,丢弃 r1
    const trimmed = trimThinkingBlock(parts, 40);
    expect(estimateThinkingChars(trimmed)).toBeLessThanOrEqual(40);
    expect(trimmed.correct).toEqual(["- [r2] 第二行", "- [r3] 第三行"]);
  });

  it("keeps at least the newest row even if maxChars is tiny", () => {
    const trimmed = trimThinkingBlock(
      { correct: ["- [r1] 第一行", "- [r2] 第二行"], wrong: [], neutral: [] },
      1,
    );
    expect(trimmed.correct).toEqual(["- [r2] 第二行"]);
  });

  it("returns empty parts for empty input or non-positive maxChars", () => {
    expect(trimThinkingBlock({ correct: [], wrong: [], neutral: [] }, 100)).toEqual({
      correct: [],
      wrong: [],
      neutral: [],
    });
    expect(trimThinkingBlock(sample(), 0)).toEqual({ correct: [], wrong: [], neutral: [] });
  });
});

describe("thinking block lenient parsing", () => {
  it("parses section-only content without the [thinking] marker", () => {
    const parts = parseThinkingBlock("## 正确\n- [r2] 链路:a\n## 中性\n- [r4] 概要:b");
    expect(parts.correct).toEqual(["- [r2] 链路:a"]);
    expect(parts.neutral).toEqual(["- [r4] 概要:b"]);
    expect(parts.wrong).toEqual([]);
  });

  it("parses trace lines without the leading '- ' prefix", () => {
    const parts = parseThinkingBlock("[thinking]\n## 正确\n[r2] 链路:a");
    expect(parts.correct).toEqual(["[r2] 链路:a"]);
  });
});
