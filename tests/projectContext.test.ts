import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadProjectContext } from "../src/projectContext";
import { buildSystemPrompt } from "../src/agent/systemPrompt";

// 隔离用户级技能扫描:home 指向可变的假路径,避免 CI/开发机真实 ~/.dsb/skills 干扰断言。
// 用 vi.mock 而非 vi.spyOn:ESM 下 node 内置模块命名空间不可配置,spyOn 会抛错。
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dctx-"));
  mockHome.value = path.join(root, "home"); // 指向不存在的子目录,scanSkillDir 返回空
  fs.mkdirSync(path.join(root, ".claude", "skills", "demo"), { recursive: true });
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目规则\n用 vitest 测试。", "utf8");
  fs.writeFileSync(path.join(root, ".claude", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: 演示技能\n---\n# Demo", "utf8");
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm -rf *)"] } }), "utf8");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("loadProjectContext", () => {
  it("loads claude.md, skills, and permission rules", async () => {
    const ctx = await loadProjectContext(root);
    expect(ctx.projectInstruction).toContain("vitest");
    expect(ctx.skills.map((s) => s.name)).toContain("demo");
    const deny = await ctx.permissionRules.match("Bash", { command: "rm -rf /" });
    expect(deny).toBe("deny");
  });
  it("injects claude.md and skills into system prompt", async () => {
    const ctx = await loadProjectContext(root);
    const prompt = buildSystemPrompt({ workspaceRoot: root, projectInstruction: ctx.projectInstruction, skillList: ctx.skills });
    expect(prompt).toContain("项目指令");
    expect(prompt).toContain("demo: 演示技能");
  });
  it("prefers .dsb DSB.md / skills / settings over .claude", async () => {
    fs.mkdirSync(path.join(root, ".dsb", "skills", "demo2"), { recursive: true });
    fs.writeFileSync(path.join(root, ".dsb", "DSB.md"), "# 新约定\n用 .dsb。", "utf8");
    fs.writeFileSync(path.join(root, ".dsb", "skills", "demo2", "SKILL.md"), "---\nname: demo2\ndescription: 新技能\n---\n# Demo2", "utf8");
    fs.writeFileSync(path.join(root, ".dsb", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm -rf *)"] } }), "utf8");
    // beforeEach 已有 CLAUDE.md / .claude/skills / .claude/settings —— .dsb 应优先
    const ctx = await loadProjectContext(root);
    expect(ctx.projectInstruction).toContain(".dsb");
    expect(ctx.projectInstruction).not.toContain("CLAUDE");
    expect(ctx.skills.map((s) => s.name)).toContain("demo2");
    expect(ctx.skills.map((s) => s.name)).not.toContain("demo");
    expect(ctx.permissionRules.match("Bash", { command: "rm -rf /" })).toBe("deny");
  });

  it("falls back to CLAUDE.md / .claude skills when no .dsb", async () => {
    const ctx = await loadProjectContext(root);
    expect(ctx.projectInstruction).toContain("vitest");
    expect(ctx.skills.map((s) => s.name)).toContain("demo");
  });
  it("project skills prefer .dsb/skills, fall back to .claude/skills", async () => {
    // 当前 beforeEach 只有 .claude/skills/demo —— 回退路径
    const ctxA = await loadProjectContext(root);
    expect(ctxA.skills.map((s) => s.name)).toContain("demo");
    // 新建 .dsb/skills 后应优先
    fs.mkdirSync(path.join(root, ".dsb", "skills", "demo3"), { recursive: true });
    fs.writeFileSync(path.join(root, ".dsb", "skills", "demo3", "SKILL.md"), "---\nname: demo3\ndescription: 三号\n---\n# D3", "utf8");
    const ctxB = await loadProjectContext(root);
    expect(ctxB.skills.map((s) => s.name)).toContain("demo3");
    expect(ctxB.skills.map((s) => s.name)).not.toContain("demo");
  });

  it("loads rules and injects into system prompt", async () => {
    fs.mkdirSync(path.join(root, ".dsb", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, ".dsb", "rules", "style.md"), "用 2 空格缩进。", "utf8");
    const ctx = await loadProjectContext(root);
    expect(ctx.rules).toHaveLength(1);
    expect(ctx.rules[0]?.name).toBe(".dsb/rules/style.md");
    const prompt = buildSystemPrompt({
      workspaceRoot: root,
      projectInstruction: ctx.projectInstruction,
      skillList: ctx.skills,
      rules: ctx.rules,
    });
    expect(prompt).toContain("项目规则");
    expect(prompt).toContain(".dsb/rules/style.md");
    expect(prompt).toContain("用 2 空格缩进。");
  });

  it("does not add rules section when rules empty", async () => {
    const ctx = await loadProjectContext(root);
    const prompt = buildSystemPrompt({ workspaceRoot: root, projectInstruction: ctx.projectInstruction, skillList: ctx.skills, rules: ctx.rules });
    expect(prompt).not.toContain("## 项目规则");
  });

  it("injects locale reply language into system prompt", () => {
    const zhPrompt = buildSystemPrompt({ workspaceRoot: root, locale: "zh" });
    expect(zhPrompt).toContain("Reply in Chinese (中文).");
    const enPrompt = buildSystemPrompt({ workspaceRoot: root, locale: "en" });
    expect(enPrompt).toContain("Reply in English.");
    const defaultPrompt = buildSystemPrompt({ workspaceRoot: root });
    expect(defaultPrompt).toContain("Reply in English.");
  });

  it("injects .dsb plans/specs/docs path convention into system prompt", () => {
    const prompt = buildSystemPrompt({ workspaceRoot: root });
    expect(prompt).toContain(".dsb/plans/");
    expect(prompt).toContain(".dsb/specs/");
    expect(prompt).toContain(".dsb/docs/");
    expect(prompt).toContain(".dsb/commands/");
    expect(prompt).toContain(".dsb/agents/");
    expect(prompt).toContain("DSB.md");
  });
});
