import { describe, it, expect } from "vitest";
import type { StatsEvent } from "../src/stats/statsStore";
import {
  analyzeCacheAfterCompact,
  hourlyCostSummary,
  sessionRoundAgg,
  type AvalancheAnalysis,
} from "../src/stats/aggregate";

type Data = Record<string, unknown>;

function ev(t: number, type: string, data?: Data): StatsEvent {
  return { t, type, data };
}

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function round(t: number, input: number, cacheRead: number, output: number, extra?: Data): StatsEvent {
  return ev(t, "provider_round", { inputTokens: input, cacheReadTokens: cacheRead, outputTokens: output, ...extra });
}

describe("analyzeCacheAfterCompact", () => {
  it("detects a cache miss avalanche after compaction and records recovery", () => {
    const events: StatsEvent[] = [
      // 压缩前:5 轮高命中(10% miss)
      round(T0, 1000, 900, 100),
      round(T0 + MIN, 1000, 900, 100),
      round(T0 + 2 * MIN, 1000, 900, 100),
      round(T0 + 3 * MIN, 1000, 900, 100),
      round(T0 + 4 * MIN, 1000, 900, 100),
      // 压缩事件
      ev(T0 + 5 * MIN, "compaction", { position: "block", beforeTokens: 50_000, afterTokens: 20_000 }),
      // 压缩后第 1 轮:90% miss(雪崩)
      round(T0 + 6 * MIN, 1000, 100, 100),
      // 恢复期 3 轮:低 miss
      round(T0 + 7 * MIN, 1000, 900, 100),
      round(T0 + 8 * MIN, 1000, 900, 100),
      round(T0 + 9 * MIN, 1000, 900, 100),
    ];

    const result: AvalancheAnalysis = analyzeCacheAfterCompact(events);

    expect(result.compactions).toHaveLength(1);
    const c = result.compactions[0];
    // 基线:压缩前 5 轮 missRate 中位数 = 0.1
    expect(c.beforeMissRate).toBeCloseTo(0.1, 5);
    // 压缩后第 1 轮 missRate = (1000-100)/1000 = 0.9
    expect(c.firstMissRate).toBeCloseTo(0.9, 5);
    // 雪崩轮超额 miss token = (0.9-0.1)*1000 = 800
    expect(c.extraMissTokens).toBeCloseTo(800, 5);
    expect(c.extraMissTokens).toBeGreaterThan(0);
    // 1 轮雪崩 + 3 轮恢复 = 恢复发生在第 4 轮
    expect(c.recoveryRounds).toBe(4);
    expect(result.totalExtraMissTokens).toBeCloseTo(800, 5);
    expect(result.avgRecoveryRounds).toBe(4);
  });

  it("marks unrecovered compactions with recoveryRounds=999 and counts until the end", () => {
    const events: StatsEvent[] = [
      round(T0, 1000, 900, 100),
      round(T0 + MIN, 1000, 900, 100),
      round(T0 + 2 * MIN, 1000, 900, 100),
      ev(T0 + 3 * MIN, "compaction", { startedAt: T0 + 3 * MIN }),
      // 雪崩后不再恢复,只剩 1 轮高 miss
      round(T0 + 4 * MIN, 1000, 100, 100),
    ];

    const result = analyzeCacheAfterCompact(events);
    const c = result.compactions[0];
    expect(c.recoveryRounds).toBe(999);
    expect(c.extraMissTokens).toBeCloseTo(800, 5);
    expect(result.avgRecoveryRounds).toBe(0);
  });

  it("uses only the last 5 chat rounds as baseline", () => {
    // 压缩前 6 轮:最近 5 轮全为 0.1 miss;最早 1 轮 0.5(应被排除)
    const events: StatsEvent[] = [
      round(T0, 1000, 500, 100), // 0.5,最早 → 不在基线窗口
      round(T0 + MIN, 1000, 900, 100),
      round(T0 + 2 * MIN, 1000, 900, 100),
      round(T0 + 3 * MIN, 1000, 900, 100),
      round(T0 + 4 * MIN, 1000, 900, 100),
      round(T0 + 5 * MIN, 1000, 900, 100),
      ev(T0 + 6 * MIN, "compaction", {}),
    ];
    const result = analyzeCacheAfterCompact(events);
    // 全量中位数 = 0.3(会误判),正确基线 = 最近 5 轮中位数 = 0.1
    expect(result.compactions[0].beforeMissRate).toBeCloseTo(0.1, 5);
  });

  it("ignores compact-phase rounds and rounds with zero input", () => {
    const events: StatsEvent[] = [
      round(T0, 1000, 900, 100),
      round(T0 + MIN, 0, 0, 10), // input=0,不计
      round(T0 + 2 * MIN, 1000, 900, 100, { phase: "compact" }), // compact 相位,不计
      ev(T0 + 3 * MIN, "compaction", {}),
    ];
    const result = analyzeCacheAfterCompact(events);
    // 基线来自压缩前仅 1 个有效点 missRate=0.1
    expect(result.compactions[0].beforeMissRate).toBeCloseTo(0.1, 5);
    expect(result.compactions[0].firstMissRate).toBe(0.1); // 无后续 chat 轮 → 回退基线
  });
});

