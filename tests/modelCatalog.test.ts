import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ModelCatalog,
  resolveCapabilities,
  kBuiltinCapabilities,
  modelListUrlCandidates,
} from "../src/providers/modelCatalog";
import { matchProfile } from "../src/providers/profiles";
import type { CatalogProvider } from "../src/providers/modelCatalog";

function makeProvider(overrides: Partial<CatalogProvider> = {}): CatalogProvider {
  return {
    id: "p1",
    baseUrl: "https://api.example.com",
    defaultCapabilities: { supportsVision: false, supportsThinking: true },
    modes: ["agent", "plan", "ask"],
    ...overrides,
  };
}

type FetchMock = ReturnType<typeof vi.fn>;
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
/** 每次调用返回新的 Response,避免 body 已读问题。 */
function mockJson(fetchMock: FetchMock, status: number, body: unknown): void {
  fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(status, body)));
}

describe("ModelCatalog.fetchModels", () => {
  let fetchMock: FetchMock;
  let catalog: ModelCatalog;

  beforeEach(() => {
    fetchMock = vi.fn();
    catalog = new ModelCatalog({ fetchImpl: fetchMock as unknown as typeof fetch });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tries /v1/models first, then /models on 404", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "m1" }, { id: "m2" }] }));
    const models = await catalog.fetchModels(makeProvider());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("/v1/models");
    expect(fetchMock.mock.calls[1][0]).toContain("/models");
    expect(models.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(models[0].source).toBe("remote");
  });

  it("for /anthropic baseUrl also probes API root /models", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "deepseek-v4-flash" }] })); // root /models first
    const models = await catalog.fetchModels(
      makeProvider({ baseUrl: "https://api.deepseek.com/anthropic" }),
    );
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "https://api.deepseek.com/models",
    ]);
    expect(models.map((m) => m.id)).toEqual(["deepseek-v4-flash"]);
  });

  it("modelListUrlCandidates strips /anthropic for root probes", () => {
    expect(modelListUrlCandidates("https://api.deepseek.com/anthropic")).toEqual([
      "https://api.deepseek.com/models",
      "https://api.deepseek.com/v1/models",
      "https://api.deepseek.com/anthropic/v1/models",
      "https://api.deepseek.com/anthropic/models",
    ]);
    expect(modelListUrlCandidates("https://api.example.com", "https://custom/list")).toEqual([
      "https://custom/list",
    ]);
  });

  it("modelListUrlCandidates strips zero-width / BOM junk in baseUrl", () => {
    // 粘贴 Base URL 时偶发 U+200B,会导致 /anthropic 后缀匹配失败、只打到错误路径
    const dirty = "https://api.deepseek.com/anthropic\u200b";
    const urls = modelListUrlCandidates(dirty);
    expect(urls.every((u) => !u.includes("\u200b"))).toBe(true);
    expect(urls[0]).toBe("https://api.deepseek.com/models");
    expect(urls).toContain("https://api.deepseek.com/anthropic/v1/models");
  });

  it("stops on 401 with auth error (does not keep probing as if 404)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "no" }));
    await expect(
      catalog.fetchModels(makeProvider({ baseUrl: "https://api.deepseek.com/anthropic" }), { apiKey: "sk-bad" }),
    ).rejects.toThrow(/API Key|401|认证|鉴权|Authentication/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("all-fail error lists every attempted URL", async () => {
    mockJson(fetchMock, 404, {});
    await expect(
      catalog.fetchModels(makeProvider({ baseUrl: "https://api.deepseek.com/anthropic" })),
    ).rejects.toThrow(/https:\/\/api\.deepseek\.com\/models/);
  });

  it("uses modelListUrl when provided", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "x" }] }));
    await catalog.fetchModels(makeProvider({ modelListUrl: "https://custom.example.com/list" }));
    expect(fetchMock.mock.calls[0][0]).toBe("https://custom.example.com/list");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends x-api-key and Authorization when apiKey is provided", async () => {
    mockJson(fetchMock, 200, { data: [{ id: "m1" }] });
    await catalog.fetchModels(makeProvider(), { apiKey: "sk-secret" });
    const init = fetchMock.mock.calls[0][1] as { headers?: Record<string, string> };
    expect(init.headers?.["x-api-key"]).toBe("sk-secret");
    expect(init.headers?.Authorization).toBe("Bearer sk-secret");
    expect(init.headers?.accept).toBe("application/json");
  });

  it("omits auth headers when apiKey is absent", async () => {
    mockJson(fetchMock, 200, { data: [{ id: "m1" }] });
    await catalog.fetchModels(makeProvider());
    const init = fetchMock.mock.calls[0][1] as { headers?: Record<string, string> };
    expect(init.headers?.["x-api-key"]).toBeUndefined();
    expect(init.headers?.Authorization).toBeUndefined();
  });

  it("throws when all attempts fail", async () => {
    mockJson(fetchMock, 500, {});
    await expect(catalog.fetchModels(makeProvider())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches for 10 minutes and returns copies", async () => {
    mockJson(fetchMock, 200, { data: [{ id: "m1" }] });
    await catalog.fetchModels(makeProvider());
    await catalog.fetchModels(makeProvider());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolveModels falls back to pinned when remote cache absent", () => {
    const models = catalog.resolveModels(
      makeProvider({ pinnedModels: ["deepseek-v4-flash", "custom-x"] }),
    );
    const ids = models.map((m) => m.id);
    expect(ids).toContain("deepseek-v4-flash");
    expect(ids).toContain("custom-x");
    const flash = models.find((m) => m.id === "deepseek-v4-flash");
    expect(flash?.capabilities).toMatchObject({ supportsVision: true, supportsThinking: true });
    const custom = models.find((m) => m.id === "custom-x");
    expect(custom?.capabilities).toMatchObject({ supportsVision: false, supportsThinking: true });
  });

  it("resolveModels falls back to vendor-scoped builtins when no cache", () => {
    const deepseek = catalog.resolveModels(
      makeProvider({ baseUrl: "https://api.deepseek.com/anthropic" }),
    );
    const ids = deepseek.map((m) => m.id);
    expect(ids.every((id) => id.startsWith("deepseek-"))).toBe(true);
    expect(ids).toContain("deepseek-v4-flash");
    expect(ids).not.toContain("claude-sonnet-4-5");
    expect(deepseek.every((m) => m.source === "builtin")).toBe(true);

    const claude = catalog.resolveModels(makeProvider({ baseUrl: "https://api.anthropic.com" }));
    expect(claude.map((m) => m.id).every((id) => id.startsWith("claude-"))).toBe(true);
    expect(claude.map((m) => m.id)).toContain("claude-sonnet-4-5");
  });

  it("force fetch keeps previous cache when all attempts fail", async () => {
    mockJson(fetchMock, 200, { data: [{ id: "m1" }] });
    await catalog.fetchModels(makeProvider());
    fetchMock.mockReset();
    mockJson(fetchMock, 500, {});
    await expect(catalog.fetchModels(makeProvider(), { force: true })).rejects.toThrow();
    expect(catalog.resolveModels(makeProvider()).map((m) => m.id)).toEqual(["m1"]);
  });

  it("hasFreshCache: false before fetch, true after success, false after expiry", async () => {
    expect(catalog.hasFreshCache("p1")).toBe(false); // 未拉取
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    mockJson(fetchMock, 200, { data: [{ id: "m1" }] });
    await catalog.fetchModels(makeProvider());
    expect(catalog.hasFreshCache("p1")).toBe(true); // 拉取成功后
    vi.setSystemTime(1_000_000 + 10 * 60 * 1000 + 1); // 超过 10 分钟
    expect(catalog.hasFreshCache("p1")).toBe(false); // 过期后
  });

  it("resolveModels merges remote cache with pinned, dedupes by id", async () => {
    mockJson(fetchMock, 200, { data: [{ id: "m1" }, { id: "m2" }] });
    await catalog.fetchModels(makeProvider());
    const models = catalog.resolveModels(makeProvider({ pinnedModels: ["m1", "m3"] }));
    const ids = models.map((m) => m.id);
    expect(ids).toEqual(["m1", "m2", "m3"]);
  });

  it("clearCache forces refetch", async () => {
    mockJson(fetchMock, 200, { data: [{ id: "m1" }] });
    await catalog.fetchModels(makeProvider());
    catalog.clearCache("p1");
    await catalog.fetchModels(makeProvider());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetchModels applies prefix profile to unknown remote ids", async () => {
    mockJson(fetchMock, 200, { data: [{ id: "claude-sonnet-4-6" }] });
    const models = await catalog.fetchModels(makeProvider());
    expect(models[0].capabilities).toMatchObject({ supportsVision: true, supportsThinking: true });
  });

  it("maps remote vision flags onto unknown model capabilities", async () => {
    mockJson(fetchMock, 200, {
      data: [{ id: "vendor-unknown-vision", supports_vision: true, supports_thinking: true }],
    });
    const models = await catalog.fetchModels(makeProvider());
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("vendor-unknown-vision");
    expect(models[0].capabilities.supportsVision).toBe(true);
    expect(models[0].capabilities.supportsThinking).toBe(true);
  });

  it("preserves remote vision via resolveModels after fetch", async () => {
    mockJson(fetchMock, 200, {
      data: [{ id: "vendor-unknown-vision", capabilities: { vision: true } }],
    });
    await catalog.fetchModels(makeProvider());
    const models = catalog.resolveModels(makeProvider());
    const m = models.find((x) => x.id === "vendor-unknown-vision");
    expect(m?.capabilities.supportsVision).toBe(true);
  });

  it("fail-open: bad capability fields on one item do not break fetch", async () => {
    mockJson(fetchMock, 200, {
      data: [
        { id: "ok-model", supports_vision: true },
        { id: "weird-model", supports_vision: "maybe", capabilities: "nope" },
      ],
    });
    const models = await catalog.fetchModels(makeProvider());
    expect(models.map((m) => m.id)).toEqual(["ok-model", "weird-model"]);
    expect(models[0].capabilities.supportsVision).toBe(true);
    // unknown id + non-boolean remote → provider default
    expect(models[1].capabilities).toMatchObject({ supportsVision: false, supportsThinking: true });
  });
});

