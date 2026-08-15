import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ContextManager } from "../src/agent/contextManager";
import { ContextStore } from "../src/context/contextStore";
import { buildCompactedBlock, parseCompactedBlock, parseThinkingBlock } from "../src/agent/contextCompactor";
import { estimateTokens } from "../src/stats/providerSendStats";
import type { ProviderMessage } from "../src/agent/provider/types";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cm-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 8 条消息:需求 + assistant(文本+tool_use) + tool_result + 需求 → 切 head=4 */
function eightMessages(): ProviderMessage[] {
  return [
    { role: "user", content: "需求A" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "开场结论\n\n" + "中间长解释".repeat(60) + "\n\n结尾结论" },
        { type: "tool_use", id: "t1", name: "Read", input: { path: "src/a.ts" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok\nline2" }] },
    { role: "user", content: "需求B" },
    { role: "user", content: "tail0" },
    { role: "user", content: "tail1" },
    { role: "user", content: "tail2" },
    { role: "user", content: "tail3" },
  ];
}

describe("ContextManager", () => {
  it("tracks ratio from usage", () => {
    const cm = new ContextManager({ windowTokens: 1000, triggerRatio: 0.8, summarize: async () => "S" });
    cm.track({ inputTokens: 900, outputTokens: 10 });
    expect(cm.ratio).toBe(0.9);
    expect(cm.needsCompaction()).toBe(true);
  });
  it("setWindowTokens updates ratio denominator", () => {
    const cm = new ContextManager({ windowTokens: 1000, triggerRatio: 0.8, summarize: async () => "S" });
    cm.track({ inputTokens: 500, outputTokens: 0 });
    expect(cm.ratio).toBe(0.5);
    cm.setWindowTokens(500);
    expect(cm.ratio).toBe(1);
    expect(cm.needsCompaction()).toBe(true);
  });

  it("compacts history into stratified block + tail", async () => {
    const cm = new ContextManager({ windowTokens: 1000, triggerRatio: 0.8, summarize: async () => "S" });
    const msgs: ProviderMessage[] = Array.from({ length: 6 }, (_, i) => ({ role: "user", content: `m${i}` }));
    const out = await cm.compact(msgs);
    expect(out).toHaveLength(5);
    expect(out[0].role).toBe("user");
    const content = out[0].content as string;
    expect(content).toContain("[compacted]");
    expect(content).toContain("## 需求");
    expect(content).toContain("- [r1] m0");
    expect(content).toContain("- [r2] m1");
  });

  it("moves the cut back so the tail never starts with an orphaned tool_result", async () => {
    const cm = new ContextManager({ windowTokens: 1000, triggerRatio: 0.8, summarize: async () => "S" });
    const msgs: ProviderMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      { role: "user", content: "b" },
      { role: "user", content: "c" },
      { role: "user", content: "d" },
    ];
    const out = await cm.compact(msgs);
    const tail = out.slice(1);
    const first = tail[0];
    const orphaned =
      first.role === "user" &&
      Array.isArray(first.content) &&
      first.content.some((b) => b.type === "tool_result");
    expect(orphaned).toBe(false);
    const flat = JSON.stringify(tail);
    expect(flat).toContain("t1");
    expect(flat).toContain("tool_result");
  });

  it("splits assistant text into conclusion/explanation tracks and summarizes only explanations", async () => {
    const summarize = vi.fn(async (text: string, opts: { maxTokens: number }) => `摘要(${text.length})`);
    const cm = new ContextManager({ windowTokens: 1000, triggerRatio: 0.8, summarize });
    const out = await cm.compact(eightMessages());
    const content = out[0].content as string;
    expect(content).toContain("## 需求");
    expect(content).toContain("- [r1] 需求A");
    expect(content).toContain("- [r4] 需求B");
    expect(content).toContain("## 结论");
    expect(content).toContain("- [r2] 开场结论");
    expect(content).toContain("- [r2] 结尾结论");
    expect(content).toContain("## 说明");
    expect(content).toContain("摘要(");
    expect(content).toContain("## 工具履历");
    expect(content).toContain("- [r2] Read: src/a.ts");
    expect(content).toContain("- [r3] ⤷ ok | line2");
    expect(summarize).toHaveBeenCalledTimes(1);
    const [text, opts] = summarize.mock.calls[0] as [string, { maxTokens: number }];
    expect(text).toContain("中间长解释");
    expect(opts.maxTokens).toBe(800);
  });

  it("incremental compaction keeps old block lines and only processes new segment", async () => {
    const summarize = vi.fn(async () => "S");
    const oldBlock = buildCompactedBlock({
      demands: ["- [r1] 旧需求"],
      conclusions: ["- [r2] 旧结论"],
      explanations: [],
      ledger: [],
    });
    const msgs: ProviderMessage[] = [
      { role: "user", content: oldBlock },
      { role: "user", content: "新需求X" },
      { role: "user", content: "新需求Y" },
      { role: "user", content: "tail0" },
      { role: "user", content: "tail1" },
      { role: "user", content: "tail2" },
    ];
    const cm = new ContextManager({ windowTokens: 1000, triggerRatio: 0.8, summarize });
    const out = await cm.compact(msgs);
    const content = out[0].content as string;
    expect(content).toContain("- [r1] 旧需求");
    expect(content).toContain("- [r2] 旧结论");
    expect(content).toContain("- [r3] 新需求X");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("incremental compaction summarizes only new explanation text", async () => {
    const summarize = vi.fn(async (text: string) => `新摘要(${text.length})`);
    const oldBlock = buildCompactedBlock({ demands: [], conclusions: [], explanations: [], ledger: [] });
    const longPara = "这是一段需要被摘要的长解释内容。".repeat(60);
    const msgs: ProviderMessage[] = [
      { role: "user", content: oldBlock },
      { role: "assistant", content: [{ type: "text", text: longPara }] },
      { role: "user", content: "tail0" },
      { role: "user", content: "tail1" },
      { role: "user", content: "tail2" },
      { role: "user", content: "tail3" },
      { role: "user", content: "tail4" },
    ];
    const cm = new ContextManager({ windowTokens: 1000, triggerRatio: 0.8, summarize });
    const out = await cm.compact(msgs);
    const content = out[0].content as string;
    expect(content).toContain("## 说明");
    expect(content).toContain("新摘要(");
    expect(content).toContain("- [r2] tail0");
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0][0]).toContain("长解释");
  });

  it("writes cold storage chunks with seq matching block lines", async () => {
    const store = new ContextStore(tmp);
    const cm = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.8,
      summarize: async () => "S",
      contextStore: store,
      sessionId: "s1",
    });
    await cm.compact(eightMessages());
    const chunks = store.load("s1");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((c) => c.type === "demand" && c.seq === 1 && c.content === "需求A")).toBe(true);
    expect(chunks.some((c) => c.type === "ledger" && c.seq === 2 && c.content === "Read: src/a.ts")).toBe(true);
    expect(chunks.some((c) => c.type === "ledger" && c.seq === 3 && c.role === "tool")).toBe(true);
  });

  it("prunes cold storage beyond maxChunks", async () => {
    const store = new ContextStore(tmp, { maxChunks: 2 });
    const cm = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.8,
      summarize: async () => "S",
      contextStore: store,
      sessionId: "s1",
    });
    await cm.compact(eightMessages());
    const chunks = store.load("s1");
    expect(chunks.length).toBeLessThanOrEqual(2);
  });

  it("keeps legacy 前文摘要 into conclusions track", async () => {
    const cm = new ContextManager({ windowTokens: 1000, triggerRatio: 0.8, summarize: async () => "S" });
    const msgs: ProviderMessage[] = [
      { role: "user", content: "[前文摘要]\n旧版摘要内容" },
      { role: "user", content: "tail0" },
      { role: "user", content: "tail1" },
      { role: "user", content: "tail2" },
      { role: "user", content: "tail3" },
    ];
    const out = await cm.compact(msgs);
    const content = out[0].content as string;
    expect(content).toContain("## 结论");
    expect(content).toContain("旧版摘要内容");
  });

  it("shrinks oversized compacted block: re-summarizes oldest explanations then truncates long lines", async () => {
    // 第一次调用(解释轨摘要)返回原样(长),第二次调用(收缩再摘要)返回短文本
    const long = "这是一段非常非常长的解释性分析内容,需要被再次压缩到更短。".repeat(200);
    const summarize = vi
      .fn()
      .mockImplementationOnce(async (text: string) => text) // 长
      .mockImplementationOnce(async (text: string) => `再摘要:${text.slice(0, 40)}…`);
    const cm = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.8,
      summarize,
      maxBlockChars: 2000,
      maxCompactTextTokens: 800,
    });
    const msgs: ProviderMessage[] = [
      { role: "user", content: "需求:精简输出" },
      {
        role: "assistant",
        content: [{ type: "text", text: `开场结论\n\n${long}\n\n结尾结论` }],
      },
      { role: "user", content: "tail0" },
      { role: "user", content: "tail1" },
      { role: "user", content: "tail2" },
      { role: "user", content: "tail3" },
    ];
    const out = await cm.compact(msgs);
    const content = out[0].content as string;
    // 收缩后块长度受控(re-summarize 只压新增尾部、保留旧行 → 首次压缩走 hardMax 扩容, 仍 ≤8K)
    expect(content.length).toBeLessThanOrEqual(8000);
    // 需求/结论原文保留
    expect(content).toContain("需求:精简输出");
    expect(content).toContain("开场结论");
    expect(content).toContain("结尾结论");
    // 说明轨被再摘要(第二次 summarize,预算 ≈200)
    expect(content).toContain("再摘要:");
    expect(summarize).toHaveBeenCalledTimes(2);
    const [, opts2] = summarize.mock.calls[1] as [string, { maxTokens: number }];
    expect(opts2.maxTokens).toBe(200);
    // 收缩产物仍可解析、可增量合并
    const parsed = parseCompactedBlock(content);
    expect(parsed.demands[0]).toContain("需求:精简输出");
    const more: ProviderMessage[] = [
      { role: "user", content },
      { role: "user", content: "新需求" },
      { role: "user", content: "中间" },
      { role: "user", content: "tailA" },
      { role: "user", content: "tailB" },
      { role: "user", content: "tailC" },
      { role: "user", content: "tailD" },
    ];
    const out2 = await cm.compact(more);
    expect((out2[0].content as string)).toContain("再摘要:");
    expect((out2[0].content as string)).toContain("新需求");
  });

  it("auto-expands the block limit when content far exceeds maxBlockChars (no truncation loss)", async () => {
    // 10 条长需求(无解释轨)→ 块 ~5KB 远超默认 2KB 上限,但未超硬上限(默认 ×4=8KB)
    // → 自动扩容返回未截断块,需求原文完整
    const cm = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.8,
      summarize: async () => "S",
      maxBlockChars: 2000,
    });
    const demandText = "需求描述" + "很长的具体内容".repeat(60); // ~480 字符
    const msgs: ProviderMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: "user",
      content: `需求${i}:${demandText}`,
    }));
    msgs.push(
      { role: "user", content: "tail0" },
      { role: "user", content: "tail1" },
      { role: "user", content: "tail2" },
      { role: "user", content: "tail3" },
    );
    const out = await cm.compact(msgs);
    const content = out[0].content as string;
    // 块超过默认上限(未压进 2000)
    expect(content.length).toBeGreaterThan(2000);
    // 但未截断:所有需求原文完整,无 "…" 截断标记
    expect(content).not.toContain("…");
    expect(content).toContain("需求9:" + demandText);
  });

  it("truncates long lines only when block exceeds the hard cap", async () => {
    const cm = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.8,
      summarize: async () => "S",
      maxBlockChars: 2000,
      maxBlockCharsHard: 8000,
    });
    const demandText = "需求描述" + "很长的具体内容".repeat(60); // ~480 字符
    const msgs: ProviderMessage[] = Array.from({ length: 30 }, (_, i) => ({
      role: "user",
      content: `需求${i}:${demandText}`,
    }));
    msgs.push(
      { role: "user", content: "tail0" },
      { role: "user", content: "tail1" },
      { role: "user", content: "tail2" },
      { role: "user", content: "tail3" },
    );
    const out = await cm.compact(msgs);
    const content = out[0].content as string;
    // 30 条长需求 ~15KB 超硬上限 → 截断兜底
    expect(content).toContain("…");
    // 所有需求行仍在(截断而非丢弃)
    expect(content).toContain("需求0:");
    expect(content).toContain("需求29:");
  });
});

