import { describe, it, expect } from "vitest";
import { AnthropicMessagesClient } from "../src/agent/provider/anthropicMessagesClient";
import type { ToolDef } from "../src/agent/tools/types";

function sseBody(events: Array<[string, Record<string, unknown>]>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function makeFetch(status: number, body: ReadableStream<Uint8Array> | string): typeof fetch {
  return (async () => {
    const headers = new Headers();
    return {
      ok: status >= 200 && status < 300,
      status,
      body: typeof body === "string" ? null : body,
      text: async () => (typeof body === "string" ? body : ""),
      headers,
      url: "",
      redirected: false,
      statusText: "",
      type: "default",
      clone: () => {
        throw new Error("unused");
      },
    } as unknown as Response;
  }) as typeof fetch;
}

const TOOLS: ToolDef[] = [
  { name: "Read", description: "read", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
];

describe("AnthropicMessagesClient", () => {
  it("streams text deltas and returns blocks", async () => {
    const stream = sseBody([
      ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello" } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: " world" } }],
      ["content_block_stop", { index: 0 }],
      ["message_delta", { usage: { input_tokens: 10, output_tokens: 2 } }],
    ]);
    const client = new AnthropicMessagesClient({ apiKey: "sk-test", baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-flash", fetchImpl: makeFetch(200, stream) });

    const deltas: string[] = [];
    const result = await client.round([{ role: "user", content: "hi" }], { system: "sys", tools: TOOLS }, (ev) => {
      if (ev.type === "text_delta") deltas.push(ev.text);
    });

    expect(deltas.join("")).toBe("Hello world");
    expect(result.toolUses).toEqual([]);
    expect(result.blocks).toEqual([{ type: "text", text: "Hello world" }]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });

  it("parses cache hit/miss tokens from usage (Anthropic & DeepSeek style)", async () => {
    const stream = sseBody([
      ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }],
      ["content_block_stop", { index: 0 }],
      [
        "message_delta",
        {
          usage: {
            input_tokens: 100,
            output_tokens: 7,
            cache_read_input_tokens: 60,
            cache_creation_input_tokens: 40,
          },
        },
      ],
    ]);
    const client = new AnthropicMessagesClient({ apiKey: "sk-test", baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-flash", fetchImpl: makeFetch(200, stream) });
    const result = await client.round([{ role: "user", content: "hi" }], { system: "sys", tools: TOOLS }, () => {});
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 7,
      cacheReadTokens: 60,
      cacheWriteTokens: 40,
    });
  });

  it("falls back to DeepSeek cache token names when Anthropic names absent", async () => {
    const stream = sseBody([
      ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }],
      ["content_block_stop", { index: 0 }],
      [
        "message_delta",
        { usage: { input_tokens: 200, output_tokens: 9, prompt_cache_hit_tokens: 120, prompt_cache_miss_tokens: 80 } },
      ],
    ]);
    const client = new AnthropicMessagesClient({ apiKey: "sk-test", baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-flash", fetchImpl: makeFetch(200, stream) });
    const result = await client.round([{ role: "user", content: "hi" }], { system: "sys", tools: TOOLS }, () => {});
    expect(result.usage).toEqual({
      inputTokens: 200,
      outputTokens: 9,
      cacheReadTokens: 120,
      cacheWriteTokens: 80,
    });
  });

  it("collects tool_use blocks", async () => {
    const stream = sseBody([
      ["content_block_start", { index: 0, content_block: { type: "tool_use", id: "t1", name: "Read", input: { path: "a.txt" } } }],
      ["content_block_stop", { index: 0 }],
    ]);
    const client = new AnthropicMessagesClient({ apiKey: "sk-test", baseUrl: "https://api.deepseek.com/anthropic", model: "m", fetchImpl: makeFetch(200, stream) });

    const result = await client.round([{ role: "user", content: "read a.txt" }], { system: "s", tools: TOOLS }, () => {});
    expect(result.toolUses).toEqual([{ id: "t1", name: "Read", input: { path: "a.txt" } }]);
  });

  it("assembles tool_use input from input_json_delta fragments", async () => {
    const stream = sseBody([
      ["content_block_start", { index: 0, content_block: { type: "tool_use", id: "t2", name: "Read", input: {} } }],
      ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\"" } }],
      ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: ":\"a.txt\"}" } }],
      ["content_block_stop", { index: 0 }],
    ]);
    const client = new AnthropicMessagesClient({ apiKey: "sk-test", baseUrl: "https://api.deepseek.com/anthropic", model: "m", fetchImpl: makeFetch(200, stream) });

    const result = await client.round([{ role: "user", content: "read a.txt" }], { system: "s", tools: TOOLS }, () => {});
    expect(result.toolUses).toEqual([{ id: "t2", name: "Read", input: { path: "a.txt" } }]);
    // blocks 必须同步写入解析后的 input:agentLoop 落盘用 blocks,空 input 会污染历史并诱发后续空 Bash
    expect(result.blocks).toEqual([{ type: "tool_use", id: "t2", name: "Read", input: { path: "a.txt" } }]);
  });

  it("writes Bash command into blocks after input_json_delta", async () => {
    const stream = sseBody([
      ["content_block_start", { index: 0, content_block: { type: "tool_use", id: "b1", name: "Bash", input: {} } }],
      ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{\"command\":\"echo hi\"}" } }],
      ["content_block_stop", { index: 0 }],
    ]);
    const client = new AnthropicMessagesClient({ apiKey: "sk-test", baseUrl: "https://x", model: "m", fetchImpl: makeFetch(200, stream) });
    const result = await client.round([{ role: "user", content: "run" }], { system: "s", tools: TOOLS }, () => {});
    expect(result.blocks[0]).toEqual({ type: "tool_use", id: "b1", name: "Bash", input: { command: "echo hi" } });
    expect(result.toolUses[0]?.input).toEqual({ command: "echo hi" });
  });

  it("flushes tool_use into toolUses when content_block_stop is missing", async () => {
    const stream = sseBody([
      ["content_block_start", { index: 0, content_block: { type: "tool_use", id: "t3", name: "Read", input: { path: "c.txt" } } }],
      // 故意没有 content_block_stop
      ["message_delta", { usage: { input_tokens: 1, output_tokens: 1 } }],
    ]);
    const client = new AnthropicMessagesClient({ apiKey: "sk-test", baseUrl: "https://x", model: "m", fetchImpl: makeFetch(200, stream) });
    const result = await client.round([{ role: "user", content: "read" }], { system: "s", tools: TOOLS }, () => {});
    expect(result.blocks).toEqual([{ type: "tool_use", id: "t3", name: "Read", input: { path: "c.txt" } }]);
    expect(result.toolUses).toEqual([{ id: "t3", name: "Read", input: { path: "c.txt" } }]);
  });

  it("densifies sparse block indexes so JSON never contains null holes", async () => {
    const stream = sseBody([
      ["content_block_start", { index: 0, content_block: { type: "text", text: "hi" } }],
      ["content_block_stop", { index: 0 }],
      ["content_block_start", { index: 2, content_block: { type: "tool_use", id: "t4", name: "Read", input: { path: "d.txt" } } }],
      ["content_block_stop", { index: 2 }],
    ]);
    const client = new AnthropicMessagesClient({ apiKey: "sk-test", baseUrl: "https://x", model: "m", fetchImpl: makeFetch(200, stream) });
    const result = await client.round([{ role: "user", content: "x" }], { system: "s", tools: TOOLS }, () => {});
    expect(result.blocks).toEqual([
      { type: "text", text: "hi" },
      { type: "tool_use", id: "t4", name: "Read", input: { path: "d.txt" } },
    ]);
    expect(result.blocks.includes(null as never)).toBe(false);
  });

  it("throws on 401", async () => {
    const client = new AnthropicMessagesClient({ apiKey: "bad", baseUrl: "https://x", model: "m", fetchImpl: makeFetch(401, "unauthorized") });
    await expect(client.round([{ role: "user", content: "hi" }], { system: "s", tools: TOOLS }, () => {})).rejects.toThrow("Invalid API key");
  });

  it("normalizes baseUrl that already ends with /v1 so request is not /v1/v1/messages", async () => {
    let hit = "";
    const fetchImpl = (async (url: string) => {
      hit = String(url);
      return makeFetch(200, sseBody([["content_block_stop", { index: 0 }]]))(url);
    }) as typeof fetch;
    const client = new AnthropicMessagesClient({
      apiKey: "sk",
      baseUrl: "https://api.deepseek.com/anthropic/v1",
      model: "m",
      fetchImpl,
    });
    await client.round([{ role: "user", content: "hi" }], { system: "s", tools: [] }, () => {});
    expect(hit).toBe("https://api.deepseek.com/anthropic/v1/messages");
  });

  it("404 error includes the request URL for diagnosis", async () => {
    const client = new AnthropicMessagesClient({
      apiKey: "sk",
      baseUrl: "https://api.deepseek.com",
      model: "m",
      fetchImpl: makeFetch(404, "not found"),
    });
    await expect(
      client.round([{ role: "user", content: "hi" }], { system: "s", tools: [] }, () => {}),
    ).rejects.toThrow(/API error \(404\).*https:\/\/api\.deepseek\.com\/v1\/messages/);
  });

  it("sends thinking disabled when capabilities.supportsThinking is false", async () => {
    const stream = sseBody([
      ["content_block_start", { index: 0, content_block: { type: "text", text: "ok" } }],
      ["content_block_stop", { index: 0 }],
    ]);
    let sentBody = "";
    const capturingFetch = (async (_url: string, init?: { body?: string }) => {
      sentBody = init?.body ?? "";
      return makeFetch(200, stream)(_url, init as RequestInit);
    }) as typeof fetch;
    const client = new AnthropicMessagesClient({
      apiKey: "sk-test",
      baseUrl: "https://x",
      model: "m",
      capabilities: { supportsVision: true, supportsThinking: false },
      fetchImpl: capturingFetch,
    });
    await client.round([{ role: "user", content: "hi" }], { system: "s", tools: TOOLS }, () => {});
    const parsed = JSON.parse(sentBody) as { thinking?: { type: string } };
    expect(parsed.thinking).toEqual({ type: "disabled" });
  });

  it("sends thinking enabled with budget from capabilities", async () => {
    const stream = sseBody([
      ["content_block_start", { index: 0, content_block: { type: "text", text: "ok" } }],
      ["content_block_stop", { index: 0 }],
    ]);
    let sentBody = "";
    const capturingFetch = (async (_url: string, init?: { body?: string }) => {
      sentBody = init?.body ?? "";
      return makeFetch(200, stream)(_url, init as RequestInit);
    }) as typeof fetch;
    const client = new AnthropicMessagesClient({
      apiKey: "sk-test",
      baseUrl: "https://x",
      model: "m",
      capabilities: { supportsVision: true, supportsThinking: true, thinkingBudgetTokens: 10_000 },
      fetchImpl: capturingFetch,
    });
    await client.round([{ role: "user", content: "hi" }], { system: "s", tools: TOOLS }, () => {});
    const parsed = JSON.parse(sentBody) as { thinking?: { type: string; budget_tokens?: number } };
    expect(parsed.thinking).toEqual({ type: "enabled", budget_tokens: 10_000 });
  });

  it("opts.thinkingBudgetTokens overrides capabilities budget", async () => {
    const stream = sseBody([
      ["content_block_start", { index: 0, content_block: { type: "text", text: "ok" } }],
      ["content_block_stop", { index: 0 }],
    ]);
    let sentBody = "";
    const capturingFetch = (async (_url: string, init?: { body?: string }) => {
      sentBody = init?.body ?? "";
      return makeFetch(200, stream)(_url, init as RequestInit);
    }) as typeof fetch;
    const client = new AnthropicMessagesClient({
      apiKey: "sk-test",
      baseUrl: "https://x",
      model: "m",
      capabilities: { supportsVision: true, supportsThinking: true, thinkingBudgetTokens: 10_000 },
      fetchImpl: capturingFetch,
    });
    await client.round(
      [{ role: "user", content: "hi" }],
      { system: "s", tools: TOOLS, thinkingBudgetTokens: 4096 },
      () => {},
    );
    const parsed = JSON.parse(sentBody) as { thinking?: { type: string; budget_tokens?: number } };
    expect(parsed.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  it("disabled thinking wins over budget in capabilities and opts", async () => {
    const stream = sseBody([
      ["content_block_start", { index: 0, content_block: { type: "text", text: "ok" } }],
      ["content_block_stop", { index: 0 }],
    ]);
    let sentBody = "";
    const capturingFetch = (async (_url: string, init?: { body?: string }) => {
      sentBody = init?.body ?? "";
      return makeFetch(200, stream)(_url, init as RequestInit);
    }) as typeof fetch;
    const client = new AnthropicMessagesClient({
      apiKey: "sk-test",
      baseUrl: "https://x",
      model: "m",
      capabilities: { supportsVision: true, supportsThinking: false, thinkingBudgetTokens: 10_000 },
      fetchImpl: capturingFetch,
    });
    await client.round(
      [{ role: "user", content: "hi" }],
      { system: "s", tools: TOOLS, thinkingBudgetTokens: 4096 },
      () => {},
    );
    const parsed = JSON.parse(sentBody) as { thinking?: { type: string } };
    expect(parsed.thinking).toEqual({ type: "disabled" });
  });

  it("omits thinking param when capabilities.supportsThinking is true", async () => {
    const stream = sseBody([
      ["content_block_start", { index: 0, content_block: { type: "text", text: "ok" } }],
      ["content_block_stop", { index: 0 }],
    ]);
    let sentBody = "";
    const capturingFetch = (async (_url: string, init?: { body?: string }) => {
      sentBody = init?.body ?? "";
      return makeFetch(200, stream)(_url, init as RequestInit);
    }) as typeof fetch;
    const client = new AnthropicMessagesClient({
      apiKey: "sk-test",
      baseUrl: "https://x",
      model: "m",
      capabilities: { supportsVision: true, supportsThinking: true, maxOutputTokens: 1024 },
      fetchImpl: capturingFetch,
    });
    await client.round([{ role: "user", content: "hi" }], { system: "s", tools: TOOLS, maxTokens: 1024 }, () => {});
    const parsed = JSON.parse(sentBody) as { thinking?: unknown; max_tokens?: number };
    expect(parsed.thinking).toBeUndefined();
    expect(parsed.max_tokens).toBe(1024);
    expect(client.capabilities).toEqual({
      supportsVision: true,
      supportsThinking: true,
      maxOutputTokens: 1024,
    });
  });

  it("maps reasoning_content block to thinking", async () => {
    const stream = sseBody([
      ["content_block_start", { index: 0, content_block: { type: "reasoning_content", reasoning_content: "step 1" } }],
      ["content_block_delta", { index: 0, delta: { type: "reasoning_content_delta", reasoning_content: " step 2" } }],
      ["content_block_stop", { index: 0 }],
    ]);
    const client = new AnthropicMessagesClient({ apiKey: "sk-test", baseUrl: "https://x", model: "m", fetchImpl: makeFetch(200, stream) });
    const deltas: string[] = [];
    const result = await client.round([{ role: "user", content: "hi" }], { system: "s", tools: TOOLS }, (ev) => {
      if (ev.type === "thinking_delta") deltas.push(ev.text);
    });
    expect(deltas.join("")).toBe(" step 2");
    expect(result.blocks).toEqual([{ type: "thinking", thinking: "step 1 step 2" }]);
  });

  it("maps reasoning_content field on non-standard block type", async () => {
    const stream = sseBody([
      ["content_block_start", { index: 0, content_block: { type: "custom", reasoning_content: "reason" } }],
      ["content_block_stop", { index: 0 }],
    ]);
    const client = new AnthropicMessagesClient({ apiKey: "sk-test", baseUrl: "https://x", model: "m", fetchImpl: makeFetch(200, stream) });
    const result = await client.round([{ role: "user", content: "hi" }], { system: "s", tools: TOOLS }, () => {});
    expect(result.blocks).toEqual([{ type: "thinking", thinking: "reason" }]);
  });
});
