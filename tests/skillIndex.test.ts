import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SkillIndex } from "../src/plugins/skillIndex";
import { scanSkillDir, scanPluginSkills } from "../src/projectContext/skillsScan";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dskill-"));
  fs.mkdirSync(path.join(dir, "s1"), { recursive: true });
  fs.writeFileSync(path.join(dir, "s1", "SKILL.md"), "---\ndescription: 技能一\n---\n# S1");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("SkillIndex", () => {
  it("adds and lists unique skills", () => {
    const idx = new SkillIndex();
    const infos = scanSkillDir(dir, "project");
    infos.forEach((i) => idx.add(i));
    idx.add(infos[0]); // 重复
    expect(idx.all()).toHaveLength(1);
    expect(idx.listForPrompt()[0].description).toBe("技能一");
  });
  it("loads skill content", () => {
    const idx = new SkillIndex();
    scanSkillDir(dir, "project").forEach((i) => idx.add(i));
    expect(idx.loadSkill("s1")).toContain("# S1");
    expect(idx.loadSkill("missing")).toBeUndefined();
  });

  it("dedupes by name keeping highest-priority source (project > user > extension > plugin)", () => {
    const idx = new SkillIndex();
    idx.add({ name: "s1", description: "extension 版", path: "/ext/s1", source: "extension" });
    idx.add({ name: "s1", description: "project 版", path: "/proj/s1", source: "project" });
    expect(idx.all()).toHaveLength(1);
    expect(idx.all()[0].description).toBe("project 版");
    expect(idx.all()[0].source).toBe("project");
  });

  it("replaces lower-priority source when a higher one comes later", () => {
    const idx = new SkillIndex();
    idx.add({ name: "s1", description: "extension 版", path: "/ext/s1", source: "extension" });
    idx.add({ name: "s1", description: "user 版", path: "/usr/s1", source: "user" });
    expect(idx.all()[0].description).toBe("user 版");
    idx.add({ name: "s1", description: "plugin 版", path: "/plug/s1", source: "plugin" });
    expect(idx.all()).toHaveLength(1); // plugin 优先级低于 user,不替换
    expect(idx.all()[0].source).toBe("user");
  });

  it("tiers prompt list: project/user and sp-*/using-* stay full, others compact", () => {
    const idx = new SkillIndex();
    const long = "A".repeat(120);
    idx.add({ name: "custom-skill", description: long, path: "/p/c", source: "project" });
    idx.add({ name: "sp-brainstorming", description: "You MUST use this before any creative work. ".repeat(3), path: "/p/sp", source: "extension" });
    idx.add({ name: "using-dsb-skills", description: "How to find and apply bundled skills. ".repeat(3), path: "/p/u", source: "extension" });
    idx.add({ name: "as-api-and-interface-design", description: "Guides stable API and interface design. Use when designing APIs. ".repeat(3), path: "/p/as", source: "extension" });
    const list = idx.listForPrompt();
    const byName = Object.fromEntries(list.map((s) => [s.name, s]));
    expect(byName["custom-skill"].compact).toBe(false);
    expect(byName["sp-brainstorming"].compact).toBe(false);
    expect(byName["using-dsb-skills"].compact).toBe(false);
    expect(byName["as-api-and-interface-design"].compact).toBe(true);
    expect(byName["as-api-and-interface-design"].description.length).toBeLessThanOrEqual(43); // 40 + "…"
  });

  it("prefixes plugin skills with <plugin>: and keeps names distinct across markets", () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "pskills-"));
    try {
      const sp = path.join(cache, "plugins", "sp-market", "superpowers", "skills");
      fs.mkdirSync(path.join(sp, "brainstorming"), { recursive: true });
      fs.writeFileSync(path.join(sp, "brainstorming", "SKILL.md"), "---\ndescription: 设计前先探讨需求\n---\n");
      fs.mkdirSync(path.join(sp, "systematic-debugging"), { recursive: true });
      fs.writeFileSync(path.join(sp, "systematic-debugging", "SKILL.md"), "---\ndescription: 系统化调试\n---\n");
      const an = path.join(cache, "plugins", "anthropic", "agent-sdk", "skills");
      fs.mkdirSync(path.join(an, "brainstorming"), { recursive: true });
      fs.writeFileSync(path.join(an, "brainstorming", "SKILL.md"), "---\ndescription: 另一个\n---\n");

      const names = scanPluginSkills(cache).map((s) => s.name).sort();
      expect(names).toEqual([
        "agent-sdk:brainstorming",
        "superpowers:brainstorming",
        "superpowers:systematic-debugging",
      ]);
      // 前缀过滤:`/su` 应命中全部 superpowers 技能
      const su = names.filter((n) => n.includes("su"));
      expect(su).toContain("superpowers:brainstorming");
      expect(su).toContain("superpowers:systematic-debugging");
    } finally {
      fs.rmSync(cache, { recursive: true, force: true });
    }
  });
});
