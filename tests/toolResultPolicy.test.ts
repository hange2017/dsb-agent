import { describe, it, expect } from "vitest";
import {
  classifyToolResult,
  findConsumedToolResults,
  planToolResultTrim,
  toolResultText,
  TRIMMED_MARKER,
  SUMMARIZED_MARKER,
  TOOL_RESULT_TRIM,
  buildToolResultArchiveChunk,
  withToolResultRecallMarker,
} from "../src/agent/toolResultPolicy";
import type { ProviderMessage } from "../src/agent/provider/types";

/** CJK 文本:每字约 1 token。 */
function cjkLines(count: number, charsPerLine = 20): string {
  return Array.from({ length: count }, (_, i) => `行${i} ` + "内容".repeat(charsPerLine)).join("\n");
}

describe("classifyToolResult", () => {
  it("keeps high-density / small-output tools", () => {
    for (const name of ["Read", "Write", "StrReplace", "Delete", "Glob", "LS", "TodoWrite", "MemoryRead", "ContextRecall"]) {
      expect(classifyToolResult(name)).toBe("keep");
    }
    expect(classifyToolResult("")).toBe("keep");
  });

  it("trims low-density tools", () => {
    for (const name of ["Bash", "Grep", "WebFetch", "WebSearch", "Workflow", "Agent"]) {
      expect(classifyToolResult(name)).toBe("trim");
    }
  });

  it("summarizes unknown tools (MCP / plugin) without rule-trimming", () => {
    expect(classifyToolResult("mcp__server_query")).toBe("summarize");
    expect(classifyToolResult("plugin__custom_tool")).toBe("summarize");
    expect(classifyToolResult("unknownTool")).toBe("summarize");
  });
});

describe("planToolResultTrim", () => {
  it("keeps small outputs (< minTokens)", () => {
    const plan = planToolResultTrim("Bash", "exit=0\nhello");
    expect(plan.action).toBe("keep");
  });

  it("keeps high-density tool even when huge", () => {
    const plan = planToolResultTrim("Read", cjkLines(200));
    expect(plan.action).toBe("keep");
  });

  it("trims huge successful Bash output: exit line + head + tail + fold marker", () => {
    const big = "exit=0\n" + cjkLines(100);
    const plan = planToolResultTrim("Bash", big);
    expect(plan.action).toBe("trim");
    expect(plan.trimmed).toContain("exit=0");
    expect(plan.trimmed).toContain("… (省略");
    const lines = plan.trimmed!.split("\n");
    expect(lines.length).toBeLessThan(TOOL_RESULT_TRIM.bashHead + TOOL_RESULT_TRIM.bashTail + 3);
  });

  it("trims huge failed Bash output but keeps error lines and exit code", () => {
    const fail = "exit=1\n" + cjkLines(80) + "\nERROR: build failed at step 3\nFATAL: cannot continue";
    const plan = planToolResultTrim("Bash", fail);
    expect(plan.action).toBe("trim");
    expect(plan.trimmed).toContain("exit=1");
    expect(plan.trimmed).toContain("ERROR: build failed at step 3");
    expect(plan.trimmed).toContain("FATAL: cannot continue");
  });

  it("trims Grep results grouped per file with limit and path:line prefix", () => {
    const rows: string[] = [];
    for (let f = 0; f < 3; f++) {
      for (let n = 0; n < 15; n++) {
        rows.push(`src/a${f}.ts:${10 + n}:内容内容内容内容内容内容内容内容`);
      }
    }
    const plan = planToolResultTrim("Grep", rows.join("\n"));
    expect(plan.action).toBe("trim");
    const kept = plan.trimmed!.split("\n").filter((l) => l.startsWith("src/"));
    expect(kept).toHaveLength(3 * TOOL_RESULT_TRIM.grepPerFile);
    expect(plan.trimmed).toContain("还有 5 条匹配");
    expect(plan.trimmed!.split("\n")[0]).toMatch(/^src\/a0\.ts:\d+:/);
  });

  it("trims WebFetch with head/tail", () => {
    const plan = planToolResultTrim("WebFetch", cjkLines(150));
    expect(plan.action).toBe("trim");
    expect(plan.trimmed!.split("\n").length).toBeLessThanOrEqual(TOOL_RESULT_TRIM.webHead + TOOL_RESULT_TRIM.webTail + 2);
  });

  it("trims Workflow output keeping stage headings", () => {
    const out = ["## 阶段1", ...cjkLines(50), "## 阶段2", ...cjkLines(50), "## 阶段3", ...cjkLines(50)].join("\n");
    const plan = planToolResultTrim("Workflow", out);
    expect(plan.action).toBe("trim");
    expect(plan.trimmed).toContain("## 阶段1");
    expect(plan.trimmed).toContain("## 阶段2");
    expect(plan.trimmed).toContain("## 阶段3");
  });

  it("upgrades to summarize when trim still exceeds threshold", () => {
    // 每行 200 个 CJK ≈ 200 tokens:100 行 ≈ 20000;WebFetch trim(head20+tail20)后 ≈ 40 行 ≈ 8000 > 3000
    const big = Array.from({ length: 100 }, (_, i) => `行${i} ` + "内容".repeat(200)).join("\n");
    const plan = planToolResultTrim("WebFetch", big);
    expect(plan.action).toBe("summarize");
  });

  it("summarizes unknown tool only when over threshold (no rule trim)", () => {
    const small = planToolResultTrim("mcp__server_query", "小输出内容");
    expect(small.action).toBe("keep");
    const huge = planToolResultTrim("mcp__server_query", cjkLines(400));
    expect(huge.action).toBe("summarize");
  });

  it("keeps empty output", () => {
    expect(planToolResultTrim("Bash", "").action).toBe("keep");
    expect(planToolResultTrim("Bash", "   ").action).toBe("keep");
  });
});

