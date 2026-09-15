import { describe, it, expect } from "vitest";
import {
  ToolRepeatTracker,
  normalizeToolInput,
  describeToolInput,
  READONLY_TOOLS,
  WRITE_TOOLS,
  DEFAULT_REPEAT_WASTE_GAP_MS,
  DEFAULT_REPEAT_MAX_KEYS,
} from "../src/agent/toolRepeatDetector";

describe("normalizeToolInput", () => {
  it("keys Read by path/offset/limit", () => {
    expect(normalizeToolInput("Read", { path: "a.ts" })).toEqual(["Read", "a.ts", "0", "0"]);
    expect(normalizeToolInput("Read", { path: "a.ts", offset: 10, limit: 5 })).toEqual([
      "Read",
      "a.ts",
      "10",
      "5",
    ]);
  });

  it("treats same Read with different offset as different calls", () => {
    const a = normalizeToolInput("Read", { path: "a.ts" }).join("|");
    const b = normalizeToolInput("Read", { path: "a.ts", offset: 100 }).join("|");
    expect(a).not.toBe(b);
  });

  it("normalizes Bash whitespace so formatting variants collapse", () => {
    const a = normalizeToolInput("Bash", { command: "npm   test" }).join("|");
    const b = normalizeToolInput("Bash", { command: " npm\ntest " }).join("|");
    expect(a).toBe(b);
  });

  it("keys Grep by pattern/path/glob", () => {
    expect(normalizeToolInput("Grep", { pattern: "foo", path: "src", glob: "*.ts" })).toEqual([
      "Grep",
      "foo",
      "src",
      "*.ts",
    ]);
  });

  it("keys Glob/LS by pattern or path", () => {
    expect(normalizeToolInput("Glob", { pattern: "**/*.ts" })).toEqual(["Glob", "**/*.ts"]);
    expect(normalizeToolInput("LS", { path: "src" })).toEqual(["LS", "src"]);
  });

  it("stable-stringifies unknown tools regardless of key order", () => {
    const a = normalizeToolInput("Custom", { b: 1, a: [2, { d: 3, c: 4 }] }).join("|");
    const b = normalizeToolInput("Custom", { a: [2, { c: 4, d: 3 }], b: 1 }).join("|");
    expect(a).toBe(b);
  });

  it("keeps Write path but ignores contents volume (same path still collides)", () => {
    const a = normalizeToolInput("Write", { path: "f.ts", contents: "x".repeat(10) }).join("|");
    const b = normalizeToolInput("Write", { path: "f.ts", contents: "y".repeat(999) }).join("|");
    expect(a).toBe(b);
  });

  it("handles missing input", () => {
    expect(normalizeToolInput("Read")).toEqual(["Read", "", "0", "0"]);
    expect(normalizeToolInput("Custom", undefined)).toEqual(["Custom", "{}"]);
  });
});

describe("describeToolInput", () => {
  it("drops tool name, joins semantic parts and truncates to 90 chars", () => {
    expect(describeToolInput(["Read", "a.ts", "0", "0"])).toBe("a.ts | 0 | 0");
    const long = describeToolInput(["Bash", "x".repeat(300)]);
    expect(long.length).toBe(90);
  });

  it("skips empty parts", () => {
    expect(describeToolInput(["Grep", "foo", "", ""])).toBe("foo");
  });
});

