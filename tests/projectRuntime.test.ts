import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ProjectRuntime } from "../src/chat/projectRuntime";

// 隔离用户级技能扫描:home 指向可变的假路径,避免开发机真实 ~/.dsb/skills 干扰断言。
// 用 vi.mock 而非 vi.spyOn:ESM 下 node 内置模块命名空间不可配置,spyOn 会抛错(与 projectContext.test.ts 同款)。
const { mockHome } = vi.hoisted(() => ({ mockHome: { value: "" } }));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return {
    ...actual,
    homedir: () => mockHome.value,
  };
});

let root: string;
let runtime: ProjectRuntime;
const runHookCommand = async (cmd: string, input: unknown): Promise<string> => `${cmd}:${JSON.stringify(input)}`;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dprt-"));
  mockHome.value = path.join(root, "home");
  runtime = new ProjectRuntime({
    getWorkspaceCwd: () => root,
    extensions: [],
    pluginCacheDir: "",
    runHookCommand,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("ProjectRuntime", () => {
  it("refreshRules loads .dsb/settings.json deny rules", () => {
    fs.mkdirSync(path.join(root, ".dsb"), { recursive: true });
    fs.writeFileSync(path.join(root, ".dsb", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm -rf *)"] } }), "utf8");
    runtime.refreshRules();
    expect(runtime.getRules().match("Bash", { command: "rm -rf /" })).toBe("deny");
  });
  it("refreshRules with explicit root uses it (worktree)", () => {
    const wt = path.join(root, "wt");
    fs.mkdirSync(path.join(wt, ".dsb"), { recursive: true });
    fs.writeFileSync(path.join(wt, ".dsb", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(*)"] } }), "utf8");
    runtime.refreshRules(wt);
    expect(runtime.getRules().match("Bash", { command: "git status" })).toBe("deny");
  });
  it("refreshRules with no cwd yields empty rules", () => {
    const r2 = new ProjectRuntime({ getWorkspaceCwd: () => undefined, runHookCommand });
    r2.refreshRules();
    expect(r2.getRules().match("Bash", { command: "anything" })).toBeUndefined();
  });
  it("buildHookRunner merges settings hooks + returns them via hookConfig", () => {
    fs.mkdirSync(path.join(root, ".dsb"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".dsb", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo hi" }] }] } }),
      "utf8",
    );
    const runner = runtime.buildHookRunner(root);
    const all = runner.all();
    expect(all.some((h) => h.event === "PreToolUse" && h.matcher === "Write" && h.command === "echo hi")).toBe(true);
    expect(runtime.hookConfig().some((h) => h.command === "echo hi")).toBe(true);
  });
  it("skillList scans .dsb/skills project layer", async () => {
    fs.mkdirSync(path.join(root, ".dsb", "skills", "demo"), { recursive: true });
    fs.writeFileSync(path.join(root, ".dsb", "skills", "demo", "SKILL.md"), "---\ndescription: 演示\n---\n# D", "utf8");
    const names = runtime.skillList().map((s) => s.name);
    expect(names).toContain("demo");
  });
  it("pluginContents returns [] when no pluginCacheDir is configured", () => {
    expect(runtime.pluginContents()).toEqual([]);
  });
  it("pluginDirs returns absolute installed plugin dirs (plugins/<market>/<plugin>)", () => {
    const cache = path.join(root, "pluginCache");
    fs.mkdirSync(path.join(cache, "plugins", "marketA", "plugin1"), { recursive: true });
    fs.mkdirSync(path.join(cache, "plugins", "marketA", "plugin2"), { recursive: true });
    fs.mkdirSync(path.join(cache, "plugins", "marketB", "plugin3"), { recursive: true });
    const r2 = new ProjectRuntime({
      getWorkspaceCwd: () => root,
      extensions: [],
      pluginCacheDir: cache,
      runHookCommand,
    });
    expect(r2.pluginDirs()).toEqual([
      path.join(cache, "plugins", "marketA", "plugin1"),
      path.join(cache, "plugins", "marketA", "plugin2"),
      path.join(cache, "plugins", "marketB", "plugin3"),
    ]);
  });
  it("pluginDirs is fail-open for a missing/corrupt cache dir", () => {
    const r2 = new ProjectRuntime({
      getWorkspaceCwd: () => root,
      extensions: [],
      pluginCacheDir: path.join(root, "does-not-exist"),
      runHookCommand,
    });
    expect(r2.pluginDirs()).toEqual([]);
  });
});
