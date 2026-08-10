import { describe, it, expect } from "vitest";
import {
  assertNoSeqOverlap,
  assertUniqueSeqLines,
  buildCompactedBlock,
  mergeCompactedTracks,
  parseCompactedBlock,
  type CompactBlockParts,
} from "../src/agent/contextCompactor";

describe("assertNoSeqOverlap(增量合并前置断言)", () => {
  it("新旧 seq 不重叠 → 通过", () => {
    expect(() =>
      assertNoSeqOverlap(["- [r1] a", "- [r2] b"], ["- [r3] c", "- [r4] d"], "轨道"),
    ).not.toThrow();
  });

  it("新旧 seq 重叠 → 抛错并列出重叠序号", () => {
    expect(() =>
      assertNoSeqOverlap(["- [r1] 旧", "- [r5] 旧5"], ["- [r2] 新", "- [r5] 新5"], "轨道"),
    ).toThrow(/seq 重叠 \[5\]/);
  });

  it("旧块无带 seq 的行(纯文本摘要) → 不误报", () => {
    expect(() => assertNoSeqOverlap(["旧摘要文本(无行标)"], ["- [r1] a"], "轨道")).not.toThrow();
  });

  it("thinking 合并同样受断言保护", () => {
    expect(() =>
      assertNoSeqOverlap(
        ["- [r9] 正确链路", "- [r10] 中性分析"],
        ["- [r10] 新分析", "- [r11] 新结论"],
        "thinking 增量合并",
      ),
    ).toThrow(/thinking/);
  });
});

describe("assertUniqueSeqLines(合并后断言)", () => {
  it("行内 seq 唯一 → 通过", () => {
    expect(() =>
      assertUniqueSeqLines(["- [r1] a", "- [r2] b", "## 标题", "- [r3] c"], "块"),
    ).not.toThrow();
  });

  it("同 seq 多条不同行 → 抛错(重复/矛盾)", () => {
    expect(() =>
      assertUniqueSeqLines(["- [r2] 内容A", "- [r2] 内容B"], "压缩块"),
    ).toThrow(/seq 重复 \[2\]/);
  });

  it("无行标的行被忽略,不参与唯一性检查", () => {
    expect(() =>
      assertUniqueSeqLines(["- [r1] a", "[前文摘要]", "纯文本行"], "块"),
    ).not.toThrow();
  });
});

describe("断言与增量合并联动", () => {
  it("正常增量合并通过前置断言,产物各轨道可解析", () => {
    const prev: CompactBlockParts = {
      demands: ["- [r1] 旧需求"],
      conclusions: ["- [r2] 旧结论"],
      explanations: [],
      ledger: [],
    };
    const next: CompactBlockParts = {
      demands: ["- [r3] 新需求"],
      conclusions: ["- [r4] 新结论"],
      explanations: [],
      ledger: [],
    };
    // 前置断言:新旧来源 seq 不重叠
    assertNoSeqOverlap(
      [...prev.demands, ...prev.conclusions, ...prev.explanations, ...prev.ledger],
      [...next.demands, ...next.conclusions, ...next.explanations, ...next.ledger],
      "轨道",
    );
    const merged = mergeCompactedTracks(prev, next);
    const parsed = parseCompactedBlock(buildCompactedBlock(merged));
    expect(parsed.demands.map((l) => Number(l.match(/\[r(\d+)\]/)?.[1]))).toEqual([1, 3]);
    expect(parsed.conclusions.map((l) => Number(l.match(/\[r(\d+)\]/)?.[1]))).toEqual([2, 4]);
  });

  it("同消息多行共享消息级 seq(既有设计)不触发前置断言", () => {
    // 同一消息(seq 2)拆出开场结论/结尾结论/工具履历,均带 [r2] —— 允许
    const prevLines = ["- [r2] 开场结论", "- [r2] 结尾结论", "- [r2] Read: src/a.ts"];
    const nextLines = ["- [r3] 新需求"]; // 新段从旧块 maxUsed+1 开始,不重叠
    expect(() => assertNoSeqOverlap(prevLines, nextLines, "轨道")).not.toThrow();
  });
});
