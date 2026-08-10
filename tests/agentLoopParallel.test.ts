import { describe, it, expect, vi } from "vitest";
import { isParallelSafeTool, partitionToolBatches, mapParallelBatches } from "../src/agent/tools/parallelSafe";
import { AgentSession } from "../src/agent/agentLoop";
import { PermissionManager } from "../src/agent/permission";
import { PermissionRules } from "../src/agent/permissionRules";
import { ContextManager } from "../src/agent/contextManager";
import type { ProviderClient, ProviderRoundResult } from "../src/agent/provider/types";
import type { ToolDef, ToolExecContext, ToolExecResult } from "../src/agent/tools/types";

describe("parallelSafe", () => {
  it("whitelists read-only tools", () => {
    expect(isParallelSafeTool("Read")).toBe(true);
    expect(isParallelSafeTool("Grep")).toBe(true);
    expect(isParallelSafeTool("Write")).toBe(false);
    expect(isParallelSafeTool("Bash")).toBe(false);
  });

  it("batches consecutive reads; isolates writes", () => {
    expect(partitionToolBatches(["Read", "Grep", "Write", "Read"])).toEqual([
      { start: 0, end: 2, parallel: true },
      { start: 2, end: 3, parallel: false },
      { start: 3, end: 4, parallel: false },
    ]);
  });

  it("mapParallelBatches serializes when mode serial or max 1", () => {
    expect(mapParallelBatches(["Read", "Grep"], { mode: "serial", maxParallelTools: 8 })).toEqual([
      { start: 0, end: 1, parallel: false },
      { start: 1, end: 2, parallel: false },
    ]);
    expect(mapParallelBatches(["Read", "Grep"], { mode: "read_safe", maxParallelTools: 1 })).toEqual([
      { start: 0, end: 1, parallel: false },
      { start: 1, end: 2, parallel: false },
    ]);
  });
});

