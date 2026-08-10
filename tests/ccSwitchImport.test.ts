import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { importFromCcSwitch, parseCcSwitchEnv } from "../src/providers/ccSwitchImport";
import type { SecretStore, SettingsWriter } from "../src/providers/providerStore";

function makeDeps(overrides: { homeDir?: string; readDbRows?: Parameters<typeof importFromCcSwitch>[0]["readDbRows"] } = {}) {
  const secrets = new Map<string, string>();
  const secret: SecretStore = {
    get: async (k) => secrets.get(k),
    set: async (k, v) => void secrets.set(k, v),
    delete: async (k) => void secrets.delete(k),
  };
  const written: unknown[] = [];
  const writer: SettingsWriter = {
    updateSetting: (key, value) => {
      if (key === "dsbAgent.providers") written.push(value);
    },
  };
  return { secret, writer, written, secrets, homeDir: overrides.homeDir, readDbRows: overrides.readDbRows };
}

const ROW = (name: string, env: Record<string, string>) => ({
  name,
  settings_config: JSON.stringify({ env }),
});

describe("parseCcSwitchEnv", () => {
  it("extracts env fields", () => {
    expect(
      parseCcSwitchEnv({
        env: {
          ANTHROPIC_BASE_URL: "https://x.example.com",
          ANTHROPIC_AUTH_TOKEN: "sk-abc",
          ANTHROPIC_MODEL: "deepseek-v4-pro",
        },
      }),
    ).toEqual({ baseUrl: "https://x.example.com", apiKey: "sk-abc", model: "deepseek-v4-pro" });
  });

  it("handles malformed input", () => {
    expect(parseCcSwitchEnv(null)).toEqual({});
    expect(parseCcSwitchEnv({})).toEqual({});
    expect(parseCcSwitchEnv({ env: { ANTHROPIC_BASE_URL: "" } })).toEqual({});
  });
});

describe("importFromCcSwitch - main path (injected db rows)", () => {
  it("imports claude providers with api keys into secret store", async () => {
    const d = makeDeps({
      readDbRows: () => [
        ROW("DemoProvider", { ANTHROPIC_BASE_URL: "https://ds.example.com", ANTHROPIC_AUTH_TOKEN: "sk-1", ANTHROPIC_MODEL: "deepseek-v4-pro" }),
        ROW("中转站", { ANTHROPIC_BASE_URL: "https://relay.example.com", ANTHROPIC_AUTH_TOKEN: "sk-2" }),
      ],
    });
    const r = await importFromCcSwitch(d);
    expect(r.imported.length).toBe(2);
    expect(r.imported[0].name).toBe("DemoProvider");
    expect(r.imported[0].baseUrl).toBe("https://ds.example.com");
    expect(r.imported[0].pinnedModels).toEqual(["deepseek-v4-pro"]);
    expect(r.imported[0].source).toBe("ccswitch");
    expect(r.imported[0].protocol).toBe("anthropic");
    expect(r.imported[1].protocol).toBe("anthropic");
    expect(d.secrets.get(`dsbAgent.apiKey.${r.imported[0].id}`)).toBe("sk-1");
    expect(d.secrets.get(`dsbAgent.apiKey.${r.imported[1].id}`)).toBe("sk-2");
    expect(d.written).toHaveLength(1);
    const merged = d.written[0] as Array<{ id: string }>;
    expect(merged).toHaveLength(2);
  });

  it("dedupes names with suffixes and skips rows without base url", async () => {
    const d = makeDeps({
      readDbRows: () => [
        ROW("Relay", { ANTHROPIC_BASE_URL: "https://r1.example.com", ANTHROPIC_AUTH_TOKEN: "k" }),
        ROW("Relay", { ANTHROPIC_BASE_URL: "https://r2.example.com", ANTHROPIC_AUTH_TOKEN: "k2" }),
        ROW("Broken", { ANTHROPIC_AUTH_TOKEN: "k3" }),
      ],
    });
    const r = await importFromCcSwitch(d);
    expect(r.imported.map((p) => p.name)).toEqual(["Relay", "Relay (2)"]);
  });

  it("merges with existing providers", async () => {
    const existing = [
      {
        id: "legacy",
        name: "Legacy",
        baseUrl: "https://old.example.com",
        defaultCapabilities: { supportsVision: false, supportsThinking: true },
        modes: ["agent", "plan", "ask"] as Array<"agent" | "plan" | "ask">,
        createdAt: 1,
      },
    ];
    const d = makeDeps({ readDbRows: () => [ROW("New", { ANTHROPIC_BASE_URL: "https://n.example.com", ANTHROPIC_AUTH_TOKEN: "k" })] });
    const r = await importFromCcSwitch({ ...d, existing });
    const merged = d.written[0] as Array<{ id: string }>;
    expect(merged.map((p) => p.id)).toEqual(["legacy", r.imported[0].id]);
  });

  it("renames imported providers that collide with existing names", async () => {
    const existing = [
      {
        id: "p1",
        name: "deepseek",
        baseUrl: "https://api.deepseek.com/anthropic",
        defaultCapabilities: { supportsVision: false, supportsThinking: true },
        modes: ["agent", "plan", "ask"] as Array<"agent" | "plan" | "ask">,
        createdAt: 1,
      },
    ];
    const d = makeDeps({
      readDbRows: () => [
        ROW("deepseek", { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "k" }),
      ],
    });
    const r = await importFromCcSwitch({ ...d, existing });
    expect(r.imported.map((p) => p.name)).toEqual(["deepseek (2)"]);
  });

  it("falls back to ~/.claude/settings.json when db read throws", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccswitch-fb-"));
    const claudeDir = path.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://fb.example.com", ANTHROPIC_AUTH_TOKEN: "sk-fb", ANTHROPIC_MODEL: "deepseek-v4-flash" } }),
    );
    const d = makeDeps({ homeDir: home, readDbRows: () => { throw new Error("better-sqlite3 not available"); } });
    const r = await importFromCcSwitch(d);
    expect(r.imported).toHaveLength(1);
    expect(r.imported[0].name).toBe("CC-Switch 当前供应商");
    expect(r.imported[0].baseUrl).toBe("https://fb.example.com");
    expect(d.secrets.get(`dsbAgent.apiKey.${r.imported[0].id}`)).toBe("sk-fb");
  });

  it("returns empty when nothing found", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccswitch-empty-"));
    const d = makeDeps({ homeDir: home, readDbRows: () => [] });
    const r = await importFromCcSwitch(d);
    expect(r.imported).toEqual([]);
    expect(d.written).toHaveLength(0);
  });
});
