import { describe, it, expect } from "vitest";
import {
  findConsumedToolUses,
  planToolUseTrim,
  transientSummary,
  isTransientSummaryText,
  scanTransientMarkerLines,
  buildStrReplaceOldStringArchiveChunk,
  withOldStringRecallMarker,
  isAnchorField,
  TOOL_USE_KEEP_RECENT_COUNT,
} from "../src/agent/toolUsePolicy";
import type { ProviderMessage } from "../src/agent/provider/types";

describe("planToolUseTrim", () => {
  it("trims Write.contents but keeps path", () => {
    const input = { path: "src/foo.ts", contents: "内容".repeat(9000) };
    const plan = planToolUseTrim("Write", input);
    expect(plan.action).toBe("trim");
    expect(plan.trimmedInput).toEqual({
      path: "src/foo.ts",
      contents: expect.stringContaining("[TRANSIENT-SUMMARY"),
    });
    expect((plan.trimmedInput as any).path).toBe("src/foo.ts");
  });

  it("keeps small Write.contents unchanged", () => {
    const input = { path: "a.ts", contents: "小内容" };
    const plan = planToolUseTrim("Write", input);
    expect(plan.action).toBe("keep");
  });

  it("per-field thresholds: Write.contents 16000 / StrReplace.new_string 8000", () => {
    // 普通整文件(1500 字符)远低于阈值 → 保留原文
    const w = planToolUseTrim("Write", { path: "a.ts", contents: "内容".repeat(750) });
    expect(w.action).toBe("keep");
    // 18000 字符(>16000) → 精简为「头尾预览」,仍以标记前缀开头便于防护识别
    const w2 = planToolUseTrim("Write", { path: "a.ts", contents: "内容".repeat(9000) });
    expect(w2.action).toBe("trim");
    const w2c = (w2.trimmedInput as any).contents as string;
    expect(w2c).toContain("[TRANSIENT-SUMMARY");
    expect(w2c).toContain("头尾预览");
    expect(w2c).toContain("内容内容内容"); // 保留头部原文:模型仍能看到自己写过什么
    // StrReplace.new_string 600 字符(<8000)→ 保留原文;old_string 9000>8000 触发精简
    const sr = planToolUseTrim("StrReplace", { path: "a.ts", old_string: "x".repeat(9000), new_string: "新".repeat(600) });
    expect(sr.action).toBe("trim");
    expect((sr.trimmedInput as any).old_string).toContain("[TRANSIENT-SUMMARY");
    expect((sr.trimmedInput as any).new_string).not.toContain("[TRANSIENT-SUMMARY");
    // 300 字符锚点(<8000)→ 保留原文:锚点是语义参数,不再被换成裸标记
    expect(planToolUseTrim("StrReplace", { path: "a.ts", old_string: "x".repeat(300), new_string: "新".repeat(600) }).action).toBe("keep");
    // StrReplace.new_string 10000 字符(>8000)→ 预览
    const sr2 = planToolUseTrim("StrReplace", { path: "a.ts", old_string: "x".repeat(300), new_string: "新".repeat(10000) });
    expect(sr2.action).toBe("trim");
    expect((sr2.trimmedInput as any).new_string).toContain("[TRANSIENT-SUMMARY");
  });

  it("trims StrReplace old_string and new_string when both exceed thresholds", () => {
    const input = { path: "a.ts", old_string: "旧".repeat(9000), new_string: "新".repeat(9000), replace_all: true };
    const plan = planToolUseTrim("StrReplace", input);
    expect(plan.action).toBe("trim");
    const out = plan.trimmedInput as any;
    expect(out.old_string).toContain("[TRANSIENT-SUMMARY");
    expect(out.new_string).toContain("[TRANSIENT-SUMMARY");
    expect(out.path).toBe("a.ts");
    expect(out.replace_all).toBe(true);
  });

  it("keeps a normal-size old_string anchor (<=8000) as-is", () => {
    // 锚点是语义参数:800 字符锚点原文保留,避免「把标记当锚点复述」
    const plan = planToolUseTrim("StrReplace", { path: "a.ts", old_string: "旧".repeat(800), new_string: "新" });
    expect(plan.action).toBe("keep");
  });

  it("trims Workflow stages prompts but keeps goal, id, dependsOn", () => {
    const input = {
      goal: "优化统计",
      stages: [
        { id: "s1", prompt: "分析".repeat(300), dependsOn: [] },
        { id: "s2", prompt: "实现".repeat(300), dependsOn: ["s1"] },
      ],
    };
    const plan = planToolUseTrim("Workflow", input);
    expect(plan.action).toBe("trim");
    const out = plan.trimmedInput as any;
    expect(out.goal).toBe("优化统计");
    expect(out.stages[0].id).toBe("s1");
    expect(out.stages[0].dependsOn).toEqual([]);
    expect(out.stages[0].prompt).toContain("[TRANSIENT-SUMMARY");
    expect(out.stages[1].prompt).toContain("[TRANSIENT-SUMMARY");
  });

  it("keeps small Workflow stage prompts", () => {
    const input = { goal: "g", stages: [{ id: "s1", prompt: "短任务", dependsOn: [] }] };
    expect(planToolUseTrim("Workflow", input).action).toBe("keep");
  });

  it("trims Agent task", () => {
    const input = { task: "任务描述".repeat(300), system: "系统提示".repeat(300) };
    const plan = planToolUseTrim("Agent", input);
    expect(plan.action).toBe("trim");
    expect((plan.trimmedInput as any).task).toContain("[TRANSIENT-SUMMARY");
    expect((plan.trimmedInput as any).system).toContain("[TRANSIENT-SUMMARY");
  });

  it("keeps tools with no transient fields", () => {
    for (const [name, input] of [
      ["Read", { path: "a.ts" }],
      ["Bash", { command: "ls", timeout_ms: 30_000 }],
      ["Grep", { pattern: "foo", path: "src" }],
      ["WebSearch", { query: "x" }],
      ["Glob", { pattern: "**/*.ts" }],
    ] as Array<[string, unknown]>) {
      expect(planToolUseTrim(name, input).action).toBe("keep");
    }
  });

  it("keeps unknown tool", () => {
    expect(planToolUseTrim("mcp__server_tool", { big: "x".repeat(1000) }).action).toBe("keep");
  });

  it("transientSummary is informative", () => {
    const s = transientSummary("contents", 1234);
    expect(s).toContain("field=contents");
    expect(s).toContain("chars=1234");
    expect(s).toContain("禁止写入文件");
  });

  it("isTransientSummaryText detects new/legacy/combo markers", () => {
    expect(isTransientSummaryText("[TRANSIENT-SUMMARY field=x chars=1] 瞬时参数省略标记:禁止写入文件")).toBe(true);
    // 头尾预览形态:以标记前缀开头、首行即标记本身,即使很长也应被识别为标记
    expect(isTransientSummaryText("[TRANSIENT-SUMMARY field=contents chars=18000] 瞬时参数已精简为头尾预览(省略 16400 字符)\n--- 预览·头 ---\nabc")).toBe(true);
    expect(isTransientSummaryText("[瞬时参数已省略:contents 300 字符]")).toBe(true);
    expect(isTransientSummaryText("瞬时参数省略标记:禁止写入文件,请用 Read 读取")).toBe(true);
    expect(isTransientSummaryText("正常内容 abc")).toBe(false);
    expect(isTransientSummaryText("")).toBe(false);
    // 严格判定:仅当内容本身基本就是标记时为真;含该字面量的长文档不再误判。
    const longDoc = "说明:" + "本段是正常文档内容。".repeat(40) + " 文末附注 [TRANSIENT-SUMMARY field=x chars=1]";
    expect(isTransientSummaryText(longDoc)).toBe(false);
  });
});