/** 4 条 head 消息:需求 + assistant(thinking+text+tool_use) + tool_result + assistant(thinking+text) */
function thinkingMessages(): ProviderMessage[] {
  return [
    { role: "user", content: "需求:解三次方程" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "观察到三次项系数 1,尝试因式分解,猜测根为 ±1…" },
        { type: "text", text: "采用因式分解法" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "solve x^3-1" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok: 根为 -1,1,1" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "验证每个根代入原方程是否为零…" },
        { type: "text", text: "验证通过,结论确定" },
      ],
    },
    { role: "user", content: "tail0" },
    { role: "user", content: "tail1" },
    { role: "user", content: "tail2" },
    { role: "user", content: "tail3" },
  ];
}

function thinkingSummarize() {
  return vi.fn(async (text: string, opts: { maxTokens: number; rules?: string }) => {
    if (opts.rules) {
      return [
        "[thinking]",
        "## 正确",
        "- [r2] 链路:因式分解 → 得根 -1,1,1 → 展开验证成立 → 采用此法",
        "## 错误",
        "- [r3] 方向:直接展开 | 结论:太繁琐,放弃",
        "## 中性",
        "- [r4] 概要:验证根是否满足原方程",
      ].join("\n");
    }
    return "S";
  });
}

describe("ContextManager thinking", () => {
  it("collects thinking with paired context and emits a standalone thinking block", async () => {
    const summarize = thinkingSummarize();
    const cm = new ContextManager({ windowTokens: 1000, triggerRatio: 0.8, summarize });
    const out = await cm.compact(thinkingMessages());
    // [压缩块, thinking块, tail×4]
    expect(out).toHaveLength(6);
    expect(out[0].content).toContain("[compacted]");
    const thinkingContent = out[1].content as string;
    expect(thinkingContent).toContain("[thinking]");
    expect(thinkingContent).toContain("- [r2] 链路:因式分解 → 得根 -1,1,1 → 展开验证成立 → 采用此法");
    expect(thinkingContent).toContain("- [r3] 方向:直接展开 | 结论:太繁琐,放弃");
    expect(thinkingContent).toContain("- [r4] 概要:验证根是否满足原方程");
    expect((out[2].content as string)).toBe("tail0");
  });

  it("injects THINKING_COMPACTION_RULES into the thinking summarize call", async () => {
    const summarize = thinkingSummarize();
    const cm = new ContextManager({ windowTokens: 1000, triggerRatio: 0.8, summarize });
    await cm.compact(thinkingMessages());
    const call = summarize.mock.calls.find(([, o]) => (o as { rules?: string }).rules) as
      | [string, { rules?: string }]
      | undefined;
    expect(call).toBeDefined();
    expect(call![1].rules).toContain("[thinking]");
    expect(call![0]).toContain("[r2] 推理原文:");
    expect(call![0]).toContain("观察到三次项系数 1");
    // 配对上下文:同消息文本 + 该轮 tool_result 摘要 + 后续 assistant text
    expect(call![0]).toContain("同消息文本:采用因式分解法");
    expect(call![0]).toContain("工具结果:ok: 根为 -1,1,1");
    expect(call![0]).toContain("后续结论:验证通过,结论确定");
  });

  it("merges old thinking block lines incrementally with new ones", async () => {
    const summarize = thinkingSummarize();
    const cm = new ContextManager({ windowTokens: 1000, triggerRatio: 0.8, summarize });
    const first = await cm.compact(thinkingMessages());
    // 第一次:seq r2/r3/r4 已入块
    expect((first[1].content as string)).toContain("- [r2] 链路:因式分解");
    // 第二次压缩:输入 = [压缩块, thinking块, 新消息…]
    const more: ProviderMessage[] = [
      ...first,
      { role: "user", content: "tail4" },
      { role: "user", content: "tail5" },
      { role: "user", content: "tail6" },
      { role: "user", content: "tail7" },
      { role: "user", content: "tail8" },
      { role: "user", content: "tail9" },
    ];
    const out2 = await cm.compact(more);
    expect(out2[0].content).toContain("[compacted]");
    const t2 = out2[1].content as string;
    // 旧脉络保留
    expect(t2).toContain("- [r2] 链路:因式分解");
    expect(t2).toContain("[thinking]");
  });

  it("trims oversized thinking blocks by dropping oldest rows (no extra LLM call)", async () => {
    const summarize = thinkingSummarize();
    const cm = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.8,
      summarize,
      thinkingMaxChars: 60,
      thinkingTrimChars: 30,
    });
    const out = await cm.compact(thinkingMessages());
    const t = out[1].content as string;
    expect(t.length).toBeLessThanOrEqual(60);
    // 最旧的 r2 被丢,r4 保留
    expect(t).not.toContain("- [r2] 链路");
    expect(t).toContain("- [r4]");
    // 收缩不引入额外 LLM 调用(仅 1 次 thinking 调用)
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("falls back to placeholder lines when thinking summarization throws", async () => {
    const summarize = vi
      .fn()
      .mockImplementationOnce(async () => "S") // explanation(无)
      .mockImplementationOnce(async () => {
        throw new Error("boom");
      });
    const cm = new ContextManager({ windowTokens: 1000, triggerRatio: 0.8, summarize });
    const out = await cm.compact(thinkingMessages());
    expect(out[0].content).toContain("[compacted]");
    const t = out[1].content as string;
    expect(t).toContain("- [r2] 推理:(原文已省略)");
    expect(t).toContain("- [r4] 推理:(原文已省略)");
  });

  it("skips thinking entirely when thinkingEnabled is false", async () => {
    const summarize = thinkingSummarize();
    const cm = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.8,
      summarize,
      thinkingEnabled: false,
    });
    const out = await cm.compact(thinkingMessages());
    // [压缩块, tail×4] 无 thinking 块
    expect(out).toHaveLength(5);
    expect(JSON.stringify(out[1].content)).not.toContain("[thinking]");
    // 无 rules 调用
    expect(summarize.mock.calls.every(([, o]) => !(o as { rules?: string }).rules)).toBe(true);
  });

  it("writes thinking originals to cold storage and backfills summary with the trace line", async () => {
    const store = new ContextStore(tmp);
    const cm = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.8,
      summarize: thinkingSummarize(),
      contextStore: store,
      sessionId: "s1",
    });
    await cm.compact(thinkingMessages());
    const chunks = store.load("s1");
    const thinking = chunks.filter((c) => c.type === "thinking");
    expect(thinking.length).toBe(2);
    expect(thinking.map((c) => c.seq).sort()).toEqual([2, 4]);
    // content 保留 thinking 原文
    expect(thinking.some((c) => c.content.includes("尝试因式分解"))).toBe(true);
    expect(thinking.some((c) => c.content.includes("验证每个根"))).toBe(true);
    // summary 回写为压缩后的脉络行(而非原文首行)
    const c2 = thinking.find((c) => c.seq === 2)!;
    expect(c2.summary).toContain("- [r2] 链路:因式分解");
    const c4 = thinking.find((c) => c.seq === 4)!;
    expect(c4.summary).toContain("- [r4] 概要");
  });

  it("drops the old thinking block when recompacting with thinkingEnabled false", async () => {
    const summarize = thinkingSummarize();
    const on = new ContextManager({ windowTokens: 1000, triggerRatio: 0.8, summarize });
    const first = await on.compact(thinkingMessages());
    expect((first[1].content as string)).toContain("[thinking]");
    const off = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.8,
      summarize: vi.fn(async () => "S"),
      thinkingEnabled: false,
    });
    const msgs: ProviderMessage[] = [
      ...first,
      { role: "user", content: "tail4" },
      { role: "user", content: "tail5" },
      { role: "user", content: "tail6" },
      { role: "user", content: "tail7" },
      { role: "user", content: "tail8" },
      { role: "user", content: "tail9" },
    ];
    const out2 = await off.compact(msgs);
    expect(JSON.stringify(out2.slice(0, 2))).not.toContain("[thinking]");
  });
});

