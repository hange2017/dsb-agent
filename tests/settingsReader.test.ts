import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readProjectSettings } from "../src/projectContext/settingsReader";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dsettings-"));
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function write(name: string, obj: unknown): void {
  fs.writeFileSync(path.join(root, ".claude", name), JSON.stringify(obj), "utf8");
}

describe("readProjectSettings", () => {
  it("merges permissions at the ARRAY level: base allow + local deny coexist", () => {
    write("settings.json", { permissions: { allow: ["Bash(git *)"] } });
    write("settings.local.json", { permissions: { deny: ["Bash(rm -rf *)"] } });

    const rules = readProjectSettings(root).permissionRules;
    // 基线的 allow 不被本地文件静默丢弃
    expect(rules.match("Bash", { command: "git status" })).toBe("allow");
    // 本地的 deny 追加进来
    expect(rules.match("Bash", { command: "rm -rf /" })).toBe("deny");
  });

  it("appends local allow rules to base allow rules", () => {
    write("settings.json", { permissions: { allow: ["Bash(git *)"] } });
    write("settings.local.json", { permissions: { allow: ["Bash(npm *)"] } });

    const rules = readProjectSettings(root).permissionRules;
    expect(rules.match("Bash", { command: "git status" })).toBe("allow");
    expect(rules.match("Bash", { command: "npm install" })).toBe("allow");
  });

  it("still lets top-level env/model be overridden by local", () => {
    write("settings.json", { env: { A: "1" }, model: "base" });
    write("settings.local.json", { env: { B: "2" }, model: "local" });

    const s = readProjectSettings(root);
    expect(s.env).toEqual({ B: "2" });
    expect(s.model).toBe("local");
  });

  it("reads from .dsb/ when present (preferred over .claude)", () => {
    fs.mkdirSync(path.join(root, ".dsb"), { recursive: true });
    fs.writeFileSync(path.join(root, ".dsb", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm -rf *)"] } }), "utf8");
    // .claude/ 也有 allow 规则(经 beforeEach + write),.dsb 应优先
    write("settings.json", { permissions: { allow: ["Bash(*)"] } });
    const rules = readProjectSettings(root).permissionRules;
    expect(rules.match("Bash", { command: "rm -rf /" })).toBe("deny"); // 来自 .dsb
    expect(rules.match("Bash", { command: "git status" })).toBeUndefined(); // .claude 的 allow 不混入
  });

  it("falls back to .claude/ when no .dsb/", () => {
    // beforeEach 已建 .claude/,无 .dsb
    write("settings.json", { permissions: { allow: ["Bash(git *)"] } });
    const rules = readProjectSettings(root).permissionRules;
    expect(rules.match("Bash", { command: "git status" })).toBe("allow");
  });

  it(".dsb settings.local merges onto .dsb settings.json", () => {
    fs.mkdirSync(path.join(root, ".dsb"), { recursive: true });
    fs.writeFileSync(path.join(root, ".dsb", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(git *)"] } }), "utf8");
    fs.writeFileSync(path.join(root, ".dsb", "settings.local.json"), JSON.stringify({ permissions: { deny: ["Bash(rm -rf *)"] } }), "utf8");
    const rules = readProjectSettings(root).permissionRules;
    expect(rules.match("Bash", { command: "git status" })).toBe("allow");
    expect(rules.match("Bash", { command: "rm -rf /" })).toBe("deny");
  });
});
