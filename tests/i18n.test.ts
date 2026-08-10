import { describe, it, expect } from "vitest";
import { en, t } from "../src/i18n/strings";

describe("i18n strings", () => {
  it("en table has no empty values and no duplicate keys", () => {
    const entries = Object.entries(en);
    expect(entries.length).toBeGreaterThan(0);
    const keys = new Set<string>();
    for (const [k, v] of entries) {
      expect(k.length).toBeGreaterThan(0);
      expect(v.trim().length).toBeGreaterThan(0);
      expect(keys.has(k)).toBe(false); // 无重复
      keys.add(k);
    }
  });

  it("zh locale returns the key itself (Chinese original)", () => {
    expect(t("设置", "zh")).toBe("设置");
  });

  it("en locale returns the translation", () => {
    expect(t("设置", "en")).toBe("Settings");
  });

  it("falls back to key when translation missing in en", () => {
    expect(t("不存在的文案", "en")).toBe("不存在的文案");
  });

  it("supports {name} interpolation", () => {
    en["已切换到供应商 {name}"] = "Switched to provider {name}";
    try {
      expect(t("已切换到供应商 {name}", "en", { name: "DemoProvider" })).toBe("Switched to provider DemoProvider");
      expect(t("已切换到供应商 {name}", "zh", { name: "DemoProvider" })).toBe("已切换到供应商 DemoProvider");
      expect(t("已切换到供应商 {name}", "en")).toBe("Switched to provider {name}");
    } finally {
      delete en["已切换到供应商 {name}"];
    }
  });
});
