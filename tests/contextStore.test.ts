import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ContextStore, ColdChunk, makeSummary, contentHash } from "../src/context/contextStore";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxstore-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function chunk(partial: Partial<ColdChunk>): ColdChunk {
  return {
    seq: 1,
    type: "conclusion",
    role: "assistant",
    summary: "s",
    content: "c",
    ts: 1000,
    ...partial,
  };
}

describe("ContextStore", () => {
  it("appends and loads chunks round-trip", () => {
    const store = new ContextStore(dir);
    store.append("sid1", [
      chunk({ seq: 1, type: "demand", content: "用户需求原文" }),
      chunk({ seq: 2, type: "ledger", content: "- [r2] Bash: npm test" }),
    ]);
    const loaded = store.load("sid1");
    expect(loaded).toHaveLength(2);
    expect(loaded[0].content).toBe("用户需求原文");
    expect(loaded[1].type).toBe("ledger");
  });

  it("load returns [] when file missing", () => {
    const store = new ContextStore(dir);
    expect(store.load("nope")).toEqual([]);
    expect(store.index("nope")).toEqual([]);
  });

  it("load returns [] on corrupt file", () => {
    fs.writeFileSync(path.join(dir, "bad.context.json"), "{not json", "utf8");
    const store = new ContextStore(dir);
    expect(store.load("bad")).toEqual([]);
  });

  it("index returns summary list only", () => {
    const store = new ContextStore(dir);
    store.append("sid1", [
      chunk({ seq: 1, type: "demand", summary: "需求摘要", content: "很长很长的原文".repeat(10) }),
      chunk({ seq: 3, type: "conclusion", summary: "结论摘要", content: "结论原文" }),
    ]);
    const idx = store.index("sid1");
    expect(idx).toHaveLength(2);
    expect(idx.map((c) => c.summary)).toEqual(["需求摘要", "结论摘要"]);
    // index 里不应带完整 content
    expect("content" in idx[0]).toBe(false);
  });

  it("get filters by seq list", () => {
    const store = new ContextStore(dir);
    store.append("sid1", [
      chunk({ seq: 1 }),
      chunk({ seq: 2 }),
      chunk({ seq: 3 }),
    ]);
    const got = store.get("sid1", [3, 1]);
    expect(got.map((c) => c.seq).sort()).toEqual([1, 3]);
  });

  it("prunes oldest chunks beyond max", () => {
    const store = new ContextStore(dir, { maxChunks: 2 });
    store.append("sid1", [
      chunk({ seq: 1, ts: 100 }),
      chunk({ seq: 2, ts: 200 }),
      chunk({ seq: 3, ts: 300 }),
    ]);
    const pruned = store.prune("sid1");
    expect(pruned).toBe(1);
    const left = store.load("sid1");
    expect(left.map((c) => c.seq)).toEqual([2, 3]);
  });

  it("prune is idempotent when under limit", () => {
    const store = new ContextStore(dir, { maxChunks: 5 });
    store.append("sid1", [chunk({ seq: 1 }), chunk({ seq: 2 })]);
    expect(store.prune("sid1")).toBe(0);
    expect(store.load("sid1")).toHaveLength(2);
  });

  it("clear removes all chunks for a session", () => {
    const store = new ContextStore(dir);
    store.append("sid1", [chunk({ seq: 1 })]);
    store.append("sid2", [chunk({ seq: 1 })]);
    store.clear("sid1");
    expect(store.load("sid1")).toEqual([]);
    expect(store.load("sid2")).toHaveLength(1);
  });

  it("keeps file on disk after clear (empty array) and delete removes file", async () => {
    const store = new ContextStore(dir);
    store.append("sid1", [chunk({ seq: 1 })]);
    await store.flush("sid1");
    store.clear("sid1");
    expect(fs.existsSync(path.join(dir, "sid1.context.ndjson"))).toBe(true);
    store.delete("sid1");
    expect(fs.existsSync(path.join(dir, "sid1.context.ndjson"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "sid1.context.json"))).toBe(false);
  });

  it("append merges with existing chunks", () => {
    const store = new ContextStore(dir);
    store.append("sid1", [chunk({ seq: 1 })]);
    store.append("sid1", [chunk({ seq: 2 })]);
    expect(store.load("sid1").map((c) => c.seq)).toEqual([1, 2]);
  });

  it("listSessions returns session ids sorted, ignoring non-context files", async () => {
    const store = new ContextStore(dir);
    store.append("s_b", [chunk({ seq: 1 })]);
    store.append("s_a", [chunk({ seq: 1 })]);
    await store.flush();
    fs.writeFileSync(path.join(dir, "note.txt"), "x", "utf8");
    expect(store.listSessions()).toEqual(["s_a", "s_b"]);
    expect(new ContextStore(path.join(dir, "missing")).listSessions()).toEqual([]);
  });

  it("mergeView aggregates across sessions with dedupe and session tag", () => {
    const store = new ContextStore(dir);
    store.append("s1", [
      chunk({ seq: 1, type: "demand", summary: "同一内容", content: "c1" }),
      chunk({ seq: 2, type: "ledger", summary: "l1", content: "l1" }),
    ]);
    store.append("s2", [
      chunk({ seq: 1, type: "demand", summary: "同一内容", content: "c1" }), // 与 s1 重复
      chunk({ seq: 5, type: "conclusion", summary: "only s2", content: "c2" }),
    ]);
    const { chunks } = store.mergeView(["s1", "s2"]);
    expect(chunks).toHaveLength(3);
    const demand = chunks.find((c) => c.type === "demand")!;
    expect(demand.session).toBe("s1");
    const s2Only = chunks.find((c) => c.summary === "only s2")!;
    expect(s2Only.session).toBe("s2");
    // 不写盘:mergeView 是只读视图
    expect(store.load("s2")).toHaveLength(2);
  });

  it("dedupe removes duplicate content within a session, keeping earliest ts", () => {
    const store = new ContextStore(dir);
    store.append("s1", [
      chunk({ seq: 1, summary: "x", content: "same", ts: 100 }),
      chunk({ seq: 2, summary: "x", content: "same", ts: 200 }),
      chunk({ seq: 3, summary: "y", content: "other", ts: 300 }),
    ]);
    const removed = store.dedupe("s1");
    expect(removed).toBe(1);
    const left = store.load("s1");
    expect(left).toHaveLength(2);
    expect(left.map((c) => c.seq)).toEqual([1, 3]);
  });

  it("merge consolidates sessions into target and deletes source files", () => {
    const store = new ContextStore(dir);
    store.append("s1", [
      chunk({ seq: 1, type: "demand", summary: "dup", content: "same" }),
      chunk({ seq: 2, type: "ledger", summary: "l", content: "l" }),
    ]);
    store.append("s2", [
      chunk({ seq: 1, type: "demand", summary: "dup", content: "same" }),
      chunk({ seq: 3, type: "conclusion", summary: "only2", content: "c2" }),
    ]);
    const r = store.merge(["s1", "s2"], "__all__");
    expect(r.merged).toBe(3);
    expect(r.removed).toBe(1);
    const all = store.load("__all__");
    expect(all).toHaveLength(3);
    expect(all.map((c) => c.summary).sort()).toEqual(["dup", "l", "only2"]);
    expect(fs.existsSync(path.join(dir, "s1.context.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "s2.context.json"))).toBe(false);
    // target 自身参与去重(s1 的 dup 为 demand/assistant,key 需一致)
    store.append("__all__", [chunk({ seq: 9, type: "demand", role: "assistant", summary: "dup", content: "same" })]);
    const r2 = store.merge(["__all__"], "__all__");
    expect(r2.removed).toBe(1);
    expect(r2.merged).toBe(3);
  });

  it("append writes a sibling index file (no content) and index() reads it", async () => {
    const store = new ContextStore(dir);
    store.append("sid1", [
      chunk({ seq: 1, type: "demand", summary: "需求摘要", content: "很长很长的原文".repeat(10) }),
      chunk({ seq: 2, type: "ledger", summary: "l", content: "x" }),
    ]);
    // 内存可见,落盘需 flush
    expect(store.index("sid1")).toHaveLength(2);
    await store.flush("sid1");
    const idxFile = path.join(dir, "sid1.index.json");
    expect(fs.existsSync(idxFile)).toBe(true);
    expect(fs.existsSync(path.join(dir, "sid1.context.ndjson"))).toBe(true);
    const raw = JSON.parse(fs.readFileSync(idxFile, "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.chunks).toHaveLength(2);
    // 索引不含 content,但带内容哈希
    expect(JSON.stringify(raw)).not.toContain("很长很长的原文");
    expect(raw.chunks[0].hash).toBe(contentHash("很长很长的原文".repeat(10)));
    // index() 读索引:无 content、有 hash
    const idx = store.index("sid1");
    expect(idx).toHaveLength(2);
    expect(idx[0].summary).toBe("需求摘要");
    expect("content" in idx[0]).toBe(false);
    expect(idx[0].hash.length).toBeGreaterThanOrEqual(8);
    // 全文仍然完整
    expect(store.load("sid1")[0].content).toBe("很长很长的原文".repeat(10));
  });

  it("lazy-migrates a legacy session (context file only) by building index on read", () => {
    // 模拟旧版:只有 .context.json,没有 index
    fs.writeFileSync(
      path.join(dir, "legacy.context.json"),
      JSON.stringify({
        chunks: [chunk({ seq: 1, summary: "旧", content: "旧内容" })],
        compactedCount: 0,
        prunedCount: 0,
      }),
      "utf8",
    );
    const idxFile = path.join(dir, "legacy.index.json");
    expect(fs.existsSync(idxFile)).toBe(false);
    const store2 = new ContextStore(dir);
    const idx = store2.index("legacy");
    expect(idx).toHaveLength(1);
    expect(idx[0].summary).toBe("旧");
    // 读取后索引文件已生成(惰性迁移)
    expect(fs.existsSync(idxFile)).toBe(true);
    // 不存在的会话:不产生任何文件
    store2.index("nope");
    expect(fs.existsSync(path.join(dir, "nope.index.json"))).toBe(false);
  });

  it("recovers from corrupt index by rebuilding from content", async () => {
    const store = new ContextStore(dir);
    store.append("sid1", [chunk({ seq: 1, summary: "ok", content: "原文" })]);
    await store.flush("sid1");
    fs.writeFileSync(path.join(dir, "sid1.index.json"), "{not json", "utf8");
    const store2 = new ContextStore(dir);
    expect(store2.index("sid1")).toHaveLength(1);
    expect(store2.index("sid1")[0].summary).toBe("ok");
    // 重建后的索引文件可正常解析
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "sid1.index.json"), "utf8"));
    expect(raw.chunks).toHaveLength(1);
  });

  it("delete removes both context and index files", async () => {
    const store = new ContextStore(dir);
    store.append("sid1", [chunk({ seq: 1 })]);
    await store.flush("sid1");
    expect(fs.existsSync(path.join(dir, "sid1.index.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "sid1.context.ndjson"))).toBe(true);
    store.delete("sid1");
    expect(fs.existsSync(path.join(dir, "sid1.context.ndjson"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "sid1.context.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "sid1.index.json"))).toBe(false);
  });

  it("prune/dedupe/clear keep index in sync", () => {
    const store = new ContextStore(dir, { maxChunks: 2 });
    store.append("sid1", [
      chunk({ seq: 1, ts: 100, summary: "one", content: "c1" }),
      chunk({ seq: 2, ts: 200, summary: "two", content: "c2" }),
      chunk({ seq: 3, ts: 300, summary: "three", content: "c3" }),
    ]);
    store.prune("sid1");
    expect(store.index("sid1").map((c) => c.seq)).toEqual([2, 3]);
    store.append("sid1", [chunk({ seq: 4, summary: "x", content: "dup", ts: 400 })]);
    store.append("sid1", [chunk({ seq: 5, summary: "x", content: "dup", ts: 500 })]);
    const removed = store.dedupe("sid1");
    expect(removed).toBe(1);
    expect(store.index("sid1").map((c) => c.seq)).toEqual([2, 3, 4]);
    expect(store.stats("sid1")).toEqual({ compacted: 3, pruned: 1 });
    store.clear("sid1");
    expect(store.index("sid1")).toEqual([]);
    // clear 重置计数(空文件)
    expect(store.stats("sid1")).toEqual({ compacted: 0, pruned: 0 });
  });

  it("mtime cache refreshes after external write (new store instance sees new index)", async () => {
    const store = new ContextStore(dir);
    store.append("sid1", [chunk({ seq: 1, summary: "one" })]);
    await store.flush("sid1");
    expect(store.index("sid1")).toHaveLength(1);
    // 外部进程读盘后追加并 flush;新实例可见完整索引
    const external = new ContextStore(dir);
    external.append("sid1", [chunk({ seq: 2, summary: "two" })]);
    await external.flush("sid1");
    expect(new ContextStore(dir).index("sid1").map((c) => c.seq)).toEqual([1, 2]);
  });

  it("mergeView aggregates index entries (no content) with session tag", () => {
    const store = new ContextStore(dir);
    store.append("s1", [
      chunk({ seq: 1, type: "demand", summary: "同一内容", content: "c1" }),
      chunk({ seq: 2, type: "ledger", summary: "l1", content: "l1" }),
    ]);
    store.append("s2", [
      chunk({ seq: 1, type: "demand", summary: "同一内容", content: "c1" }),
      chunk({ seq: 5, type: "conclusion", summary: "only s2", content: "c2" }),
    ]);
    const { chunks } = store.mergeView(["s1", "s2"]);
    expect(chunks).toHaveLength(3);
    expect("content" in chunks[0]).toBe(false);
    expect(chunks.find((c) => c.type === "demand")?.session).toBe("s1");
    expect(chunks.find((c) => c.summary === "only s2")?.session).toBe("s2");
  });

  it("contentHash is stable and distinct", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
    expect(contentHash("")).toBe(contentHash(""));
  });
});

describe("makeSummary", () => {
  it("uses first line truncated to 160 chars", () => {
    const long = "A".repeat(300) + "\n第二行";
    const s = makeSummary("demand", long);
    expect(s.length).toBeLessThanOrEqual(165);
    expect(s).not.toContain("第二行");
  });
  it("returns short content as-is", () => {
    expect(makeSummary("ledger", "- [r2] Read: a.ts")).toBe("- [r2] Read: a.ts");
  });
  it("fallback for empty", () => {
    expect(makeSummary("conclusion", "")).toBe("");
  });
});

describe("ContextStore thinking chunks", () => {
  it("round-trips thinking chunks with type", () => {
    const store = new ContextStore(dir);
    store.append("sid1", [
      chunk({ seq: 9, type: "thinking", content: "[thinking]\n## 正确\n- [r9] 链路确认" }),
    ]);
    const loaded = store.load("sid1");
    expect(loaded[0].type).toBe("thinking");
    expect(loaded[0].content).toContain("[thinking]");
    const idx = store.index("sid1");
    expect(idx[0].type).toBe("thinking");
  });

  it("thinking chunks do not count against maxChunks", () => {
    const store = new ContextStore(dir, { maxChunks: 1 });
    store.append("sid1", [
      chunk({ seq: 1, ts: 100 }),
      chunk({ seq: 2, ts: 200 }),
      chunk({ seq: 9, type: "thinking", ts: 300, content: "thinking-a" }),
    ]);
    store.prune("sid1");
    const left = store.load("sid1");
    // 非 thinking 只剩 1 条(最新),thinking 不因条数被淘汰
    expect(left.filter((c) => c.type !== "thinking")).toHaveLength(1);
    expect(left.filter((c) => c.type === "thinking")).toHaveLength(1);
    expect(left.find((c) => c.type === "thinking")!.content).toBe("thinking-a");
  });

  it("prunes thinking chunks by bytes oldest-first, keeping at least one", () => {
    const store = new ContextStore(dir, { maxThinkingBytes: 20 });
    store.append("sid1", [
      chunk({ seq: 9, type: "thinking", ts: 100, content: "0123456789abcdef0123456789abcdef" }),
      chunk({ seq: 10, type: "thinking", ts: 200, content: "0123456789abcdef0123456789abcdef" }),
      chunk({ seq: 11, type: "thinking", ts: 300, content: "0123456789abcdef0123456789abcdef" }),
    ]);
    const pruned = store.prune("sid1");
    expect(pruned).toBe(2);
    const left = store.load("sid1").filter((c) => c.type === "thinking");
    expect(left.map((c) => c.seq)).toEqual([11]);
  });

  it("prunes thinking chunks independently of non-thinking ones", () => {
    const store = new ContextStore(dir, { maxChunks: 1, maxThinkingBytes: 20 });
    store.append("sid1", [
      chunk({ seq: 1, ts: 100 }),
      chunk({ seq: 2, ts: 200 }),
      chunk({ seq: 9, type: "thinking", ts: 300, content: "0123456789abcdef0123456789abcdef" }),
      chunk({ seq: 10, type: "thinking", ts: 400, content: "0123456789abcdef0123456789abcdef" }),
    ]);
    const pruned = store.prune("sid1");
    expect(pruned).toBe(2); // 1 条非 thinking + 1 条 thinking
    const left = store.load("sid1");
    expect(left.filter((c) => c.type !== "thinking").map((c) => c.seq)).toEqual([2]);
    expect(left.filter((c) => c.type === "thinking").map((c) => c.seq)).toEqual([10]);
  });

  it("keeps thinking chunks untouched when under byte limit", () => {
    const store = new ContextStore(dir, { maxThinkingBytes: 1000 });
    store.append("sid1", [
      chunk({ seq: 9, type: "thinking", ts: 100, content: "tiny" }),
    ]);
    expect(store.prune("sid1")).toBe(0);
    expect(store.load("sid1")).toHaveLength(1);
  });
});

describe("ContextStore updateSummaries", () => {
  it("updates summaries by seq without touching content/ts", () => {
    const store = new ContextStore(dir);
    store.append("sid1", [
      chunk({ seq: 9, type: "thinking", summary: "原文首行", content: "thinking 原文", ts: 111 }),
      chunk({ seq: 10, type: "thinking", summary: "s2", content: "c2" }),
    ]);
    const n = store.updateSummaries("sid1", [
      { seq: 9, summary: "- [r9] 链路:因式分解验证" },
      { seq: 99, summary: "不存在的 seq" },
    ]);
    expect(n).toBe(1);
    const loaded = store.load("sid1");
    const c9 = loaded.find((c) => c.seq === 9)!;
    expect(c9.summary).toBe("- [r9] 链路:因式分解验证");
    expect(c9.content).toBe("thinking 原文");
    expect(c9.ts).toBe(111);
    expect(loaded.find((c) => c.seq === 10)!.summary).toBe("s2");
    // 索引同步
    const idx = store.index("sid1");
    expect(idx.find((c) => c.seq === 9)!.summary).toBe("- [r9] 链路:因式分解验证");
  });

  it("no-op when summaries unchanged or empty", () => {
    const store = new ContextStore(dir);
    store.append("sid1", [chunk({ seq: 1, summary: "same", content: "c" })]);
    expect(store.updateSummaries("sid1", [{ seq: 1, summary: "same" }])).toBe(0);
    expect(store.updateSummaries("sid1", [{ seq: 1, summary: "" }])).toBe(0);
    expect(store.updateSummaries("sid1", [])).toBe(0);
  });
});

describe("ContextStore NDJSON + async flush", () => {
  it("flush writes .context.ndjson lines and index offsets", async () => {
    const store = new ContextStore(dir);
    store.append("s1", [chunk({ seq: 1, content: "A" }), chunk({ seq: 2, content: "B" })]);
    expect(fs.existsSync(path.join(dir, "s1.context.ndjson"))).toBe(false);
    await store.flush("s1");
    const ndjson = path.join(dir, "s1.context.ndjson");
    expect(fs.existsSync(ndjson)).toBe(true);
    const lines = fs.readFileSync(ndjson, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).content).toBe("A");
    const idx = JSON.parse(fs.readFileSync(path.join(dir, "s1.index.json"), "utf8"));
    expect(typeof idx.chunks[0].offset).toBe("number");
    expect(typeof idx.chunks[0].length).toBe("number");
  });

  it("skips corrupt NDJSON lines (fail-open)", async () => {
    fs.writeFileSync(
      path.join(dir, "bad.context.ndjson"),
      `${JSON.stringify(chunk({ seq: 1, content: "ok" }))}\n{not json\n${JSON.stringify(chunk({ seq: 2, content: "ok2" }))}\n`,
      "utf8",
    );
    const store = new ContextStore(dir);
    expect(store.load("bad").map((c) => c.seq)).toEqual([1, 2]);
  });

  it("migrates legacy .context.json to ndjson on append", async () => {
    fs.writeFileSync(
      path.join(dir, "leg.context.json"),
      JSON.stringify({
        chunks: [chunk({ seq: 1, summary: "old", content: "legacy" })],
        compactedCount: 0,
        prunedCount: 0,
      }),
      "utf8",
    );
    const store = new ContextStore(dir);
    store.append("leg", [chunk({ seq: 2, content: "new" })]);
    await store.flush("leg");
    expect(fs.existsSync(path.join(dir, "leg.context.ndjson"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "leg.context.json"))).toBe(false);
    expect(store.load("leg").map((c) => c.seq)).toEqual([1, 2]);
  });

  it("prune by maxTotalBytes keeps newest", () => {
    const store = new ContextStore(dir, { maxTotalBytes: 30, maxChunks: 100 });
    store.append("s1", [
      chunk({ seq: 1, ts: 100, content: "aaaaaaaaaaaa" }),
      chunk({ seq: 2, ts: 200, content: "bbbbbbbbbbbb" }),
      chunk({ seq: 3, ts: 300, content: "cccccccccccc" }),
    ]);
    const removed = store.prune("s1");
    expect(removed).toBeGreaterThan(0);
    const left = store.load("s1");
    expect(left[left.length - 1].seq).toBe(3);
    expect(Buffer.byteLength(left.map((c) => c.content).join(""), "utf8")).toBeLessThanOrEqual(30);
  });
});
