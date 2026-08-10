import { describe, it, expect } from "vitest";
import { CapabilityRegistry } from "../src/providers/capabilityRegistry";
import type { CapabilityProvider } from "../src/providers/capabilityRegistry";

const provider: CapabilityProvider = {
  id: "p1",
  defaultCapabilities: { supportsVision: false, supportsThinking: true },
  capabilityOverrides: { "m1": { supportsVision: true } },
};

describe("CapabilityRegistry", () => {
  const reg = new CapabilityRegistry();

  it("resolves per-model capabilities", () => {
    expect(reg.resolve(provider, "m1")).toMatchObject({ supportsVision: true, supportsThinking: true });
    expect(reg.resolve(provider, "deepseek-v4-flash")).toMatchObject({ supportsVision: true, supportsThinking: true });
    expect(reg.resolve(provider, "unknown")).toMatchObject({ supportsVision: false, supportsThinking: true });
  });

  it("buildOverride merges existing overrides with patch", () => {
    const next = reg.buildOverride(provider, "m2", { supportsThinking: false });
    expect(next["m2"]).toEqual({ supportsThinking: false });
    const merged = reg.buildOverride(provider, "m1", { supportsThinking: false });
    expect(merged["m1"]).toMatchObject({ supportsVision: true, supportsThinking: false });
  });

  it("buildOverride without prior overrides starts fresh", () => {
    const next = reg.buildOverride({ id: "p2", defaultCapabilities: { supportsVision: false, supportsThinking: true } }, "x", { supportsVision: true });
    expect(next).toEqual({ x: { supportsVision: true } });
  });
});
