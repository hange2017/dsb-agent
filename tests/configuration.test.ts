import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";
import { Configuration } from "../src/settings/configuration";

describe("Configuration", () => {
  it("falls back to defaults when config empty", () => {
    const cfg = new Configuration({ getString: () => "" });
    expect(cfg.baseUrl()).toBe("https://api.deepseek.com/anthropic");
    expect(cfg.model()).toBe("deepseek-v4-flash");
  });
  it("reads configured values", () => {
    const cfg = new Configuration({
      getString: (k) => (k === "dsbAgent.model" ? "deepseek-v4-pro" : ""),
    });
    expect(cfg.model()).toBe("deepseek-v4-pro");
  });
  it("memory defaults to ~/.dsb/memory", () => {
    const cfg = new Configuration({ getString: () => "" });
    expect(cfg.memoryDir()).toBe(path.join(os.homedir(), ".dsb", "memory"));
  });
  it("memoryDir honors a configured override with ~ expansion", () => {
    const cfg = new Configuration({ getString: (k) => (k === "dsbAgent.memoryDir" ? "~/custom-mem" : "") });
    expect(cfg.memoryDir()).toBe(path.join(os.homedir(), "custom-mem"));
  });
  it("language defaults to follow-interface (empty)", () => {
    const cfg = new Configuration({ getString: () => "" });
    expect(cfg.language()).toBe("");
  });
  it("language honors zh/en and rejects invalid values", () => {
    const zh = new Configuration({ getString: (k) => (k === "dsbAgent.language" ? "zh" : "") });
    expect(zh.language()).toBe("zh");
    const en = new Configuration({ getString: (k) => (k === "dsbAgent.language" ? "en" : "") });
    expect(en.language()).toBe("en");
    const bad = new Configuration({ getString: (k) => (k === "dsbAgent.language" ? "fr" : "") });
    expect(bad.language()).toBe("");
  });
  it("compactionTriggerRatio defaults to 0.75 and accepts valid values", () => {
    expect(new Configuration({ getString: () => "" }).compactionTriggerRatio()).toBe(0.75);
    const cfg = new Configuration({ getString: (k) => (k === "dsbAgent.compaction.triggerRatio" ? "0.55" : "") });
    expect(cfg.compactionTriggerRatio()).toBe(0.55);
  });
  it("compactionTriggerRatio rejects out-of-range and non-numeric values", () => {
    const tooBig = new Configuration({ getString: (k) => (k === "dsbAgent.compaction.triggerRatio" ? "1.5" : "") });
    expect(tooBig.compactionTriggerRatio()).toBe(0.75);
    const negative = new Configuration({ getString: (k) => (k === "dsbAgent.compaction.triggerRatio" ? "-0.1" : "") });
    expect(negative.compactionTriggerRatio()).toBe(0.75);
    const junk = new Configuration({ getString: (k) => (k === "dsbAgent.compaction.triggerRatio" ? "abc" : "") });
    expect(junk.compactionTriggerRatio()).toBe(0.75);
  });
  it("compactionThinkingEnabled defaults to true and accepts false", () => {
    expect(new Configuration({ getString: () => "" }).compactionThinkingEnabled()).toBe(true);
    const off = new Configuration({ getString: (k) => (k === "dsbAgent.compaction.thinking" ? "false" : "") });
    expect(off.compactionThinkingEnabled()).toBe(false);
    const junk = new Configuration({ getString: (k) => (k === "dsbAgent.compaction.thinking" ? "yes" : "") });
    expect(junk.compactionThinkingEnabled()).toBe(true);
  });
  it("historyTokenBudget defaults to 150000 and accepts 0 (disabled)", () => {
    expect(new Configuration({ getString: () => "" }).historyTokenBudget()).toBe(150000);
    const zero = new Configuration({ getString: (k) => (k === "dsbAgent.compaction.historyTokenBudget" ? "0" : "") });
    expect(zero.historyTokenBudget()).toBe(0);
    const custom = new Configuration({ getString: (k) => (k === "dsbAgent.compaction.historyTokenBudget" ? "20000" : "") });
    expect(custom.historyTokenBudget()).toBe(20000);
  });
  it("historyTokenBudget rejects non-numeric and negative", () => {
    const junk = new Configuration({ getString: (k) => (k === "dsbAgent.compaction.historyTokenBudget" ? "abc" : "") });
    expect(junk.historyTokenBudget()).toBe(150000);
    const negative = new Configuration({ getString: (k) => (k === "dsbAgent.compaction.historyTokenBudget" ? "-5" : "") });
    expect(negative.historyTokenBudget()).toBe(150000);
  });
  it("budgetSplit defaults to 45/20/35", () => {
    expect(new Configuration({ getString: () => "" }).budgetSplit()).toEqual({
      compacted: 0.45,
      thinking: 0.2,
      tail: 0.35,
    });
  });
  it("budgetSplit reads valid values and normalizes", () => {
    const cfg = new Configuration({
      getString: () => "",
      getJson: <T>(_k: string) => ({ compacted: 0.5, thinking: 0.25, tail: 0.25 }) as T,
    });
    expect(cfg.budgetSplit()).toEqual({ compacted: 0.5, thinking: 0.25, tail: 0.25 });
  });
  it("budgetSplit falls back on invalid values", () => {
    // 缺项
    expect(
      new Configuration({ getString: () => "", getJson: <T>(_k: string) => ({ compacted: 1 }) as T }).budgetSplit(),
    ).toEqual({ compacted: 0.45, thinking: 0.2, tail: 0.35 });
    // 非数
    expect(
      new Configuration({ getString: () => "", getJson: <T>(_k: string) => ({ compacted: "x", thinking: 0.2, tail: 0.35 }) as T }).budgetSplit(),
    ).toEqual({ compacted: 0.45, thinking: 0.2, tail: 0.35 });
    // 非正数
    expect(
      new Configuration({ getString: () => "", getJson: <T>(_k: string) => ({ compacted: -1, thinking: 0.2, tail: 0.35 }) as T }).budgetSplit(),
    ).toEqual({ compacted: 0.45, thinking: 0.2, tail: 0.35 });
    // 和为 0
    expect(
      new Configuration({ getString: () => "", getJson: <T>(_k: string) => ({ compacted: 0, thinking: 0, tail: 0 }) as T }).budgetSplit(),
    ).toEqual({ compacted: 0.45, thinking: 0.2, tail: 0.35 });
    // 未归一化 → 按和归一化
    const unnormalized = new Configuration({
      getString: () => "",
      getJson: <T>(_k: string) => ({ compacted: 50, thinking: 20, tail: 30 }) as T,
    });
    expect(unnormalized.budgetSplit()).toEqual({ compacted: 0.5, thinking: 0.2, tail: 0.3 });
  });
});