describe("ContextManager thinking toggle", () => {
  it("setThinkingEnabled hot-updates the switch between compactions", async () => {
    const summarize = thinkingSummarize();
    const cm = new ContextManager({ windowTokens: 1000, triggerRatio: 0.8, summarize });
    // 初始默认开
    const on = await cm.compact(thinkingMessages());
    expect((on[1].content as string)).toContain("[thinking]");
    // 关闭后压缩:无 thinking 块
    cm.setThinkingEnabled(false);
    const off = await cm.compact(thinkingMessages());
    expect(JSON.stringify(off.slice(0, 2))).not.toContain("[thinking]");
    // 重新开启
    cm.setThinkingEnabled(true);
    const again = await cm.compact(thinkingMessages());
    expect((again[1].content as string)).toContain("[thinking]");
  });

  it("thinking off normalizes budget to two shorts (compacted+tail), default split {0.45,0.2,0.35}->{0.5625,0,0.4375}", () => {
    const summarize = thinkingSummarize();
    const cm = new ContextManager({ windowTokens: 1_000_000, triggerRatio: 0.9, historyTokenBudget: 20000, summarize });
    const budgetOf = (): { tailTokens: number; compactedTokens: number; thinkingTokens: number } =>
      (cm as unknown as { budgetInfo: () => { tailTokens: number; compactedTokens: number; thinkingTokens: number } }).budgetInfo();
    // thinking 开启:三段分配(默认 split)
    cm.setThinkingEnabled(true);
    const on = budgetOf();
    expect(on.thinkingTokens).toBeGreaterThan(0);
    expect(on.compactedTokens).toBe(9000); // 20000*0.45/1.0
    expect(on.tailTokens).toBe(7000);      // 20000*0.35/1.0
    // thinking 关闭:thinking 份额并入 compacted/tail 两段,归一化到原两段比例
    cm.setThinkingEnabled(false);
    const off = budgetOf();
    expect(off.thinkingTokens).toBe(0);
    expect(off.compactedTokens).toBe(Math.floor(20000 * 0.5625)); // =11250
    expect(off.tailTokens).toBe(Math.floor(20000 * 0.4375));      // =8750
    // 两段归一化后总额应覆盖全部预算(不再有 thinking 单独占用)
    expect(off.compactedTokens + off.tailTokens).toBeGreaterThan(on.compactedTokens + on.tailTokens);
  });
});

