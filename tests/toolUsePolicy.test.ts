import { describe, it, expect } from "vitest";
import {
  findConsumedToolUses,
  planToolUseTrim,
  transientSummary,
} from "../src/agent/toolUsePolicy";
import type { ProviderMessage } from "../src/agent/provider/types";

describe("planToolUseTrim", () => {
  it("trims Write.contents but keeps path", () => {
    const input = { path: "src/foo.ts", contents: "内容".repeat(500) };
    const plan = planToolUseTrim("Write", input);
    expect(plan.action).toBe("trim");
    expect(plan.trimmedInput).toEqual({
      path: "src/foo.ts",
      contents: expect.stringContaining("[瞬时参数已省略"),
    });
    expect((plan.trimmedInput as any).path).toBe("src/foo.ts");
  });

  it("keeps small Write.contents unchanged", () => {
    const input = { path: "a.ts", contents: "小内容" };
    const plan = planToolUseTrim("Write", input);
    expect(plan.action).toBe("keep");
  });

  it("trims StrReplace old_string and new_string", () => {
    const input = { path: "a.ts", old_string: "旧".repeat(300), new_string: "新".repeat(500), replace_all: true };
    const plan = planToolUseTrim("StrReplace", input);
    expect(plan.action).toBe("trim");
    const out = plan.trimmedInput as any;
    expect(out.old_string).toContain("[瞬时参数已省略");
    expect(out.new_string).toContain("[瞬时参数已省略");
    expect(out.path).toBe("a.ts");
    expect(out.replace_all).toBe(true);
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
    expect(out.stages[0].prompt).toContain("[瞬时参数已省略");
    expect(out.stages[1].prompt).toContain("[瞬时参数已省略");
  });

  it("keeps small Workflow stage prompts", () => {
    const input = { goal: "g", stages: [{ id: "s1", prompt: "短任务", dependsOn: [] }] };
    expect(planToolUseTrim("Workflow", input).action).toBe("keep");
  });

  it("trims Agent task", () => {
    const input = { task: "任务描述".repeat(300), system: "系统提示".repeat(300) };
    const plan = planToolUseTrim("Agent", input);
    expect(plan.action).toBe("trim");
    expect((plan.trimmedInput as any).task).toContain("[瞬时参数已省略");
    expect((plan.trimmedInput as any).system).toContain("[瞬时参数已省略");
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
    expect(transientSummary("contents", 1234)).toContain("1234 字符");
    expect(transientSummary("contents", 1234)).toContain("重新调用");
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
  it("trims TodoWrite content when long", () => {
    const content = "编写自动化测试并修复遗留 bug".repeat(30); // >200 字符
    const plan = planToolUseTrim("TodoWrite", { op: "add", content });
    expect(plan.action).toBe("trim");
    const input = plan.trimmedInput as { op: string; content: string };
    expect(input.op).toBe("add");
    expect(input.content).toContain("[瞬时参数已省略");
    expect(input.content.length).toBeLessThan(200);
  });

  it("keeps TodoWrite content when short", () => {
    const plan = planToolUseTrim("TodoWrite", { op: "add", content: "短任务" });
    expect(plan.action).toBe("keep");
  });

  it("keeps TodoWrite semantic fields (op/id/done)", () => {
    const plan = planToolUseTrim("TodoWrite", { op: "update", id: "t3", done: true });
    expect(plan.action).toBe("keep");
  });

  it("trims MemoryWrite body when long", () => {
    const body = "这是一段要写入记忆的长内容".repeat(40); // >200 字符
    const plan = planToolUseTrim("MemoryWrite", {
      name: "my-memory",
      description: "desc",
      body,
      scope: "project",
    });
    expect(plan.action).toBe("trim");
    const input = plan.trimmedInput as Record<string, unknown>;
    expect(input.name).toBe("my-memory");
    expect(input.description).toBe("desc");
    expect(input.scope).toBe("project");
    expect(String(input.body)).toContain("[瞬时参数已省略");
    expect(String(input.body).length).toBeLessThan(200);
  });

  it("keeps MemoryWrite semantic fields intact when only body trimmed", () => {
    const plan = planToolUseTrim("MemoryWrite", {
      name: "keep-name",
      description: "keep-desc",
      body: "x".repeat(500),
      pinned: true,
    });
    expect(plan.action).toBe("trim");
    const input = plan.trimmedInput as Record<string, unknown>;
    expect(input.name).toBe("keep-name");
    expect(input.description).toBe("keep-desc");
    expect(input.pinned).toBe(true);
  });

  it("keeps other memory tool params untouched", () => {
    expect(planToolUseTrim("MemoryRead", { name: "abc", scope: "global" }).action).toBe("keep");
    expect(planToolUseTrim("MemoryList", { scope: "project" }).action).toBe("keep");
    expect(planToolUseTrim("MemoryDelete", { name: "abc" }).action).toBe("keep");
  });
});
