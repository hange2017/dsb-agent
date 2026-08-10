import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MemoryStore } from "../src/agent/memory/memoryStore";
import { MemoryManager } from "../src/agent/memory/memoryManager";

let dir: string;
let manager: MemoryManager;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsb-memmgr-"));
  const root = new MemoryStore(path.join(dir, "mem"));
  manager = new MemoryManager(root.scoped("proj-key"), root, "proj-key");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("MemoryManager", () => {
  it("write 按 scope 路由:project 写项目目录,global 写全局目录,互不可见", () => {
    manager.write("project", { name: "p-note", description: "p", body: "project body" });
    manager.write("global", { name: "g-note", description: "g", body: "global body" });
    const { project, global } = manager.list();
    expect(project.map((e) => e.name)).toEqual(["p-note"]);
    expect(global.map((e) => e.name)).toEqual(["g-note"]);
  });

  it("write 校验:name/description/body 必填(空白也拒绝),不落盘", () => {
    expect(() => manager.write("project", { name: "", description: "d", body: "b" })).toThrow("name");
    expect(() => manager.write("project", { name: "n", description: " ", body: "b" })).toThrow("description");
    expect(() => manager.write("project", { name: "n", description: "d", body: "" })).toThrow("body");
    expect(manager.list().project.length).toBe(0);
    expect(fs.existsSync(path.join(dir, "mem", "proj-key"))).toBe(false); // 目录未创建
  });

  it("同名条目在不同 scope 独立存在;delete 只删指定 scope", () => {
    manager.write("project", { name: "dup", description: "p", body: "p" });
    manager.write("global", { name: "dup", description: "g", body: "g" });
    manager.delete("project", "dup");
    const { project, global } = manager.list();
    expect(project).toEqual([]);
    expect(global.map((e) => e.name)).toEqual(["dup"]);
  });

  it("write 覆盖同 scope 同名条目(更新语义)", () => {
    manager.write("project", { name: "n", description: "old", body: "old body" });
    manager.write("project", { name: "n", description: "new", body: "new body" });
    expect(manager.list().project.length).toBe(1);
    expect(manager.list().project[0].description).toBe("new");
  });

  it("key() 返回当前项目 key", () => {
    expect(manager.key()).toBe("proj-key");
  });
});
