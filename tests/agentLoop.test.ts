import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AgentSession, clampHistoryTokenBudget, injectTodoIntoMessages } from "../src/agent/agentLoop";
import { CompactionStats } from "../src/agent/compactionStats";
import { PermissionManager } from "../src/agent/permission";
import { PermissionRules } from "../src/agent/permissionRules";
import { ContextManager } from "../src/agent/contextManager";
import { ContextStore } from "../src/context/contextStore";
import type { ProviderClient, ProviderMessage, ProviderRoundResult, ProviderStreamEvent } from "../src/agent/provider/types";
import type { ToolDef, ToolExecContext, ToolExecResult } from "../src/agent/tools/types";
import { TodoManager } from "../src/agent/tools/todoTool";
import { HookRunner } from "../src/hooks/hookRunner";

function fakeProvider(
  script: Array<{ result: ProviderRoundResult }>,
  caps?: { supportsVision?: boolean; supportsThinking?: boolean },
): { provider: ProviderClient; calls: Array<{ messages: ProviderMessage[] }> } {
  const calls: Array<{ messages: ProviderMessage[] }> = [];
  let i = 0;
  const provider: ProviderClient = {
    capabilities: {
      supportsVision: caps?.supportsVision ?? true,
      supportsThinking: caps?.supportsThinking ?? true,
    },
    async round(messages, _opts, _onEvent): Promise<ProviderRoundResult> {
      calls.push({ messages: JSON.parse(JSON.stringify(messages)) });
      return script[Math.min(i++, script.length - 1)].result;
    },
  };
  return { provider, calls };
}

function fakeTools(handlers: Record<string, (input: Record<string, unknown>) => ToolExecResult>): { tools: any } {
  // 真实工具表:覆盖读/写/执行/MCP 四类,供 mode 过滤测试断言「plan 下只剩只读白名单、无 mcp__」。
  const defs: ToolDef[] = [
    { name: "Read", description: "read a file", input_schema: {} },
    { name: "Write", description: "write a file", input_schema: {} },
    { name: "Bash", description: "run a command", input_schema: {} },
    { name: "mcp__demo_server_query", description: "an MCP tool", input_schema: {} },
  ];
  const tools = {
    toolDefs: [] as ToolDef[],
    allToolDefs: () => defs,
    async execute(name: string, input: Record<string, unknown>, _ctx: ToolExecContext): Promise<ToolExecResult> {
      return handlers[name] ? handlers[name](input) : { ok: false, content: "no handler" };
    },
  };
  return { tools };
}

