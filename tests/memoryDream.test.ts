import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MemoryStore } from "../src/agent/memory/memoryStore";
import { dreamMemory } from "../src/agent/memory/memoryDream";

let dir: string;
let store: MemoryStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmem-dream-"));
  store = new MemoryStore(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const seed = () => {
  store.write({ name: "alpha", description: "A 项目", body: "用户偏好 vitest。", updatedAt: 1 });
  store.write({ name: "beta", description: "B 项目", body: "使用 esbuild 打包。", updatedAt: 2 });
  store.write({ name: "gamma", description: "G 项目", body: "喜欢 pnpm。", updatedAt: 3 });
};

const snapshot = () =>
  store
    .list()
    .map((e) => ({ name: e.name, description: e.description, body: e.body }))
    .sort((a, b) => a.name.localeCompare(b.name));

describe("dreamMemory", () => {
  it("applies delete + create, keeps the rest, and reports before/after counts", async () => {
    seed();
    const llm = async () =>
      '```json\n' +
      JSON.stringify({
        keep: ["alpha", "gamma"],
        delete: ["beta"],
        create: [{ name: "delta", description: "D 项目", body: "合并后的内容。" }],
      }) +
      '\n```';

    const result = await dreamMemory(store, llm);

    expect(result).toEqual({ before: 3, after: 3 });
    const entries = snapshot();
    expect(entries).toEqual([
      { name: "alpha", description: "A 项目", body: "用户偏好 vitest。" },
      { name: "delta", description: "D 项目", body: "合并后的内容。" },
      { name: "gamma", description: "G 项目", body: "喜欢 pnpm。" },
    ]);
    expect(store.get("beta")).toBeUndefined();
  });

  it("accepts a plain JSON response without a code fence", async () => {
    seed();
    const llm = async () =>
      JSON.stringify({ keep: [], delete: ["gamma"], create: [] });

    const result = await dreamMemory(store, llm);

    expect(result).toEqual({ before: 3, after: 2 });
    expect(store.get("gamma")).toBeUndefined();
    expect(store.get("alpha")).toBeDefined();
    expect(store.get("beta")).toBeDefined();
  });

  it("allows create to overwrite an existing name and counts the resulting entries", async () => {
    seed();
    const llm = async () =>
      JSON.stringify({
        keep: ["alpha"],
        delete: ["beta", "gamma"],
        create: [{ name: "alpha", description: "A 项目(新)", body: "覆盖后的内容。" }],
      });

    const result = await dreamMemory(store, llm);

    expect(result).toEqual({ before: 3, after: 1 });
    expect(store.get("alpha")?.description).toBe("A 项目(新)");
    expect(store.get("beta")).toBeUndefined();
    expect(store.get("gamma")).toBeUndefined();
  });

  it("throws and leaves all entries untouched when the LLM returns invalid JSON", async () => {
    seed();
    const before = snapshot();
    const llm = async () => "I'm sorry, but here are my thoughts...";

    await expect(dreamMemory(store, llm)).rejects.toThrow(/invalid JSON/);
    expect(snapshot()).toEqual(before);
  });

  it("throws and leaves all entries untouched when delete references an unknown name", async () => {
    seed();
    const before = snapshot();
    const llm = async () =>
      JSON.stringify({
        keep: [],
        delete: ["does-not-exist"],
        create: [{ name: "delta", description: "D", body: "b" }],
      });

    await expect(dreamMemory(store, llm)).rejects.toThrow(/unknown memory name/);
    expect(snapshot()).toEqual(before);
  });

  it("throws and leaves all entries untouched when create has an empty name", async () => {
    seed();
    const before = snapshot();
    const llm = async () =>
      JSON.stringify({
        keep: [],
        delete: ["beta"],
        create: [{ name: "   ", description: "D", body: "b" }],
      });

    await expect(dreamMemory(store, llm)).rejects.toThrow(/non-empty string/);
    expect(snapshot()).toEqual(before);
  });

  it("throws and leaves all entries untouched when the shape is not an object", async () => {
    seed();
    const before = snapshot();
    const llm = async () => '[1, 2, 3]';

    await expect(dreamMemory(store, llm)).rejects.toThrow(/not a JSON object/);
    expect(snapshot()).toEqual(before);
  });

  it("handles an empty memory store", async () => {
    const llm = async () => JSON.stringify({ keep: [], delete: [], create: [] });

    const result = await dreamMemory(store, llm);

    expect(result).toEqual({ before: 0, after: 0 });
  });
});
