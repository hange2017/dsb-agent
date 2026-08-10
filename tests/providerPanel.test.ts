import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => ({
  Uri: {
    joinPath: (...parts: unknown[]) => ({
      fsPath: parts.map(String).join("/"),
      toString: () => parts.map(String).join("/"),
    }),
    file: (p: string) => ({ fsPath: p, toString: () => p }),
  },
}));

import { createProviderPanel, type ProviderPanelServices, type VscodeWebviewPanelLike } from "../src/settings/providerPanel";

function makeServices(overrides: Partial<ProviderPanelServices> = {}): ProviderPanelServices {
  const base: ProviderPanelServices = {
    listProviders: () => [
      {
        id: "p1",
        name: "默认兼容端点",
        baseUrl: "https://api.deepseek.com/anthropic",
        defaultCapabilities: { supportsVision: false, supportsThinking: true },
        modes: ["agent", "plan", "ask"],
        protocol: "anthropic",
      },
    ],
    getActiveProviderId: () => "p1",
    getLocale: () => "zh",
    createProvider: vi.fn(async () => ({ id: "p2" })),
    updateProvider: vi.fn(async () => {}),
    removeProvider: vi.fn(async () => {}),
    setActiveProvider: vi.fn(async () => {}),
    setApiKey: vi.fn(async () => {}),
    resolveModels: () => [
      { id: "deepseek-v4-flash", capabilities: { supportsVision: true, supportsThinking: true }, source: "builtin" },
    ],
    refreshModels: vi.fn(async () => {}),
    setCapabilityOverride: vi.fn(async () => {}),
    importFromCcSwitch: vi.fn(async () => ({ imported: 2 })),
    testConnection: vi.fn(async () => ({ ok: true, message: "连接成功" })),
    promptApiKey: vi.fn(async () => {}),
    promptEditProvider: vi.fn(async () => {}),
  };
  return { ...base, ...overrides };
}

interface FakePanel {
  panel: VscodeWebviewPanelLike;
  posted: Array<{ type: string } & Record<string, unknown>>;
  handlers: Array<(msg: unknown) => void>;
}