describe("AgentSession", () => {
  it("finishes immediately when no tool use", async () => {
    const { provider } = fakeProvider([{ result: { blocks: [{ type: "text", text: "hi" }], toolUses: [] } }]);
    const session = new AgentSession({ provider, tools: fakeTools({}).tools, permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }), workspaceRoot: "/tmp", systemPrompt: "s" });
    const events: string[] = [];
    await session.send("hello", (ev) => events.push(ev.type));
    expect(events).toContain("done");
  });

  it("includes image blocks in user message when provider supports vision", async () => {
    const { provider, calls } = fakeProvider(
      [{ result: { blocks: [{ type: "text", text: "ok" }], toolUses: [] } }],
      { supportsVision: true },
    );
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
    });
    await session.send("see", () => {}, {
      images: [{ mimeType: "image/png", data: "abc123" }],
    });
    const user = calls[0]?.messages.find((m) => m.role === "user");
    expect(Array.isArray(user?.content)).toBe(true);
    expect(JSON.stringify(user?.content)).toContain('"type":"image"');
    expect(JSON.stringify(user?.content)).toContain("abc123");
  });

  it("strips images from user message when provider lacks vision", async () => {
    const { provider, calls } = fakeProvider(
      [{ result: { blocks: [{ type: "text", text: "ok" }], toolUses: [] } }],
      { supportsVision: false },
    );
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
    });
    await session.send("see", () => {}, {
      images: [{ mimeType: "image/png", data: "abc123" }],
    });
    const user = calls[0]?.messages.find((m) => m.role === "user");
    expect(user?.content).toBe("see");
    expect(JSON.stringify(user)).not.toContain("image");
    expect(JSON.stringify(user)).not.toContain("abc123");
  });

  it("executes a tool round then finishes", async () => {
    const { provider, calls } = fakeProvider([
      { result: { blocks: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a.txt" } }], toolUses: [{ id: "t1", name: "Read", input: { path: "a.txt" } }] } },
      { result: { blocks: [{ type: "text", text: "done" }], toolUses: [] } },
    ]);
    const { tools } = fakeTools({ Read: () => ({ ok: true, content: "contents of a.txt" }) });
    const session = new AgentSession({ provider, tools, permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }), workspaceRoot: "/tmp", systemPrompt: "s" });

    const toolEvents: string[] = [];
    const runningInputs: unknown[] = [];
    await session.send("read", (ev) => {
      if (ev.type === "tool_call") {
        toolEvents.push(`${ev.name}:${ev.status}`);
        if (ev.status === "running") runningInputs.push(ev.input);
      }
    });

    expect(toolEvents).toEqual(["Read:running", "Read:completed"]);
    expect(runningInputs[0]).toEqual({ path: "a.txt" });
    // 第二轮消息含 tool_result
    const second = calls[1]?.messages;
    expect(JSON.stringify(second).includes("tool_result")).toBe(true);
  });

  it("puts all tool_results for one assistant turn into the immediately next user message", async () => {
    // Anthropic 兼容 API:同一条 assistant 里的多个 tool_use,其 tool_result 必须全部出现在紧随其后的那一条 user 消息里,拆成多条会 400。
    const { provider, calls } = fakeProvider([
      {
        result: {
          blocks: [
            { type: "tool_use", id: "t1", name: "Read", input: { path: "a.txt" } },
            { type: "tool_use", id: "t2", name: "Read", input: { path: "b.txt" } },
          ],
          toolUses: [
            { id: "t1", name: "Read", input: { path: "a.txt" } },
            { id: "t2", name: "Read", input: { path: "b.txt" } },
          ],
        },
      },
      { result: { blocks: [{ type: "text", text: "done" }], toolUses: [] } },
    ]);
    const { tools } = fakeTools({
      Read: (input) => ({ ok: true, content: `contents of ${String(input.path)}` }),
    });
    const session = new AgentSession({
      provider,
      tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
    });

    await session.send("read both", () => {});

    const second = calls[1]?.messages ?? [];
    const assistantIdx = second.findIndex(
      (m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use"),
    );
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    const next = second[assistantIdx + 1];
    expect(next?.role).toBe("user");
    expect(Array.isArray(next?.content)).toBe(true);
    const results = (next!.content as Array<{ type: string; tool_use_id?: string }>).filter((b) => b.type === "tool_result");
    expect(results.map((r) => r.tool_use_id).sort()).toEqual(["t1", "t2"]);
    // 不得再跟一条只含另一个 tool_result 的 user 消息
    const after = second[assistantIdx + 2];
    const afterHasOnlyToolResult =
      after?.role === "user" &&
      Array.isArray(after.content) &&
      after.content.every((b) => b.type === "tool_result");
    expect(afterHasOnlyToolResult).toBe(false);
  });

  it("still executes tool_use blocks when provider.toolUses is empty", async () => {
    // 流截断时 client 可能把 tool_use 只留在 blocks 里;loop 必须以 blocks 为准,否则历史带孤儿 tool_use。
    const { provider, calls } = fakeProvider([
      {
        result: {
          blocks: [{ type: "tool_use", id: "t9", name: "Read", input: { path: "z.txt" } }],
          toolUses: [],
        },
      },
      { result: { blocks: [{ type: "text", text: "done" }], toolUses: [] } },
    ]);
    const { tools } = fakeTools({ Read: () => ({ ok: true, content: "z" }) });
    const session = new AgentSession({
      provider,
      tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
    });
    await session.send("read z", () => {});
    expect(JSON.stringify(calls[1]?.messages).includes("tool_result")).toBe(true);
    expect(JSON.stringify(calls[1]?.messages).includes("t9")).toBe(true);
  });

  it("merges toolUses input into persisted blocks when blocks still have empty input", async () => {
    // 回归:SSE stop 曾只更新 toolUses 不写回 blocks,落盘 input={} 诱发后续空 Bash
    const { provider } = fakeProvider([
      {
        result: {
          blocks: [{ type: "tool_use", id: "b1", name: "Bash", input: {} }],
          toolUses: [{ id: "b1", name: "Bash", input: { command: "echo hi" } }],
        },
      },
      { result: { blocks: [{ type: "text", text: "done" }], toolUses: [] } },
    ]);
    const { tools } = fakeTools({ Bash: () => ({ ok: true, content: "exit=0\nhi" }) });
    let persisted: ProviderMessage[] | undefined;
    const session = new AgentSession({
      provider,
      tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      onPersist: (m) => {
        persisted = m;
      },
    });
    await session.send("run", () => {});
    const assistant = (persisted ?? []).find(
      (m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use"),
    ) as { content: Array<{ type: string; name?: string; input?: Record<string, unknown> }> } | undefined;
    const bash = assistant?.content.find((b) => b.type === "tool_use" && b.name === "Bash");
    expect(bash?.input).toEqual({ command: "echo hi" });
  });

  it("reports permission denials", async () => {
    const { provider, calls } = fakeProvider([
      { result: { blocks: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "rm -rf /" } }], toolUses: [{ id: "t1", name: "Bash", input: { command: "rm -rf /" } }] } },
      { result: { blocks: [{ type: "text", text: "ok" }], toolUses: [] } },
    ]);
    const { tools } = fakeTools({ Bash: () => ({ ok: true, content: "ran" }) });
    const permissions = new PermissionManager({ gateway: { request: async () => false }, rules: new PermissionRules() });
    const session = new AgentSession({ provider, tools, permissions, workspaceRoot: "/tmp", systemPrompt: "s" });

    const events: string[] = [];
    await session.send("x", (ev) => { if (ev.type === "tool_call") events.push(`${ev.name}:${ev.status}`); });

    expect(events).toContain("Bash:error");
    expect(JSON.stringify(calls[1]?.messages).includes("Permission denied")).toBe(true);
  });

  it("does not record an assistant event when assistantText is empty on done", async () => {
    const { provider } = fakeProvider([
      // 只输出 thinking,无 text_delta → assistantText 为空
      { result: { blocks: [{ type: "thinking", thinking: "hmm" }], toolUses: [] } },
    ]);
    const recorded: string[] = [];
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      onRecord: (ev) => recorded.push(ev.kind),
    });
    await session.send("x", () => {});
    expect(recorded).toEqual(["user"]);
  });

  it("does not record concatenated assistant text (controller owns text segments)", async () => {
    const provider: ProviderClient = {
      capabilities: { supportsVision: true, supportsThinking: true },
      async round(_messages, _opts, onEvent) {
        onEvent({ type: "text_delta", text: "hi" });
        return { blocks: [{ type: "text", text: "hi" }], toolUses: [] };
      },
    };
    const recorded: string[] = [];
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      onRecord: (ev) => recorded.push(ev.kind),
    });
    await session.send("x", () => {});
    expect(recorded).toEqual(["user"]);
  });

  it("records the RAW user text as the session user event, not the expanded prompt", async () => {
    const provider: ProviderClient = {
      capabilities: { supportsVision: true, supportsThinking: true },
      async round(_messages, _opts, onEvent) {
        onEvent({ type: "text_delta", text: "ok" });
        return { blocks: [{ type: "text", text: "ok" }], toolUses: [] };
      },
    };
    const recorded: Array<{ kind: string; text?: string }> = [];
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      onRecord: (ev) => recorded.push(ev),
    });
    // userText 是展开后的 prompt,rawText 是用户原始输入
    await session.send("[Context: file a.txt]\nxxx", () => {}, { rawText: "read `a.txt`" });
    expect(recorded[0]).toMatchObject({ kind: "user", text: "read `a.txt`" });
  });

  it("does not let an injected ContextManager's compaction failure escape send()", async () => {
    const { provider, calls } = fakeProvider([
      { result: { blocks: [{ type: "text", text: "done" }], toolUses: [] } },
    ]);
    const badCm = {
      needsCompaction: () => true,
      compact: async () => {
        throw new Error("summarize boom");
      },
      track: () => 0,
    } as unknown as ContextManager;
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      contextManager: badCm,
    });
    const info: string[] = [];
    await session.send("hello", (ev) => {
      if (ev.type === "info") info.push(ev.text);
    });
    // 压缩失败不阻断主循环:provider.round 仍被调用,消息含用户输入,会话正常 done
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0].messages).includes("hello")).toBe(true);
    expect(info.some((t) => t.includes("压缩失败"))).toBe(true);
  });

  it("fires SessionStart on creation and Stop at run end", async () => {
    const { provider } = fakeProvider([{ result: { blocks: [{ type: "text", text: "hi" }], toolUses: [] } }]);
    const calls: string[] = [];
    const hooks = new HookRunner(
      [
        { event: "SessionStart", matcher: "", command: "s" },
        { event: "Stop", matcher: "", command: "t" },
      ],
      { run: async (c) => { calls.push(c); return ""; } },
    );
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      hooks,
    });
    expect(calls).toEqual(["s"]); // 构造即触发 SessionStart
    await session.send("hello", () => {});
    expect(calls).toEqual(["s", "t"]); // 运行结束触发 Stop
  });

  it("a failing SessionStart/Stop hook does not break the loop", async () => {
    const warns: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((m: string) => warns.push(m));
    const { provider } = fakeProvider([{ result: { blocks: [{ type: "text", text: "hi" }], toolUses: [] } }]);
    const hooks = new HookRunner(
      [
        { event: "SessionStart", matcher: "", command: "s" },
        { event: "Stop", matcher: "", command: "t" },
      ],
      { run: async () => { throw new Error("boom"); } },
    );
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      hooks,
    });
    const events: string[] = [];
    await session.send("hello", (ev) => events.push(ev.type));
    // fire-and-forget 的 Stop hook 在微任务队列中收尾,flush 后再断言告警已吞掉
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toContain("done");
    // fail-open:两个 hook 都失败,但主循环正常 done,失败只留下 warn 记录
    expect(warns.some((w) => w.includes("SessionStart"))).toBe(true);
    expect(warns.some((w) => w.includes("Stop"))).toBe(true);
    warn.mockRestore();
  });

  it("persists exact tool-paired history via onPersist after a tool round", async () => {
    const { provider } = fakeProvider([
      { result: { blocks: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a.txt" } }], toolUses: [{ id: "t1", name: "Read", input: { path: "a.txt" } }] } },
      { result: { blocks: [{ type: "text", text: "done" }], toolUses: [] } },
    ]);
    const { tools } = fakeTools({ Read: () => ({ ok: true, content: "contents of a.txt" }) });
    let persisted: ProviderMessage[] | undefined;
    const session = new AgentSession({
      provider,
      tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      onPersist: (m) => {
        persisted = m;
      },
    });
    await session.send("read", () => {});
    expect(persisted).toBeDefined();
    // 末次保存的 user 历史含 tool_result,tool_use_id 能对上历史里的 tool_use
    const toolResultUser = (persisted ?? []).find(
      (m) => m.role === "user" && Array.isArray(m.content) && (m.content as unknown[]).some((b) => (b as { type?: string }).type === "tool_result"),
    ) as { content: Array<{ type: string; tool_use_id: string; content: Array<{ type: "text"; text: string }> }> } | undefined;
    expect(toolResultUser).toBeDefined();
    // Anthropic 原生 block 结构:content 为 text block 数组(api-history.json 形状)
    expect(toolResultUser!.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "t1",
      content: [{ type: "text", text: "contents of a.txt" }],
    });
  });

  it("reports real usage + cache tokens via onProviderRound", async () => {
    const { provider } = fakeProvider([
      { result: { blocks: [{ type: "text", text: "done" }], toolUses: [], usage: { inputTokens: 1234, outputTokens: 56, cacheReadTokens: 900, cacheWriteTokens: 334 } } },
    ]);
    const rounds: Array<{ inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }> = [];
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      onProviderRound: (u) => rounds.push(u),
    });
    await session.send("hi", () => {});
    expect(rounds).toEqual([
      { inputTokens: 1234, outputTokens: 56, cacheReadTokens: 900, cacheWriteTokens: 334, phase: "chat", roundMs: expect.any(Number) },
    ]);
  });

  it("compacts with default trigger ratio 0.75 (200000/256000 ≈ 0.781)", async () => {
    const { provider } = fakeProvider([
      {
        result: {
          blocks: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "/tmp/a" } }],
          toolUses: [{ id: "t1", name: "Read", input: { path: "/tmp/a" } }],
          usage: { inputTokens: 200000, outputTokens: 10 },
        },
      },
      { result: { blocks: [{ type: "text", text: "final" }], toolUses: [] } },
    ]);
    let persisted: ProviderMessage[] | undefined;
    const session = new AgentSession({
      provider,
      tools: fakeTools({ Read: () => ({ ok: true, content: "x" }) }).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      initialHistory: [
        { role: "user", content: "h0" },
        { role: "assistant", content: [{ type: "text", text: "h1" }] },
        { role: "user", content: "h2" },
        { role: "assistant", content: [{ type: "text", text: "h3" }] },
        { role: "user", content: "h4" },
      ],
      onPersist: (m) => {
        persisted = m;
      },
    });
    await session.send("g", () => {});
    expect(persisted).toBeDefined();
    // 0.75 阈值触发压缩:历史被替换为分轨压缩块
    expect(JSON.stringify(persisted)).toContain("[compacted]");
    expect(JSON.stringify(persisted)).toContain("## 需求");
  });

  it("uses injected triggerRatio (0.5 triggers at 140800/256000 ≈ 0.55)", async () => {
    const { provider } = fakeProvider([
      {
        result: {
          blocks: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "/tmp/a" } }],
          toolUses: [{ id: "t1", name: "Read", input: { path: "/tmp/a" } }],
          usage: { inputTokens: 140800, outputTokens: 10 },
        },
      },
      { result: { blocks: [{ type: "text", text: "final" }], toolUses: [] } },
    ]);
    let persisted: ProviderMessage[] | undefined;
    const session = new AgentSession({
      provider,
      tools: fakeTools({ Read: () => ({ ok: true, content: "x" }) }).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      triggerRatio: 0.5,
      initialHistory: [
        { role: "user", content: "h0" },
        { role: "assistant", content: [{ type: "text", text: "h1" }] },
        { role: "user", content: "h2" },
        { role: "assistant", content: [{ type: "text", text: "h3" }] },
        { role: "user", content: "h4" },
      ],
      onPersist: (m) => {
        persisted = m;
      },
    });
    await session.send("g", () => {});
    expect(persisted).toBeDefined();
    expect(JSON.stringify(persisted)).toContain("[compacted]");
  });

  it("injects contextStore + sessionId into the built-in ContextManager", async () => {    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aglooptest-"));
    const store = new ContextStore(tmp);
    const { provider } = fakeProvider([
      {
        result: {
          blocks: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "/tmp/a" } }],
          toolUses: [{ id: "t1", name: "Read", input: { path: "/tmp/a" } }],
          usage: { inputTokens: 200000, outputTokens: 10 },
        },
      },
      { result: { blocks: [{ type: "text", text: "final" }], toolUses: [] } },
    ]);
    const session = new AgentSession({
      provider,
      tools: fakeTools({ Read: () => ({ ok: true, content: "x" }) }).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      contextStore: store,
      sessionId: "s9",
      initialHistory: [
        { role: "user", content: "h0" },
        { role: "assistant", content: [{ type: "text", text: "h1" }] },
        { role: "user", content: "h2" },
        { role: "assistant", content: [{ type: "text", text: "h3" }] },
        { role: "user", content: "h4" },
      ],
    });
    await session.send("g", () => {});
    const chunks = store.load("s9");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((c) => c.type === "demand" && c.content === "h0")).toBe(true);
  });

  it("persists compacted history via onPersist after compaction", async () => {    const { provider } = fakeProvider([{ result: { blocks: [{ type: "text", text: "ok" }], toolUses: [] } }]);
    const cm = new ContextManager({
      windowTokens: 100,
      triggerRatio: 0.8,
      summarize: async () => "[前文摘要]",
    });
    cm.track({ inputTokens: 90, outputTokens: 10 }); // ratio 0.9 → 触发压缩
    let persisted: ProviderMessage[] | undefined;
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      contextManager: cm,
      initialHistory: [
        { role: "user", content: "a" },
        { role: "assistant", content: [{ type: "text", text: "b" }] },
        { role: "user", content: "c" },
        { role: "assistant", content: [{ type: "text", text: "d" }] },
        { role: "user", content: "e" },
        { role: "assistant", content: [{ type: "text", text: "f" }] },
      ],
      onPersist: (m) => {
        persisted = m;
      },
    });
    await session.send("g", () => {});
    expect(persisted).toBeDefined();
    // 压缩后的历史:head 替换为摘要,尾部保留
    expect(JSON.stringify(persisted)).toContain("[前文摘要]");
  });

  it("persists rolled-back history when the run is cancelled", async () => {
    let resolveAbort!: () => void;
    const gate = new Promise<void>((r) => { resolveAbort = r; });
    let started!: () => void;
    const startedP = new Promise<void>((r) => { started = r; });
    const { tools } = fakeTools({ Read: () => ({ ok: true, content: "x" }) });
    const provider: ProviderClient = {
      capabilities: { supportsVision: true, supportsThinking: true },
      async round(): Promise<ProviderRoundResult> {
        started();
        await gate;
        return { blocks: [], toolUses: [] };
      },
    };
    let persisted: ProviderMessage[] | undefined;
    const session = new AgentSession({
      provider,
      tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      onPersist: (m) => {
        persisted = m;
      },
    });
    const sendP = session.send("read", () => {});
    await startedP;
    session.cancel();
    resolveAbort();
    await sendP;
    // 取消时也必须落盘:persistNow() 必须位于 if (terminal) 之外
    expect(persisted).toBeDefined();
    // rollback 丢弃本轮用户消息:persisted 应精确等于发送前的空历史
    expect(persisted).toEqual([]);
    const userTexts = (persisted ?? [])
      .filter((m) => m.role === "user" && typeof m.content === "string")
      .map((m) => m.content as string);
    expect(userTexts).not.toContain("read");
  });

  it("rolls back and persists a legal snapshot when a tool executor throws", async () => {
    const { provider } = fakeProvider([
      { result: { blocks: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a.txt" } }], toolUses: [{ id: "t1", name: "Read", input: { path: "a.txt" } }] } },
    ]);
    const { tools } = fakeTools({ Read: () => { throw new Error("boom"); } });
    let persisted: ProviderMessage[] | undefined;
    const events: string[] = [];
    const session = new AgentSession({
      provider,
      tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      onPersist: (m) => {
        persisted = m;
      },
    });
    await session.send("read", (ev) => events.push(ev.type));
    expect(events).toContain("error");
    // 抛出被 catch 回滚:persisted 不应含孤儿 tool_use,也不含本轮用户消息
    const assistantToolUse = (persisted ?? []).find(
      (m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as unknown[]).some((b) => (b as { type?: string }).type === "tool_use"),
    );
    expect(assistantToolUse).toBeUndefined();
    const userTexts = (persisted ?? []).filter((m) => m.role === "user" && typeof m.content === "string").map((m) => m.content as string);
    expect(userTexts).not.toContain("read");
  });

  it("resume: a new session seeded with persisted history sends valid tool pairing", async () => {
    // 会话 A:一轮工具调用 + 完成回复,经 onPersist 捕获持久化历史
    const { provider: pa } = fakeProvider([
      { result: { blocks: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a.txt" } }], toolUses: [{ id: "t1", name: "Read", input: { path: "a.txt" } }] } },
      { result: { blocks: [{ type: "text", text: "done A" }], toolUses: [] } },
    ]);
    const { tools } = fakeTools({ Read: () => ({ ok: true, content: "contents of a.txt" }) });
    let persistedA: ProviderMessage[] | undefined;
    const sessionA = new AgentSession({
      provider: pa,
      tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      onPersist: (m) => {
        persistedA = m;
      },
    });
    await sessionA.send("read", () => {});
    expect(persistedA).toBeDefined();

    // 会话 B:以 A 的持久化历史作为 initialHistory 续跑
    const { provider: pb, calls } = fakeProvider([{ result: { blocks: [{ type: "text", text: "done B" }], toolUses: [] } }]);
    const sessionB = new AgentSession({
      provider: pb,
      tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      initialHistory: persistedA,
    });
    await sessionB.send("继续", () => {});

    const sentMessages = calls[0]?.messages;
    expect(sentMessages).toBeDefined();
    // 每条 tool_result 的 tool_use_id 都必须在历史里存在对应的 tool_use(无孤儿块)
    const toolUseIds = new Set<string>();
    for (const m of sentMessages ?? []) {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const b of m.content as Array<{ type?: string; id?: string }>) {
          if (b.type === "tool_use" && b.id) toolUseIds.add(b.id);
        }
      }
    }
    const toolResultUsers = (sentMessages ?? []).filter(
      (m) => m.role === "user" && Array.isArray(m.content) && (m.content as unknown[]).some((b) => (b as { type?: string }).type === "tool_result"),
    ) as Array<{ content: Array<{ tool_use_id: string }> }>;
    expect(toolResultUsers.length).toBeGreaterThan(0);
    for (const um of toolResultUsers) {
      for (const b of um.content) {
        expect(toolUseIds.has(b.tool_use_id)).toBe(true);
      }
    }
  });

  it("mode=plan filters provider tools to the read-only allowlist", async () => {
    const systems: string[] = [];
    const tools: string[] = [];
    const provider: ProviderClient = {
      capabilities: { supportsVision: true, supportsThinking: true },
      async round(_messages, opts, _onEvent): Promise<ProviderRoundResult> {
        tools.push(...opts.tools.map((t) => t.name));
        systems.push(opts.system);
        return { blocks: [{ type: "text", text: "ok" }], toolUses: [] };
      },
    };
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
    });
    await session.send("read only", () => {}, { mode: "plan" });
    expect(tools).toContain("Read");
    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Bash");
    expect(tools.some((t) => t.startsWith("mcp__"))).toBe(false);
    expect(systems[0]).toContain("Plan 模式");
  });

  it("mode=plan hard-rejects a Write call with an error tool_result", async () => {
    const { provider } = fakeProvider([
      { result: { blocks: [{ type: "tool_use", id: "w1", name: "Write", input: { path: "a.ts", contents: "x" } }], toolUses: [{ id: "w1", name: "Write", input: { path: "a.ts", contents: "x" } }] } },
      // 第二轮必须给「done」终态:ERROR tool_result 回喂后若仍只回 Write,循环会硬拒到 maxRounds,事件数就不是 1 了
      { result: { blocks: [{ type: "text", text: "ok" }], toolUses: [] } },
    ]);
    const executed: string[] = [];
    const { tools } = fakeTools({ Write: () => { executed.push("write"); return { ok: true, content: "done" }; } });
    const session = new AgentSession({
      provider,
      tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
    });
    const toolStatuses: string[] = [];
    await session.send("try write", (ev) => {
      if (ev.type === "tool_call") toolStatuses.push(ev.status);
    }, { mode: "plan" });
    expect(executed).toEqual([]); // 未执行
    expect(toolStatuses).toEqual(["error"]);
  });
});