describe("toolResultText", () => {
  it("returns string content as-is", () => {
    expect(toolResultText("hello")).toBe("hello");
  });
  it("joins text blocks", () => {
    expect(toolResultText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  });
});

describe("findConsumedToolResults", () => {
  const bashResult = (id: string): ProviderMessage => ({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "out" }] }],
  });

  it("finds tool_result followed by an assistant message and resolves tool name", () => {
    const msgs: ProviderMessage[] = [
      { role: "user", content: "需求" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "先跑命令" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
      },
      bashResult("t1"),
      { role: "assistant", content: [{ type: "text", text: "看到了" }] },
    ];
    expect(findConsumedToolResults(msgs)).toEqual([{ index: 2, toolName: "Bash" }]);
  });

  it("keeps tool_result with no following assistant (latest, unconsumed)", () => {
    const msgs: ProviderMessage[] = [
      { role: "user", content: "需求" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } }] },
      bashResult("t1"),
      { role: "user", content: "继续" },
    ];
    expect(findConsumedToolResults(msgs)).toEqual([]);
  });

  it("handles parallel tool_results with different tool names", () => {
    const msgs: ProviderMessage[] = [
      { role: "user", content: "需求" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "pwd" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "file" }] },
          { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "pwd" }] },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "看完了" }] },
    ];
    const found = findConsumedToolResults(msgs);
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.toolName).sort()).toEqual(["Bash", "Read"]);
  });

  it("returns empty for empty history", () => {
    expect(findConsumedToolResults([])).toEqual([]);
  });

  it("exported TRIMMED_MARKER is a string marker", () => {
    expect(TRIMMED_MARKER).toMatch(/^\[/);
  });

  it("keeps already trimmed/summarized results (idempotent)", () => {
    expect(planToolResultTrim("Bash", `${TRIMMED_MARKER}\n[r3]\n` + cjkLines(100)).action).toBe("keep");
    expect(planToolResultTrim("Bash", `${SUMMARIZED_MARKER}\n摘要`).action).toBe("keep");
  });
});

describe("toolResult archive helpers", () => {
  it("buildToolResultArchiveChunk and withToolResultRecallMarker", () => {
    const c = buildToolResultArchiveChunk("exit=0\n一大段日志");
    expect(c.type).toBe("ledger");
    expect(c.content).toContain("一大段日志");
    expect(withToolResultRecallMarker("body", 4)).toBe("[r4]\nbody");
    expect(withToolResultRecallMarker("[r4]\nbody", 4)).toBe("[r4]\nbody");
  });
});
