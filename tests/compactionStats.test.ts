import { describe, it, expect } from "vitest";
import { CompactionStats, COMPACTION_STATS_WINDOW } from "../src/agent/compactionStats";

describe("CompactionStats", () => {
  it("counts conversations and compactions within the window", () => {
    const s = new CompactionStats();
    s.beginConversation();
    s.beginConversation();
    s.recordThinkingCompaction();
    s.recordThinkingCompaction();
    s.beginConversation();
    expect(s.windowConversations).toBe(3);
    expect(s.windowCompactions).toBe(2);
    expect(s.conversationCount).toBe(3);
    expect(s.compactionCount).toBe(2);
    const snap = s.snapshot();
    expect(snap.windowSize).toBe(COMPACTION_STATS_WINDOW);
    expect(snap.windowConversations).toBe(3);
    expect(snap.windowCompactions).toBe(2);
    // 趋势序列:对话1 0 次、对话2 2 次、对话3 0 次(旧→新)
    expect(snap.windowSeries).toEqual([0, 2, 0]);
  });

  it("attaches compactions to the most recent conversation", () => {
    const s = new CompactionStats();
    s.beginConversation(); // 对话 1:无压缩
    s.beginConversation(); // 对话 2:2 次压缩
    s.recordThinkingCompaction();
    s.recordThinkingCompaction();
    // 滑动窗口只保留最近一次对话:压缩 2 次
    expect(s.windowCompactions).toBe(2);
    expect(s.windowConversations).toBe(2);
    expect(s.snapshot().windowSeries).toEqual([0, 2]);
  });

  it("drops the oldest conversation once the window is full", () => {
    const s = new CompactionStats();
    // 第 1 次对话压缩 5 次,其余 99 次无压缩 → 填满窗口
    s.beginConversation();
    for (let i = 0; i < 5; i++) s.recordThinkingCompaction();
    for (let i = 0; i < COMPACTION_STATS_WINDOW - 1; i++) s.beginConversation();
    expect(s.windowConversations).toBe(COMPACTION_STATS_WINDOW);
    expect(s.windowCompactions).toBe(5);
    // 再来一次对话:最旧(压缩 5 次的)被挤出窗口
    s.beginConversation();
    expect(s.windowConversations).toBe(COMPACTION_STATS_WINDOW);
    expect(s.windowCompactions).toBe(0);
    expect(s.conversationCount).toBe(COMPACTION_STATS_WINDOW + 1);
    expect(s.compactionCount).toBe(5); // 累计值保留
    // 趋势序列:最旧对话被挤出,其余全 0
    expect(s.snapshot().windowSeries).toEqual(Array(COMPACTION_STATS_WINDOW).fill(0));
  });

  it("recordThinkingCompaction outside any conversation only bumps totals", () => {
    const s = new CompactionStats();
    s.recordThinkingCompaction();
    expect(s.compactionCount).toBe(1);
    expect(s.windowCompactions).toBe(0);
    expect(s.windowConversations).toBe(0);
  });
});