describe("AgentSession thinking compaction wiring", () => {
  /** 含 thinking 块的历史:head 中 assistant h1 带 thinking,压缩时会被处理。 */
  const thinkingHistory: ProviderMessage[] = [
    { role: "user", content: "h0" },
    { role: "assistant", content: [{ type: "thinking", thinking: "内部推理 h1 长链路…" }, { type: "text", text: "h1 结论" }] },
    { role: "user", content: "h2" },
    { role: "assistant", content: [{ type: "thinking", thinking: "内部推理 h3 长链路…" }, { type: "text", text: "h3 结论" }] },
    { role: "user", content: "h4" },
  ];

  it("calls setThinkingEnabled(false) before compacting in plan mode", async () => {
    const { provider } = fakeProvider([
      { result: { blocks: [{ type: "text", text: "done" }], toolUses: [] } },
    ]);
    const toggles: boolean[] = [];
    const cm = {
      needsCompaction: () => true,
      setThinkingEnabled: (v: boolean) => void toggles.push(v),
      compact: async (msgs: ProviderMessage[]) => msgs,
      track: () => 0,
    } as unknown as ContextManager;
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      contextManager: cm,
    });
    await session.send("hello", () => {}, { mode: "plan" });
    expect(toggles).toEqual([false]);
  });

  it("calls setThinkingEnabled(true) before compacting in agent mode", async () => {
    const { provider } = fakeProvider([
      { result: { blocks: [{ type: "text", text: "done" }], toolUses: [] } },
    ]);
    const toggles: boolean[] = [];
    const cm = {
      needsCompaction: () => true,
      setThinkingEnabled: (v: boolean) => void toggles.push(v),
      compact: async (msgs: ProviderMessage[]) => msgs,
      track: () => 0,
    } as unknown as ContextManager;
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      contextManager: cm,
    });
    await session.send("hello", () => {}, { mode: "agent" });
    expect(toggles).toEqual([true]);
  });

  it("injects THINKING_COMPACTION_RULES into summarize in agent mode but not in plan mode", async () => {
    const systems: string[] = [];
    const provider: ProviderClient = {
      capabilities: { supportsVision: true, supportsThinking: true },
      async round(messages, opts) {
        systems.push(opts.system);
        if (systems.length === 1) {
          return {
            blocks: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "/tmp/a" } }],
            toolUses: [{ id: "t1", name: "Read", input: { path: "/tmp/a" } }],
            usage: { inputTokens: 200000, outputTokens: 10 },
          };
        }
        return { blocks: [{ type: "text", text: "S" }], toolUses: [] };
      },
    };
    const session = new AgentSession({
      provider,
      tools: fakeTools({ Read: () => ({ ok: true, content: "x" }) }).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      initialHistory: thinkingHistory,
    });
    await session.send("g", () => {}, { mode: "agent" });
    // 第二轮压缩:summarizeMessages 收到 thinking 压缩规则
    expect(systems.some((s) => s.includes("## 正确"))).toBe(true);
  });

  it("emits a thinking block after compaction in agent mode, absent in plan mode", async () => {
    const make = async (mode: "agent" | "plan"): Promise<string> => {
      let persisted = "";
      const { provider } = fakeProvider([
        { result: { blocks: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "/tmp/a" } }], toolUses: [{ id: "t1", name: "Read", input: { path: "/tmp/a" } }], usage: { inputTokens: 200000, outputTokens: 10 } } },
        { result: { blocks: [{ type: "text", text: "S" }], toolUses: [] } },
        { result: { blocks: [{ type: "text", text: "final" }], toolUses: [] } },
      ]);
      const session = new AgentSession({
        provider,
        tools: fakeTools({ Read: () => ({ ok: true, content: "x" }) }).tools,
        permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
        workspaceRoot: "/tmp",
        systemPrompt: "s",
        initialHistory: thinkingHistory,
        onPersist: (m) => {
          persisted = JSON.stringify(m);
        },
      });
      await session.send("g", () => {}, { mode });
      return persisted;
    };
    const agent = await make("agent");
    expect(agent).toContain("[thinking]");
    const plan = await make("plan");
    expect(plan).not.toContain("[thinking]");
  });

  it("emits compaction_stats per conversation and counts thinking compactions", async () => {
    const stats = new CompactionStats();
    const { provider } = fakeProvider([
      { result: { blocks: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "/tmp/a" } }], toolUses: [{ id: "t1", name: "Read", input: { path: "/tmp/a" } }], usage: { inputTokens: 200000, outputTokens: 10 } } },
      { result: { blocks: [{ type: "text", text: "摘要" }], toolUses: [] } },
      { result: { blocks: [{ type: "text", text: "S" }], toolUses: [] } },
      { result: { blocks: [{ type: "text", text: "final" }], toolUses: [] } },
    ]);
    const session = new AgentSession({
      provider,
      tools: fakeTools({ Read: () => ({ ok: true, content: "x" }) }).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      stats,
      initialHistory: thinkingHistory,
    });
    const statsEvents: Array<{ windowConversations: number; windowCompactions: number }> = [];
    await session.send("g", (ev) => {
      if (ev.type === "compaction_stats") statsEvents.push(ev.stats);
    });
    // 一次对话计一轮;历史含 thinking + ratio 0.781 ≥ 0.75 → thinking 压缩至少一次
    const snap = stats.snapshot();
    expect(snap.totalConversations).toBe(1);
    expect(snap.windowConversations).toBe(1);
    expect(snap.windowCompactions).toBeGreaterThanOrEqual(1);
    // UI 事件:send 开始时推送一次,每次压缩后推送
    expect(statsEvents.length).toBeGreaterThanOrEqual(2);
    expect(statsEvents[0].windowConversations).toBe(1);
  });

  it("counts manual compactNow thinking compactions without adding a conversation", async () => {
    const stats = new CompactionStats();
    const { provider } = fakeProvider([
      { result: { blocks: [{ type: "text", text: "ok" }], toolUses: [] } },
      { result: { blocks: [{ type: "text", text: "摘要" }], toolUses: [] } },
      { result: { blocks: [{ type: "text", text: "S" }], toolUses: [] } },
    ]);
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      stats,
      initialHistory: thinkingHistory,
    });
    await session.send("g", () => {});
    const before = stats.snapshot().windowCompactions;
    await session.compactNow(); // 手动压缩:不计对话,但 thinking 压缩计入成本
    expect(stats.snapshot().windowCompactions).toBe(before + 1);
    expect(stats.snapshot().totalConversations).toBe(1);
  });

  it("thinkingProcessEnabled=false decouples processing from model-side request budget", async () => {
    const seen: Array<{ thinkingDisabled?: boolean; thinkingBudgetTokens?: number }> = [];
    const allMessages: ProviderMessage[][] = [];
    const provider: ProviderClient = {
      capabilities: { supportsVision: true, supportsThinking: true, thinkingBudgetTokens: 4096 },
      async round(messages, opts) {
        seen.push({ thinkingDisabled: opts.thinkingDisabled, thinkingBudgetTokens: opts.thinkingBudgetTokens });
        allMessages.push(messages.map((m) => ({ ...m })));
        // 第一轮:产 thinking + tool_use(模型侧重开,产生 thinking);处理侧关会剥离 thinking
        if (seen.length === 1) {
          return {
            blocks: [
              { type: "thinking", thinking: "内部推理…" },
              { type: "tool_use", id: "t1", name: "Read", input: { path: "/tmp/a" } },
            ],
            toolUses: [{ id: "t1", name: "Read", input: { path: "/tmp/a" } }],
            usage: { inputTokens: 1000, outputTokens: 10 },
          };
        }
        // 后续轮:收敛为纯文本,终止循环
        return { blocks: [{ type: "text", text: "done" }], toolUses: [], usage: { inputTokens: 1000, outputTokens: 5 } };
      },
    };
    const session = new AgentSession({
      provider,
      tools: fakeTools({ Read: () => ({ ok: true, content: "x" }) }).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      thinkingProcessEnabled: false, // 处理侧关
      initialHistory: [],
    });
    await session.send("g", () => {});
    // 请求仍带 thinking 预算(模型侧重开不受处理侧影响)
    for (const c of seen) {
      expect(c.thinkingBudgetTokens).toBe(4096);
      expect(c.thinkingDisabled).toBeUndefined(); // 模型侧重开:不强制 thinkingDisabled
    }
    // 历史里第一条 assistant 消息不含 thinking(处理侧剥离)
    const assistantMsgs = allMessages.flatMap((m) => m).filter((m) => m.role === "assistant" && Array.isArray(m.content));
    for (const a of assistantMsgs) {
      for (const b of a.content as Array<{ type: string }>) {
        expect(b.type).not.toBe("thinking");
      }
    }
  });
});