describe("hourlyCostSummary", () => {
  it("groups by local hour and separates qa costs", () => {
    // 两小时:第 1 小时 10:00,第 2 小时 11:00
    const d1 = new Date(2024, 0, 15, 10, 5, 0); // 10:00 本地
    const d2 = new Date(2024, 0, 15, 10, 55, 0); // 仍 10:00 本地
    const d3 = new Date(2024, 0, 15, 11, 2, 0); // 11:00 本地

    const events: StatsEvent[] = [
      round(d1.getTime(), 100_000, 90_000, 50_000), // hit 90k / miss 10k
      round(d2.getTime(), 200_000, 150_000, 100_000), // hit 150k / miss 50k
      round(d3.getTime(), 300_000, 0, 150_000), // 全 miss
      ev(d1.getTime() + 1000, "compaction", { position: "tail" }),
      ev(d1.getTime() + 2000, "compaction_qa", { seq: 1, answerable: true, qaInputTokens: 10_000, qaOutputTokens: 5_000 }),
    ];

    const rows = hourlyCostSummary(events);

    expect(rows).toHaveLength(2);
    expect(rows[0].hour).toBe("2024-01-15T10:00");
    expect(rows[1].hour).toBe("2024-01-15T11:00");

    const h10 = rows[0];
    expect(h10.rounds).toBe(2);
    expect(h10.inputHit).toBe(90_000 + 150_000);
    expect(h10.inputMiss).toBe(10_000 + 50_000);
    expect(h10.output).toBe(50_000 + 100_000);
    expect(h10.compactions).toBe(1);
    expect(h10.qaInput).toBe(10_000);
    expect(h10.qaOutput).toBe(5_000);

    const h11 = rows[1];
    expect(h11.rounds).toBe(1);
    expect(h11.inputMiss).toBe(300_000);
    expect(h11.compactions).toBe(0);
    expect(h11.qaInput).toBe(0);

    // 默认单价:hit 0.02/M, miss 1/M, output 2/M
    expect(h10.costHit).toBeCloseTo((240_000 / 1e6) * 0.02, 8);
    expect(h10.costMiss).toBeCloseTo((60_000 / 1e6) * 1, 8);
    expect(h10.costOutput).toBeCloseTo((150_000 / 1e6) * 2, 8);
    expect(h10.costTotal).toBeCloseTo(h10.costHit + h10.costMiss + h10.costOutput, 8);
    // qa:input 按 miss 单价 1/M,output 按 2/M
    expect(h10.qaCost).toBeCloseTo((10_000 / 1e6) * 1 + (5_000 / 1e6) * 2, 8);
    expect(h10.realCost).toBeCloseTo(h10.costTotal - h10.qaCost, 8);

    expect(h11.realCost).toBeCloseTo(h11.costTotal, 8); // 无 qa
  });

  it("honors custom prices", () => {
    const d = new Date(2024, 5, 1, 9, 0, 0);
    const events: StatsEvent[] = [round(d.getTime(), 1_000_000, 0, 500_000)];
    const rows = hourlyCostSummary(events, { hitPerM: 0.1, missPerM: 2, outputPerM: 3 });
    expect(rows[0].costMiss).toBeCloseTo(2, 8);
    expect(rows[0].costOutput).toBeCloseTo(1.5, 8);
  });
});

