import { describe, it, expect } from "vitest";
import { matchProfile, kExactProfiles } from "../src/providers/profiles";

describe("matchProfile", () => {
  it("exact match returns full caps for migrated builtin ids", () => {
    for (const id of Object.keys(kExactProfiles)) {
      expect(matchProfile(id)).toEqual(kExactProfiles[id]);
    }
  });

  it("exact match wins over prefix", () => {
    expect(matchProfile("deepseek-v4-pro")).toEqual(kExactProfiles["deepseek-v4-pro"]);
    expect(matchProfile("deepseek-v4-pro").supportsVision).toBe(false);
  });

  it("prefix match applies to unknown remote-style ids", () => {
    expect(matchProfile("claude-sonnet-4-6")).toMatchObject({
      supportsVision: true,
      supportsThinking: true,
      contextWindowTokens: 200_000,
      maxOutputTokens: 8192,
    });
    expect(matchProfile("deepseek-v4-lite")).toMatchObject({
      supportsThinking: true,
      contextWindowTokens: 256_000,
      maxOutputTokens: 8192,
    });
  });

  it("deepseek-v4 series uses the 256K window (spec 2026-08-09 §7)", () => {
    expect(matchProfile("deepseek-v4-flash")).toMatchObject({ contextWindowTokens: 256_000 });
    expect(matchProfile("deepseek-v4-pro")).toMatchObject({ contextWindowTokens: 256_000 });
    // 非 v4 系列(deepseek-chat/reasoner)保持原窗口
    expect(matchProfile("deepseek-chat")).toMatchObject({ contextWindowTokens: 128_000 });
    expect(matchProfile("deepseek-reasoner")).toMatchObject({ contextWindowTokens: 128_000 });
  });

  it("unknown model returns empty partial", () => {
    expect(matchProfile("totally-unknown-xyz")).toEqual({});
    expect(matchProfile("gpt-4o")).toEqual({});
  });
});
