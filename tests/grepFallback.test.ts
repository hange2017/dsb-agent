import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { grepFallback } from "../src/agent/tools/grepFallback";

describe("grepFallback", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "grepfb-"));
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a.ts"), "hello world\nfoo bar\nHELLO again\n");
    fs.writeFileSync(path.join(dir, "b.txt"), "nothing here\n");
    fs.writeFileSync(path.join(dir, "sub", "c.ts"), "hello sub\n");
    fs.writeFileSync(path.join(dir, "skip.log"), "hello log\n");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("matches lines with rg-style output", () => {
    const r = grepFallback("hello", { root: dir });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("a.ts:1: hello world");
    expect(r.content).toContain("sub/c.ts:1: hello sub");
    expect(r.content).not.toContain("b.txt");
  });

  it("case-insensitive", () => {
    const r = grepFallback("HELLO", { root: dir, caseInsensitive: true });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("a.ts:1: hello world");
  });

  it("glob filter restricts files", () => {
    const r = grepFallback("hello", { root: dir, glob: "*.ts" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("a.ts");
    expect(r.content).not.toContain("skip.log");
  });

  it("literal pattern when invalid regex", () => {
    fs.writeFileSync(path.join(dir, "special.txt"), "literal (text)\n");
    const r = grepFallback("(text", { root: dir });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("special.txt:1: literal (text)");
  });

  it("no matches", () => {
    const r = grepFallback("zzz-nope", { root: dir });
    expect(r.ok).toBe(true);
    expect(r.content).toBe("(no matches)");
  });

  it("missing path returns error", () => {
    const r = grepFallback("x", { root: dir, path: "missing" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("not found");
  });

  it("skips node_modules by default", () => {
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "dep.js"), "hello dep\n");
    const r = grepFallback("hello", { root: dir });
    expect(r.ok).toBe(true);
    expect(r.content).not.toContain("dep.js");
  });
});