describe("ContextManager thinking smoke", () => {
  it("compresses a realistic thinking-heavy conversation into [compacted] + [thinking] + tail, then merges incrementally", async () => {
    const msgs: ProviderMessage[] = [];
    for (let i = 0; i < 5; i++) {
      msgs.push({ role: "user", content: `需求${i}` });
      msgs.push({
        role: "assistant",
        content: [
          { type: "thinking", thinking: `第${i}轮推理:分析需求${i},尝试方案 A/B…` },
          { type: "text", text: `结论:采用方案${i}` },
          { type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `run ${i}` } },
        ],
      });
      msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `ok: 输出${i}` }] });
    }
    msgs.push(
      { role: "user", content: "tail0" },
      { role: "user", content: "tail1" },
      { role: "user", content: "tail2" },
      { role: "user", content: "tail3" },
    );
    const summarize = vi.fn(async (text: string, opts: { maxTokens: number; rules?: string }) => {
      if (opts.rules) {
        return "[thinking]\n## 正确\n- [r2] 链路:方案A 展开验证成立\n## 中性\n- [r6] 概要:方案B 待验证";
      }
      return "S";
    });
    const cm = new ContextManager({ windowTokens: 1000, triggerRatio: 0.8, summarize });
    const out = await cm.compact(msgs);
    // 结构:[压缩块, thinking块, tail…]
    expect(out.length).toBeGreaterThanOrEqual(6);
    const block = out[0].content as string;
    expect(block).toContain("[compacted]");
    const t = out[1].content as string;
    expect(t).toContain("[thinking]");
    // 压缩块四轨完整,thinking 不混入常规轨
    const parsed = parseCompactedBlock(block);
    expect(parsed.demands.length).toBe(5);
    expect(parsed.ledger.length).toBeGreaterThan(0);
    expect(block).not.toContain("推理:分析需求");
    // thinking 块可解析
    const thinkingParts = parseThinkingBlock(t);
    expect(thinkingParts.correct.some((l) => l.includes("方案A"))).toBe(true);
    // 增量:再次压缩保留旧 thinking 脉络,新段只加需求
    const more: ProviderMessage[] = [
      ...out,
      { role: "user", content: "新需求X" },
      { role: "user", content: "t2" },
      { role: "user", content: "t3" },
      { role: "user", content: "t4" },
      { role: "user", content: "t5" },
      { role: "user", content: "t6" },
    ];
    const out2 = await cm.compact(more);
    expect((out2[1].content as string)).toContain("- [r2] 链路:方案A");
    expect((out2[0].content as string)).toContain("新需求X");
  });
});

