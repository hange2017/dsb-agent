import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseCommandMd, loadCommandDir, SlashCommandIndex } from "../src/chat/slashCommands";

describe("parseCommandMd", () => {
  it("reads description from frontmatter and body after it", () => {
    const raw = "---\ndescription: 跑测试\n---\n运行 npm test 并报告结果。";
    const cmd = parseCommandMd("test", raw, "project");
    expect(cmd).toEqual({ name: "test", description: "跑测试", body: "运行 npm test 并报告结果。", source: "project" });
  });
  it("defaults description to empty when no frontmatter", () => {
    const cmd = parseCommandMd("plain", "直接当 prompt。", "project");
    expect(cmd.description).toBe("");
    expect(cmd.body).toBe("直接当 prompt。");
  });
  it("handles CRLF line endings", () => {
    const cmd = parseCommandMd("crlf", "---\r\ndescription: CRLF 命令\r\n---\r\nbody 内容", "project");
    expect(cmd.description).toBe("CRLF 命令");
    expect(cmd.body).toBe("body 内容");
  });
});

describe("loadCommandDir", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join("/tmp", "dcmd-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("loads .md files in the dir, name from filename", () => {
    fs.writeFileSync(path.join(root, "test.md"), "---\ndescription: 跑测试\n---\nbody", "utf8");
    const cmds = loadCommandDir(root, "project");
    expect(cmds).toEqual([{ name: "test", description: "跑测试", body: "body", source: "project" }]);
  });
  it("returns [] when dir missing (fail-open)", () => {
    expect(loadCommandDir(path.join(root, "nope"), "user")).toEqual([]);
  });
  it("rejects a non-command file (no .md)", () => {
    fs.writeFileSync(path.join(root, "readme.txt"), "x", "utf8");
    expect(loadCommandDir(root, "project")).toEqual([]);
  });
  it("is fail-open when dir is actually a file (ENOTDIR)", () => {
    fs.writeFileSync(path.join(root, "commands"), "not a dir", "utf8");
    expect(loadCommandDir(path.join(root, "commands"), "project")).toEqual([]);
  });
  it("ignores entries outside the dir (no .. traversal)", () => {
    // readdirSync 文件名不含分隔符;`..` 不会出现在子项;此测试锁定 fail-open 语义
    fs.writeFileSync(path.join(root, "..", "escape.md"), "---\ndescription: x\n---\nbody", "utf8");
    expect(loadCommandDir(root, "project").some((c) => c.name.includes("escape"))).toBe(false);
  });
});

describe("SlashCommandIndex", () => {
  it("lists and invokes registered commands", () => {
    const idx = new SlashCommandIndex();
    idx.add(parseCommandMd("test", "---\ndescription: 跑测试\n---\nbody", "project"));
    expect(idx.listForPrompt()).toEqual([{ name: "test", description: "跑测试" }]);
    expect(idx.invokeCommand("test")).toEqual({ ok: true, content: "body" });
    expect(idx.invokeCommand("missing").ok).toBe(false);
  });
});
