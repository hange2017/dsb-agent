import { describe, it, expect } from "vitest";
import { summarizeSkillDescription, renderSkillSummary } from "../src/plugins/skillDescription";

describe("summarizeSkillDescription", () => {
  it("compresses standard as-* description into lead + trigger tags", () => {
    const desc =
      "Guides stable API and interface design. Use when designing APIs, module boundaries, or any public interface. Use when creating REST or GraphQL endpoints, defining type contracts between modules, or establishing boundaries between frontend and backend.";
    const r = summarizeSkillDescription(desc);
    expect(r).not.toBeNull();
    expect(r!.lead).toBe("Guides stable API and interface design.");
    expect(r!.tags).toEqual(["#designing-apis", "#module-boundaries", "#public-interface"]);
  });

  it("handles sp-* skills that start with Use when (empty lead -> first clause as lead)", () => {
    const desc =
      "Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims.";
    const r = summarizeSkillDescription(desc);
    expect(r).not.toBeNull();
    expect(r!.lead.length).toBeLessThanOrEqual(81); // MAX_LEAD + "…"
    expect(r!.lead.startsWith("about to claim work is complete")).toBe(true);
    expect(r!.tags.join(" ")).toContain("#fixed");
    expect(r!.tags.join(" ")).toContain("#passing");
  });

  it("handles Use before phrasing (as-code-review-and-quality)", () => {
    const desc =
      "Conducts multi-axis code review. Use before merging any change. Use when reviewing code written by yourself, another agent, or a human.";
    const r = summarizeSkillDescription(desc);
    expect(r).not.toBeNull();
    expect(r!.lead).toBe("Conducts multi-axis code review.");
    expect(r!.tags).toContain("#merging-change");
    expect(r!.tags.join(" ")).toContain("#reviewing-code");
  });

  it("deduplicates repeated tags", () => {
    const desc = "Do X. Use when building widgets, when building widgets again, or when fixing widgets.";
    const r = summarizeSkillDescription(desc)!;
    expect(new Set(r.tags).size).toBe(r.tags.length);
  });

  it("returns null when no Use when/before structure exists (fall back to original truncation)", () => {
    expect(summarizeSkillDescription("How to set up a new TypeScript project.")).toBeNull();
    expect(summarizeSkillDescription("You MUST use this before any creative work. Explores intent.")).toBeNull();
    expect(summarizeSkillDescription("")).toBeNull();
  });

  it("truncates over-long lead with …", () => {
    const longLead = "A".repeat(150);
    const r = summarizeSkillDescription(`${longLead}. Use when fixing bugs.`);
    expect(r!.lead.length).toBeLessThanOrEqual(80);
    expect(r!.lead.endsWith("…")).toBe(true);
  });

  it("limits to MAX_TAGS tags", () => {
    const desc = "Do X. Use when a. Use when b. Use when c. Use when d. Use when e. Use when f.";
    const r = summarizeSkillDescription(desc)!;
    expect(r.tags.length).toBeLessThanOrEqual(3);
  });
});

describe("renderSkillSummary", () => {
  it("renders lead + space-joined tags on one line", () => {
    expect(renderSkillSummary({ lead: "Guides stable API design.", tags: ["#designing-apis", "#module-boundaries"] }))
      .toBe("Guides stable API design. #designing-apis #module-boundaries");
  });
});
