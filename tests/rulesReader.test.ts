import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readRules } from "../src/projectContext/rulesReader";

// 隔离用户级 rules 扫描:home 指向可变的假路径,避免 CI/开发机真实 ~/.dsb/rules 干扰断言。
const { mockHome } = vi.hoisted(() => ({ mockHome: { value: "" } }));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return {
    ...actual,
    homedir: () => mockHome.value,
  };
});

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rules-"));
  mockHome.value = path.join(root, "home"); // 指向不存在的子目录,readRules 用户级为空
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("readRules", () => {
  it("returns empty when no rules dirs exist", () => {
    expect(readRules(root)).toEqual([]);
  });

  it("reads project rules sorted by filename", () => {
    fs.mkdirSync(path.join(root, ".dsb", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, ".dsb", "rules", "b.md"), "B 规则", "utf8");
    fs.writeFileSync(path.join(root, ".dsb", "rules", "a.md"), "A 规则", "utf8");
    const rules = readRules(root);
    expect(rules.map((r) => r.name)).toEqual([".dsb/rules/a.md", ".dsb/rules/b.md"]);
    expect(rules[0]?.content).toContain("A 规则");
    expect(rules[0]?.source).toBe("project");
  });

  it("reads user rules after project rules", () => {
    fs.mkdirSync(path.join(root, ".dsb", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, ".dsb", "rules", "p.md"), "P", "utf8");
    fs.mkdirSync(path.join(mockHome.value, ".dsb", "rules"), { recursive: true });
    fs.writeFileSync(path.join(mockHome.value, ".dsb", "rules", "u.md"), "U", "utf8");
    const rules = readRules(root);
    expect(rules.map((r) => r.source)).toEqual(["project", "user"]);
    expect(rules[1]?.name).toBe("~/.dsb/rules/u.md");
  });

  it("falls back to .claude/rules when no .dsb/rules", () => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "rules", "legacy.md"), "旧规则", "utf8");
    const rules = readRules(root);
    expect(rules[0]?.name).toBe(".claude/rules/legacy.md");
    expect(rules[0]?.content).toContain("旧规则");
    expect(rules[0]?.source).toBe("project");
  });

  it("ignores non-md files", () => {
    fs.mkdirSync(path.join(root, ".dsb", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, ".dsb", "rules", "a.md"), "A", "utf8");
    fs.writeFileSync(path.join(root, ".dsb", "rules", "notes.txt"), "TXT", "utf8");
    const rules = readRules(root);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.name).toBe(".dsb/rules/a.md");
  });

  it("falls back to ~/.claude/rules for user level", () => {
    fs.mkdirSync(path.join(mockHome.value, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(mockHome.value, ".claude", "rules", "u.md"), "U2", "utf8");
    const rules = readRules(root);
    expect(rules[0]?.name).toBe("~/.claude/rules/u.md");
    expect(rules[0]?.source).toBe("user");
  });
});
