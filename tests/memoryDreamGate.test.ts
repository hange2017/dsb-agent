import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MemoryStore } from "../src/agent/memory/memoryStore";
import { dreamDue, buildDreamHint, DREAM_MIN_ENTRIES, DREAM_COOLDOWN_MS } from "../src/agent/memory/memoryDream";

let dir: string;
let store: MemoryStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmem-gate-"));
  store = new MemoryStore(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const seed = (n: number) => {
  for (let i = 0; i < n; i++) store.write({ name: `m${i}`, description: `d${i}`, body: `b${i}`, updatedAt: i });
};

describe("dreamDue 双闸门", () => {
  const now = 1_000_000_000_000;

  it("条数不足(闸门1)不提示,即使从未整合过", () => {
    expect(dreamDue({ entryCount: DREAM_MIN_ENTRIES - 1, lastDreamAt: undefined, now })).toBe(false);
    expect(dreamDue({ entryCount: DREAM_MIN_ENTRIES, lastDreamAt: undefined, now })).toBe(true);
  });

  it("冷却期内(闸门2)不提示", () => {
    const last = now - DREAM_COOLDOWN_MS + 1;
    expect(dreamDue({ entryCount: 10, lastDreamAt: last, now })).toBe(false);
  });

  it("超过冷却期才提示", () => {
    const last = now - DREAM_COOLDOWN_MS;
    expect(dreamDue({ entryCount: 10, lastDreamAt: last, now })).toBe(true);
  });

  it("从未整合过(lastDreamAt 缺失)条数达标即可提示", () => {
    expect(dreamDue({ entryCount: 5, lastDreamAt: undefined, now })).toBe(true);
  });

  it("默认值与自定义值均可覆盖", () => {
    expect(dreamDue({ entryCount: 3, lastDreamAt: undefined, now, minEntries: 3 })).toBe(true);
    expect(dreamDue({ entryCount: 10, lastDreamAt: now - 1000, now, cooldownMs: 500 })).toBe(true);
  });
});

describe("buildDreamHint(SessionStart 注入)", () => {
  it("条数不足返回 undefined,不打扰", () => {
    expect(buildDreamHint(store, "zh")).toBeUndefined();
    seed(DREAM_MIN_ENTRIES - 1);
    expect(buildDreamHint(store, "zh")).toBeUndefined();
  });

  it("达标且从未整合过 → 返回中文提示", () => {
    seed(DREAM_MIN_ENTRIES);
    const hint = buildDreamHint(store, "zh");
    expect(hint).toContain("/memory dream");
    expect(hint).toContain(String(DREAM_MIN_ENTRIES));
  });

  it("刚整合过(冷却期内) → 返回 undefined", () => {
    seed(DREAM_MIN_ENTRIES);
    store.writeDreamAt(Date.now());
    expect(buildDreamHint(store, "zh")).toBeUndefined();
  });

  it("超过冷却期 → 恢复提示;en 返回英文文案", () => {
    seed(DREAM_MIN_ENTRIES);
    store.writeDreamAt(Date.now() - DREAM_COOLDOWN_MS - 1000);
    expect(buildDreamHint(store, "zh")).toContain("/memory dream");
    const en = buildDreamHint(store, "en");
    expect(en).toContain("/memory dream");
    expect(en).toContain("memories");
  });
});
