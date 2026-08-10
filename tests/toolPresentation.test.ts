import { describe, it, expect } from "vitest";
import { presentTool } from "../src/chat/toolPresentation";

describe("presentTool", () => {
  it("Read shows basename and optional lines", () => {
    const p = presentTool("Read", { path: "src/a.ts", offset: 10, limit: 20 }, "x", "completed");
    expect(p.displayName).toBe("Read");
    expect(p.headerSecondary ?? "").toMatch(/a\.ts/);
    expect(p.headerSecondary ?? "").toMatch(/lines/);
  });

  it("StrReplace displays as Edit with modification summary", () => {
    const p = presentTool(
      "StrReplace",
      { path: "f.ts", old_string: "a\nb", new_string: "a\nb\nc" },
      "Replaced 1",
      "completed",
    );
    expect(p.displayName).toBe("Edit");
    expect(p.summary ?? "").toMatch(/Added|Modified|Removed/);
    // 类型化后 StrReplace 改为 diff 块,不再是 "Show full" 文本块
    expect(p.body?.[0]).toMatchObject({ kind: "diff" });
  });

  it("Bash renders a terminal block", () => {
    const p = presentTool("Bash", { command: "npm test" }, "ok\n", "completed");
    expect(p.displayName).toBe("Bash");
    // 类型化后 Bash 合并为单个 terminal 块($ command + stdout)
    expect(p.body?.[0]).toMatchObject({ kind: "terminal", label: "Bash" });
    if (p.body?.[0]?.kind === "terminal") expect(p.body[0].content).toContain("npm test");
  });

  it("Glob summarizes file count", () => {
    const p = presentTool("Glob", { pattern: "**/*.ts" }, "a.ts\nb.ts\n", "completed");
    expect(p.summary ?? "").toMatch(/Found 2 files/);
  });

  it("Write shows line count summary", () => {
    const p = presentTool("Write", { path: "x.ts", contents: "a\nb\n" }, "Wrote x.ts", "completed");
    expect(p.displayName).toBe("Write");
    expect(p.summary ?? "").toMatch(/lines/);
  });

  it("Grep renders a file/line/content table", () => {
    const p = presentTool("Grep", { pattern: "foo" }, "src/a.ts:10:const foo = 1;\nsrc/b.ts:20:foo();", "completed");
    expect(p.body?.[0]).toMatchObject({ kind: "table", columns: ["文件", "行", "内容"] });
    if (p.body?.[0]?.kind === "table") expect(p.body[0].rows[0]).toEqual(["src/a.ts", "10", "const foo = 1;"]);
  });
  it("Glob renders a single-column file table", () => {
    const p = presentTool("Glob", { pattern: "**/*.ts" }, "a.ts\nb/c.ts", "completed");
    expect(p.body?.[0]).toMatchObject({ kind: "table", columns: ["文件"] });
  });
  it("LS marks directories", () => {
    const p = presentTool("LS", { path: "." }, "src/\nreadme.md", "completed");
    const table = p.body?.[0];
    if (table?.kind === "table") expect(table.rows).toEqual([["src", "dir"], ["readme.md", "file"]]);
  });
  it("Read shows a file view block", () => {
    const p = presentTool("Read", { path: "a.ts" }, "export const x = 1;", "completed");
    expect(p.body?.[0]).toMatchObject({ kind: "file", path: "a.ts" });
  });
  it("StrReplace renders a diff with add/del", () => {
    const p = presentTool("StrReplace", { path: "a.ts", old_string: "foo\nbar", new_string: "foo\nbaz" }, undefined, "completed");
    const d = p.body?.[0];
    expect(d?.kind).toBe("diff");
    if (d?.kind === "diff") {
      expect(d.hunks.some((h) => h.type === "del" && h.text === "bar")).toBe(true);
      expect(d.hunks.some((h) => h.type === "add" && h.text === "baz")).toBe(true);
      expect(d.hunks.some((h) => h.type === "same" && h.text === "foo")).toBe(true);
    }
  });
  it("WebSearch renders a list, falls back to text on unparseable", () => {
    const p = presentTool("WebSearch", { query: "q" }, "1. 标题\n   https://x\n   摘要", "completed");
    expect(p.body?.[0]).toMatchObject({ kind: "list" });
    const p2 = presentTool("WebSearch", { query: "q" }, "(no results)", "completed");
    expect(p2.body?.[0]?.kind).toBe("text");
  });
});
