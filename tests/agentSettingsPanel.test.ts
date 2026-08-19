import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => ({
  Uri: {
    joinPath: (...parts: unknown[]) => ({
      fsPath: parts.map(String).join("/"),
      toString: () => parts.map(String).join("/"),
    }),
    file: (p: string) => ({ fsPath: p, toString: () => p }),
  },
}));

import { normalizeConfig, normalizeSplit } from "../src/settings/agentSettingsPanel";
import { handleMessage } from "../src/settings/agentSettingsPanel";

const defaultConfig = () => ({
  windowTokens: 600000,
  budget: 64000,
  // 默认思考编排关闭 → split 归一化为两段(thinking 份额按 45:35 并入 compacted/tail)
  split: { compacted: 0.5625, thinking: 0, tail: 0.4375 },
  triggerPct: 0.75,
  targetPct: 0.5,
  thinking: { compact: false as const },
});

/** 假面板:记录 postMessage,返回可 resolve 的 Thenable。 */
function fakePanel() {
  const posted: unknown[] = [];
  const panel = {
    webview: {
      html: "",
      onDidReceiveMessage: () => {},
      postMessage: (msg: unknown) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => {},
    extensionUri: { fsPath: "/tmp" } as never,
  };
  return { panel, posted };
}

describe("normalizeSplit", () => {
  it("defaults to 45/20/35 when missing or invalid", () => {
    expect(normalizeSplit(undefined)).toEqual({ compacted: 0.45, thinking: 0.2, tail: 0.35 });
    expect(normalizeSplit({ compacted: 1 })).toEqual({ compacted: 0.45, thinking: 0.2, tail: 0.35 });
    expect(normalizeSplit({ compacted: "x", thinking: 0.2, tail: 0.35 } as never)).toEqual({
      compacted: 0.45,
      thinking: 0.2,
      tail: 0.35,
    });
    expect(normalizeSplit({ compacted: -1, thinking: 0.2, tail: 0.35 })).toEqual({
      compacted: 0.45,
      thinking: 0.2,
      tail: 0.35,
    });
    expect(normalizeSplit({ compacted: 0, thinking: 0, tail: 0 })).toEqual({
      compacted: 0.45,
      thinking: 0.2,
      tail: 0.35,
    });
  });
  it("normalizes non-1 sums", () => {
    expect(normalizeSplit({ compacted: 50, thinking: 20, tail: 30 })).toEqual({
      compacted: 0.5,
      thinking: 0.2,
      tail: 0.3,
    });
  });
});

describe("normalizeConfig", () => {
  it("defaults all five fields when missing", () => {
    expect(normalizeConfig(undefined)).toEqual(defaultConfig());
    expect(normalizeConfig({} as never)).toEqual(defaultConfig());
  });

  it("keeps valid values and floors numbers", () => {
    const out = normalizeConfig({
      windowTokens: 128000,
      budget: 12000.9,
      split: { compacted: 50, thinking: 20, tail: 30 },
      triggerPct: 0.8,
      targetPct: 0.4,
      thinking: { compact: true as const },
    });
    expect(out).toEqual({
      windowTokens: 128000,
      budget: 12000,
      split: { compacted: 0.5, thinking: 0.2, tail: 0.3 },
      triggerPct: 0.8,
      targetPct: 0.4,
      thinking: { compact: true as const },
    });
  });

  it("collapses thinking into two shorts when thinking is off (config-layer normalization)", () => {
    // 关闭思考编排:split 本身归一化为两段(thinking=0,份额按原比例并入 compacted/tail)
    const off = normalizeConfig({
      split: { compacted: 50, thinking: 20, tail: 30 },
      thinking: { compact: false as const },
    });
    expect(off.split).toEqual({ compacted: 0.625, thinking: 0, tail: 0.375 });
    expect(off.thinking).toEqual({ compact: false });
    // 开启思考编排:三段原样保留
    const on = normalizeConfig({
      split: { compacted: 50, thinking: 20, tail: 30 },
      thinking: { compact: true as const },
    });
    expect(on.split).toEqual({ compacted: 0.5, thinking: 0.2, tail: 0.3 });
  });

  it("falls back invalid window/budget and clamps negatives to 0", () => {
    const out = normalizeConfig({
      windowTokens: -5,
      budget: Number.NaN,
      split: undefined,
      triggerPct: 0.75,
      targetPct: 0.5,
    });
    expect(out.windowTokens).toBe(600000);
    expect(out.budget).toBe(64000);
    // 默认思考编排关闭 → 默认三段 45/20/35 归一化为两段 56.25/0/43.75
    expect(out.split).toEqual({ compacted: 0.5625, thinking: 0, tail: 0.4375 });
  });

  it("rejects triggerPct out of (0,1] and targetPct >= trigger", () => {
    expect(normalizeConfig({ triggerPct: 0, targetPct: 0.5 } as never).triggerPct).toBe(0.75);
    expect(normalizeConfig({ triggerPct: 1.5, targetPct: 0.5 } as never).triggerPct).toBe(0.75);
    // target >= trigger → fallback 0.5
    const out = normalizeConfig({ triggerPct: 0.6, targetPct: 0.6 } as never);
    expect(out.triggerPct).toBe(0.6);
    expect(out.targetPct).toBe(0.5);
    expect(normalizeConfig({ triggerPct: 0.6, targetPct: 0 } as never).targetPct).toBe(0.5);
  });

  it("normalizes thinking: keeps valid compact, defaults missing", () => {
    // 显式 compact=false → 保留
    expect(normalizeConfig({ thinking: { compact: false } } as never).thinking).toEqual({ compact: false });
    // 缺省 → false(默认关闭 thinking 链路)
    expect(normalizeConfig({ thinking: {} } as never).thinking).toEqual({ compact: false });
    // 空对象/undefined → 默认关闭
    expect(normalizeConfig({ thinking: null } as never).thinking).toEqual({ compact: false });
    expect(normalizeConfig({ thinking: null } as never).thinking).toEqual({ compact: false });
  });

  it("collapses split to two shorts when thinking compaction is off, keeps three when on", () => {
    // 关闭:三段 {0.45,0.2,0.35} → 两段 {0.5625,0,0.4375}(thinking 份额按 45:35 并入)
    expect(
      normalizeConfig({ split: { compacted: 0.45, thinking: 0.2, tail: 0.35 }, thinking: { compact: false } } as never)
        .split,
    ).toEqual({ compacted: 0.5625, thinking: 0, tail: 0.4375 });
    // 关闭 + 自定义三段:thinking 份额并入后保持原比例缩放
    expect(
      normalizeConfig({ split: { compacted: 60, thinking: 20, tail: 20 }, thinking: { compact: false } } as never)
        .split,
    ).toEqual({ compacted: 0.75, thinking: 0, tail: 0.25 }); // 60/(60+20)=0.75, 20/80=0.25
    // 开启:三段原样保留(仅比例归一化)
    expect(
      normalizeConfig({ split: { compacted: 60, thinking: 20, tail: 20 }, thinking: { compact: true } } as never)
        .split,
    ).toEqual({ compacted: 0.6, thinking: 0.2, tail: 0.2 });
  });
});

describe("agentSettingsPanel handleMessage", () => {
  it("posts state on ready", async () => {
    const { panel, posted } = fakePanel();
    const services = {
      getLocale: () => "zh" as const,
      getBudget: () => defaultConfig(),
      updateBudget: vi.fn(),
    };
    await handleMessage({ type: "ready" }, panel as never, services);
    expect(posted[0]).toMatchObject({ type: "state", config: defaultConfig() });
  });

  it("updates config with normalization and posts state + toast", async () => {
    const { panel, posted } = fakePanel();
    const updateBudget = vi.fn();
    const services = {
      getLocale: () => "en" as const,
      getBudget: () => defaultConfig(),
      updateBudget,
    };
    await handleMessage(
      {
        type: "budget_update",
        config: {
          windowTokens: 256000,
          budget: 12000,
          split: { compacted: 60, thinking: 20, tail: 20 },
          triggerPct: 0.8,
          targetPct: 0.4,
          thinking: { compact: true as const },
        },
      },
      panel as never,
      services,
    );
    expect(updateBudget).toHaveBeenCalledWith({
      windowTokens: 256000,
      budget: 12000,
      split: { compacted: 0.6, thinking: 0.2, tail: 0.2 },
      triggerPct: 0.8,
      targetPct: 0.4,
      thinking: { compact: true as const },
    });
    // 随后 postState(新预算) + toast
    const types = posted.map((m) => (m as { type: string }).type);
    expect(types).toContain("state");
    expect(types).toContain("toast");
  });

  it("rejects invalid budget with default 64000", async () => {
    const { panel } = fakePanel();
    const updateBudget = vi.fn();
    const services = {
      getLocale: () => "zh" as const,
      getBudget: () => defaultConfig(),
      updateBudget,
    };
    await handleMessage(
      { type: "budget_update", config: { ...defaultConfig(), budget: Number.NaN } },
      panel as never,
      services,
    );
    expect(updateBudget).toHaveBeenCalledWith({ ...defaultConfig(), budget: 64000 });
  });

  it("resets to defaults on reset_defaults", async () => {
    const { panel, posted } = fakePanel();
    const updateBudget = vi.fn();
    const services = {
      getLocale: () => "zh" as const,
      getBudget: () => defaultConfig(),
      updateBudget,
    };
    await handleMessage({ type: "reset_defaults" }, panel as never, services);
    expect(updateBudget).toHaveBeenCalledWith(defaultConfig());
    const types = posted.map((m) => (m as { type: string }).type);
    expect(types).toContain("state");
    expect(types).toContain("toast");
  });

  it("surfaces service errors as error toast", async () => {
    const { panel, posted } = fakePanel();
    const services = {
      getLocale: () => "zh" as const,
      getBudget: () => defaultConfig(),
      updateBudget: () => {
        throw new Error("config write failed");
      },
    };
    await handleMessage(
      { type: "budget_update", config: defaultConfig() },
      panel as never,
      services,
    );
    const last = posted[posted.length - 1] as { type: string; error?: boolean; message: string };
    expect(last.type).toBe("toast");
    expect(last.error).toBe(true);
    expect(last.message).toContain("config write failed");
  });
});