describe("findConsumedToolUses", () => {
  it("finds executed + consumed tool_use and resolves name", () => {
    const msgs: ProviderMessage[] = [
      { role: "user", content: "写文件" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Write", input: { path: "a.ts", contents: "x" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "Wrote a.ts" }] }] },
      { role: "assistant", content: [{ type: "text", text: "写完了" }] },
    ];
    expect(findConsumedToolUses(msgs)).toEqual([{ index: 1, blockIndex: 0, toolName: "Write" }]);
  });

  it("keeps tool_use that was never executed (no tool_result)", () => {
    const msgs: ProviderMessage[] = [
      { role: "user", content: "x" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Write", input: {} }] },
      { role: "assistant", content: [{ type: "text", text: "我改主意了" }] },
    ];
    expect(findConsumedToolUses(msgs)).toEqual([]);
  });

  it("keeps tool_use executed but not yet consumed (no following assistant)", () => {
    const msgs: ProviderMessage[] = [
      { role: "user", content: "x" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "out" }] }] },
    ];
    expect(findConsumedToolUses(msgs)).toEqual([]);
  });

  it("handles parallel tool_uses in one assistant message", () => {
    const msgs: ProviderMessage[] = [
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } },
          { type: "tool_use", id: "t2", name: "Write", input: { path: "b.ts", contents: "y" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a" }] },
          { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "b" }] },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "完成" }] },
    ];
    const found = findConsumedToolUses(msgs);
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.blockIndex).sort()).toEqual([0, 1]);
    expect(found.map((f) => f.toolName).sort()).toEqual(["Read", "Write"]);
  });

  it("keeps other assistant messages untouched", () => {
    const msgs: ProviderMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    expect(findConsumedToolUses(msgs)).toEqual([]);
  });
});