describe("ContextManager thinking lenient parsing", () => {
  it("accepts summarize output without the [thinking] marker", async () => {
    const summarize = vi.fn(async (text: string, opts: { maxTokens: number; rules?: string }) => {
      if (opts.rules) {
        // 模型没输出 [thinking] 标记,只有小节
        return "## 正确\n- [r2] 链路:因式分解验证\n## 中性\n- [r4] 概要:验证根";
      }
      return "S";
    });
    const cm = new ContextManager({ windowTokens: 1000, triggerRatio: 0.8, summarize });
    const out = await cm.compact(thinkingMessages());
    const t = out[1].content as string;
    expect(t).toContain("[thinking]"); // 组装时程序补上标记
    expect(t).toContain("- [r2] 链路:因式分解验证");
    expect(t).toContain("- [r4] 概要:验证根");
    // 两条 thinking 都命中,不补占位
    expect(t).not.toContain("推理:(原文已省略)");
  });

  it("accepts trace lines without the leading '- ' prefix", async () => {
    const summarize = vi.fn(async (text: string, opts: { maxTokens: number; rules?: string }) => {
      if (opts.rules) {
        return "[thinking]\n## 正确\n[r2] 链路:因式分解验证\n[r4] 概要:验证根";
      }
      return "S";
    });
    const cm = new ContextManager({ windowTokens: 1000, triggerRatio: 0.8, summarize });
    const out = await cm.compact(thinkingMessages());
    const t = out[1].content as string;
    expect(t).toContain("链路:因式分解验证");
    expect(t).not.toContain("推理:(原文已省略)");
  });

  it("backfills placeholder summaries when the model emits nothing parseable", async () => {
    const store = new ContextStore(tmp);
    const summarize = vi.fn(async (text: string, opts: { maxTokens: number; rules?: string }) => {
      if (opts.rules) return "抱歉,我无法处理"; // 无小节无标记
      return "S";
    });
    const cm = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.8,
      summarize,
      contextStore: store,
      sessionId: "s1",
    });
    const out = await cm.compact(thinkingMessages());
    const t = out[1].content as string;
    expect(t).toContain("- [r2] 推理:(原文已省略)");
    // 冷存储 summary 也回写为占位行,content 仍是原文
    const thinking = store.load("s1").filter((c) => c.type === "thinking");
    expect(thinking.find((c) => c.seq === 2)!.summary).toBe("- [r2] 推理:(原文已省略)");
    expect(thinking.find((c) => c.seq === 2)!.content).toContain("尝试因式分解");
  });
});