describe("AgentSession summarize budget", () => {
  it("caps the summarize request maxTokens to the compaction budget (800 for explanations)", async () => {
    const capturedMax: number[] = [];
    const provider: ProviderClient = {
      capabilities: { supportsVision: true, supportsThinking: true, maxOutputTokens: 8192 },
      async round(messages, opts) {
        capturedMax.push(opts.maxTokens ?? 0);
        if (capturedMax.length === 1) {
          return {
            blocks: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "/tmp/a" } }],
            toolUses: [{ id: "t1", name: "Read", input: { path: "/tmp/a" } }],
            usage: { inputTokens: 200000, outputTokens: 10 },
          };
        }
        return { blocks: [{ type: "text", text: "摘要结果" }], toolUses: [] };
      },
    };
    const session = new AgentSession({
      provider,
      tools: fakeTools({ Read: () => ({ ok: true, content: "x" }) }).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      initialHistory: [
        { role: "user", content: "需求" },
        { role: "assistant", content: [{ type: "text", text: "开场结论\n\n" + "中间长解释内容".repeat(200) + "\n\n结尾结论" }] },
        { role: "user", content: "h2" },
        { role: "assistant", content: [{ type: "text", text: "h3" }] },
        { role: "user", content: "h4" },
      ],
    });
    await session.send("g", () => {});
    // 第一轮 tool_use(180000 触发压缩);第二轮压缩时 explanation 摘要请求预算 800
    expect(capturedMax[1]).toBe(800);
  });
});