describe("extended transient fields (TodoWrite/MemoryWrite)", () => {
  it("never trims TodoWrite content, even when long", () => {
    const content = "编写自动化测试并修复遗留 bug".repeat(30); // >200 字符
    const plan = planToolUseTrim("TodoWrite", { op: "add", content });
    expect(plan.action).toBe("keep");
    expect(plan.trimmedInput).toBeUndefined();
  });

  it("keeps TodoWrite content when short", () => {
    const plan = planToolUseTrim("TodoWrite", { op: "add", content: "短任务" });
    expect(plan.action).toBe("keep");
  });

  it("keeps TodoWrite semantic fields (op/id/done)", () => {
    const plan = planToolUseTrim("TodoWrite", { op: "update", id: "t3", done: true });
    expect(plan.action).toBe("keep");
  });

  it("never trims MemoryWrite body, even when long", () => {
    const body = "这是一段要写入记忆的长内容".repeat(40); // >200 字符
    const plan = planToolUseTrim("MemoryWrite", {
      name: "my-memory",
      description: "desc",
      body,
      scope: "project",
    });
    expect(plan.action).toBe("keep");
    expect(plan.trimmedInput).toBeUndefined();
  });

  it("keeps MemoryWrite semantic fields intact (no trim at all)", () => {
    const plan = planToolUseTrim("MemoryWrite", {
      name: "keep-name",
      description: "keep-desc",
      body: "x".repeat(500),
      pinned: true,
    });
    expect(plan.action).toBe("keep");
    expect(plan.trimmedInput).toBeUndefined();
  });

  it("keeps other memory tool params untouched", () => {
    expect(planToolUseTrim("MemoryRead", { name: "abc", scope: "global" }).action).toBe("keep");
    expect(planToolUseTrim("MemoryList", { scope: "project" }).action).toBe("keep");
    expect(planToolUseTrim("MemoryDelete", { name: "abc" }).action).toBe("keep");
  });
});

