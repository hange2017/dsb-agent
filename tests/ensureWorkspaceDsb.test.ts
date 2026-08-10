import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ensureWorkspaceDsb } from "../src/projectContext/ensureWorkspaceDsb";
import { CONVENTION_DIR } from "../src/projectContext/convention";

describe("ensureWorkspaceDsb", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dsb-scaffold-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates .dsb tree when missing and copies project skills/rules", () => {
    const skillSrc = path.join(root, ".claude", "skills", "demo");
    fs.mkdirSync(skillSrc, { recursive: true });
    fs.writeFileSync(path.join(skillSrc, "SKILL.md"), "---\ndescription: Demo\n---\n");
    const rulesSrc = path.join(root, "rules");
    fs.mkdirSync(rulesSrc, { recursive: true });
    fs.writeFileSync(path.join(rulesSrc, "style.md"), "# style\n");

    const r = ensureWorkspaceDsb(root, { extensions: [] });
    expect(r.created).toBe(true);
    expect(fs.statSync(path.join(root, CONVENTION_DIR, "skills")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(root, CONVENTION_DIR, "rules")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(root, CONVENTION_DIR, "commands")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(root, CONVENTION_DIR, "agents")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(root, CONVENTION_DIR, "plans")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(root, CONVENTION_DIR, "specs")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(root, CONVENTION_DIR, "docs")).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(root, CONVENTION_DIR, "skills", "demo", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, CONVENTION_DIR, "rules", "style.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, CONVENTION_DIR, "DSB.md"))).toBe(true);
    expect(r.copiedSkills).toBeGreaterThanOrEqual(1);
    expect(r.copiedRules).toBeGreaterThanOrEqual(1);
    expect(r.wroteDsbMd).toBe(true);
  });

  it("copies commands and agents from project and extensions", () => {
    fs.mkdirSync(path.join(root, ".claude", "commands"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "commands", "review.md"), "---\ndescription: Review\n---\nDo review\n");
    fs.mkdirSync(path.join(root, "agents"), { recursive: true });
    fs.writeFileSync(path.join(root, "agents", "researcher.md"), "---\ndescription: Research\n---\nResearch\n");

    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsb-ext-cmd-"));
    try {
      fs.mkdirSync(path.join(extRoot, "commands"), { recursive: true });
      fs.writeFileSync(path.join(extRoot, "commands", "extcmd.md"), "ext command\n");
      fs.mkdirSync(path.join(extRoot, ".agents"), { recursive: true });
      fs.writeFileSync(path.join(extRoot, ".agents", "extagent.md"), "ext agent\n");

      const r = ensureWorkspaceDsb(root, {
        extensions: [{ extensionPath: extRoot, id: "pub.ext" }],
      });
      expect(r.copiedCommands).toBeGreaterThanOrEqual(2);
      expect(r.copiedAgents).toBeGreaterThanOrEqual(2);
      expect(fs.existsSync(path.join(root, CONVENTION_DIR, "commands", "review.md"))).toBe(true);
      expect(fs.existsSync(path.join(root, CONVENTION_DIR, "commands", "extcmd.md"))).toBe(true);
      expect(fs.existsSync(path.join(root, CONVENTION_DIR, "agents", "researcher.md"))).toBe(true);
      expect(fs.existsSync(path.join(root, CONVENTION_DIR, "agents", "extagent.md"))).toBe(true);
    } finally {
      fs.rmSync(extRoot, { recursive: true, force: true });
    }
  });

  it("seeds DSB.md from existing CLAUDE.md when present", () => {
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Project\nUse TypeScript.\n");
    const r = ensureWorkspaceDsb(root, { extensions: [] });
    expect(r.wroteDsbMd).toBe(true);
    expect(fs.readFileSync(path.join(root, CONVENTION_DIR, "DSB.md"), "utf8")).toContain("Use TypeScript");
  });

  it("is no-op when .dsb already exists", () => {
    fs.mkdirSync(path.join(root, CONVENTION_DIR), { recursive: true });
    fs.mkdirSync(path.join(root, ".claude", "skills", "x"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "skills", "x", "SKILL.md"), "x");
    const r = ensureWorkspaceDsb(root, { extensions: [] });
    expect(r.created).toBe(false);
    expect(fs.existsSync(path.join(root, CONVENTION_DIR, "skills", "x"))).toBe(false);
  });

  it("does not overwrite existing skill dir or rule file when seeding", () => {
    // Simulate race: we only seed when missing; for copy conflicts within first seed:
    // put two sources with same skill name — first wins
    fs.mkdirSync(path.join(root, "skills", "dup"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "dup", "SKILL.md"), "from-root");
    fs.mkdirSync(path.join(root, ".claude", "skills", "dup"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "skills", "dup", "SKILL.md"), "from-claude");

    ensureWorkspaceDsb(root, { extensions: [] });
    const body = fs.readFileSync(path.join(root, CONVENTION_DIR, "skills", "dup", "SKILL.md"), "utf8");
    expect(body).toBe("from-root");
  });

  it("copies skills from vscode extensions", () => {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsb-ext-"));
    try {
      const skill = path.join(extRoot, "skills", "extskill");
      fs.mkdirSync(skill, { recursive: true });
      fs.writeFileSync(path.join(skill, "SKILL.md"), "---\ndescription: Ext\n---\n");
      const r = ensureWorkspaceDsb(root, {
        extensions: [{ extensionPath: extRoot, id: "pub.ext" }],
      });
      expect(r.created).toBe(true);
      expect(fs.existsSync(path.join(root, CONVENTION_DIR, "skills", "extskill", "SKILL.md"))).toBe(true);
    } finally {
      fs.rmSync(extRoot, { recursive: true, force: true });
    }
  });
});