describe("AgentSession history token budget wiring", () => {
  it("passes budget into self-built ContextManager and compacts within it", async () => {
    const { provider, calls } = fakeProvider([
      { result: { blocks: [{ type: "text", text: "done" }], toolUses: [] } },
    ]);
    const history: ProviderMessage[] = Array.from({ length: 8 }, () => ({ role: "user", content: "中".repeat(50) }));
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      initialHistory: history,
      triggerRatio: 0, // 立即触发压缩
      historyTokenBudget: 1000, // tail 35% = 350;v2 目标 = 175 → 保留 m5..m7+hello(≈152)
    });
    await session.send("hello", () => {});
    const sent = calls[0].messages;
    // [压缩块, ...tail]
    expect(String((sent[0].content as string))).toContain("[compacted]");
    // tail 4 条 = m5..m7 + hello;v2 目标线下 m0..m4 被压缩
    expect(sent).toHaveLength(5);
    expect(sent[sent.length - 1]).toMatchObject({ role: "user", content: "hello" });
  });

  it("falls back to legacy keepTail=4 when budget is 0", async () => {
    const { provider, calls } = fakeProvider([
      { result: { blocks: [{ type: "text", text: "done" }], toolUses: [] } },
    ]);
    const history: ProviderMessage[] = Array.from({ length: 8 }, () => ({ role: "user", content: "中".repeat(50) }));
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      initialHistory: history,
      triggerRatio: 0,
      historyTokenBudget: 0, // 关闭 → 现状 keepTail=4
    });
    await session.send("hello", () => {});
    const sent = calls[0].messages;
    expect(String((sent[0].content as string))).toContain("[compacted]");
    // [压缩块, m5..m7(3 条), hello] = 5 条
    expect(sent).toHaveLength(5);
    expect(sent[sent.length - 1]).toMatchObject({ role: "user", content: "hello" });
  });
});

describe("AgentSession pipeline v2 wiring", () => {
  it("compacts from tail self-driven trigger even when window ratio is low", async () => {
    const calls: Array<{ messages: ProviderMessage[] }> = [];
    const provider: ProviderClient = {
      capabilities: { supportsVision: true, supportsThinking: true },
      async round(messages, _opts, _onEvent) {
        calls.push({ messages: JSON.parse(JSON.stringify(messages)) });
        return { blocks: [{ type: "text", text: "done" }], toolUses: [] };
      },
    };
    const history: ProviderMessage[] = Array.from({ length: 8 }, () => ({ role: "user", content: "中".repeat(50) }));
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      initialHistory: history,
      triggerRatio: 1.0, // 窗口兜底永不触发
      historyTokenBudget: 400, // tail 额定 140,trigger 75% = 105;8×50=400 ≥ 105 → tail 自驱动压缩
    });
    await session.send("hello", () => {});
    const sent = calls[0].messages;
    expect(String((sent[0].content as string))).toContain("[compacted]");
  });

  it("windowTokensOverride narrows the max output budget (prepareRound bound)", async () => {
    const seen: Array<{ maxTokens?: number }> = [];
    const provider: ProviderClient = {
      capabilities: { supportsVision: true, supportsThinking: true },
      async round(_messages, opts, _onEvent) {
        seen.push({ maxTokens: opts?.maxTokens });
        return { blocks: [{ type: "text", text: "done" }], toolUses: [] };
      },
    };
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      windowTokensOverride: 2000, // 默认 256K → maxTokens=8192;覆盖后 room≈1980 < 8192
    });
    await session.send("hi", () => {});
    expect(seen[0].maxTokens).toBeLessThan(8192);
  });
});

describe("AgentSession compaction events wiring", () => {
  it("passes onCompaction through to the self-built ContextManager", async () => {
    const { provider } = fakeProvider([
      { result: { blocks: [{ type: "text", text: "done" }], toolUses: [] } },
    ]);
    const events: Array<import("../src/stats/compactionEvents").CompactionRecord> = [];
    const history: ProviderMessage[] = Array.from({ length: 8 }, () => ({ role: "user", content: "中".repeat(50) }));
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      initialHistory: history,
      triggerRatio: 0, // 立即触发窗口兜底压缩
      historyTokenBudget: 1000, // 预算模式:压缩前 head(5 条×50) > 压缩后块(≈219)
      onCompaction: (ev) => events.push(ev),
    });
    await session.send("hello", () => {});
    expect(events.length).toBeGreaterThan(0);
    const tailEv = events.find((e) => e.position === "tail");
    expect(tailEv).toBeDefined();
    expect(tailEv!.reason).toBe("window_ratio");
    expect(tailEv!.beforeTokens).toBeGreaterThan(tailEv!.afterTokens);
    expect(tailEv!.headCount).toBe(5); // m0..m4(含 hello 后共 9 条,head=5)
    expect(tailEv!.tailCount).toBe(4); // m5..m7 + hello
  });
});