describe("ToolRepeatTracker", () => {
  it("returns undefined on first observation and hit on second with same key", () => {
    const t = new ToolRepeatTracker();
    expect(t.observe("Read", { path: "a.ts" }, "line1\nline2", 1000)).toBeUndefined();
    const hit = t.observe("Read", { path: "a.ts" }, "line1\nline2", 2000);
    expect(hit).toBeDefined();
    expect(hit?.tool).toBe("Read");
    expect(hit?.gapMs).toBe(1000);
    expect(hit?.count).toBe(2);
    expect(hit?.readonly).toBe(true);
  });

  it("flags waste when gap below threshold, not when above", () => {
    const t = new ToolRepeatTracker({ wasteGapMs: 300_000 });
    t.observe("Bash", { command: "ls" }, "out", 0);
    // 间隔永远相对「上一次」调用:299_999 与首次间隔 299_999 → 浪费型
    expect(t.observe("Bash", { command: "ls" }, "out", 299_999)?.isWaste).toBe(true);
    // 相对上一次(299_999)间隔 300_001 → 超出阈值,不算浪费型
    expect(t.observe("Bash", { command: "ls" }, "out", 600_000)?.isWaste).toBe(false);
    expect(DEFAULT_REPEAT_WASTE_GAP_MS).toBe(300_000);
  });

  it("uses previous output size as redundantTokens (re-read cost)", () => {
    const t = new ToolRepeatTracker();
    const big = "x".repeat(400); // 400 chars -> ~100 tokens
    t.observe("Read", { path: "a.ts" }, big, 0);
    const hit = t.observe("Read", { path: "a.ts" }, "", 10);
    expect(hit?.redundantTokens).toBe(100);
  });

  it("marks afterWrite when a write happened between the two calls", () => {
    const t = new ToolRepeatTracker();
    t.observe("Read", { path: "a.ts" }, "out", 0);
    t.observe("Write", { path: "a.ts", contents: "new" }, "ok", 5);
    const hit = t.observe("Read", { path: "a.ts" }, "out", 10);
    expect(hit?.afterWrite).toBe(true);
  });

  it("does not mark afterWrite without an intervening write", () => {
    const t = new ToolRepeatTracker();
    t.observe("Read", { path: "a.ts" }, "out", 0);
    expect(t.observe("Read", { path: "a.ts" }, "out", 10)?.afterWrite).toBe(false);
  });

  it("re-registers the write tool itself as afterWrite=false (matches offline script)", () => {
    const t = new ToolRepeatTracker();
    t.observe("Bash", { command: "git status" }, "out", 0);
    const first = t.observe("Bash", { command: "git status" }, "out", 5);
    expect(first?.afterWrite).toBe(false);
    // 写工具出现时会把所有 key(含它自己)先标 afterWrite=true,随后自身重新登记为 false,
    // 与离线脚本 `last[k] = (ts, True, ...)` 后 `last[key] = (ts, False, ...)` 的语义一致。
    const second = t.observe("Bash", { command: "git status" }, "out", 10);
    expect(second?.count).toBe(3);
    expect(second?.afterWrite).toBe(false);
  });

  it("increments count across repeated calls", () => {
    const t = new ToolRepeatTracker();
    t.observe("Grep", { pattern: "foo" }, "a", 0);
    t.observe("Grep", { pattern: "foo" }, "a", 1);
    const hit = t.observe("Grep", { pattern: "foo" }, "a", 2);
    expect(hit?.count).toBe(3);
  });

  it("exposes keyText summary without huge payloads", () => {
    const t = new ToolRepeatTracker();
    t.observe("Write", { path: "f.ts", contents: "z".repeat(5000) }, "ok", 0);
    const hit = t.observe("Write", { path: "f.ts", contents: "y".repeat(5000) }, "ok", 1);
    expect(hit?.keyText).toBe("f.ts");
    expect(JSON.stringify(hit).length).toBeLessThan(500);
  });

  it("evicts oldest keys when exceeding maxKeys (LRU)", () => {
    const t = new ToolRepeatTracker({ maxKeys: 2 });
    t.observe("Read", { path: "a.ts" }, "", 0);
    t.observe("Read", { path: "b.ts" }, "", 0);
    t.observe("Read", { path: "c.ts" }, "", 0);
    expect(t.size()).toBe(2);
    // a 已被淘汰 -> 再次调用视为首次
    expect(t.observe("Read", { path: "a.ts" }, "", 1)).toBeUndefined();
    expect(DEFAULT_REPEAT_MAX_KEYS).toBeGreaterThan(0);
  });

  it("touching a key keeps it alive (true LRU, not FIFO)", () => {
    const t = new ToolRepeatTracker({ maxKeys: 2 });
    t.observe("Read", { path: "a.ts" }, "", 0);
    t.observe("Read", { path: "b.ts" }, "", 0);
    t.observe("Read", { path: "a.ts" }, "", 0); // touch a -> b 成为最旧
    t.observe("Read", { path: "c.ts" }, "", 0); // 淘汰 b,保留 a
    expect(t.size()).toBe(2);
    // a 被 touch 保护,仍在表内(命中即 defined);若实现是 FIFO,淘汰的会是 a。
    expect(t.observe("Read", { path: "a.ts" }, "", 1)).toBeDefined();
  });

  it("reset clears会话内状态", () => {
    const t = new ToolRepeatTracker();
    t.observe("Read", { path: "a.ts" }, "", 0);
    t.reset();
    expect(t.size()).toBe(0);
    expect(t.observe("Read", { path: "a.ts" }, "", 1)).toBeUndefined();
  });

  it("clamps negative gaps to zero", () => {
    const t = new ToolRepeatTracker();
    t.observe("Read", { path: "a.ts" }, "", 1000);
    expect(t.observe("Read", { path: "a.ts" }, "", 500)?.gapMs).toBe(0);
  });

  it("tool sets match offline script口径", () => {
    expect(READONLY_TOOLS.has("Read")).toBe(true);
    expect(READONLY_TOOLS.has("Grep")).toBe(true);
    expect(READONLY_TOOLS.has("MemoryRead")).toBe(true);
    expect(READONLY_TOOLS.has("Bash")).toBe(false);
    expect(WRITE_TOOLS.has("Bash")).toBe(true);
    expect(WRITE_TOOLS.has("StrReplace")).toBe(true);
    expect(WRITE_TOOLS.has("Read")).toBe(false);
  });
});
