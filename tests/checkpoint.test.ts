import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CheckpointStore } from "../src/agent/checkpoint";
import { ToolExecutor } from "../src/agent/tools/executor";
import { MemoryStore } from "../src/agent/memory/memoryStore";

let root: string;
let target: string;
let store: CheckpointStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-"));
  target = path.join(root, "rewind-target.tmp"); // 目标文件放 tmp 目录,避免泄漏到仓库根
  store = new CheckpointStore(root, "sess1");
  fs.writeFileSync(target, "v1", "utf8");
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("CheckpointStore", () => {
  const storeDir = (): string => path.join(root, ".dsb", "checkpoints", "sess1");
  it("snapshots and restores", async () => {
    store.snapshot(target);
    fs.writeFileSync(target, "v2", "utf8");
    store.restore(target);
    expect(fs.readFileSync(target, "utf8")).toBe("v1");
  });
  it("keeps at most KEEP versions", () => {
    for (let i = 0; i < 15; i++) {
      store.snapshot(target);
      fs.writeFileSync(target, `v${i}`, "utf8");
    }
    const snaps = fs.readdirSync(storeDir());
    expect(snaps.length).toBeLessThanOrEqual(10);
  });
  it("records a new file's absence so rewind deletes it", () => {
    const fresh = path.join(root, "new.ts");
    store.snapshot(fresh); // 文件尚不存在 → 记录"不存在"哨兵快照
    expect(fs.existsSync(storeDir())).toBe(true);
    fs.writeFileSync(fresh, "fresh content", "utf8");
    store.restore(fresh);
    expect(fs.existsSync(fresh)).toBe(false);
    expect(store.list(fresh)).toHaveLength(0);
  });
  it("no-ops for a directory (no snapshot written)", () => {
    fs.mkdirSync(path.join(root, "subdir"));
    store.snapshot(path.join(root, "subdir"));
    expect(store.list(path.join(root, "subdir"))).toHaveLength(0);
  });
  it("lists snapshots newest first and restores a specific one", () => {
    store.snapshot(target); // v1
    fs.writeFileSync(target, "v2", "utf8");
    store.snapshot(target); // v2
    fs.writeFileSync(target, "v3", "utf8");
    const snaps = store.list(target);
    expect(snaps).toHaveLength(2);
    // 恢复最旧那份 → v1,且该快照被删除
    store.restore(target, snaps[1]);
    expect(fs.readFileSync(target, "utf8")).toBe("v1");
    expect(store.list(target)).toHaveLength(1);
    // 未指定快照 → 恢复最近一份 → v2
    store.restore(target);
    expect(fs.readFileSync(target, "utf8")).toBe("v2");
  });
  it("restores a deleted file", () => {
    store.snapshot(target);
    fs.rmSync(target, { force: true });
    store.restore(target);
    expect(fs.readFileSync(target, "utf8")).toBe("v1");
  });
  it("does not conflate same-dir files whose names are dash-suffixes (unit-test.ts vs test.ts)", () => {
    const a = path.join(root, "unit-test.ts");
    const b = path.join(root, "test.ts");
    fs.writeFileSync(a, "unit", "utf8");
    fs.writeFileSync(b, "plain", "utf8");
    store.snapshot(b); // b 的快照最旧
    store.snapshot(a); // a 的快照最新
    expect(store.list(a)).toHaveLength(1);
    expect(store.list(b)).toHaveLength(1);
    // 若 list 把 a 的快照混入 b,restore 会误把 a 的内容写进 b
    store.restore(b);
    expect(fs.readFileSync(b, "utf8")).toBe("plain");
  });
  it("prunes only the target file's snapshots, not a dash-suffix sibling's", () => {
    const a = path.join(root, "unit-test.ts");
    const b = path.join(root, "test.ts");
    fs.writeFileSync(a, "a0", "utf8");
    fs.writeFileSync(b, "b0", "utf8");
    for (let i = 0; i < 15; i++) {
      store.snapshot(a);
      fs.writeFileSync(a, `a${i}`, "utf8");
    }
    store.snapshot(b);
    expect(store.list(a)).toHaveLength(10); // a 轮转到 KEEP
    expect(store.list(b)).toHaveLength(1); // b 的仅此一份不被误删
  });
});

describe("CheckpointStore integration with ToolExecutor", () => {
  let exec: ToolExecutor;
  beforeEach(() => {
    exec = new ToolExecutor(new MemoryStore(path.join(root, ".mem")), undefined, undefined, undefined, 0, store);
  });

  it("snapshots before Write so rewind restores prior content", async () => {
    const r1 = await exec.execute("Write", { path: "a.txt", contents: "first" }, { workspaceRoot: root });
    expect(r1.ok).toBe(true);
    await exec.execute("Write", { path: "a.txt", contents: "second" }, { workspaceRoot: root });
    const candidates = store.files();
    expect(candidates.some((f) => f.endsWith("a.txt"))).toBe(true);
    store.restore(candidates.find((f) => f.endsWith("a.txt"))!);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("first");
  });

  it("snapshots before StrReplace and Delete", async () => {
    fs.writeFileSync(path.join(root, "b.txt"), "foo bar", "utf8");
    await exec.execute("StrReplace", { path: "b.txt", old_string: "foo", new_string: "baz" }, { workspaceRoot: root });
    const files = store.files();
    expect(files).toHaveLength(1);
    store.restore(files[0]);
    expect(fs.readFileSync(path.join(root, "b.txt"), "utf8")).toBe("foo bar");
    // Delete:快照保留被删文件内容,restore 复活
    await exec.execute("Delete", { path: "b.txt" }, { workspaceRoot: root });
    expect(fs.existsSync(path.join(root, "b.txt"))).toBe(false);
    store.restore(path.join(root, "b.txt"));
    expect(fs.readFileSync(path.join(root, "b.txt"), "utf8")).toBe("foo bar");
  });
});
