import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { scanSkillDir } from "../src/projectContext/skillsScan";

describe("bundled extension skills", () => {
  const skillsRoot = path.join(__dirname, "..", "skills");

  it("ships process + engineering packs with notices", () => {
    expect(fs.existsSync(path.join(skillsRoot, "_notices", "NOTICE.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillsRoot, "_notices", "LICENSE-obra-superpowers.txt"))).toBe(true);
    expect(fs.existsSync(path.join(skillsRoot, "_notices", "LICENSE-addyosmani-agent-skills.txt"))).toBe(true);
    expect(fs.existsSync(path.join(skillsRoot, "using-dsb-skills", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillsRoot, "sp-brainstorming", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillsRoot, "as-documentation-and-adrs", "SKILL.md"))).toBe(true);
  });

  it("is scannable as a skills directory (37 adapted + 1 original skills)", () => {
    const listed = scanSkillDir(skillsRoot, "extension");
    // _notices has no SKILL.md so excluded
    expect(listed.length).toBe(38);
    expect(listed.some((s) => s.name === "using-dsb-skills")).toBe(true);
    expect(listed.some((s) => s.name === "context-recall-usage")).toBe(true);
    expect(listed.some((s) => s.name.startsWith("sp-"))).toBe(true);
    expect(listed.some((s) => s.name.startsWith("as-"))).toBe(true);
  });
});
