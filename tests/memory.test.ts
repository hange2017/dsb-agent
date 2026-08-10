import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MemoryStore } from "../src/agent/memory/memoryStore";

let dir: string;
let store: MemoryStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmem-"));
  store = new MemoryStore(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("MemoryStore", () => {
  it("writes, reads, lists", () => {
    store.write({ name: "user-prefers", description: "喜欢 vitest", body: "用户偏好用 vitest 测试。", updatedAt: 1 });
    expect(store.get("user-prefers")?.body).toContain("vitest");
    expect(store.list()).toHaveLength(1);
    expect(store.index()).toContain("user-prefers");
  });
  it("deletes", () => {
    store.write({ name: "temp", description: "d", body: "b", updatedAt: 1 });
    store.delete("temp");
    expect(store.list()).toHaveLength(0);
  });
  it("slugs names", () => {
    store.write({ name: "My Pref", description: "d", body: "b", updatedAt: 1 });
    expect(fs.existsSync(path.join(dir, "my-pref.json"))).toBe(true);
  });
  it("tolerates corrupt json: skips it in list, get returns undefined", () => {
    store.write({ name: "good", description: "d", body: "b", updatedAt: 1 });
    fs.writeFileSync(path.join(dir, "bad.json"), "{ not valid json", "utf8");
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].name).toBe("good");
    expect(store.get("bad")).toBeUndefined();
    expect(store.index()).toContain("good");
  });
  it("skips valid-JSON-but-wrong-shape files so they don't inject junk into the prompt", () => {
    store.write({ name: "good", description: "d", body: "b", updatedAt: 1 });
    fs.writeFileSync(path.join(dir, "empty-obj.json"), "{}", "utf8");
    fs.writeFileSync(path.join(dir, "string.json"), '"just a string"', "utf8");
    fs.writeFileSync(path.join(dir, "array.json"), "[1,2]", "utf8");
    fs.writeFileSync(path.join(dir, "missing-body.json"), JSON.stringify({ name: "n", description: "d" }), "utf8");
    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("good");
    expect(store.get("empty-obj")).toBeUndefined();
    expect(store.get("missing-body")).toBeUndefined();
    // 上述坏形状文件绝不能变成 `- undefined: undefined` 注入索引
    expect(store.index()).toBe("- good: d");
  });
  it("creates the dir lazily on first write; list/get tolerate a missing dir", () => {
    const missing = path.join(dir, "does-not-exist-yet");
    const s = new MemoryStore(missing);
    expect(fs.existsSync(missing)).toBe(false);
    expect(s.list()).toEqual([]);
    expect(s.index()).toBe("");
    s.write({ name: "x", description: "d", body: "b", updatedAt: 1 });
    expect(fs.existsSync(missing)).toBe(true);
    expect(s.get("x")?.body).toBe("b");
  });
});