describe("AgentSession toolResult tail trimming", () => {
  function bigBashOutput(): string {
    const rows: string[] = ["exit=0"];
    for (let i = 0; i < 100; i++) rows.push(`行${i} ` + "内容内容内容内容内容内容内容内容内容内容");
    return rows.join("\n");
  }

  function bigWebOutput(): string {
    const rows: string[] = ["exit=0"];
    for (let i = 0; i < 200; i++) rows.push(`行${i} ` + "内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容");
    return rows.join("\n");
  }

  function sessionDeps(initialHistory: ProviderMessage[]) {
    const { provider, calls } = fakeProvider([{ result: { blocks: [{ type: "text", text: "done" }], toolUses: [] } }]);
    const breakdowns: Array<{ totalTokens: number; toolResultTokens: number; messageBreakdown: Array<{ kind: string; tokens: number }> }> = [];
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      initialHistory,
      onProviderSend: (b) =>
        breakdowns.push({
          totalTokens: b.totalTokens,
          toolResultTokens: b.toolResultTokens,
          messageBreakdown: b.messageBreakdown.map((p) => ({ kind: p.kind, tokens: p.tokens })),
        }),
    });
    return { session, calls, breakdowns };
  }

  it("replaces consumed big WebFetch toolResult with trimmed marker before send", async () => {
    const initialHistory: ProviderMessage[] = [
      { role: "user", content: "需求" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "先抓页面" },
          { type: "tool_use", id: "t1", name: "WebFetch", input: { url: "https://example.com" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: bigWebOutput() }] }],
      },
      { role: "assistant", content: [{ type: "text", text: "我看到了输出" }] },
    ];
    const { session, calls, breakdowns } = sessionDeps(initialHistory);
    await session.send("继续", () => {});

    const sent = calls[0]!.messages;
    const resultMsg = sent.find((m) => m.role === "user" && Array.isArray(m.content) && (m.content as any[]).some((b) => b.type === "tool_result"));
    expect(resultMsg).toBeDefined();
    const text = (resultMsg!.content as any[])[0].content[0].text as string;
    expect(text.startsWith("[tool-result-trimmed]")).toBe(true);
    expect(text).toContain("exit=0");
    expect(text).toContain("行199");
    // 保留 head40+tail40+折叠 ≈ 81 行,明显小于原始 200 行
    expect(text.length).toBeLessThan(bigWebOutput().length * 0.6);

    // 打点反映精简后真实发送:tool_result tokens 远小于原始(~8800)
    expect(breakdowns.length).toBeGreaterThan(0);
    const b = breakdowns[0]!;
    expect(b.toolResultTokens).toBeLessThan(4000);
    const trPart = b.messageBreakdown.find((p) => p.kind === "tool_result");
    expect(trPart!.tokens).toBeLessThan(4000);
  });

  it("keeps latest unconsumed toolResult as-is", async () => {
    const initialHistory: ProviderMessage[] = [
      { role: "user", content: "需求" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "小文件内容" }] }],
      },
    ];
    const { session, calls } = sessionDeps(initialHistory);
    await session.send("继续", () => {});

    const sent = calls[0]!.messages;
    const resultMsg = sent.find((m) => m.role === "user" && Array.isArray(m.content) && (m.content as any[]).some((b) => b.type === "tool_result"));
    const text = (resultMsg!.content as any[])[0].content[0].text as string;
    expect(text.startsWith("[tool-result-trimmed]")).toBe(false);
    expect(text).toBe("小文件内容");
  });

  it("does not trim high-density Read result even when consumed and huge", async () => {
    const bigFile = "文件内容" + "内容内容内容内容内容内容内容内容".repeat(200);
    const initialHistory: ProviderMessage[] = [
      { role: "user", content: "读文件" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: bigFile }] }],
      },
      { role: "assistant", content: [{ type: "text", text: "分析完了" }] },
    ];
    const { session, calls } = sessionDeps(initialHistory);
    await session.send("继续", () => {});

    const sent = calls[0]!.messages;
    const resultMsg = sent.find((m) => m.role === "user" && Array.isArray(m.content) && (m.content as any[]).some((b) => b.type === "tool_result"));
    const text = (resultMsg!.content as any[])[0].content[0].text as string;
    expect(text.startsWith("[tool-result-trimmed]")).toBe(false);
    expect(text).toBe(bigFile);
  });

  it("P1: writes trim-class tool result as final form at write time (not send-pre), keeping prefix stable", async () => {
    // 第一轮 provider 触发 WebFetch 工具,本地执行产生超大输出;agentLoop 将 tool_result
    // push 前(写前定型)就按 planToolResultTrim 裁剪,使该块自首次进入消息即字节恒定。
    const { provider, calls } = fakeProvider([
      { result: { blocks: [{ type: "tool_use", id: "t1", name: "WebFetch", input: { url: "https://example.com" } }], toolUses: [{ id: "t1", name: "WebFetch", input: { url: "https://example.com" } }] } },
      { result: { blocks: [{ type: "text", text: "done" }], toolUses: [] } },
    ]);
    const tools = fakeTools({ WebFetch: () => ({ ok: true, content: bigWebOutput() }) }).tools;
    const session = new AgentSession({
      provider,
      tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
    });
    const events: string[] = [];
    await session.send("跑命令", (ev) => events.push(ev.type));
    expect(events).toContain("done");

    // 第二轮 round 发送的 tool_result 应已是定型的精简形态(写前定型,而非发送前二次替换)。
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const round2 = calls[1]!.messages;
    const resultMsg = round2.find((m) => m.role === "user" && Array.isArray(m.content) && (m.content as any[]).some((b) => b.type === "tool_result"));
    expect(resultMsg).toBeDefined();
    const text = (resultMsg!.content as any[])[0].content[0].text as string;
    expect(text.startsWith("[tool-result-trimmed]")).toBe(true);
    expect(text).toContain("exit=0");
    expect(text.length).toBeLessThan(bigWebOutput().length * 0.6);

    // 持久 history 中该 tool_result 已在 push 时定型(messages 已含定型态),
    // 证明不是等到发送前 trimConsumedToolResults 才替换。
    // 再跑一轮:形态应保持不变(已在消息中定型,无二次「原始→精简」转变)。
    await session.send("继续", () => {});
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const round3 = calls[2]!.messages;
    const resultMsg3 = round3.find((m) => m.role === "user" && Array.isArray(m.content) && (m.content as any[]).some((b) => b.type === "tool_result"));
    const text3 = (resultMsg3!.content as any[])[0].content[0].text as string;
    expect(text3).toBe(text);
  });
});

describe("AgentSession toolUse tail trimming", () => {
  function sessionDeps(initialHistory: ProviderMessage[]) {
    const { provider, calls } = fakeProvider([{ result: { blocks: [{ type: "text", text: "done" }], toolUses: [] } }]);
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      initialHistory,
    });
    return { session, calls };
  }

  it("replaces consumed Write contents with transient summary, keeping path", async () => {
    const initialHistory: ProviderMessage[] = [
      { role: "user", content: "写文件" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Write", input: { path: "src/foo.ts", contents: "内容".repeat(500) } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "Wrote src/foo.ts" }] }] },
      { role: "assistant", content: [{ type: "text", text: "写完了" }] },
    ];
    const { session, calls } = sessionDeps(initialHistory);
    await session.send("继续", () => {});

    const sent = calls[0]!.messages;
    const assistantMsg = sent.find((m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as any[]).some((b) => b.type === "tool_use"));
    const block = (assistantMsg!.content as any[]).find((b) => b.type === "tool_use");
    expect(block.input.path).toBe("src/foo.ts");
    expect(block.input.contents).toContain("[TRANSIENT-SUMMARY");
    expect(block.id).toBe("t1");
  });

  it("keeps latest unconsumed toolUse as-is", async () => {
    const initialHistory: ProviderMessage[] = [
      { role: "user", content: "写文件" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Write", input: { path: "src/foo.ts", contents: "内容".repeat(500) } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "Wrote src/foo.ts" }] }] },
    ];
    const { session, calls } = sessionDeps(initialHistory);
    await session.send("继续", () => {});

    const sent = calls[0]!.messages;
    const assistantMsg = sent.find((m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as any[]).some((b) => b.type === "tool_use"));
    const block = (assistantMsg!.content as any[]).find((b) => b.type === "tool_use");
    expect(block.input.contents).toBe("内容".repeat(500));
  });

  it("keeps Read toolUse (no transient fields) even when consumed", async () => {
    const initialHistory: ProviderMessage[] = [
      { role: "user", content: "读文件" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a" }] }] },
      { role: "assistant", content: [{ type: "text", text: "读完了" }] },
    ];
    const { session, calls } = sessionDeps(initialHistory);
    await session.send("继续", () => {});

    const sent = calls[0]!.messages;
    const assistantMsg = sent.find((m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as any[]).some((b) => b.type === "tool_use"));
    const block = (assistantMsg!.content as any[]).find((b) => b.type === "tool_use");
    expect(block.input).toEqual({ path: "a.ts" });
  });

  it("P3: shapes trim-class tool_use at persist time (first entry), keeping prefix stable", async () => {
    // 第一轮 provider 返回带大瞬时参数的 Write;落盘前(而非消费后发送前)就定型为最终形态,
    // 使该块自首次进入前缀起字节恒定,根治「原始 → 精简」两次形态导致的缓存前缀断裂。
    const { provider, calls } = fakeProvider([
      {
        result: {
          blocks: [{ type: "tool_use", id: "t1", name: "Write", input: { path: "src/foo.ts", contents: "内容".repeat(500) } }],
          toolUses: [{ id: "t1", name: "Write", input: { path: "src/foo.ts", contents: "内容".repeat(500) } }],
        },
      },
      { result: { blocks: [{ type: "text", text: "done" }], toolUses: [] } },
    ]);
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
    });
    await session.send("写文件", () => {});

    // 第二轮发送的 messages 里 tool_use 已是定型形态(写前定型,非消费后改写)。
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const round2 = calls[1]!.messages;
    const assistantMsg = round2.find((m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as any[]).some((b) => b.type === "tool_use"));
    const block = (assistantMsg!.content as any[]).find((b) => b.type === "tool_use");
    expect(block.input.path).toBe("src/foo.ts");
    expect(block.input.contents).toContain("[TRANSIENT-SUMMARY");

    // 第三轮形态不变:已定型块不因兜底 trimConsumedToolUses 二次改写。
    await session.send("继续", () => {});
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const round3 = calls[2]!.messages;
    const assistantMsg3 = round3.find((m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as any[]).some((b) => b.type === "tool_use"));
    const block3 = (assistantMsg3!.content as any[]).find((b) => b.type === "tool_use");
    expect(block3.input.contents).toBe(block.input.contents);
  });
});

