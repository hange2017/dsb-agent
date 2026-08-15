import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ContextStore, ColdChunk, serializeWithOffsets } from "../src/context/contextStore";

// ESM 命名空间不可配置,不能 spyOn(fs, "readFileSync");改用 vi.mock 包装成 vi.fn,
// 以便断言"按 seq 回查不整读 .context.ndjson"(仅随机读小段)。
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    readSync: vi.fn(actual.readSync),
  };
});

let dir: string;
beforeEach(() => {
  vi.clearAllMocks(); // 清空调用记录,保留真实实现
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-offset-"));
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

/** 造一批大内容 chunk(模拟数十 MB 冷存储),返回数量。 */
async function seedLarge(store: ContextStore, n: number, sessionId = "big"): Promise<void> {
  const chunks: ColdChunk[] = [];
  for (let i = 1; i <= n; i++) {
    chunks.push(
      chunk({ seq: i, type: "demand", content: `需求 ${i} ` + "x".repeat(2000), summary: `sum${i}` }),
    );
  }
  store.append(sessionId, chunks);
  await store.flush(sessionId);
}

describe("serializeWithOffsets", () => {
  it("produces parseable JSON with per-chunk offsets", () => {
    const data = {
      chunks: [
        chunk({ seq: 1, content: "aaa" }),
        chunk({ seq: 2, content: "bbb" }),
      ],
      compactedCount: 1,
      prunedCount: 0,
    };
    const { text, offsets } = serializeWithOffsets(data);
    expect(offsets).toHaveLength(2);
    const parsed = JSON.parse(text) as { chunks: ColdChunk[] };
    expect(parsed.chunks.map((c) => c.seq)).toEqual([1, 2]);
    // 每个偏移区间都能单独解析出对应 chunk
    offsets.forEach((off, i) => {
      const s = text.slice(off.offset, off.offset + off.length);
      expect(JSON.parse(s)).toEqual(data.chunks[i]);
    });
  });
});

describe("ContextStore 偏移直读(免整文件解析)", () => {
  it("get() 命中后索引条目带 offset/length", async () => {
    const store = new ContextStore(dir);
    store.append("s1", [chunk({ seq: 7, content: "hello" }), chunk({ seq: 9, content: "world" })]);
    await store.flush("s1");
    const idx = store.index("s1");
    expect(idx).toHaveLength(2);
    for (const e of idx) {
      expect(typeof e.offset).toBe("number");
      expect(typeof e.length).toBe("number");
      expect(e.length).toBeGreaterThan(0);
    }
  });

  it("按 seq 回查返回正确内容(偏移直读)", () => {
    const store = new ContextStore(dir);
    store.append("s1", [chunk({ seq: 1, content: "A" }), chunk({ seq: 2, content: "B" }), chunk({ seq: 3, content: "C" })]);
    // 有会话内存时优先内存(无需 flush)
    const hits = store.get("s1", [2]);
    expect(hits).toHaveLength(1);
    expect(hits[0].seq).toBe(2);
    expect(hits[0].content).toBe("B");
  });

  it("大文件回查不整读 .context.ndjson(只随机读小段)", async () => {
    const store = new ContextStore(dir);
    await seedLarge(store, 300); // 300 × 2KB ≈ 600KB 原文
    const ctxFile = path.join(dir, "big.context.ndjson");
    const sizeBefore = fs.statSync(ctxFile).size;
    // 新实例无会话内存 → 走偏移直读
    const cold = new ContextStore(dir);
    cold.index("big");
    const readFile = vi.mocked(fs.readFileSync);
    const readSync = vi.mocked(fs.readSync);
    readFile.mockClear();
    readSync.mockClear();
    const hits = cold.get("big", [42, 150, 299]);
    expect(hits.map((c) => c.seq)).toEqual([42, 150, 299]);
    expect(hits[0].content).toContain("需求 42");
    // 关键:没有整文件 readFileSync(.context.ndjson),只发生了小段 readSync
    const ctxReads = readFile.mock.calls.filter((c) => String(c[0]).includes("big.context.ndjson"));
    expect(ctxReads).toHaveLength(0);
    expect(readSync).toHaveBeenCalled();
    // 单次读取的字节总量远小于文件体积
    const totalRead = readSync.mock.calls.reduce(
      (s, c) => s + (typeof c[2] === "number" ? c[2] : 0),
      0,
    );
    expect(totalRead).toBeLessThan(sizeBefore / 10);
  });

  it("旧格式(无偏移索引)→ get 回退全量并重建带偏移索引,下次回查走直读", async () => {
    const store = new ContextStore(dir);
    await seedLarge(store, 60, "legacy");
    // 模拟旧格式:手改索引丢 offset(NDJSON 原文仍在)
    const idxFile = path.join(dir, "legacy.index.json");
    const legacyIndex = JSON.parse(fs.readFileSync(idxFile, "utf8")) as { chunks: Array<Record<string, unknown>> };
    legacyIndex.chunks = legacyIndex.chunks.map(({ offset, length, ...rest }) => rest);
    fs.writeFileSync(idxFile, JSON.stringify(legacyIndex), "utf8");
    const store2 = new ContextStore(dir); // 新实例,索引缓存空、无会话内存
    // 第一次 get:无偏移 → 回退全量解析,但结果正确
    const hits1 = store2.get("legacy", [3]);
    expect(hits1.map((c) => c.seq)).toEqual([3]);
    // 顺带重建 → 索引已带 offset
    const idx2 = store2.index("legacy");
    expect(idx2[2].offset).toBeTypeOf("number");
    expect(idx2[2].length).toBeTypeOf("number");
    // 重建后第二次 get 走偏移直读,不整读原文
    store2.index("legacy"); // 预热缓存
    const readFile = vi.mocked(fs.readFileSync);
    readFile.mockClear();
    const hits2 = store2.get("legacy", [7]);
    expect(hits2.map((c) => c.seq)).toEqual([7]);
    const ctxReads = readFile.mock.calls.filter((c) => String(c[0]).includes("legacy.context.ndjson"));
    expect(ctxReads).toHaveLength(0);
  });

  it("原文被外部改坏导致偏移错位 → 回退全量解析仍返回正确结果", async () => {
    const store = new ContextStore(dir);
    store.append("s1", [chunk({ seq: 1, content: "A" }), chunk({ seq: 2, content: "B" })]);
    await store.flush("s1");
    const cold = new ContextStore(dir);
    cold.index("s1"); // 预热索引缓存,不入会话内存
    // 外部手改原文(在中间插入字节),索引偏移随之错位
    const ctxFile = path.join(dir, "s1.context.ndjson");
    const raw = fs.readFileSync(ctxFile, "utf8");
    const tampered = raw.replace('"content":"B"', '"content":"BBBBBB"');
    fs.writeFileSync(ctxFile, tampered, "utf8");
    const hits = cold.get("s1", [2]);
    expect(hits.map((c) => c.seq)).toEqual([2]);
    expect(hits[0].content).toContain("B");
  });

  it("未知 seq 返回空,不触发读取", () => {
    const store = new ContextStore(dir);
    store.append("s1", [chunk({ seq: 1, content: "A" })]);
    const readSync = vi.mocked(fs.readSync);
    readSync.mockClear();
    expect(store.get("s1", [999])).toEqual([]);
    expect(readSync).not.toHaveBeenCalled();
  });
});