describe("resolveCapabilities priority", () => {
  const provider = {
    defaultCapabilities: { supportsVision: false, supportsThinking: true },
    capabilityOverrides: { "m-override": { supportsVision: true } },
  };

  it("override wins over builtin and default", () => {
    expect(resolveCapabilities(provider, "m-override")).toMatchObject({ supportsVision: true, supportsThinking: true });
  });

  it("builtin wins over default", () => {
    expect(resolveCapabilities(provider, "deepseek-v4-flash")).toMatchObject({ supportsVision: true, supportsThinking: true });
    expect(resolveCapabilities(provider, "deepseek-chat")).toMatchObject({ supportsVision: false, supportsThinking: false });
  });

  it("default applies when nothing matches", () => {
    expect(resolveCapabilities(provider, "unknown-model")).toMatchObject({ supportsVision: false, supportsThinking: true });
  });

  it("remote beats profile/builtin but loses to override", () => {
    expect(
      resolveCapabilities(provider, "unknown-model", undefined, { remote: { supportsVision: true } }),
    ).toMatchObject({ supportsVision: true, supportsThinking: true });
    expect(
      resolveCapabilities(provider, "m-override", undefined, { remote: { supportsVision: false } }),
    ).toMatchObject({ supportsVision: true, supportsThinking: true });
  });

  it("explicit profile beats builtin table entry for same id when provided", () => {
    expect(
      resolveCapabilities(provider, "deepseek-chat", undefined, {
        profile: { supportsVision: true, supportsThinking: true },
      }),
    ).toMatchObject({ supportsVision: true, supportsThinking: true });
  });

  it("matchProfile prefix applies when passed as profile opts", () => {
    expect(
      resolveCapabilities(provider, "claude-sonnet-4-6", undefined, {
        profile: matchProfile("claude-sonnet-4-6"),
      }),
    ).toMatchObject({ supportsVision: true, supportsThinking: true });
  });

  it("remote and profile can be passed together; remote wins field-wise", () => {
    expect(
      resolveCapabilities(provider, "claude-unknown", undefined, {
        remote: { supportsVision: false },
        profile: matchProfile("claude-unknown"),
      }),
    ).toMatchObject({ supportsVision: false, supportsThinking: true });
  });
});
