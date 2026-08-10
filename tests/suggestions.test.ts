import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  detectTrigger,
  filterByQuery,
  filterBuiltInCommands,
  stripTriggerToken,
} from "../src/chat/suggestions";
import { suggestWorkspaceFiles } from "../src/agent/tools/workspaceFs";

const tempDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sugg-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("detectTrigger", () => {
  it("detects @ at token start", () => {
    expect(detectTrigger("@file.md", 8)).toEqual({ trigger: "@", query: "file.md", start: 0, end: 8 });
  });

  it("detects / at token start", () => {
    expect(detectTrigger("/new", 4)).toEqual({ trigger: "/", query: "new", start: 0, end: 4 });
  });

  it("detects trigger after whitespace", () => {
    expect(detectTrigger("hi /new", 7)).toEqual({ trigger: "/", query: "new", start: 3, end: 7 });
  });

  it("returns empty query for bare trigger", () => {
    expect(detectTrigger("/", 1)).toEqual({ trigger: "/", query: "", start: 0, end: 1 });
  });

  it("returns null when token has no trigger", () => {
    expect(detectTrigger("hello", 5)).toBeNull();
    expect(detectTrigger("a/b", 2)).toBeNull(); // 斜杠在 token 中间,不算触发
  });

  it("clamps cursor to text length", () => {
    expect(detectTrigger("/new", 99)).toEqual({ trigger: "/", query: "new", start: 0, end: 4 });
  });
});

describe("filterByQuery / filterBuiltInCommands", () => {
  it("filters by substring, case-insensitive", () => {
    const items = [{ n: "Foo.ts" }, { n: "Bar.ts" }];
    expect(filterByQuery(items, "foo", (x) => x.n)).toEqual([{ n: "Foo.ts" }]);
    expect(filterByQuery(items, "", (x) => x.n)).toHaveLength(2);
  });

  it("lists all built-in commands when query is empty", () => {
    expect(filterBuiltInCommands("").map((c) => c.name)).toContain("new");
    // new/plugins/cancel/compact/export/memory/help = 7
    expect(filterBuiltInCommands("")).toHaveLength(7);
  });

  it("filters commands by name or detail", () => {
    const q = filterBuiltInCommands("插件");
    expect(q.length).toBeGreaterThan(0);
    expect(q.every((c) => c.kind === "command")).toBe(true);
    expect(filterBuiltInCommands("zzz")).toHaveLength(0);
  });
});

describe("stripTriggerToken", () => {
  it("removes the token at cursor", () => {
    expect(stripTriggerToken("/new", 0, 4)).toBe("");
    expect(stripTriggerToken("hi /new", 3, 7)).toBe("hi ");
  });
});

describe("suggestWorkspaceFiles", () => {
  it("lists files and skips node_modules/.git", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "main.ts"), "x");
    fs.writeFileSync(path.join(dir, "README.md"), "x");
    fs.writeFileSync(path.join(dir, "node_modules", "dep.js"), "x");
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "x");

    const files = suggestWorkspaceFiles(dir, "", 40);
    expect(files).toContain("src/main.ts");
    expect(files).toContain("README.md");
    expect(files).not.toContain("node_modules/dep.js");
    expect(files).not.toContain(".git/HEAD");
  });

  it("filters by query and caps at max", () => {
    const dir = tmpDir();
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(dir, `file${i}.ts`), "x");
    fs.writeFileSync(path.join(dir, "other.md"), "x");

    expect(suggestWorkspaceFiles(dir, "", 3)).toHaveLength(3);
    expect(suggestWorkspaceFiles(dir, "other", 40)).toEqual(["other.md"]);
  });
});
