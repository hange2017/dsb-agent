import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MemoryStore, mergeMemoryIndex } from "../src/agent/memory/memoryStore";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsb-mem-test-"));
}

const entry = (name: string, description = "d") => ({ name, description, body: "b", updatedAt: 1 });

describe("MemoryStore.scoped 按项目隔离", () => {
  it("scoped 实例把文件写入子目录,与全局/其他项目互不可见", () => {
    const root = tmpDir();
    const global = new MemoryStore(root);
    const a = global.scoped("proj-a");
    const b = global.scoped("proj-b");

    global.write(entry("shared-note"));
    a.write(entry("proj-a-note"));
    b.write(entry("proj-b-note"));

    // 文件落位
    expect(fs.existsSync(path.join(root, "shared-note.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "proj-a", "proj-a-note.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "proj-b", "proj-b-note.json"))).toBe(true);

    // 隔离:全局看不到项目记忆,项目间互不可见
    expect(global.get("proj-a-note")).toBeUndefined();
    expect(a.get("shared-note")).toBeUndefined();
    expect(a.get("proj-b-note")).toBeUndefined();
    expect(b.get("proj-a-note")).toBeUndefined();
    expect(a.list().map((e) => e.name)).toEqual(["proj-a-note"]);
    expect(b.list().map((e) => e.name)).toEqual(["proj-b-note"]);
  });

  it("同名记忆在不同 scope 互不覆盖,delete 也只删本 scope", () => {
    const root = tmpDir();
    const global = new MemoryStore(root);
    const a = global.scoped("proj-a");
    const b = global.scoped("proj-b");
    global.write(entry("dup", "global"));
    a.write(entry("dup", "project-a"));
    expect(global.get("dup")?.description).toBe("global");
    expect(a.get("dup")?.description).toBe("project-a");
    a.delete("dup");
    expect(a.get("dup")).toBeUndefined();
    expect(global.get("dup")?.description).toBe("global");
    expect(b.get("dup")).toBeUndefined(); // b 从未写入
  });

  it("同一 projectKey 的 scoped 实例共享同一目录", () => {
    const root = tmpDir();
    const global = new MemoryStore(root);
    const a1 = global.scoped("proj-a");
    const a2 = global.scoped("proj-a");
    a1.write(entry("note"));
    expect(a2.get("note")?.body).toBe("b");
  });
});

describe("mergeMemoryIndex", () => {
  it("拼接非空块,空块跳过,行不重复", () => {
    expect(mergeMemoryIndex()).toBe("");
    expect(mergeMemoryIndex("", "   ")).toBe("");
    expect(mergeMemoryIndex("- a: A", "", "- b: B")).toBe("- a: A\n- b: B");
    expect(mergeMemoryIndex("- a: A", "- a: A", "- b: B")).toBe("- a: A\n- b: B");
  });

  it("index(label) 为每行加作用域前缀", () => {
    const root = tmpDir();
    const global = new MemoryStore(root);
    const a = global.scoped("proj-a");
    a.write(entry("note", "desc"));
    expect(a.index()).toBe("- note: desc");
    expect(a.index("项目")).toBe("(项目) note: desc");
    expect(global.index("全局")).toBe("");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("MemoryStore.index 瘦身", () => {
  // write() 会以 Date.now() 覆盖 updatedAt,这里直接写文件构造不同时间戳条目
  const writeEntry = (root: string, name: string, description: string, updatedAt: number): void => {
    fs.writeFileSync(
      path.join(root, `${name}.json`),
      JSON.stringify({ name, description, body: "b", updatedAt }),
      "utf8",
    );
  };

  it("不传参数行为不变(全量、不截断)", () => {
    const root = tmpDir();
    const store = new MemoryStore(root);
    writeEntry(root, "a", "desc-a", 1);
    writeEntry(root, "b", "desc-b", 2);
    expect(store.index()).toBe("- b: desc-b\n- a: desc-a");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("limit 按 updatedAt 降序截断(取最近 N 条)", () => {
    const root = tmpDir();
    const store = new MemoryStore(root);
    writeEntry(root, "old", "old-desc", 1);
    writeEntry(root, "mid", "mid-desc", 2);
    writeEntry(root, "new", "new-desc", 3);
    expect(store.index("项目", { limit: 2 })).toBe("(项目) new: new-desc\n(项目) mid: mid-desc");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("maxDescLen 截断超长 description 并加省略号", () => {
    const root = tmpDir();
    const store = new MemoryStore(root);
    const longDesc = "x".repeat(200);
    store.write({ name: "n", description: longDesc, body: "b", updatedAt: 1 });
    const out = store.index(undefined, { maxDescLen: 50 });
    expect(out).toContain("n: " + "x".repeat(50) + "…");
    expect(out.length).toBeLessThan(60);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("limit 与 maxDescLen 同时生效;空索引返回空串", () => {
    const root = tmpDir();
    const store = new MemoryStore(root);
    expect(store.index(undefined, { limit: 3, maxDescLen: 10 })).toBe("");
    fs.rmSync(root, { recursive: true, force: true });
  });
});
