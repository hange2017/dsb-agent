import { describe, it, expect } from "vitest";
import { noProviderChoices } from "../src/settings/providerChoices";

describe("noProviderChoices", () => {
  it("returns template / ccswitch / manual in order", () => {
    const choices = noProviderChoices("zh");
    expect(choices.map((c) => c.action)).toEqual(["template", "ccswitch", "manual"]);
  });

  it("zh labels are Chinese and include a default compatible endpoint template", () => {
    const choices = noProviderChoices("zh");
    const tpl = choices.find((c) => c.action === "template");
    expect(tpl?.label).toContain("默认兼容端点");
    expect(tpl?.detail).toContain("https://api.deepseek.com/anthropic");
    expect(choices.find((c) => c.action === "ccswitch")?.label).toContain("cc-switch");
  });

  it("en labels are English", () => {
    const choices = noProviderChoices("en");
    expect(choices.find((c) => c.action === "template")?.label).toContain("Default compatible endpoint");
    expect(choices.find((c) => c.action === "manual")?.label).toContain("Manual");
  });
});
