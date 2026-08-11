import { describe, it, expect } from "vitest";
import {
  normalizeCapabilities,
  normalizeCapabilityOverrides,
  toPersistedCapabilities,
  effectiveThinkingBudgetTokens,
} from "../src/providers/capabilities";

describe("normalizeCapabilities", () => {
  it("accepts new field names", () => {
    expect(normalizeCapabilities({ supportsVision: true, supportsThinking: false })).toEqual({
      supportsVision: true,
      supportsThinking: false,
    });
  });

  it("migrates legacy vision/thinking keys", () => {
    expect(normalizeCapabilities({ vision: true, thinking: false })).toEqual({
      supportsVision: true,
      supportsThinking: false,
    });
  });

  it("defaults when raw is missing", () => {
    expect(normalizeCapabilities(undefined)).toEqual({
      supportsVision: false,
      supportsThinking: true,
    });
  });

  it("keeps positive thinkingBudgetTokens only", () => {
    expect(normalizeCapabilities({ supportsThinking: true, thinkingBudgetTokens: 8192 })).toEqual({
      supportsVision: false,
      supportsThinking: true,
      thinkingBudgetTokens: 8192,
    });
    expect(normalizeCapabilities({ supportsThinking: true, thinkingBudgetTokens: 0 })).toEqual({
      supportsVision: false,
      supportsThinking: true,
    });
    expect(normalizeCapabilities({ supportsThinking: true, thinkingBudgetTokens: -1 })).toEqual({
      supportsVision: false,
      supportsThinking: true,
    });
  });

  it("keeps parallel fields", () => {
    expect(
      normalizeCapabilities({
        supportsThinking: true,
        maxParallelTools: 4,
        toolParallelMode: "serial",
      }),
    ).toEqual({
      supportsVision: false,
      supportsThinking: true,
      maxParallelTools: 4,
      toolParallelMode: "serial",
    });
    expect(normalizeCapabilities({ supportsThinking: true, toolParallelMode: "nope" })).toEqual({
      supportsVision: false,
      supportsThinking: true,
    });
  });

  it("prefers new keys when both shapes present", () => {
    expect(
      normalizeCapabilities({ supportsVision: true, vision: false, supportsThinking: false, thinking: true }),
    ).toEqual({ supportsVision: true, supportsThinking: false });
  });
});

describe("normalizeCapabilityOverrides", () => {
  it("migrates per-model legacy patches", () => {
    expect(normalizeCapabilityOverrides({ m1: { vision: true } })).toEqual({
      m1: { supportsVision: true },
    });
  });
});

describe("toPersistedCapabilities", () => {
  it("writes only new keys", () => {
    expect(toPersistedCapabilities({ supportsVision: true, supportsThinking: true })).toEqual({
      supportsVision: true,
      supportsThinking: true,
    });
  });

  it("persists thinkingBudgetTokens when set", () => {
    expect(
      toPersistedCapabilities({ supportsVision: true, supportsThinking: true, thinkingBudgetTokens: 4096 }),
    ).toEqual({
      supportsVision: true,
      supportsThinking: true,
      thinkingBudgetTokens: 4096,
    });
  });
});

describe("thinkingLevel", () => {
  it("normalizes thinkingLevel and keeps it in caps", () => {
    expect(normalizeCapabilities({ supportsVision: false, supportsThinking: true, thinkingLevel: "high" })).toEqual({
      supportsVision: false,
      supportsThinking: true,
      thinkingLevel: "high",
    });
    expect(normalizeCapabilities({ supportsVision: false, thinkingLevel: "bogus" }).thinkingLevel).toBeUndefined();
  });

  it("persists thinkingLevel via toPersistedCapabilities", () => {
    expect(
      toPersistedCapabilities({ supportsVision: false, supportsThinking: true, thinkingLevel: "medium" }),
    ).toEqual({ supportsVision: false, supportsThinking: true, thinkingLevel: "medium" });
  });

  it("effectiveThinkingBudgetTokens prefers explicit budget over level", () => {
    // 显式 budget 优先
    expect(
      effectiveThinkingBudgetTokens({ supportsVision: false, supportsThinking: true, thinkingBudgetTokens: 2048, thinkingLevel: "high" }),
    ).toBe(2048);
    // level 派生
    expect(
      effectiveThinkingBudgetTokens({ supportsVision: false, supportsThinking: true, thinkingLevel: "low" }),
    ).toBe(1024);
    expect(
      effectiveThinkingBudgetTokens({ supportsVision: false, supportsThinking: true, thinkingLevel: "medium" }),
    ).toBe(4096);
    expect(
      effectiveThinkingBudgetTokens({ supportsVision: false, supportsThinking: true, thinkingLevel: "high" }),
    ).toBe(16384);
    // 都不是 → undefined
    expect(effectiveThinkingBudgetTokens({ supportsVision: false, supportsThinking: true })).toBeUndefined();
  });
});