describe("AgentSession parallel tool execution", () => {
  function perms() {
    return new PermissionManager({
      gateway: { request: async () => true },
      rules: new PermissionRules(),
    });
  }

  it("runs consecutive Reads concurrently and preserves tool_result order", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const started: string[] = [];
    const handlers: Record<string, (input: Record<string, unknown>) => Promise<ToolExecResult>> = {
      Read: async (input) => {
        started.push(String(input.path));
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 40));
        inflight--;
        return { ok: true, content: `file:${input.path}` };
      },
    };
    const defs: ToolDef[] = [{ name: "Read", description: "r", input_schema: {} }];
    const tools = {
      allToolDefs: () => defs,
      async execute(name: string, input: Record<string, unknown>, _ctx: ToolExecContext) {
        return handlers[name](input);
      },
    };
    const script: ProviderRoundResult[] = [
      {
        blocks: [
          { type: "tool_use", id: "a", name: "Read", input: { path: "1" } },
          { type: "tool_use", id: "b", name: "Read", input: { path: "2" } },
        ],
        toolUses: [
          { id: "a", name: "Read", input: { path: "1" } },
          { id: "b", name: "Read", input: { path: "2" } },
        ],
      },
      { blocks: [{ type: "text", text: "done" }], toolUses: [] },
    ];
    let i = 0;
    const provider: ProviderClient = {
      capabilities: { supportsVision: true, supportsThinking: true },
      async round() {
        return script[Math.min(i++, script.length - 1)];
      },
    };
    const session = new AgentSession({
      provider,
      tools: tools as never,
      permissions: perms(),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
    });
    await session.send("go", () => {});
    expect(maxInflight).toBeGreaterThanOrEqual(2);
    const msgs = session.getMessages();
    const results = msgs.find(
      (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
    );
    expect(results?.content).toEqual([
      { type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "file:1" }] },
      { type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: "file:2" }] },
    ]);
  });

  it("does not parallelize Write with Read", async () => {
    const order: string[] = [];
    const tools = {
      allToolDefs: () =>
        [
          { name: "Read", description: "r", input_schema: {} },
          { name: "Write", description: "w", input_schema: {} },
        ] as ToolDef[],
      async execute(name: string, input: Record<string, unknown>) {
        order.push(name);
        if (name === "Write") {
          await new Promise((r) => setTimeout(r, 30));
        }
        return { ok: true, content: `${name}:${JSON.stringify(input)}` };
      },
    };
    const script: ProviderRoundResult[] = [
      {
        blocks: [
          { type: "tool_use", id: "w", name: "Write", input: { path: "a" } },
          { type: "tool_use", id: "r", name: "Read", input: { path: "b" } },
        ],
        toolUses: [
          { id: "w", name: "Write", input: { path: "a" } },
          { id: "r", name: "Read", input: { path: "b" } },
        ],
      },
      { blocks: [{ type: "text", text: "done" }], toolUses: [] },
    ];
    let i = 0;
    const provider: ProviderClient = {
      capabilities: { supportsVision: true, supportsThinking: true },
      async round() {
        return script[Math.min(i++, script.length - 1)];
      },
    };
    const session = new AgentSession({
      provider,
      tools: tools as never,
      permissions: perms(),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
    });
    await session.send("go", () => {});
    expect(order).toEqual(["Write", "Read"]);
  });

  it("passes thinkingBudgetTokens and syncs window after caps change", async () => {
    const caps = {
      supportsVision: true,
      supportsThinking: true,
      thinkingBudgetTokens: 4096,
      contextWindowTokens: 10_000,
      maxOutputTokens: 8192,
    };
    const captured: Array<{ budget?: number; maxTokens?: number }> = [];
    const provider: ProviderClient = {
      get capabilities() {
        return caps;
      },
      async round(_m, opts) {
        captured.push({ budget: opts.thinkingBudgetTokens, maxTokens: opts.maxTokens });
        caps.contextWindowTokens = 20_000;
        return { blocks: [{ type: "text", text: "ok" }], toolUses: [] };
      },
    };
    const cm = new ContextManager({
      windowTokens: 10_000,
      triggerRatio: 0.8,
      summarize: async () => "s",
    });
    const session = new AgentSession({
      provider,
      tools: { allToolDefs: () => [], execute: async () => ({ ok: true, content: "" }) } as never,
      permissions: perms(),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      contextManager: cm,
    });
    await session.send("x", () => {});
    expect(captured[0]?.budget).toBe(4096);
    expect(captured[0]?.maxTokens).toBe(8192);
    cm.track({ inputTokens: 16_000 });
    expect(cm.ratio).toBe(0.8); // 16000/20000 after sync
  });

  it("honors maxParallelTools=1 by not overlapping Reads", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const tools = {
      allToolDefs: () => [{ name: "Read", description: "r", input_schema: {} }] as ToolDef[],
      async execute(_name: string, input: Record<string, unknown>) {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 30));
        inflight--;
        return { ok: true, content: String(input.path) };
      },
    };
    const script: ProviderRoundResult[] = [
      {
        blocks: [
          { type: "tool_use", id: "a", name: "Read", input: { path: "1" } },
          { type: "tool_use", id: "b", name: "Read", input: { path: "2" } },
        ],
        toolUses: [
          { id: "a", name: "Read", input: { path: "1" } },
          { id: "b", name: "Read", input: { path: "2" } },
        ],
      },
      { blocks: [{ type: "text", text: "done" }], toolUses: [] },
    ];
    let i = 0;
    const provider: ProviderClient = {
      capabilities: {
        supportsVision: true,
        supportsThinking: true,
        maxParallelTools: 1,
      },
      async round() {
        return script[Math.min(i++, script.length - 1)];
      },
    };
    await new AgentSession({
      provider,
      tools: tools as never,
      permissions: perms(),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
    }).send("go", () => {});
    expect(maxInflight).toBe(1);
  });

  it("shrinks maxTokens when lastInput leaves little room", async () => {
    const captured: number[] = [];
    const cm = new ContextManager({
      windowTokens: 10_000,
      triggerRatio: 0.99,
      summarize: async () => "s",
    });
    cm.track({ inputTokens: 9_000 });
    const provider: ProviderClient = {
      capabilities: {
        supportsVision: true,
        supportsThinking: true,
        contextWindowTokens: 10_000,
        maxOutputTokens: 8192,
      },
      async round(_m, opts) {
        captured.push(opts.maxTokens ?? -1);
        return { blocks: [{ type: "text", text: "ok" }], toolUses: [] };
      },
    };
    await new AgentSession({
      provider,
      tools: { allToolDefs: () => [], execute: async () => ({ ok: true, content: "" }) } as never,
      permissions: perms(),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      contextManager: cm,
    }).send("x", () => {});
    expect(captured[0]).toBe(900);
  });
});