describe("ContextManager history token budget", () => {
  /** 中文文本,token ≈ 字符数(1 CJK ≈ 1 token)。 */
  const textMsg = (n: number): ProviderMessage => ({ role: "user", content: "中".repeat(n) });

  it("keeps tail within budget and compacts the rest", async () => {
    // 8 条,每条 50 tokens;total=1000 → tail 35% = 350;v2 压缩后目标 = 350×50% = 175
    // → 从尾部累加 3 条(150 ≤ 175,第 4 条 200 > 175),cut=5
    const msgs: ProviderMessage[] = Array.from({ length: 8 }, () => textMsg(50));
    const cm = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.8,
      summarize: async () => "S",
      historyTokenBudget: 1000,
    });
    const out = await cm.compact(msgs);
    // 压缩块 + tail(3 条原样) = 4 条
    expect(out).toHaveLength(4);
    expect(out[0].role).toBe("user");
    expect((out[0].content as string)).toContain("[compacted]");
    // tail = out.slice(1) 与原 history 尾部 3 条一致(连续 slice)
    expect(out.slice(1)).toEqual(msgs.slice(5));
  });

  it("always keeps the current round even with a tiny budget", async () => {
    const msgs: ProviderMessage[] = Array.from({ length: 5 }, () => textMsg(200));
    const cm = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.8,
      summarize: async () => "S",
      historyTokenBudget: 100, // tail 35 = 35 tokens,单条 200 远超
    });
    const out = await cm.compact(msgs);
    // 仍保留最后一条(当前轮),其余全部进压缩块
    expect(out[out.length - 1]).toEqual(msgs[msgs.length - 1]);
    expect(out[0].role).toBe("user");
    expect((out[0].content as string)).toContain("[compacted]");
  });

  it("returns history unchanged when everything fits in tail budget", async () => {
    const msgs: ProviderMessage[] = Array.from({ length: 6 }, () => textMsg(20)); // 共 120 tokens
    const cm = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.8,
      summarize: async () => "S",
      historyTokenBudget: 1000, // tail 350,全部能放下
    });
    const out = await cm.compact(msgs);
    expect(out).toEqual(msgs);
  });

  it("does not split tool_use/tool_result pair at the cut point", async () => {
    // 构造:total=170 → tail 额定 59,压缩后目标 29 → 容纳 m7(20)+m6(8)=28,cut 落在 m6(tool_result)
    // → 向前扩展至 m5,使 tool_use 与 tool_result 同侧
    const msgs: ProviderMessage[] = [
      textMsg(100), // m0 最旧
      textMsg(100), // m1
      textMsg(100), // m2
      textMsg(100), // m3
      textMsg(30), // m4
      {
        role: "assistant", // m5
        content: [
          { type: "text", text: "分析" },
          { type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "文件内容" }] }, // m6
      textMsg(20), // m7 当前轮
    ];
    const cm = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.8,
      summarize: async () => "S",
      historyTokenBudget: 170, // tail 额定 59,目标 29:m7(20)+m6(8)=28 ≤ 29,m5 超 → cut=6 落在 tool_result
    });
    const out = await cm.compact(msgs);
    // tool_result 与其 tool_use 必须同侧:tool_result 在 tail,其前一跳 assistant(tool_use) 也必须在 tail
    const toolResultIdx = out.findIndex((m) => m.role === "user" && typeof m.content !== "string");
    expect(toolResultIdx).toBeGreaterThan(0);
    const asst = out[toolResultIdx - 1];
    expect(asst.role).toBe("assistant");
    expect(JSON.stringify(asst.content)).toContain("tool_use");
    expect(JSON.stringify(out[0].content)).toContain("[compacted]");
  });

  it("shrinks the compacted block into its budget (no 4x expansion)", async () => {
    // 20 条长需求 ≈ 20×90=1800 tokens;total=2000 → compacted 45% = 900
    const msgs: ProviderMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: "user",
      content: `需求${i}:` + "内容".repeat(45), // ≈ 90+ tokens/条
    }));
    const cm = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.8,
      summarize: async () => "S",
      historyTokenBudget: 2000,
    });
    const out = await cm.compact(msgs);
    const block = out[0].content as string;
    expect(block).toContain("[compacted]");
    // 压缩块 token ≤ compacted 预算(900);estimateTokens 与实现同口径
    expect(estimateTokens(block)).toBeLessThanOrEqual(900);
  });

  it("trims thinking block into its budget", async () => {
    const summarize = vi.fn(async (text: string, opts: { maxTokens: number; rules?: string }) => {
      if (opts.rules) {
        // 10 行脉络,每行 ~46 tokens → 超 thinking 预算(60)→ 收缩到保留最新 1 行
        return "[thinking]\n## 正确\n" + Array.from({ length: 10 }, (_, i) => `- [r${i + 1}] 推理脉络行${i} ${"详".repeat(40)}`).join("\n");
      }
      return "S";
    });
    const msgs: ProviderMessage[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "推理" }, { type: "text", text: "结论" }],
      },
      textMsg(50),
      textMsg(50),
      textMsg(50),
      textMsg(50),
      textMsg(50),
    ];
    const cm = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.8,
      summarize,
      historyTokenBudget: 300, // thinking 20% = 60 tokens;tail 105 → m0 进入 head
    });
    const out = await cm.compact(msgs);
    const t = out[1].content as string;
    expect(t).toContain("[thinking]");
    expect(estimateTokens(t)).toBeLessThanOrEqual(60);
  });

  it("falls back to legacy behavior when budget is 0", async () => {
    const msgs: ProviderMessage[] = Array.from({ length: 8 }, (_, i) => ({ role: "user", content: `m${i}` }));
    const cm = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.8,
      summarize: async () => "S",
      historyTokenBudget: 0,
    });
    const out = await cm.compact(msgs);
    // 现状:压缩块 + tail 4 条原样
    expect(out).toHaveLength(5);
    expect(out[0].role).toBe("user");
    expect((out[0].content as string)).toContain("[compacted]");
    expect(out.slice(1)).toEqual(msgs.slice(4));
  });
});