describe("AgentSession thinking tail trimming", () => {
  function sessionDeps(initialHistory: ProviderMessage[]) {
    const { provider, calls } = fakeProvider([{ result: { blocks: [{ type: "text", text: "done" }], toolUses: [] } }]);
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      initialHistory,
    });
    return { session, calls };
  }

  function bigThinking(): string {
    return Array.from({ length: 60 }, (_, i) => `推理第 ${i} 行:` + "内容内容内容内容内容内容内容内容").join("\n");
  }

  it("trims consumed big thinking keeping tail conclusion", async () => {
    const initialHistory: ProviderMessage[] = [
      { role: "user", content: "需求" },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: bigThinking() }, { type: "text", text: "结论一" }],
      },
      { role: "assistant", content: [{ type: "text", text: "第二轮" }] },
    ];
    const { session, calls } = sessionDeps(initialHistory);
    await session.send("继续", () => {});

    const sent = calls[0]!.messages;
    const first = sent.find((m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as any[]).some((b) => b.type === "thinking"));
    const block = (first!.content as any[]).find((b) => b.type === "thinking");
    expect(block.thinking).toContain("[thinking-trimmed");
    expect(block.thinking).toContain("推理第 59 行");
    expect(block.thinking).not.toContain("推理第 0 行");
    expect(block.thinking.length).toBeLessThan(bigThinking().length / 2);
  });

  it("keeps latest unconsumed thinking as-is", async () => {
    const initialHistory: ProviderMessage[] = [
      { role: "user", content: "需求" },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: bigThinking() }, { type: "text", text: "结论一" }],
      },
    ];
    const { session, calls } = sessionDeps(initialHistory);
    await session.send("继续", () => {});

    const sent = calls[0]!.messages;
    const first = sent.find((m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as any[]).some((b) => b.type === "thinking"));
    const block = (first!.content as any[]).find((b) => b.type === "thinking");
    expect(block.thinking).toBe(bigThinking());
  });

  it("keeps small thinking even when consumed", async () => {
    const initialHistory: ProviderMessage[] = [
      { role: "user", content: "需求" },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "短思考" }, { type: "text", text: "结论一" }],
      },
      { role: "assistant", content: [{ type: "text", text: "第二轮" }] },
    ];
    const { session, calls } = sessionDeps(initialHistory);
    await session.send("继续", () => {});

    const sent = calls[0]!.messages;
    const first = sent.find((m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as any[]).some((b) => b.type === "thinking"));
    const block = (first!.content as any[]).find((b) => b.type === "thinking");
    expect(block.thinking).toBe("短思考");
  });

  it("collapses old consumed thinking beyond recent N to one-line (N=15)", async () => {
    const mk = (n: number) => ({
      role: "assistant" as const,
      content: [
        { type: "thinking" as const, thinking: `轮次${n}推理\n轮次${n}结论` },
        { type: "text" as const, text: `结论${n}` },
      ],
    });
    const initialHistory: ProviderMessage[] = [
      { role: "user", content: "需求" },
      ...Array.from({ length: 16 }, (_, i) => mk(i + 1)),
      { role: "assistant", content: [{ type: "text", text: "最终结论" }] },
    ];
    const { session, calls } = sessionDeps(initialHistory);
    await session.send("继续", () => {});
    const sent = calls[0]!.messages;
    const blocks = sent
      .filter((m) => m.role === "assistant" && Array.isArray(m.content))
      .flatMap((m) => (m.content as any[]).filter((b) => b.type === "thinking"))
      .map((b) => b.thinking as string);

    // 16 条已消费 thinking:最近 15 条保留,最旧 1 条压成一行
    expect(blocks).toHaveLength(16);
    const olds = blocks.filter((t) => t.startsWith("[thinking-old:"));
    expect(olds).toHaveLength(1);
    expect(olds[0]).toContain("轮次1结论");
    expect(olds[0]).not.toContain("轮次1推理");
    const recent = blocks.filter((t) => !t.startsWith("[thinking-old:"));
    // 其余 15 条:短 thinking(≤150)原样保留
    expect(recent.filter((t) => !t.startsWith("[thinking-trimmed")).length).toBe(15);
  });

  it("P3: shapes oversized thinking at persist time (first entry), keeping prefix stable", async () => {
    // 第一轮 provider 返回超阈值 thinking;落盘前即定型(保留尾部结论),首次进入前缀即最终形态,
    // 发送前 trimConsumedThinking 只做幂等兜底,不产生「原始 → 精简」二次形态。
    const { provider, calls } = fakeProvider([
      { result: { blocks: [{ type: "thinking", thinking: bigThinking() }], toolUses: [] } },
      { result: { blocks: [{ type: "text", text: "done" }], toolUses: [] } },
    ]);
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
    });
    await session.send("x", () => {});
    expect(calls.length).toBe(1); // 首轮 thinking 无 tool_use → 直接 done

    // 第二轮发送:thinking 已定型(保留尾部结论行 + 截断标记)。
    await session.send("继续", () => {});
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const round2 = calls[1]!.messages;
    const assistantMsg = round2.find((m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as any[]).some((b) => b.type === "thinking"));
    const block = (assistantMsg!.content as any[]).find((b) => b.type === "thinking");
    expect(block.thinking).toContain("[thinking-trimmed");
    expect(block.thinking).toContain("推理第 59 行");
    expect(block.thinking).not.toContain("推理第 0 行");

    // 第三轮形态不变:幂等兜底不再二次改写(planThinkingTrim 已含标记 → keep)。
    await session.send("继续", () => {});
    expect(calls.length).toBeGreaterThanOrEqual(3);

    const round3 = calls[2]!.messages;
    const assistantMsg3 = round3.find((m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as any[]).some((b) => b.type === "thinking"));
    const block3 = (assistantMsg3!.content as any[]).find((b) => b.type === "thinking");
    expect(block3.thinking).toBe(block.thinking);
  });
});