describe("可重建性分档: 锚点档不参与写前定型", () => {
  it("isAnchorField 只认 StrReplace.old_string", () => {
    expect(isAnchorField("StrReplace", "old_string")).toBe(true);
    expect(isAnchorField("StrReplace", "new_string")).toBe(false);
    expect(isAnchorField("Write", "contents")).toBe(false);
  });

  it("skipAnchorFields: 大 old_string 保留原文, 只精简 new_string", () => {
    const input = { path: "a.ts", old_string: "旧".repeat(9000), new_string: "新".repeat(9000) };
    // 默认(发送前窗):两者都精简
    expect(planToolUseTrim("StrReplace", input).action).toBe("trim");
    // 写前定型(跳过锚点档):旧串原文保留,新串精简
    const plan = planToolUseTrim("StrReplace", input, { skipAnchorFields: true });
    expect(plan.action).toBe("trim");
    const out = plan.trimmedInput as Record<string, unknown>;
    expect(out.old_string).toBe(input.old_string); // 不可重建 → 原文进历史
    expect(String(out.new_string)).toContain("[TRANSIENT-SUMMARY");
  });

  it("skipAnchorFields: 仅锚点超阈值时不变更(避免无谓改写破坏前缀)", () => {
    const input = { path: "a.ts", old_string: "旧".repeat(9000), new_string: "短" };
    expect(planToolUseTrim("StrReplace", input, { skipAnchorFields: true }).action).toBe("keep");
  });

  it("近期窗口常量与设计一致(N>0, 且远小于 thinking 的 15 属同一量级)", () => {
    expect(TOOL_USE_KEEP_RECENT_COUNT).toBeGreaterThan(0);
    expect(TOOL_USE_KEEP_RECENT_COUNT).toBeLessThanOrEqual(15);
  });
});

describe("StrReplace old_string archive helpers", () => {
  it("archives large old_string only", () => {
    const big = "旧".repeat(300);
    const chunk = buildStrReplaceOldStringArchiveChunk({
      path: "a.ts",
      old_string: big,
      new_string: "x".repeat(300),
    });
    expect(chunk?.content).toBe(big);
    expect(chunk?.type).toBe("ledger");
    expect(buildStrReplaceOldStringArchiveChunk({ path: "a.ts", old_string: "短" })).toBeUndefined();
    expect(
      buildStrReplaceOldStringArchiveChunk({
        path: "a.ts",
        old_string: transientSummary("old_string", 500),
      }),
    ).toBeUndefined();
  });

  it("withOldStringRecallMarker suffixes [r{seq}]", () => {
    const out = withOldStringRecallMarker(
      { path: "a.ts", old_string: transientSummary("old_string", 300) },
      9,
    ) as Record<string, unknown>;
    expect(String(out.old_string)).toContain("[r9]");
  });
});

describe("scanTransientMarkerLines (写后自检)", () => {
  it("命中整行的瞬时参数占位标记", () => {
    const text = "正常第一行\n[瞬时参数已省略:new_string 500 字符;内容已在文件系统/执行状态中]\n正常第三行";
    const hits = scanTransientMarkerLines(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("[瞬时参数已省略");
  });

  it("命中 TRANSIENT-SUMMARY 形状行(不看整段长度)", () => {
    // 整段远超 320 字符:写前守卫会提前返回 false,写后扫描仍必须命中
    const text =
      "这是一段很长的正常正文,用于让整段长度突破 320 字符。".repeat(20) +
      "\n[TRANSIENT-SUMMARY field=contents chars=999]\n" +
      "正常结尾";
    expect(text.length).toBeGreaterThan(320);
    const hits = scanTransientMarkerLines(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("[TRANSIENT-SUMMARY");
  });

  it("不误伤文档中对标记的引用(超长整行)", () => {
    const longRef = "说明:" + "这是引用该标记的正常文档正文。".repeat(40);
    expect(scanTransientMarkerLines(longRef)).toHaveLength(0);
  });

  it("空内容/无标记返回空数组", () => {
    expect(scanTransientMarkerLines("")).toEqual([]);
    expect(scanTransientMarkerLines("完全正常的文件内容\n第二行")).toEqual([]);
  });
});