describe("ContextManager pipeline v2 (tail self-driven + hysteresis)", () => {
  const textMsg = (n: number): ProviderMessage => ({ role: "user", content: "中".repeat(n) });

  it("needsCompaction triggers from tail size even when window ratio is low", () => {
    // window 巨大 → ratio=0(未 track),窗口兜底不触发;tail 8×50=400 ≥ 额定 350×75%=262 → 触发
    const cm = new ContextManager({
      windowTokens: 1_000_000,
      triggerRatio: 0.75,
      summarize: async () => "S",
      historyTokenBudget: 1000,
    });
    const msgs: ProviderMessage[] = Array.from({ length: 8 }, () => textMsg(50));
    expect(cm.needsCompaction(msgs)).toBe(true);
    // tail 未达触发线:3×50=150 < 262 → 不触发
    const small = Array.from({ length: 3 }, () => textMsg(50));
    expect(cm.needsCompaction(small)).toBe(false);
  });

  it("needsCompaction still fires from window ratio (safety valve) with a small tail", () => {
    const cm = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.75,
      summarize: async () => "S",
      historyTokenBudget: 1000,
    });
    cm.track({ inputTokens: 900, outputTokens: 10 }); // ratio 0.9 ≥ 0.75
    expect(cm.needsCompaction([textMsg(50)])).toBe(true);
  });

  it("needsCompaction without messages only uses window ratio (back-compat)", () => {
    const cm = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.75,
      summarize: async () => "S",
      historyTokenBudget: 1000,
    });
    expect(cm.needsCompaction()).toBe(false);
    cm.track({ inputTokens: 800, outputTokens: 10 });
    expect(cm.needsCompaction()).toBe(true);
  });

  it("compacts block into rated × targetPct (50%)", async () => {
    // total=1000 → compacted 额定 450,target 225;20 条×50 塞满 head → 块收缩到 ≤225
    const msgs: ProviderMessage[] = Array.from({ length: 20 }, () => textMsg(50));
    const cm = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.8,
      summarize: async () => "S",
      historyTokenBudget: 1000,
    });
    const out = await cm.compact(msgs);
    const block = out[0].content as string;
    expect(block).toContain("[compacted]");
    expect(estimateTokens(block)).toBeLessThanOrEqual(225);
    // tail 收缩到 额定×50%:tail 额定 350 → 175 → 3 条(150)
    expect(out.slice(1)).toEqual(msgs.slice(17));
  });

  it("honors custom triggerPct/targetPct", async () => {
    // trigger 0.6:tail 额定 350×0.6=210;5×50=250 ≥ 210 → 触发
    const cm = new ContextManager({
      windowTokens: 1_000_000,
      triggerRatio: 0.75,
      summarize: async () => "S",
      historyTokenBudget: 1000,
      triggerPct: 0.6,
      targetPct: 0.4,
    });
    const five = Array.from({ length: 5 }, () => textMsg(50));
    expect(cm.needsCompaction(five)).toBe(true);
    const two = Array.from({ length: 2 }, () => textMsg(50));
    expect(cm.needsCompaction(two)).toBe(false);
    // compact 目标:tail 350×0.4=140 → 2 条(100)
    const msgs = Array.from({ length: 8 }, () => textMsg(50));
    const out = await cm.compact(msgs);
    expect(out.slice(1)).toEqual(msgs.slice(6));
  });

  it("compacts with compacted block already present (tail only) and advances seq", async () => {
    // 已有压缩块 + 大 tail → 压缩时旧块保留 + 新段追加;块收缩到目标线
    const summarize = vi.fn(async (text: string) => `摘要${text.length}`);
    const cm = new ContextManager({
      windowTokens: 1_000_000,
      triggerRatio: 0.75,
      summarize,
      historyTokenBudget: 430,
    });
    const first = await cm.compact(Array.from({ length: 6 }, () => textMsg(50)));
    expect(first[0].role).toBe("user");
    expect((first[0].content as string)).toContain("[compacted]");
    // 第二轮:首块 + 8 条新消息;tail 400×35%=140,target 70 → keep 1(当前轮)
    const second = await cm.compact([...first, ...Array.from({ length: 8 }, () => textMsg(50))]);
    const block = second[0].content as string;
    expect(block).toContain("[compacted]");
    expect(estimateTokens(block)).toBeLessThanOrEqual(Math.floor(430 * 0.45 * 0.5));
    // 增量合并 + 只删尾部:预算内滚动剔除增量段最新行(r7..r14 中新 seq 被裁),
    // 最旧稳定行 r1 保留(前缀字节稳定);极低预算下块可被削到只剩 r1。
    // 注:预算 430(原 400)+30 为压缩块尾部固定 ContextRecall 提示行的开销(P1b 引入)。
    expect(block).toContain("- [r1]");
    expect(block).not.toContain("- [r13]");
    const maxSeq = Math.max(...[...block.matchAll(/\[r(\d+)\]/g)].map((m) => Number(m[1])), 0);
    // 块内任意行号都来自首轮的稳定段(r1..r6),绝不含本轮新增尾部 r7+
    expect(maxSeq).toBeLessThanOrEqual(6);
  });
});