function makePanel(): FakePanel {
  const posted: FakePanel["posted"] = [];
  const handlers: Array<(msg: unknown) => void> = [];
  const panel = {
    webview: {
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: (uri: { toString(): string }) => ({ toString: () => `uri:${uri.toString()}` }),
      onDidReceiveMessage: (cb: (msg: unknown) => void) => {
        handlers.push(cb);
      },
      postMessage: (msg: unknown) => {
        posted.push(msg as FakePanel["posted"][number]);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => {},
    extensionUri: { fsPath: "/ext", toString: () => "/ext" },
  } as unknown as VscodeWebviewPanelLike;
  return { panel, posted, handlers };
}

function dispatch(panel: FakePanel, msg: unknown): Promise<void> {
  return Promise.all(panel.handlers.map((h) => h(msg))).then(() => {});
}

describe("providerPanel", () => {
  let fake: FakePanel;

  beforeEach(() => {
    fake = makePanel();
  });

  it("renders html template onto the webview", () => {
    const services = makeServices();
    createProviderPanel(fake.panel, services);
    expect(fake.panel.webview.html).toContain("Provider 设置");
    expect(fake.panel.webview.html).toContain("providerSettings.js");
  });

  it("ready 时回发 state(供应商 + 当前 + 模型)", async () => {
    const services = makeServices();
    createProviderPanel(fake.panel, services);
    await dispatch(fake, { type: "ready" });
    const state = fake.posted.find((m) => m.type === "state");
    expect(state).toBeDefined();
    expect(state?.providers).toHaveLength(1);
    expect((state?.providers as Array<{ protocol?: string }>)[0]?.protocol).toBe("anthropic");
    expect(state?.activeProviderId).toBe("p1");
    expect((state?.models as Array<{ id: string }>)[0]?.id).toBe("deepseek-v4-flash");
  });

  it("ready 时透传 openai 协议供面板标注", async () => {
    const services = makeServices({
      listProviders: () => [
        {
          id: "p-oai",
          name: "OpenAI relay",
          baseUrl: "https://api.openai.com",
          defaultCapabilities: { supportsVision: false, supportsThinking: false },
          modes: ["agent"],
          protocol: "openai",
        },
      ],
      getActiveProviderId: () => "p-oai",
    });
    createProviderPanel(fake.panel, services);
    await dispatch(fake, { type: "ready" });
    const state = fake.posted.find((m) => m.type === "state");
    expect((state?.providers as Array<{ protocol?: string }>)[0]?.protocol).toBe("openai");
  });

  it("create_provider 调 createProvider 并设为当前、回发新 state", async () => {
    const services = makeServices();
    const createProvider = vi.fn(async () => ({ id: "p2" }));
    const setActive = vi.fn(async () => {});
    createProviderPanel(fake.panel, { ...services, createProvider, setActiveProvider: setActive });
    await dispatch(fake, { type: "create_provider", name: "P2", baseUrl: "https://x", apiKey: "sk-2" });
    expect(createProvider).toHaveBeenCalledWith({ name: "P2", baseUrl: "https://x", apiKey: "sk-2" });
    expect(setActive).toHaveBeenCalledWith("p2");
  });

  it("set_capability 只发送已定义的字段", async () => {
    const services = makeServices();
    const setCap = vi.fn(async () => {});
    createProviderPanel(fake.panel, { ...services, setCapabilityOverride: setCap });
    await dispatch(fake, { type: "set_capability", providerId: "p1", modelId: "m1", supportsVision: false });
    expect(setCap).toHaveBeenCalledWith("p1", "m1", { supportsVision: false });
    await dispatch(fake, { type: "set_capability", providerId: "p1", modelId: "m1", supportsThinking: true });
    expect(setCap).toHaveBeenCalledWith("p1", "m1", { supportsThinking: true });
  });

  it("refresh_models 缺省 providerId 时回退当前供应商", async () => {
    const services = makeServices();
    const refresh = vi.fn(async () => {});
    createProviderPanel(fake.panel, { ...services, refreshModels: refresh });
    await dispatch(fake, { type: "refresh_models" });
    expect(refresh).toHaveBeenCalledWith("p1");
  });

  it("import_ccswitch 导入后回发 state 与 toast", async () => {
    const services = makeServices();
    createProviderPanel(fake.panel, services);
    await dispatch(fake, { type: "import_ccswitch" });
    expect(fake.posted.some((m) => m.type === "state")).toBe(true);
    const toastMsg = fake.posted.find((m) => m.type === "toast");
    expect(toastMsg?.message).toContain("2");
  });

  it("服务抛错时回发 error toast", async () => {
    const services = makeServices({
      removeProvider: vi.fn(async () => {
        throw new Error("删除失败");
      }),
    });
    createProviderPanel(fake.panel, services);
    await dispatch(fake, { type: "remove_provider", id: "p1" });
    const toastMsg = fake.posted.find((m) => m.type === "toast");
    expect(toastMsg?.message).toBe("删除失败");
    expect(toastMsg?.error).toBe(true);
  });

  it("test_connection 成功回发连接成功 toast", async () => {
    const services = makeServices();
    const testConnection = vi.fn(async () => ({ ok: true, message: "连接成功" }));
    createProviderPanel(fake.panel, { ...services, testConnection });
    await dispatch(fake, { type: "test_connection", providerId: "p1" });
    expect(testConnection).toHaveBeenCalledWith("p1");
    const toastMsg = fake.posted.find((m) => m.type === "toast");
    expect(toastMsg?.message).toContain("连接成功");
    expect(toastMsg?.error).toBeFalsy();
  });

  it("test_connection 失败回发 error toast 并调 onError", async () => {
    const services = makeServices({
      testConnection: vi.fn(async () => ({ ok: false, message: "Invalid API key" })),
    });
    const onError = vi.fn();
    createProviderPanel(fake.panel, services, { onError });
    await dispatch(fake, { type: "test_connection", providerId: "p1" });
    const toastMsg = fake.posted.find((m) => m.type === "toast");
    expect(toastMsg?.error).toBe(true);
    expect(String(toastMsg?.message)).toContain("Invalid API key");
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("Invalid API key"));
  });

  it("prompt_api_key 调 services.promptApiKey 并回发 state", async () => {
    const promptApiKey = vi.fn(async () => {});
    const services = makeServices({ promptApiKey });
    createProviderPanel(fake.panel, services);
    await dispatch(fake, { type: "prompt_api_key", id: "p1" });
    expect(promptApiKey).toHaveBeenCalledWith("p1");
    expect(fake.posted.some((m) => m.type === "state")).toBe(true);
  });

  it("prompt_edit_provider 调 services.promptEditProvider 并回发 state", async () => {
    const promptEditProvider = vi.fn(async () => {});
    const services = makeServices({ promptEditProvider });
    createProviderPanel(fake.panel, services);
    await dispatch(fake, { type: "prompt_edit_provider", id: "p1" });
    expect(promptEditProvider).toHaveBeenCalledWith("p1");
    expect(fake.posted.some((m) => m.type === "state")).toBe(true);
  });
});