describe("Configuration context window & trigger/target pct", () => {
  it("contextWindowTokens defaults to 1000000 (1M) and accepts positive numbers", () => {
    expect(new Configuration({ getString: () => "" }).contextWindowTokens()).toBe(1000000);
    const cfg = new Configuration({ getString: (k) => (k === "dsbAgent.contextWindowTokens" ? "128000" : "") });
    expect(cfg.contextWindowTokens()).toBe(128000);
  });

  it("contextWindowTokens rejects invalid values (non-numeric / negative / zero)", () => {
    const mk = (v: string) => new Configuration({ getString: (k) => (k === "dsbAgent.contextWindowTokens" ? v : "") });
    expect(mk("abc").contextWindowTokens()).toBe(1000000);
    expect(mk("-5").contextWindowTokens()).toBe(1000000);
    expect(mk("0").contextWindowTokens()).toBe(0);
    expect(mk("").contextWindowTokens()).toBe(1000000);
  });

  it("compactionTriggerPct defaults to 0.75 and accepts (0,1]", () => {
    expect(new Configuration({ getString: () => "" }).compactionTriggerPct()).toBe(0.75);
    const cfg = new Configuration({ getString: (k) => (k === "dsbAgent.compaction.triggerPct" ? "0.8" : "") });
    expect(cfg.compactionTriggerPct()).toBe(0.8);
    expect(cfg.compactionTargetPct()).toBe(0.5);
  });

  it("compactionTriggerPct rejects out-of-range values", () => {
    const mk = (v: string) => new Configuration({ getString: (k) => (k === "dsbAgent.compaction.triggerPct" ? v : "") });
    expect(mk("0").compactionTriggerPct()).toBe(0.75);
    expect(mk("1.5").compactionTriggerPct()).toBe(0.75);
    expect(mk("x").compactionTriggerPct()).toBe(0.75);
  });

  it("compactionTargetPct defaults to 0.5, accepts (0,trigger)", () => {
    expect(new Configuration({ getString: () => "" }).compactionTargetPct()).toBe(0.5);
    const cfg = new Configuration({ getString: (k) => (k === "dsbAgent.compaction.targetPct" ? "0.4" : "") });
    expect(cfg.compactionTargetPct()).toBe(0.4);
  });

  it("compactionTargetPct rejects target >= trigger or invalid values", () => {
    const mk = (target: string, trigger = "0.75") =>
      new Configuration({
        getString: (k) =>
          k === "dsbAgent.compaction.targetPct" ? target : k === "dsbAgent.compaction.triggerPct" ? trigger : "",
      });
    expect(mk("0.75").compactionTargetPct()).toBe(0.5); // target == trigger → fallback
    expect(mk("0.9").compactionTargetPct()).toBe(0.5); // target > trigger → fallback
    expect(mk("0").compactionTargetPct()).toBe(0.5);
    expect(mk("1").compactionTargetPct()).toBe(0.5);
    expect(mk("x").compactionTargetPct()).toBe(0.5);
  });
});