describe("ContextManager compaction events", () => {
  type Ev = import("../src/stats/compactionEvents").CompactionRecord;
  const textMsg = (n: number): ProviderMessage => ({ role: "user", content: "中".repeat(n) });

  it("emits tail event (tail_self_driven) with before/after tokens and counts", async () => {
    const events: Ev[] = [];
    const cm = new ContextManager({
      windowTokens: 1_000_000, // 窗口兜底不触发
      triggerRatio: 0.75,
      summarize: async () => "S",
      historyTokenBudget: 1000, // tail 额定 350,trigger 75% = 262
      onCompaction: (ev) => events.push(ev),
    });
    const msgs = Array.from({ length: 20 }, () => textMsg(50)); // tail 1000 ≥ 262 → 触发
    const out = await cm.compact(msgs);
    const ev = events.find((e) => e.position === "tail");
    expect(ev).toBeDefined();
    expect(ev!.reason).toBe("tail_self_driven");
    expect(ev!.beforeTokens).toBeGreaterThan(ev!.afterTokens);
    // 压缩耗时统计:startedAt 为 epoch ms,且一次 compact 流程结束后 durationMs ≥ 0
    expect(ev!.startedAt).toBeGreaterThan(0);
    expect(ev!.durationMs).toBeGreaterThanOrEqual(0);
    expect(ev!.headCount).toBe(17); // tail 目标 175 → 保留 3 条(150)
    expect(ev!.tailCount).toBe(3);
    expect(ev!.headCount! + ev!.tailCount!).toBe(msgs.length);
    expect(ev!.budget).toEqual({ total: 1000, compacted: 450, thinking: 200, tail: 350 });
    expect(ev!.sessionId).toBe("default");
    // 压缩后 [compacted 块, ...tail]
    expect(String((out[0].content as string))).toContain("[compacted]");
    expect(out).toHaveLength(4);
  });

  it("emits tail event with reason window_ratio when safety valve fires", async () => {
    const events: Ev[] = [];
    const cm = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.75,
      summarize: async () => "S",
      historyTokenBudget: 1000,
      onCompaction: (ev) => events.push(ev),
    });
    cm.track({ inputTokens: 900, outputTokens: 10 }); // ratio 0.9 ≥ 0.75
    const out = await cm.compact(Array.from({ length: 6 }, () => textMsg(50)));
    const ev = events.find((e) => e.position === "tail");
    expect(ev).toBeDefined();
    expect(ev!.reason).toBe("window_ratio");
    expect(out).toHaveLength(4); // [块, tail×3]
  });

  it("emits block shrink event when compacted block exceeds maxBlockChars", async () => {
    const events: Ev[] = [];
    const cm = new ContextManager({
      windowTokens: 1_000_000,
      triggerRatio: 0.75,
      summarize: async () => "S",
      historyTokenBudget: 1000,
      maxBlockChars: 100, // 需求轨 17×50=850 字 → 必收缩
      onCompaction: (ev) => events.push(ev),
    });
    await cm.compact(Array.from({ length: 20 }, () => textMsg(50)));
    const ev = events.find((e) => e.position === "block");
    expect(ev).toBeDefined();
    expect(ev!.reason).toBe("tail_self_driven");
    expect(ev!.beforeTokens).toBeGreaterThan(ev!.afterTokens);
    expect(ev!.budget?.compacted).toBe(450);
  });

  it("emits thinking and thinking_block events (compress + roll shrink)", async () => {
    const events: Ev[] = [];
    const summarize = thinkingSummarize();
    const cm = new ContextManager({
      windowTokens: 1_000_000,
      triggerRatio: 0.75,
      summarize,
      thinkingMaxChars: 30, // 合并后脉络超限 → 触发滚动
      thinkingTrimChars: 20, // 收缩目标 < 脉络长度 → 实际剔除旧行
      onCompaction: (ev) => events.push(ev),
    });
    // 无预算 → keepTail=4;head=前 4 条(含 thinking 原文),tail=后 4 条文本
    await cm.compact([...thinkingMessages(), ...Array.from({ length: 4 }, () => textMsg(50))]);
    const thinkEv = events.find((e) => e.position === "thinking");
    expect(thinkEv).toBeDefined();
    expect(thinkEv!.reason).toBe("manual"); // 无预算 → manual(窗口/tail 均未触发)
    expect(thinkEv!.beforeTokens).toBeGreaterThan(0);
    expect(thinkEv!.afterTokens).toBeGreaterThan(0);

    const shrinkEv = events.find((e) => e.position === "thinking_block");
    expect(shrinkEv).toBeDefined();
    expect(shrinkEv!.beforeTokens).toBeGreaterThan(shrinkEv!.afterTokens);
  });

  it("emits tail event without budget (manual reason, legacy keepTail=4)", async () => {
    const events: Ev[] = [];
    const cm = new ContextManager({
      windowTokens: 1_000_000,
      triggerRatio: 0.75,
      summarize: async () => "S",
      onCompaction: (ev) => events.push(ev),
    });
    await cm.compact(Array.from({ length: 8 }, () => textMsg(50)));
    const ev = events.find((e) => e.position === "tail");
    expect(ev).toBeDefined();
    expect(ev!.reason).toBe("manual");
    expect(ev!.budget).toBeUndefined();
    expect(ev!.headCount).toBe(4);
    expect(ev!.tailCount).toBe(4);
  });

  it("does not emit when no compaction happens", async () => {
    const events: Ev[] = [];
    const cm = new ContextManager({
      windowTokens: 1_000_000,
      triggerRatio: 0.75,
      summarize: async () => "S",
      historyTokenBudget: 1000,
      onCompaction: (ev) => events.push(ev),
    });
    // 预算内:cut === 0 → 原样返回,不上报
    const small = await cm.compact(Array.from({ length: 3 }, () => textMsg(50)));
    expect(small).toHaveLength(3);
    expect(events).toHaveLength(0);
    // 无预算且 ≤4 条 → 早退不上报
    const cm2 = new ContextManager({
      windowTokens: 1_000_000,
      triggerRatio: 0.75,
      summarize: async () => "S",
      onCompaction: (ev) => events.push(ev),
    });
    await cm2.compact(Array.from({ length: 3 }, () => textMsg(50)));
    expect(events).toHaveLength(0);
  });

  it("records LLM call stats (llmCalls/llmMs/algoMs/selfTokens) on compaction events", async () => {
    const events: Ev[] = [];
    let summarizeCalls = 0;
    const cm = new ContextManager({
      windowTokens: 1_000_000,
      triggerRatio: 0.75,
      summarize: async (text, opts) => {
        summarizeCalls += 1;
        expect(opts.maxTokens).toBeGreaterThan(0);
        return "S".repeat(20);
      },
      onCompaction: (ev) => events.push(ev),
    });
    // 触发一次完整压缩(含解释段 summarize → 至少 1 次 LLM 调用)
    await cm.compact([...eightMessages(), ...Array.from({ length: 4 }, () => textMsg(50))]);
    expect(summarizeCalls).toBeGreaterThan(0);

    const ev = events.find((e) => e.position === "tail");
    expect(ev).toBeDefined();
    expect(ev!.llmCalls).toBeGreaterThan(0);
    expect(ev!.llmCalls).toBe(summarizeCalls);
    expect(ev!.llmMs).toBeGreaterThanOrEqual(0);
    expect(ev!.algoMs).toBeGreaterThanOrEqual(0);
    expect(ev!.selfInputTokens).toBeGreaterThan(0);
    expect(ev!.selfOutputTokens).toBeGreaterThan(0);
    // 一致性:算法耗时 + LLM 耗时 ≈ 总耗时
    expect(ev!.algoMs + ev!.llmMs).toBeLessThanOrEqual(ev!.durationMs + 10);
  });
  it("A7: compaction 事件携带逐位置 llmDetail/posMs/usedLLM/compactedSeqs", async () => {
    const events: Ev[] = [];
    let summarizeCalls = 0;
    const cm = new ContextManager({
      windowTokens: 5000,
      triggerRatio: 0.5,
      targetPct: 0.3,
      summarize: async () => {
        summarizeCalls++;
        return "S";
      },
      historyTokenBudget: 800,
      budgetSplit: { compacted: 0.45, thinking: 0.2, tail: 0.35 },
      onCompaction: (ev) => events.push(ev),
    });
    await cm.compact([
      { role: "user", content: "[r1] 需求:做一个登录页" },
      { role: "assistant", content: [{ type: "text", text: "结论:用表单 + JWT" }] },
      { role: "user", content: "[r3] 继续:加注册接口" },
      ...Array.from({ length: 4 }, () => textMsg(50)),
    ]);

    const ev = events.find((e) => e.position === "tail");
    expect(ev).toBeDefined();
    expect(ev!.llmDetail).toBeDefined();
    const detail = ev!.llmDetail!;
    const totalCalls = detail.resummarize.calls + detail.oversize.calls + detail.explanation.calls + detail.thinking.calls;
    expect(totalCalls).toBe(summarizeCalls);
    expect(totalCalls).toBe(ev!.llmCalls);
    expect(ev!.posMs).toBeGreaterThanOrEqual(0);
    expect(typeof ev!.usedLLM).toBe("boolean");
    // compactedSeqs:tail 压缩应带出被压掉的 [r{n}] 序号
    expect(Array.isArray(ev!.compactedSeqs)).toBe(true);
  });
});
