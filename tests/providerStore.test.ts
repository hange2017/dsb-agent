import { describe, it, expect, beforeEach } from "vitest";
import { ProviderStore, apiKeySecretKey, isProviderNameTaken } from "../src/providers/providerStore";
import type { SecretStore, SettingsReader, SettingsWriter } from "../src/providers/providerStore";
import type { ProviderDef } from "../src/providers/types";

function makeDef(id: string, name: string, baseUrl: string): ProviderDef {
  return {
    id,
    name,
    baseUrl,
    defaultCapabilities: { supportsVision: false, supportsThinking: true },
    modes: ["agent", "plan", "ask"],
    createdAt: 1,
  };
}

function makeDeps(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const reader: SettingsReader = {
    getJson: <T,>(key: string) => store.get(key) as T,
  };
  const writer: SettingsWriter = {
    updateSetting: (key, value) => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
  };
  const secrets = new Map<string, string>();
  const secret: SecretStore = {
    get: async (k) => secrets.get(k),
    set: async (k, v) => void secrets.set(k, v),
    delete: async (k) => void secrets.delete(k),
  };
  return { store, reader, writer, secret, secrets };
}

describe("ProviderStore", () => {
  let d: ReturnType<typeof makeDeps>;
  let ps: ProviderStore;

  beforeEach(() => {
    d = makeDeps({
      "dsbAgent.providers": [makeDef("p1", "A", "https://a.example.com")],
      "dsbAgent.activeProviderId": "p1",
    });
    ps = new ProviderStore({ reader: d.reader, writer: d.writer, secret: d.secret });
  });

  it("lists providers from settings", () => {
    expect(ps.list().map((p) => p.id)).toEqual(["p1"]);
  });

  it("sanitizes invisible chars in baseUrl/modelListUrl on read and upsert", () => {
    d.store.set("dsbAgent.providers", [
      makeDef("p1", "A", "https://api.deepseek.com/anthropic\u200b"),
      { ...makeDef("p2", "B", "https://b.example.com"), modelListUrl: "https://b.example.com/v1/models\uFEFF" },
    ]);
    const list = ps.list();
    expect(list[0].baseUrl).toBe("https://api.deepseek.com/anthropic");
    expect(list[1].modelListUrl).toBe("https://b.example.com/v1/models");

    ps.upsert({ ...makeDef("p3", "C", "https://c.example.com\u200B"), modelListUrl: "https://c.example.com/models\u00A0" });
    const saved = d.store.get("dsbAgent.providers") as ProviderDef[];
    const p3 = saved.find((p) => p.id === "p3");
    expect(p3?.baseUrl).toBe("https://c.example.com");
    expect(p3?.modelListUrl).toBe("https://c.example.com/models");
  });

  it("returns active provider, falling back to first", () => {
    expect(ps.getActive()?.id).toBe("p1");
    d.store.delete("dsbAgent.activeProviderId");
    expect(ps.getActive()?.id).toBe("p1");
  });

  it("sets active provider", () => {
    ps.setActive("p2");
    expect(d.store.get("dsbAgent.activeProviderId")).toBe("p2");
  });

  it("getActive sees setActive before delayed writer finishes", async () => {
    d = makeDeps({
      "dsbAgent.providers": [
        makeDef("p1", "A", "https://a.example.com"),
        makeDef("p2", "B", "https://b.example.com"),
      ],
      "dsbAgent.activeProviderId": "p1",
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const writer: SettingsWriter = {
      updateSetting: async (key, value) => {
        await gate;
        if (value === undefined) d.store.delete(key);
        else d.store.set(key, value);
      },
    };
    ps = new ProviderStore({ reader: d.reader, writer, secret: d.secret });
    const pending = ps.setActive("p2");
    expect(ps.getActive()?.id).toBe("p2");
    release();
    await pending;
    expect(d.store.get("dsbAgent.activeProviderId")).toBe("p2");
  });

  it("list/getActive see upsert before delayed writer finishes (VS Code configuration.update 竞态)", async () => {
    d = makeDeps({ "dsbAgent.providers": [] });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const writer: SettingsWriter = {
      updateSetting: async (key, value) => {
        await gate;
        if (value === undefined) d.store.delete(key);
        else d.store.set(key, value);
      },
    };
    ps = new ProviderStore({ reader: d.reader, writer, secret: d.secret });
    ps.upsert(makeDef("p_new", "新建", "https://api.deepseek.com/anthropic"));
    const pending = ps.setActive("p_new");
    // 设置面板/Agent 在 writer 落地前就会读 list/getActive — 必须立刻可见
    expect(ps.list().map((p) => p.id)).toEqual(["p_new"]);
    expect(ps.getActive()?.id).toBe("p_new");
    expect(ps.getActive()?.baseUrl).toBe("https://api.deepseek.com/anthropic");
    release();
    await pending;
    expect(d.store.get("dsbAgent.activeProviderId")).toBe("p_new");
  });

  it("isProviderNameTaken is case-insensitive and can exclude id", () => {
    expect(isProviderNameTaken(ps.list(), "a")).toBe(true);
    expect(isProviderNameTaken(ps.list(), " A ")).toBe(true);
    expect(isProviderNameTaken(ps.list(), "A", "p1")).toBe(false);
    expect(isProviderNameTaken(ps.list(), "missing")).toBe(false);
  });

  it("upserts: adds new and updates existing", () => {
    ps.upsert(makeDef("p2", "B", "https://b.example.com"));
    expect(ps.list().map((p) => p.id)).toEqual(["p1", "p2"]);
    ps.upsert({ ...makeDef("p1", "A2", "https://a2.example.com"), baseUrl: "https://a2.example.com" });
    expect(ps.list().find((p) => p.id === "p1")?.baseUrl).toBe("https://a2.example.com");
    expect(ps.list().length).toBe(2);
  });

  it("protocol defaults to anthropic", () => {
    ps.upsert({ ...makeDef("p2", "B", "https://b.example.com"), protocol: "anthropic" });
    expect(ps.list().find((p) => p.id === "p2")?.protocol).toBe("anthropic");
  });

  it("upsert preserves protocol", () => {
    ps.upsert({ ...makeDef("p2", "B", "https://b.example.com"), protocol: "anthropic" });
    ps.upsert({ ...makeDef("p2", "B2", "https://b2.example.com"), protocol: "anthropic" });
    expect(ps.list().find((p) => p.id === "p2")?.protocol).toBe("anthropic");
  });

  it("undefined protocol is treated as anthropic", () => {
    ps.upsert(makeDef("p2", "B", "https://b.example.com")); // 旧数据无 protocol
    expect(ps.list().find((p) => p.id === "p2")?.protocol).toBeUndefined();
  });

  it("remove deletes provider, clears active, and purges secret key", async () => {
    await ps.setApiKey("p1", "sk-test");
    expect(d.secrets.get(apiKeySecretKey("p1"))).toBe("sk-test");
    ps.remove("p1");
    expect(ps.list()).toEqual([]);
    expect(d.store.get("dsbAgent.activeProviderId")).toBeUndefined();
    expect(d.secrets.has(apiKeySecretKey("p1"))).toBe(false);
  });

  it("stores and reads api keys per provider", async () => {
    await ps.setApiKey("p1", "sk-1");
    await expect(ps.getApiKey("p1")).resolves.toBe("sk-1");
    await expect(ps.getApiKey("p2")).resolves.toBeUndefined();
  });
});
