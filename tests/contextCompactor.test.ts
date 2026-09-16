import { describe, it, expect } from "vitest";
import {
  classifyAssistantText,
  summarizeToolUse,
  extractKeyLines,
  buildCompactedBlock,
  RECALL_HINT_LINE,
  isCompactedBlock,
  parseCompactedBlock,
  mergeCompactedTracks,
  THINKING_COMPACTION_RULES,
  buildThinkingBlock,
  parseThinkingBlock,
  isThinkingBlock,
  mergeThinkingBlocks,
  estimateThinkingChars,
  truncateParts,
  trimThinkingBlock,
  demoteInnerHeadings,
  type ThinkingBlockParts,
} from "../src/agent/contextCompactor";

describe("classifyAssistantText", () => {
  it("keeps short replies entirely as conclusion", () => {
    const r = classifyAssistantText("已完成,606 个测试全绿。", false);
    expect(r.conclusion.length).toBeGreaterThan(0);
    expect(r.explanation).toEqual([]);
  });

  it("keeps headings, lists, code and tables as conclusion on a FINAL (no-tool) turn", () => {
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
    const r = classifyAssistantText(text, false);
    expect(r.conclusion.length).toBeGreaterThan(0);
    expect(r.explanation).toEqual([]);
  });

  it("P0-1(补全): on a tool turn, structural blocks are work-in-progress, not conclusions", () => {
    // 现场:过程轮的分析正文(几乎全是代码块 + 列表)曾被**无条件**判结论 → 进 conclusions 轨
    // → 地图「结果」段 → 下轮任务锚回喂自身 → 自我强化循环(单条 43 字消息跑 20 轮)。
    // 终答轮(无 tool_use)才可能产出结论,过程轮一律降级 explanation。
    const text = [
      "## 分析",
      "先看这段代码:",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "- 要点一",
      "- 要点二",
    ].join("\n");
    const r = classifyAssistantText(text, true);
    expect(r.conclusion).toEqual([]);
    expect(r.explanation.length).toBeGreaterThan(0);
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
  it("flattens multi-line command to one line (P0-5: 防轨条目裂行)", () => {
    // Bash heredoc / 多段 command 含换行:若不单行化,压缩块 join("\n") 后
    // 一条轨条目会裂成多个物理行,parse 读回即成为无前缀碎片行。
    const s = summarizeToolUse("Bash", { command: "cd /x && python3 - <<'PY'\nimport json, os\nprint(1)\nPY" });
    expect(s).not.toContain("\n");
    expect(s).toBe("Bash: cd /x && python3 - <<'PY' | import json, os | print(1) | PY");
    // 制表符 / 连续空格也归一化,保证「一条工具调用 == 一行」
    expect(summarizeToolUse("Read", { path: "a\t\tb" })).toBe("Read: a b");
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
  it("always emits section titles even for empty tracks (缓存前缀稳定)", () => {
    const block = buildCompactedBlock({ demands: [], conclusions: [], explanations: [], ledger: ["- [r2] Bash: npm test"] });
    expect(block).toContain("## 需求");
    expect(block).toContain("## 结论");
    expect(block).toContain("## 说明");
    expect(block).toContain("## 工具履历");
  });
  it("emits a stable tail hint line guiding ContextRecall usage (P1)", () => {
    const block = buildCompactedBlock({ demands: ["- [r1] a"], conclusions: [], explanations: [], ledger: [] });
    expect(block.endsWith(RECALL_HINT_LINE)).toBe(true);
    expect(block).toContain("ContextRecall(seq=n)");
    // parse 时提示行不并入任何轨(防 merge 膨胀 / 前缀漂移)
    const parsed = parseCompactedBlock(block);
    expect(parsed.ledger).not.toContain(RECALL_HINT_LINE);
    expect(parsed.demands).toEqual(["- [r1] a"]);
    // 空 parts 也恒输出提示行(字节稳定)
    const empty = buildCompactedBlock({ demands: [], conclusions: [], explanations: [], ledger: [] });
    expect(empty).toContain(RECALL_HINT_LINE);
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

describe("内嵌标题转义 (t37): 防串轨 + build/parse 幂等", () => {
  it("demoteInnerHeadings 转义内嵌 ##/### 标题, 且幂等", () => {
    const text = "- [r2] 正文\n## 说明\n- [r3] 列表项\n### 子标题";
    const once = demoteInnerHeadings(text);
    expect(once).toBe("- [r2] 正文\n\\## 说明\n- [r3] 列表项\n\\### 子标题");
    expect(demoteInnerHeadings(once)).toBe(once); // 幂等:已转义不再变
  });

  it("条目正文内嵌标准轨名时, build→parse→build 保持字节稳定(不串轨)", () => {
    const parts = {
      demands: ["- [r1] 需求A"],
      conclusions: ["- [r2] 正文\n## 说明\n- [r3] 表格/列表内容"],
      explanations: ["- [r4] 解释X"],
      ledger: ["- [r5] Bash: ls"],
    };
    const block = buildCompactedBlock(parts);
    const parsed = parseCompactedBlock(block);
    // 内嵌标题不再被误判为轨起点:内容不被搬到说明轨
    expect(parsed.explanations).toEqual(["- [r4] 解释X"]);
    expect(parsed.conclusions.join("\n")).toContain("表格/列表内容");
    expect(buildCompactedBlock(parsed)).toBe(block);
  });

  it("历史污染块(内容已散落多行)在 build 出口自愈, 且自愈后幂等", () => {
    // 模拟已被 parse 拆散的历史形态:标准轨行夹杂内嵌伪标题
    const polluted = {
      demands: ["- [r1] a"],
      conclusions: ["- [r2] 汇报:", "## 项目现状", "**技术栈**:CMake", "- [r3] 完成"],
      explanations: [],
      ledger: [],
    };
    const healed = buildCompactedBlock(polluted);
    const reparsed = parseCompactedBlock(healed);
    expect(reparsed.conclusions).toContain("\\## 项目现状");
    expect(buildCompactedBlock(reparsed)).toBe(healed); // 自愈后幂等
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

describe("任务地图轨 (P2-3): 可选, 空则字节与旧版一致, 永不参与截断", () => {
  const mapAxis = ["## 任务地图", "**目标:** 修复多轮迷失目标", "### 更早的需求", "- P2-3 块首地图"];

  it("无 map 时块内不出现任务地图段 (字节与旧版一致)", () => {
    const block = buildCompactedBlock({ demands: ["- [r1] a"], conclusions: [], explanations: [], ledger: [] });
    expect(block).not.toContain("任务地图");
  });

  it("T1: 有 map 时块内也不出现地图 (地图改由消息尾部任务锚投递)", () => {
    const block = buildCompactedBlock({ map: mapAxis, demands: ["- [r1] a"], conclusions: [], explanations: [], ledger: [] });
    // T1 核心断言:地图不再写入块内任何位置 —— 它的滑动窗口段每轮都变,
    // 置于块首(最前缀)会让整块 hash 变化 → 全额 miss。
    expect(block).not.toContain("任务地图");
    expect(block).not.toContain("P2-3 块首地图");
    // 块骨架只由 4 轨构成,字节与「无 map」完全一致(块层跨轮稳定)
    const noMap = buildCompactedBlock({ demands: ["- [r1] a"], conclusions: [], explanations: [], ledger: [] });
    expect(block).toBe(noMap);
  });

  it("build→parse→build 幂等 (旧块含地图时仍可解析;新块不再产出地图)", () => {
    const parts = { map: mapAxis, demands: ["- [r1] a"], conclusions: ["- [r3] c"], explanations: [], ledger: ["- [r2] Read: a"] };
    const block = buildCompactedBlock(parts);
    const parsed = parseCompactedBlock(block);
    // 新块不含地图 → 解析得到空地图轨,但 4 轨内容完整保留
    expect(parsed.map ?? []).toEqual([]);
    expect(parsed.demands).toEqual(["- [r1] a"]);
    expect(buildCompactedBlock(parsed)).toBe(block);
  });

  it("旧块(带块首地图)仍可被 parse 解析出地图轨(向后兼容读取)", () => {
    const legacy = ["[前文摘要]", "[compacted]", ...mapAxis, "## 需求", "- [r1] a"].join("\n");
    const parsed = parseCompactedBlock(legacy);
    expect(parsed.map).toEqual(mapAxis);
    expect(parsed.demands).toEqual(["- [r1] a"]);
  });

  it("增量合并: next 无地图时沿用 prev 地图; next 有地图时以 next 为准", () => {
    const prev = { map: mapAxis, demands: ["- [r1] a"], conclusions: [], explanations: [], ledger: [] };
    const nextNoMap = { demands: ["- [r5] b"], conclusions: [], explanations: [], ledger: [] };
    expect(mergeCompactedTracks(prev, nextNoMap).map).toEqual(mapAxis);
    const nextMap = { map: ["## 任务地图", "**目标:** 新目标"], demands: [], conclusions: [], explanations: [], ledger: [] };
    expect(mergeCompactedTracks(prev, nextMap).map).toEqual(["## 任务地图", "**目标:** 新目标"]);
  });

  it("truncateParts 原样保留地图, 只截断其它轨", () => {
    const long = "y".repeat(500);
    const out = truncateParts({ map: mapAxis, demands: [long], conclusions: [], explanations: [], ledger: [] }, 100);
    expect(out.map).toEqual(mapAxis);
    expect(out.demands[0].length).toBe(101);
  });
});
