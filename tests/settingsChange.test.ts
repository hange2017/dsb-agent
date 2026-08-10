import { describe, it, expect } from "vitest";
import {
  BudgetSettingsSnapshot,
  buildSettingsChangeData,
  changedBudgetKeys,
} from "../src/stats/settingsChange";

const base: BudgetSettingsSnapshot = {
  windowTokens: 1_000_000,
  budget: 100_000,
  split: { compacted: 0.45, thinking: 0.2, tail: 0.35 },
  triggerPct: 0.75,
  targetPct: 0.5,
};

describe("settingsChange", () => {
  it("reports no changed keys when snapshots are identical", () => {
    expect(changedBudgetKeys(base, { ...base })).toEqual([]);
  });

  it("reports single-key changes (split counts as one key)", () => {
    const after = { ...base, budget: 200_000 };
    expect(changedBudgetKeys(base, after)).toEqual(["budget"]);

    const splitOnly = {
      ...base,
      split: { compacted: 0.4, thinking: 0.2, tail: 0.4 },
    };
    expect(changedBudgetKeys(base, splitOnly)).toEqual(["split"]);
  });

  it("reports multiple changed keys", () => {
    const after = {
      ...base,
      windowTokens: 128_000,
      budget: 64_000,
      triggerPct: 0.85,
      targetPct: 0.6,
    };
    expect(changedBudgetKeys(base, after).sort()).toEqual(
      ["budget", "targetPct", "triggerPct", "windowTokens"],
    );
  });

  it("builds settings_change payload with scope budget", () => {
    const after = { ...base, budget: 64_000 };
    const data = buildSettingsChangeData(base, after);
    expect(data.scope).toBe("budget");
    expect(data.before).toEqual(base);
    expect(data.after).toEqual(after);
    expect(data.changed).toEqual(["budget"]);
  });

  it("treats split as changed when any ratio differs", () => {
    const after = { ...base, split: { ...base.split, tail: 0.4 } };
    expect(changedBudgetKeys(base, after)).toEqual(["split"]);
  });
});
