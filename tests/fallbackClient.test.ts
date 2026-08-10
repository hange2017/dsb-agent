import { describe, it, expect, vi } from "vitest";
import { FallbackClient } from "../src/agent/provider/fallbackClient";
import type { ProviderClient, ProviderRoundResult } from "../src/agent/provider/types";

function stub(resultOrError: ProviderRoundResult | Error): ProviderClient {
  return {
    capabilities: { supportsVision: true, supportsThinking: true },
    round: vi.fn(async () => {
      if (resultOrError instanceof Error) throw resultOrError;
      return resultOrError;
    }),
  };
}

const NOOP = () => {};

describe("FallbackClient", () => {
  it("passes through when primary succeeds", async () => {
    const primary = stub({ blocks: [{ type: "text", text: "ok" }], toolUses: [] });
    const fc = new FallbackClient({ primary, fallbacks: [] });
    const r = await fc.round([], { system: "s", tools: [] }, NOOP);
    expect(r.blocks[0].type).toBe("text");
  });
  it("falls back on rate limit errors", async () => {
    const primary = stub(new Error("429 rate limited"));
    const fb = stub({ blocks: [{ type: "text", text: "fb" }], toolUses: [] });
    const fc = new FallbackClient({ primary, fallbacks: [{ model: "m2", make: () => fb }] });
    const r = await fc.round([], { system: "s", tools: [] }, NOOP);
    expect((r.blocks[0] as { type: "text"; text: string }).text).toBe("fb");
  });
  it("does not fall back on 401", async () => {
    const primary = stub(new Error("Invalid API key (401)"));
    const fb = stub({ blocks: [], toolUses: [] });
    const fc = new FallbackClient({ primary, fallbacks: [{ model: "m2", make: () => fb }] });
    await expect(fc.round([], { system: "s", tools: [] }, NOOP)).rejects.toThrow("401");
  });
  it("never builds unused fallbacks when the primary succeeds", async () => {
    const primary = stub({ blocks: [{ type: "text", text: "ok" }], toolUses: [] });
    const made: string[] = [];
    const fc = new FallbackClient({
      primary,
      fallbacks: [
        { model: "m2", make: (m) => { made.push(m); return stub({ blocks: [], toolUses: [] }); } },
      ],
    });
    const r = await fc.round([], { system: "s", tools: [] }, NOOP);
    expect((r.blocks[0] as { type: "text"; text: string }).text).toBe("ok");
    expect(made).toEqual([]); // primary 成功时任何 fallback 都不应被构造
  });
  it("routes a make() throw on a later fallback through the retry chain", async () => {
    const primary = stub(new Error("429 rate limited"));
    const fb1 = stub(new Error("timeout"));
    const fb3 = stub({ blocks: [{ type: "text", text: "fb3" }], toolUses: [] });
    const fc = new FallbackClient({
      primary,
      fallbacks: [
        { model: "m1", make: () => fb1 },
        { model: "m2", make: () => { throw new Error("503 overloaded"); } }, // make 抛错须被重试链捕获
        { model: "m3", make: () => fb3 },
      ],
    });
    const r = await fc.round([], { system: "s", tools: [] }, NOOP);
    expect((r.blocks[0] as { type: "text"; text: string }).text).toBe("fb3");
  });

  it("exposes primary capabilities before any round", () => {
    const primary: ProviderClient = {
      capabilities: { supportsVision: false, supportsThinking: true, contextWindowTokens: 100_000 },
      round: vi.fn(async () => ({ blocks: [], toolUses: [] })),
    };
    const fc = new FallbackClient({ primary, fallbacks: [] });
    expect(fc.capabilities).toEqual({ supportsVision: false, supportsThinking: true, contextWindowTokens: 100_000 });
  });

  it("exposes fallback capabilities after successful fallback round", async () => {
    const primary: ProviderClient = {
      capabilities: { supportsVision: false, supportsThinking: true, contextWindowTokens: 100_000 },
      round: vi.fn(async () => {
        throw new Error("429 rate limited");
      }),
    };
    const fb: ProviderClient = {
      capabilities: { supportsVision: true, supportsThinking: false, contextWindowTokens: 200_000 },
      round: vi.fn(async (): Promise<ProviderRoundResult> => ({
        blocks: [{ type: "text", text: "fb" }],
        toolUses: [],
      })),
    };
    const fc = new FallbackClient({
      primary,
      fallbacks: [{ model: "m2", make: () => fb }],
    });
    expect(fc.capabilities).toEqual({ supportsVision: false, supportsThinking: true, contextWindowTokens: 100_000 });
    await fc.round([], { system: "s", tools: [] }, NOOP);
    expect(fc.capabilities).toEqual({ supportsVision: true, supportsThinking: false, contextWindowTokens: 200_000 });
  });

  it("exposes primary capabilities after primary succeeds", async () => {
    const primary: ProviderClient = {
      capabilities: { supportsVision: false, supportsThinking: true, contextWindowTokens: 100_000 },
      round: vi.fn(async (): Promise<ProviderRoundResult> => ({
        blocks: [{ type: "text", text: "ok" }],
        toolUses: [],
      })),
    };    const fb: ProviderClient = {
      capabilities: { supportsVision: true, supportsThinking: false, contextWindowTokens: 200_000 },
      round: vi.fn(async () => ({ blocks: [], toolUses: [] })),
    };
    const fc = new FallbackClient({
      primary,
      fallbacks: [{ model: "m2", make: () => fb }],
    });
    await fc.round([], { system: "s", tools: [] }, NOOP);
    expect(fc.capabilities).toEqual({ supportsVision: false, supportsThinking: true, contextWindowTokens: 100_000 });
  });

  it("re-prepares outbound for fallback client capabilities", async () => {
    const primary: ProviderClient = {
      capabilities: { supportsVision: true, supportsThinking: true, maxOutputTokens: 8192 },
      round: vi.fn(async () => {
        throw new Error("429 rate limited");
      }),
    };
    let seen: unknown[] = [];
    const fb: ProviderClient = {
      capabilities: {
        supportsVision: false,
        supportsThinking: false,
        maxOutputTokens: 1024,
        contextWindowTokens: 50_000,
      },
      round: vi.fn(async (messages, opts) => {
        seen = JSON.parse(JSON.stringify(messages));
        expect(opts.maxTokens).toBeLessThanOrEqual(1024);
        return { blocks: [{ type: "text" as const, text: "fb" }], toolUses: [] };
      }),
    };
    const fc = new FallbackClient({ primary, fallbacks: [{ model: "m2", make: () => fb }] });
    await fc.round(
      [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "img" } },
            { type: "text", text: "q" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret" },
            { type: "text", text: "a" },
          ],
        },
      ],
      { system: "s", tools: [], lastInputTokens: 0 },
      NOOP,
    );
    const blob = JSON.stringify(seen);
    expect(blob).not.toContain("thinking");
    expect(blob).not.toContain('"type":"image"');
    expect(blob).toContain('"q"');
  });
});
