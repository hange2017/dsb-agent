import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionStore, migrateLegacySessions, listSessionProjects } from "../src/session/sessionStore";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsb-sess-test-"));
}

describe("SessionStore 按项目隔离", () => {
  it("scoped 目录下 create/list 只看到该项目会话", () => {
    const root = tmpDir();
    const projA = new SessionStore(path.join(root, "proj-a"));
    const projB = new SessionStore(path.join(root, "proj-b"));
    const idA = projA.create();
    const idB = projB.create();
    // 文件落在各自项目子目录
    expect(fs.existsSync(path.join(root, "proj-a", `${idA}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(root, "proj-b", `${idB}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(root, "proj-a", `${idB}.jsonl`))).toBe(false);
    // list 隔离:各项目只见自己的会话
    expect(projA.list().map((s) => s.id)).toEqual([idA]);
    expect(projB.list().map((s) => s.id)).toEqual([idB]);
    // 跨项目访问返回空(隔离)
    expect(projA.exists(idB)).toBe(false);
    expect(projA.load(idB)).toEqual([]);
    expect(projB.exists(idA)).toBe(false);
  });

  it("同一项目目录下的会话可互相访问(worktree 归一后共享)", () => {
    const root = tmpDir();
    const s1 = new SessionStore(path.join(root, "shared-key"));
    const s2 = new SessionStore(path.join(root, "shared-key"));
    const id = s1.create();
    expect(s2.exists(id)).toBe(true);
    expect(s2.load(id)).toEqual([]);
  });
});

describe("migrateLegacySessions", () => {
  it("把旧版根目录会话文件迁入项目子目录,id 不变,无关文件不动", () => {
    const root = tmpDir();
    // 旧版:会话文件直接在根下
    fs.writeFileSync(path.join(root, "s_old1.jsonl"), "", "utf8");
    fs.writeFileSync(path.join(root, "s_old1.api.json"), "[]", "utf8");
    fs.writeFileSync(path.join(root, "s_old2.jsonl"), "", "utf8");
    fs.writeFileSync(path.join(root, "readme.txt"), "keep", "utf8");
    fs.mkdirSync(path.join(root, "already-project"), { recursive: true });
    fs.writeFileSync(path.join(root, "already-project", "s_x.jsonl"), "", "utf8");

    const moved = migrateLegacySessions(root, "proj-key");
    expect(moved).toBe(3); // 2 jsonl + 1 api.json(readme.txt 与已有子目录不迁移)
    // 旧文件已移入项目子目录,id 不变
    expect(fs.existsSync(path.join(root, "proj-key", "s_old1.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(root, "proj-key", "s_old1.api.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "proj-key", "s_old2.jsonl"))).toBe(true);
    // 无关文件与已有项目目录保持原样
    expect(fs.existsSync(path.join(root, "readme.txt"))).toBe(true);
    expect(fs.existsSync(path.join(root, "already-project", "s_x.jsonl"))).toBe(true);
  });

  it("幂等:无根目录遗留文件时返回 0,不产生多余子目录", () => {
    const root = tmpDir();
    const moved = migrateLegacySessions(root, "proj-key");
    expect(moved).toBe(0);
  });

  it("迁移后 SessionStore 从新目录可读,且根目录不再见旧文件", () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "s_old.jsonl"), '{"kind":"user","text":"hi"}\n', "utf8");
    fs.writeFileSync(path.join(root, "s_old.api.json"), "[]", "utf8");
    migrateLegacySessions(root, "proj-key");

    const store = new SessionStore(path.join(root, "proj-key"));
    expect(store.exists("s_old")).toBe(true);
    expect(store.load("s_old").length).toBe(1);
    expect(fs.existsSync(path.join(root, "s_old.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(root, "s_old.api.json"))).toBe(false);
  });

  it("listSessionProjects 列出项目子目录", () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, "proj-a"), { recursive: true });
    fs.mkdirSync(path.join(root, "proj-b"), { recursive: true });
    fs.writeFileSync(path.join(root, "loose.jsonl"), "", "utf8");
    expect(listSessionProjects(root).sort()).toEqual(["proj-a", "proj-b"]);
  });
});