describe("sessionRoundAgg", () => {
  it("marks rounds as failed when followed by an error event", () => {
    const events: StatsEvent[] = [
      round(T0, 1000, 500, 100, { windowTokens: 100_000 }),
      // 第 0 轮之后跟 error
      ev(T0 + 10_000, "error", { message: "boom" }),
      round(T0 + 20_000, 2000, 1000, 200, { windowTokens: 100_000 }),
      round(T0 + 30_000, 3000, 1500, 300, { windowTokens: 200_000 }),
    ];

    const result = sessionRoundAgg(events);

    expect(result.rounds).toHaveLength(3);
    expect(result.rounds[0].roundIndex).toBe(0);
    expect(result.rounds[0].ok).toBe(false); // 到下一轮之间有 error
    expect(result.rounds[1].roundIndex).toBe(1);
    expect(result.rounds[1].ok).toBe(true);
    expect(result.rounds[2].roundIndex).toBe(2);
    expect(result.rounds[2].ok).toBe(true);
    expect(result.rounds[0].roundsSinceCompaction).toBe(-1);
    expect(result.rounds[0].windowTokens).toBe(100_000);

    // 分组:100k 组 2 轮(1 ok)、200k 组 1 轮(1 ok)
    expect(result.agg).toHaveLength(2);
    const g100 = result.agg.find((g) => g.windowTokens === 100_000)!;
    const g200 = result.agg.find((g) => g.windowTokens === 200_000)!;
    expect(g100.roundsAnalyzed).toBe(2);
    expect(g100.successRate).toBe(0.5);
    expect(g200.roundsAnalyzed).toBe(1);
    expect(g200.successRate).toBe(1);
  });

  it("tracks roundsSinceCompaction after a compaction and assigns compressCount to the largest group", () => {
    const events: StatsEvent[] = [
      round(T0, 1000, 500, 100, { windowTokens: 50_000 }),
      ev(T0 + 5000, "compaction", { position: "block" }),
      round(T0 + 10_000, 2000, 1000, 200, { windowTokens: 50_000 }),
      round(T0 + 20_000, 3000, 1500, 300, { windowTokens: 50_000 }),
    ];

    const result = sessionRoundAgg(events);

    expect(result.rounds[0].roundsSinceCompaction).toBe(-1);
    // 压缩后第 1 轮 = 1(压缩之后到本轮内)
    expect(result.rounds[1].roundsSinceCompaction).toBe(1);
    expect(result.rounds[2].roundsSinceCompaction).toBe(2);

    // compaction 总数分到轮数最多的组(50k 组 3 轮)
    expect(result.agg).toHaveLength(1);
    expect(result.agg[0].compressCount).toBe(1);
    expect(result.agg[0].roundsAnalyzed).toBe(3);
    expect(result.agg[0].successRate).toBe(1);
  });

  it("uses a custom window field", () => {
    const events: StatsEvent[] = [
      round(T0, 1000, 500, 100, { budget: 42 }),
      round(T0 + 10_000, 2000, 1000, 200, { budget: 42 }),
    ];
    const result = sessionRoundAgg(events, { windowField: "budget" });
    expect(result.rounds[0].windowTokens).toBe(42);
    expect(result.rounds[1].windowTokens).toBe(42);
    expect(result.agg).toHaveLength(1);
    expect(result.agg[0].windowTokens).toBe(42);
  });

  it("maps zero windowTokens to its own bucket", () => {
    const events: StatsEvent[] = [
      round(T0, 1000, 500, 100), // 无 windowTokens 字段 → 0
      round(T0 + 10_000, 2000, 1000, 200, { windowTokens: 0 }),
      round(T0 + 20_000, 3000, 1500, 300, { windowTokens: 0 }),
    ];
    const result = sessionRoundAgg(events);
    expect(result.agg).toHaveLength(1);
    expect(result.agg[0].windowTokens).toBe(0);
    expect(result.agg[0].roundsAnalyzed).toBe(3);
  });
});
