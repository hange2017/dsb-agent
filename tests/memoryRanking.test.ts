import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MemoryStore } from "../src/agent/memory/memoryStore";

let dir: string;
let store: MemoryStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmem-rank-"));
  store = new MemoryStore(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("MemoryStore 加权排序 + pinned 常驻", () => {
  it("pinned 置顶,且不受 index limit 截断(常驻)", () => {
    store.write({ name: "a-new", description: "a", body: "x", updatedAt: 3 });
    store.write({ name: "b-pinned", description: "b", body: "x", updatedAt: 2, pinned: true });
    store.write({ name: "c-old", description: "c", body: "x", updatedAt: 1 });
    // list: pinned 最前(write 的 updatedAt 一律取 Date.now(),同毫秒内非 pinned 间顺序不定)
    const listed = store.list().map((e) => e.name);
    expect(listed).toHaveLength(3);
    expect(listed[0]).toBe("b-pinned");
    // index limit=1:pinned 常驻占据唯一名额
    expect(store.index(undefined, { limit: 1 })).toBe("- b-pinned: b");
    // limit=2:pinned + 下一个非 pinned
    const idx2 = store.index(undefined, { limit: 2 }).split("\n");
    expect(idx2).toHaveLength(2);
    expect(idx2[0]).toBe("- b-pinned: b");
  });

  it("访问计数影响排序:高频访问的旧条目排到新条目前面", () => {
    store.write({ name: "hot", description: "h", body: "x", updatedAt: 1 });
    store.write({ name: "fresh", description: "f", body: "x", updatedAt: 100 });
    expect(store.list().map((e) => e.name)).toEqual(["fresh", "hot"]);
    // hot 被读 10 次 → 加权分反超(一次访问 ≈ 6h 新鲜度,10 次 > 时间差)
    for (let i = 0; i < 10; i++) store.touch("hot");
    expect(store.list().map((e) => e.name)).toEqual(["hot", "fresh"]);
  });

  it("touch 递增 accessCount 并刷新 lastAccessAt", () => {
    store.write({ name: "n", description: "d", body: "b", updatedAt: 1 });
    expect(store.get("n")?.accessCount).toBe(0);
    store.touch("n");
    const after = store.get("n");
    expect(after?.accessCount).toBe(1);
    expect(after?.lastAccessAt).toBeGreaterThan(0);
    store.touch("n");
    expect(store.get("n")?.accessCount).toBe(2);
  });

  it("touch 不存在的条目静默跳过,不抛错", () => {
    expect(() => store.touch("missing")).not.toThrow();
  });

  it("write 覆盖时保留既有访问统计与 pinned(未显式变更)", () => {
    store.write({ name: "n", description: "d", body: "b", updatedAt: 1, pinned: true });
    store.touch("n");
    store.touch("n");
    // 普通覆盖(不传 pinned/accessCount)→ 统计保留
    store.write({ name: "n", description: "d2", body: "b2", updatedAt: 2 });
    const e = store.get("n");
    expect(e?.description).toBe("d2");
    expect(e?.body).toBe("b2");
    expect(e?.pinned).toBe(true);
    expect(e?.accessCount).toBe(2);
    // 显式 pinned:false → 解除常驻
    store.write({ name: "n", description: "d3", body: "b3", updatedAt: 3, pinned: false });
    expect(store.get("n")?.pinned).toBe(false);
    // 显式 accessCount: 0 → 清空计数
    store.write({ name: "n", description: "d4", body: "b4", updatedAt: 4, accessCount: 0 });
    expect(store.get("n")?.accessCount).toBe(0);
  });

  it("meta.json 读写 lastDreamAt,且不被 list/index 当作记忆", () => {
    expect(store.readDreamAt()).toBeUndefined();
    store.write({ name: "n", description: "d", body: "b", updatedAt: 1 });
    store.writeDreamAt(12345);
    expect(store.readDreamAt()).toBe(12345);
    // meta.json 形状校验不通过 → 不会混入记忆清单/索引
    expect(store.list().map((e) => e.name)).toEqual(["n"]);
    expect(store.index()).toBe("- n: d");
    // 损坏的 meta 文件 → readDreamAt 返回 undefined 不抛错
    fs.writeFileSync(path.join(dir, "meta.json"), "{ broken", "utf8");
    expect(store.readDreamAt()).toBeUndefined();
  });

  it("readDreamAt/writeDreamAt 在目录不存在时安全(惰性建目录)", () => {
    const missing = path.join(dir, "sub", "nested");
    const s = new MemoryStore(missing);
    expect(s.readDreamAt()).toBeUndefined();
    s.writeDreamAt(999);
    expect(s.readDreamAt()).toBe(999);
    expect(fs.existsSync(missing)).toBe(true);
  });
});