describe("clampHistoryTokenBudget", () => {
  it("keeps budget below window clamp as-is", () => {
    expect(clampHistoryTokenBudget(64000, 256000)).toBe(64000);
  });
  it("clamps oversized budget to window*0.7 minus system reserve", () => {
    // 128K 窗口:128000*0.7-4096 = 85504
    expect(clampHistoryTokenBudget(256000, 128000)).toBe(85504);
  });
  it("keeps 0 (disabled) as 0", () => {
    expect(clampHistoryTokenBudget(0, 256000)).toBe(0);
  });
  it("keeps undefined as undefined", () => {
    expect(clampHistoryTokenBudget(undefined, 256000)).toBe(undefined);
  });
  it("A5: 自动压缩后触发 compaction_qa 抽查(独立 provider.round,不含 onProviderRound 污染)", async () => {
    const { provider } = fakeProvider([
      { result: { blocks: [{ type: "text", text: "done" }], toolUses: [] } },
    ]);
    const qas: any[] = [];
    const rounds: any[] = [];
    const history: ProviderMessage[] = [
      { role: "user", content: "[r1] 需求:做一个登录页" },
      { role: "assistant", content: [{ type: "text", text: "结论:用表单 + JWT" }] },
      { role: "user", content: "[r3] 继续:加注册接口" },
      ...Array.from({ length: 5 }, () => ({ role: "user" as const, content: "中".repeat(50) })),
    ];
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      initialHistory: history,
      triggerRatio: 0, // 立即触发窗口兜底压缩
      historyTokenBudget: 1000, // 预算模式触发压缩
      onProviderRound: (u) => rounds.push(u),
      onCompactionQa: (ev) => qas.push(ev),
    });
    await session.send("hello", () => {});
    expect(qas.length).toBeGreaterThan(0);
    const qa = qas[0];
    expect(typeof qa.answerable).toBe("boolean");
    expect(qa.qaMs).toBeGreaterThanOrEqual(0);
    expect(typeof qa.seq).toBe("number");
    // QA 的 provider.round 不打 onProviderRound(不污染对话轮次统计)
    expect(rounds.filter((r) => r.phase === "compact").length).toBe(0);
  });
});

describe("todo 注入: 可并入 user 则改消息尾部,否则不注入(绝不进 system、绝不追加伪 user)", () => {
  it("injectTodoIntoMessages: 尾部为 user 时合并入最后一条 content", () => {
    const base: ProviderMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: "see" },
    ];
    const out = injectTodoIntoMessages(base, "## 任务清单\n- [ ] a (t1)");
    expect(out).toHaveLength(2);
    const last = out[out.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe("## 任务清单\n- [ ] a (t1)\n\nsee");
    expect(base[1].content).toBe("see");
  });

  it("injectTodoIntoMessages: 尾部为 assistant 时不注入,原样返回(绝不追加伪 user)", () => {
    const base: ProviderMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
    ];
    const out = injectTodoIntoMessages(base, "## 任务清单\n- [ ] b (t2)");
    expect(out).toEqual(base);
  });

  it("injectTodoIntoMessages: 尾部为 block 数组 user 时按 text block 前置", () => {
    const base: ProviderMessage[] = [
      { role: "user", content: [{ type: "text", text: "see" }] },
    ];
    const out = injectTodoIntoMessages(base, "## 任务清单\n- [ ] c (t3)");
    expect(out).toHaveLength(1);
    const last = out[out.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toEqual([
      { type: "text", text: "## 任务清单\n- [ ] c (t3)" },
      { type: "text", text: "see" },
    ]);
  });

  it("injectTodoIntoMessages: tool_result 后不注入(避免伪用户发言 + API 400)", () => {
    const base: ProviderMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_00_Brz", name: "Read", input: { path: "a.ts" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_00_Brz", content: [{ type: "text", text: "ok" }] }],
      },
    ];
    const out = injectTodoIntoMessages(base, "## 任务清单\n- [ ] x (t9)");
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual(base[1]);
  });

  it("injectTodoIntoMessages: 空块或空消息时原样返回", () => {
    expect(injectTodoIntoMessages([{ role: "user", content: "hi" }], "")).toEqual([
      { role: "user", content: "hi" },
    ]);
    expect(injectTodoIntoMessages([], "## 任务清单\n- [ ] d (t4)")).toEqual([]);
  });

  it("首轮 system 不含 todo,尾部 user 消息注入最新清单", async () => {
    const { provider, calls } = fakeProvider([
      { result: { blocks: [{ type: "text", text: "done" }], toolUses: [] } },
    ]);
    const todo = new TodoManager();
    todo.add("第一步");
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "s:p",
      todo,
    });
    await session.send("hello", () => {});
    const sent = calls[0].messages;
    const last = sent[sent.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe("## 任务清单\n- [ ] 第一步 (t1)\n\nhello");
    const head = sent.slice(0, -1);
    expect(JSON.stringify(head)).not.toContain("任务清单");
  });

  it("工具轮次:不注入清单,messages 尾部保持纯 tool_result,system 无后缀", async () => {
    const systems: string[] = [];
    const messageSnapshots: ProviderMessage[][] = [];
    let i = 0;
    const provider: ProviderClient = {
      capabilities: { supportsVision: true, supportsThinking: true },
      async round(messages, opts): Promise<ProviderRoundResult> {
        messageSnapshots.push(JSON.parse(JSON.stringify(messages)));
        systems.push(opts.system ?? "");
        const script: ProviderRoundResult[] = [
          {
            blocks: [
              { type: "text", text: "先读一下" },
              { type: "tool_use", id: "c1", name: "Read", input: { path: "a.ts" } },
            ],
            toolUses: [{ id: "c1", name: "Read", input: { path: "a.ts" } }],
          },
          { blocks: [{ type: "text", text: "done" }], toolUses: [] },
        ];
        return script[Math.min(i++, script.length - 1)];
      },
    };
    const todo = new TodoManager();
    todo.add("修 t5");
    const session = new AgentSession({
      provider,
      tools: fakeTools({
        Read: () => ({ ok: true, content: "ok" }),
      }).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "base-system",
      todo,
    });
    await session.send("请修", () => {});
    expect(messageSnapshots).toHaveLength(2);
    expect(JSON.stringify(messageSnapshots[0])).toContain("任务清单");
    expect(systems[0]).toBe("base-system");
    const round2 = messageSnapshots[1];
    const last2 = round2[round2.length - 1];
    expect(last2.role).toBe("user");
    expect(JSON.stringify(last2.content)).toContain("tool_result");
    expect(JSON.stringify(last2.content)).not.toContain("任务清单");
    // system 无动态后缀:todo 是会话内动态内容,进 system 会打断 tools+messages 前缀(规则 1)
    expect(systems[1]).toBe("base-system");
  });

  it("全部完成后不再向请求注入任务清单", async () => {
    const systems: string[] = [];
    const messageSnapshots: ProviderMessage[][] = [];
    const provider: ProviderClient = {
      capabilities: { supportsVision: true, supportsThinking: true },
      async round(messages, opts): Promise<ProviderRoundResult> {
        messageSnapshots.push(JSON.parse(JSON.stringify(messages)));
        systems.push(opts.system ?? "");
        return { blocks: [{ type: "text", text: "ok" }], toolUses: [] };
      },
    };
    const todo = new TodoManager();
    const it = todo.add("已做完");
    todo.update(it.id, true);
    const session = new AgentSession({
      provider,
      tools: fakeTools({}).tools,
      permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
      workspaceRoot: "/tmp",
      systemPrompt: "base-system",
      todo,
    });
    await session.send("继续", () => {});
    expect(JSON.stringify(messageSnapshots[0])).not.toContain("任务清单");
    expect(systems[0]).toBe("base-system");
  });
});

describe("AgentSession snapshot-store cut-point archive", () => {
  function bigThinking(lines: number): string {
    return Array.from(
      { length: lines },
      (_, i) => `推理第 ${i} 行:` + "内容内容内容内容内容内容内容内容",
    ).join("\n");
  }

  it("trim → archive → flush → ContextRecall retrieves original thinking", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agloop-snap-"));
    try {
      const store = new ContextStore(tmp);
      const original = bigThinking(60);
      const { provider } = fakeProvider([
        { result: { blocks: [{ type: "text", text: "继续" }], toolUses: [] } },
      ]);
      const session = new AgentSession({
        provider,
        tools: fakeTools({}).tools,
        permissions: new PermissionManager({
          gateway: { request: async () => true },
          rules: new PermissionRules(),
        }),
        workspaceRoot: "/tmp",
        systemPrompt: "s",
        contextStore: store,
        sessionId: "snap1",
        initialHistory: [
          { role: "user", content: "问1" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: original },
              { type: "text", text: "答1" },
            ],
          },
          { role: "user", content: "问2" },
          { role: "assistant", content: [{ type: "text", text: "答2" }] },
        ],
      });

      await session.send("问3", () => {});

      const archived = store.load("snap1").filter((c) => c.type === "thinking");
      expect(archived.length).toBeGreaterThanOrEqual(1);
      expect(archived.some((c) => c.content === original)).toBe(true);
      const seq = archived.find((c) => c.content === original)!.seq;

      const recalled = store.get("snap1", [seq]);
      expect(recalled).toHaveLength(1);
      expect(recalled[0].content).toBe(original);

      const hist = session.getMessages();
      const thinkingMsg = hist.find(
        (m) =>
          m.role === "assistant" &&
          m.content.some((b) => b.type === "thinking" && (b as { thinking: string }).thinking.includes(`[r${seq}]`)),
      );
      expect(thinkingMsg).toBeDefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

