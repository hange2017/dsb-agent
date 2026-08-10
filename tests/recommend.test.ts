import { describe, it, expect } from "vitest";
import { keywordFilter, Recommender, type PluginCandidate } from "../src/plugins/recommend";

const candidates: PluginCandidate[] = [
  { name: "tdd", source: "marketplace", origin: "mk", description: "test driven development workflow", skills: ["test", "tdd"] },
  { name: "docs", source: "marketplace", origin: "mk", description: "documentation generator", skills: ["doc"] },
];

describe("keywordFilter", () => {
  it("ranks relevant candidates first", () => {
    const out = keywordFilter("写测试的 tdd 流程", candidates);
    expect(out[0]?.name).toBe("tdd");
  });
  it("returns empty when no match", () => {
    expect(keywordFilter("数据库优化", candidates)).toEqual([]);
  });
});

describe("Recommender", () => {
  it("shortlists, ranks, and returns topN", async () => {
    const rec = new Recommender({
      collectCandidates: () => candidates,
      rank: async (_q, c) => c.map((candidate, i) => ({ candidate, score: 1 - i * 0.1, reason: "r" })),
    });
    const out = await rec.recommend("tdd");
    expect(out).toHaveLength(1);
    expect(out[0].candidate.name).toBe("tdd");
    expect(out[0].score).toBeGreaterThan(0);
  });

  it("short-circuits a bare /plugins (empty query) to keyword order without LLM rank", async () => {
    let rankCalls = 0;
    const rec = new Recommender({
      collectCandidates: () => candidates,
      rank: async (_q, c) => {
        rankCalls++;
        return c.map((candidate, i) => ({ candidate, score: 1 - i * 0.1, reason: "r" }));
      },
    });
    const out = await rec.recommend("");
    expect(rankCalls).toBe(0); // 不调 LLM 排序
    expect(out.length).toBe(candidates.length);
    expect(out.every((r) => r.reason === "关键词匹配")).toBe(true);
  });
});
