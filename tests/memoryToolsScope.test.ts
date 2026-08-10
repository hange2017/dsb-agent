import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolExecutor } from "../src/agent/tools/executor";
import { MemoryStore } from "../src/agent/memory/memoryStore";
import { normalizeMemoryScope } from "../src/agent/memory/memoryTools";

let tmp: string;
let globalMem: MemoryStore;
let projectMem: MemoryStore;
let exec: ToolExecutor;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsb-memtool-"));
  globalMem = new MemoryStore(path.join(tmp, "mem"));
  projectMem = globalMem.scoped("proj-key");
  exec = new ToolExecutor(projectMem, undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, undefined, undefined, globalMem);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("memory 工具 scope 语义", () => {
  it("auto(默认)写入项目记忆,scope=global 写入全局记忆", async () => {
    await exec.execute("MemoryWrite", { name: "proj-note", description: "p", body: "project body" }, { workspaceRoot: tmp });
    await exec.execute("MemoryWrite", { name: "global-note", description: "g", body: "global body", scope: "global" }, { workspaceRoot: tmp });
    expect(projectMem.get("proj-note")?.body).toBe("project body");
    expect(globalMem.get("global-note")?.body).toBe("global body");
    expect(globalMem.get("proj-note")).toBeUndefined(); // auto 不写全局
    expect(projectMem.get("global-note")).toBeUndefined(); // global 不写项目
  });

  it("MemoryRead auto 项目优先,未命中回退全局;scope=global 只读全局", async () => {
    await exec.execute("MemoryWrite", { name: "dup", description: "project", body: "from project" }, { workspaceRoot: tmp });
    await exec.execute("MemoryWrite", { name: "dup", description: "global", body: "from global", scope: "global" }, { workspaceRoot: tmp });
    await exec.execute("MemoryWrite", { name: "only-global", description: "g", body: "g body", scope: "global" }, { workspaceRoot: tmp });

    const dup = await exec.execute("MemoryRead", { name: "dup" }, { workspaceRoot: tmp });
    expect(dup.content).toContain("from project"); // auto:项目优先
    const onlyGlobal = await exec.execute("MemoryRead", { name: "only-global" }, { workspaceRoot: tmp });
    expect(onlyGlobal.ok).toBe(true);
    expect(onlyGlobal.content).toContain("g body"); // auto:项目未命中回退全局
    const gDup = await exec.execute("MemoryRead", { name: "dup", scope: "global" }, { workspaceRoot: tmp });
    expect(gDup.content).toContain("from global");
  });

  it("MemoryList auto 合并项目 + 全局;scope=global 只列全局", async () => {
    await exec.execute("MemoryWrite", { name: "proj-note", description: "p", body: "x" }, { workspaceRoot: tmp });
    await exec.execute("MemoryWrite", { name: "global-note", description: "g", body: "x", scope: "global" }, { workspaceRoot: tmp });

    const auto = await exec.execute("MemoryList", {}, { workspaceRoot: tmp });
    expect(auto.content).toContain("proj-note");
    expect(auto.content).toContain("global-note");
    const g = await exec.execute("MemoryList", { scope: "global" }, { workspaceRoot: tmp });
    expect(g.content).toContain("global-note");
    expect(g.content).not.toContain("proj-note");
  });

  it("MemoryDelete auto 只删项目同名,不误删全局;scope=global 删全局", async () => {
    await exec.execute("MemoryWrite", { name: "dup", description: "p", body: "p" }, { workspaceRoot: tmp });
    await exec.execute("MemoryWrite", { name: "dup", description: "g", body: "g", scope: "global" }, { workspaceRoot: tmp });
    await exec.execute("MemoryDelete", { name: "dup" }, { workspaceRoot: tmp });
    expect(projectMem.get("dup")).toBeUndefined();
    expect(globalMem.get("dup")?.body).toBe("g"); // 全局同名保留
    await exec.execute("MemoryDelete", { name: "dup", scope: "global" }, { workspaceRoot: tmp });
    expect(globalMem.get("dup")).toBeUndefined();
  });

  it("无全局实例时回退到项目 store,不抛错", async () => {
    const solo = new ToolExecutor(new MemoryStore(path.join(tmp, "solo")));
    const w = await solo.execute("MemoryWrite", { name: "n", description: "d", body: "b", scope: "global" }, { workspaceRoot: tmp });
    expect(w.ok).toBe(true);
    const r = await solo.execute("MemoryRead", { name: "n", scope: "global" }, { workspaceRoot: tmp });
    expect(r.ok).toBe(true);
  });

  it("MemoryWrite pinned=true 置顶且不受索引 limit 截断", async () => {
    await exec.execute("MemoryWrite", { name: "old-note", description: "o", body: "x" }, { workspaceRoot: tmp });
    await exec.execute("MemoryWrite", { name: "key-convention", description: "k", body: "x", pinned: true }, { workspaceRoot: tmp });
    const e = projectMem.get("key-convention");
    expect(e?.pinned).toBe(true);
    const idx = projectMem.index("项目", { limit: 1 });
    expect(idx).toBe("(项目) key-convention: k"); // pinned 占据唯一名额
    // 显式 pinned:false 解除
    await exec.execute("MemoryWrite", { name: "key-convention", description: "k", body: "x", pinned: false }, { workspaceRoot: tmp });
    expect(projectMem.get("key-convention")?.pinned).toBe(false);
  });

  it("MemoryWrite 返回相似记忆候选提示(非同名近似)", async () => {
    await exec.execute("MemoryWrite", { name: "user-prefers-vitest", description: "用户偏好 vitest 测试", body: "x" }, { workspaceRoot: tmp });
    const w = await exec.execute("MemoryWrite", { name: "user-likes-jest", description: "用户偏好 jest 测试框架", body: "x" }, { workspaceRoot: tmp });
    expect(w.ok).toBe(true);
    expect(w.content).toContain("Memory written: user-likes-jest");
    expect(w.content).toContain("user-prefers-vitest"); // 候选提示
    expect(w.content).toContain("相似度");
  });

  it("MemoryWrite 同名覆盖不触发相似提示", async () => {
    await exec.execute("MemoryWrite", { name: "same", description: "d", body: "v1" }, { workspaceRoot: tmp });
    const w = await exec.execute("MemoryWrite", { name: "same", description: "d", body: "v2" }, { workspaceRoot: tmp });
    expect(w.ok).toBe(true);
    expect(w.content).not.toContain("相似记忆");
  });

  it("MemoryRead/MemoryList 触碰计数(accessCount 递增)", async () => {
    await exec.execute("MemoryWrite", { name: "touched", description: "d", body: "b" }, { workspaceRoot: tmp });
    expect(projectMem.get("touched")?.accessCount).toBe(0);
    await exec.execute("MemoryRead", { name: "touched" }, { workspaceRoot: tmp });
    expect(projectMem.get("touched")?.accessCount).toBe(1);
    await exec.execute("MemoryList", {}, { workspaceRoot: tmp });
    expect(projectMem.get("touched")?.accessCount).toBe(2);
  });

  it("MemoryRead 命中全局记忆时触碰全局条目,不触碰项目", async () => {
    await exec.execute("MemoryWrite", { name: "only-global", description: "g", body: "b", scope: "global" }, { workspaceRoot: tmp });
    await exec.execute("MemoryRead", { name: "only-global" }, { workspaceRoot: tmp });
    expect(globalMem.get("only-global")?.accessCount).toBe(1);
  });
});

describe("normalizeMemoryScope", () => {
  it("非法值/缺省回退 auto,大小写不敏感", () => {
    expect(normalizeMemoryScope(undefined)).toBe("auto");
    expect(normalizeMemoryScope("auto")).toBe("auto");
    expect(normalizeMemoryScope("project")).toBe("project");
    expect(normalizeMemoryScope("GLOBAL")).toBe("global");
    expect(normalizeMemoryScope("banana")).toBe("auto");
    expect(normalizeMemoryScope(42)).toBe("auto");
  });
});
