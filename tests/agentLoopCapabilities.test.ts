import { describe, it, expect, vi } from "vitest";
import { AgentSession, stripThinkingBlocks } from "../src/agent/agentLoop";
import type { ProviderClient, ProviderMessage, ProviderRoundResult } from "../src/agent/provider/types";
import { PermissionManager } from "../src/agent/permission";
import { PermissionRules } from "../src/agent/permissionRules";
import {
  effectiveContextWindowTokens,
  effectiveMaxOutputTokens,
  normalizeCapabilities,
} from "../src/providers/capabilities";

describe("stripThinkingBlocks", () => {
  it("removes thinking blocks from assistant messages", () => {
    const messages: ProviderMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan" },
          { type: "text", text: "ok" },
          { type: "tool_use", id: "t1", name: "Read", input: {} },
        ],
      },
    ];
    const out = stripThinkingBlocks(messages);
    expect(out[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", id: "t1", name: "Read", input: {} },
      ],
    });
  });
});

describe("effective capability defaults", () => {
  it("falls back to defaults when optional fields omitted", () => {
    const caps = normalizeCapabilities({ supportsVision: false, supportsThinking: true });
    expect(effectiveContextWindowTokens(caps)).toBe(256_000);
    expect(effectiveMaxOutputTokens(caps)).toBe(8192);
  });

  it("uses explicit numeric fields", () => {
    const caps = normalizeCapabilities({
      supportsVision: true,
      supportsThinking: true,
      contextWindowTokens: 200_000,
      maxOutputTokens: 4096,
    });
    expect(effectiveContextWindowTokens(caps)).toBe(200_000);
    expect(effectiveMaxOutputTokens(caps)).toBe(4096);
  });
});

describe("AgentSession capability consumption", () => {
  function perms() {
    return new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() });
  }

  it("passes maxTokens from capabilities and strips thinking when unsupported", async () => {
    const captured: Array<{ messages: ProviderMessage[]; maxTokens?: number }> = [];
    const provider: ProviderClient = {
      capabilities: {
        supportsVision: false,
        supportsThinking: false,
        maxOutputTokens: 2048,
        contextWindowTokens: 50_000,
      },
      async round(messages, opts) {
        captured.push({ messages: JSON.parse(JSON.stringify(messages)), maxTokens: opts.maxTokens });
        return { blocks: [{ type: "text", text: "done" }], toolUses: [] };
      },
    };
    const tools = {
      allToolDefs: () => [],
      execute: async () => ({ ok: true, content: "" }),
      subagentDepth: 0,
    };
    const session = new AgentSession({
      provider,
      tools: tools as never,
      permissions: perms(),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      initialHistory: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret" },
            { type: "text", text: "prev" },
          ],
        },
      ],
    });
    await session.send("next", () => {});
    expect(captured[0]?.maxTokens).toBe(2048);
    // loop 传原始历史;出站清洗由 AnthropicMessagesClient / FallbackClient.prepareRound 负责
    const assistant = captured[0]?.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toEqual([
      { type: "thinking", thinking: "secret" },
      { type: "text", text: "prev" },
    ]);
    // 内存真相源仍保留 thinking
    expect(session.getMessages().some((m) => m.role === "assistant" && m.content.some((b) => b.type === "thinking"))).toBe(
      true,
    );
  });

  it("keeps thinking in outbound when supportsThinking is true", async () => {
    const captured: ProviderMessage[][] = [];
    const provider: ProviderClient = {
      capabilities: { supportsVision: true, supportsThinking: true, maxOutputTokens: 1024 },
      async round(messages) {
        captured.push(JSON.parse(JSON.stringify(messages)));
        return { blocks: [{ type: "text", text: "ok" }], toolUses: [] } satisfies ProviderRoundResult;
      },
    };
    const session = new AgentSession({
      provider,
      tools: { allToolDefs: () => [], execute: async () => ({ ok: true, content: "" }), subagentDepth: 0 } as never,
      permissions: perms(),
      workspaceRoot: "/tmp",
      systemPrompt: "s",
      initialHistory: [
        { role: "assistant", content: [{ type: "thinking", thinking: "keep" }, { type: "text", text: "a" }] },
      ],
    });
    await session.send("x", () => {});
    const assistant = captured[0]?.find((m) => m.role === "assistant");
    expect(assistant?.content.some((b) => b.type === "thinking")).toBe(true);
  });
});
