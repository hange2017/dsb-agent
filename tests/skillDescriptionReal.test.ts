import { describe, it, expect } from "vitest";
import * as path from "path";
import { scanSkillDir } from "../src/projectContext/skillsScan";
import { summarizeSkillDescription, renderSkillSummary } from "../src/plugins/skillDescription";

describe("real bundled skills: tag summarization integrity", () => {
  const skillsRoot = path.join(__dirname, "..", "skills");
  const skills = scanSkillDir(skillsRoot, "extension");

  it("every tag word is traceable back to the original description (no hallucinated tags)", () => {
    for (const s of skills) {
      const r = summarizeSkillDescription(s.description);
      if (!r) continue;
      // 归一化保留词内字符(数字、+、#、-),去掉标点
      const norm = s.description.toLowerCase().replace(/[^a-z0-9+]/g, " ");
      const normWords = new Set(norm.split(/\s+/).filter(Boolean));
      for (const tag of r.tags) {
        for (const w of tag.slice(1).split("-")) {
          expect(normWords.has(w), `${s.name}: tag word "${w}" not in original desc`).toBe(true);
        }
      }
    }
  });

  it("tagged rendering is no longer overall than the 120-char truncation (cost-neutral or cheaper)", () => {
    let oldTotal = 0;
    let newTotal = 0;
    for (const s of skills) {
      const r = summarizeSkillDescription(s.description);
      oldTotal += Math.min(s.description.length, 120);
      newTotal += r ? renderSkillSummary(r).length : Math.min(s.description.length, 120);
    }
    expect(newTotal).toBeLessThanOrEqual(oldTotal);
  });

  it("most descriptions carry a Use when/before structure (summarizable)", () => {
    const summarized = skills.filter((s) => summarizeSkillDescription(s.description) !== null).length;
    expect(summarized).toBeGreaterThan(skills.length / 2);
  });
});
