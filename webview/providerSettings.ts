/**
 * Provider 设置面板页面逻辑(纯 DOM,无框架)。
 * 协议:载入后 postMessage({ type: "ready" });
 * host 下发 { type: "state"; providers; activeProviderId; models } / { type: "toast"; ... };
 * 用户操作发送 create_provider / update_provider / remove_provider / set_active /
 * set_api_key / refresh_models / set_capability / import_ccswitch。
 */

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

import { t } from "../src/i18n/strings";

export interface ProviderCapabilities {
  supportsVision: boolean;
  supportsThinking: boolean;
}

export interface ProviderView {
  id: string;
  name: string;
  baseUrl: string;
  modelListUrl?: string;
  defaultCapabilities: ProviderCapabilities;
  modes: string[];
  source?: string;
  /** 缺省视为 anthropic。 */
  protocol?: "anthropic" | "openai";
}

export interface ModelView {
  id: string;
  capabilities: ProviderCapabilities;
  source: "builtin" | "remote" | "pinned";
}

type HostMessage =
  | {
      type: "state";
      providers: ProviderView[];
      activeProviderId?: string;
      models: ModelView[];
      locale: "zh" | "en";
    }
  | { type: "toast"; message: string; error?: boolean };

type WebviewMessage =
  | { type: "ready" }
  | { type: "create_provider"; name: string; baseUrl: string; modelListUrl?: string; apiKey?: string }
  | {
      type: "update_provider";
      id: string;
      patch: Partial<{
        name: string;
        baseUrl: string;
        modelListUrl?: string;
        defaultCapabilities: ProviderCapabilities;
        modes: string[];
      }>;
    }
  | { type: "remove_provider"; id: string }
  | { type: "set_active"; id: string }
  | { type: "set_api_key"; id: string; apiKey: string }
  | { type: "refresh_models"; providerId?: string }
  | { type: "set_capability"; providerId: string; modelId: string; supportsVision?: boolean; supportsThinking?: boolean }
  | { type: "import_ccswitch" }
  | { type: "test_connection"; providerId: string };

const ALL_MODES = ["agent", "plan", "ask"] as const;

const post = (msg: WebviewMessage): void => vscode.postMessage(msg);

const statusEl = document.getElementById("status") as HTMLElement;
const createForm = document.getElementById("createForm") as HTMLFormElement;
const createName = document.getElementById("createName") as HTMLInputElement;
const createBaseUrl = document.getElementById("createBaseUrl") as HTMLInputElement;
const createModelListUrl = document.getElementById("createModelListUrl") as HTMLInputElement;
const createApiKey = document.getElementById("createApiKey") as HTMLInputElement;
const providerList = document.getElementById("providerList") as HTMLElement;
const modelList = document.getElementById("modelList") as HTMLElement;
const refreshModelsBtn = document.getElementById("refreshModelsBtn") as HTMLButtonElement;
const importCcswitchBtn = document.getElementById("importCcswitch") as HTMLButtonElement;

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** 当前 UI 语言(host state 下发);文案经 t(key, locale) 渲染。 */
let locale: "zh" | "en" = "zh";

/** 重渲染所有 data-i18n 标注元素(静态模板文案,语言切换即时生效)。 */
function applyLocale(): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key, locale);
  }
}

/** 状态提示:数秒后自动清除。 */
function showToast(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastTimer = undefined;
    statusEl.textContent = "";
    statusEl.classList.remove("error");
  }, 5000);
}

/** 创建元素的小助手(text 用 textContent 赋值,避免把用户输入当 HTML 注入)。 */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 复选控件:label 内含 input + 文本;值从用户数据来,一律 textContent 渲染。 */
function checkbox(
  label: string,
  checked: boolean,
  attrs?: Record<string, string>,
  onChange?: (next: boolean) => void,
): HTMLLabelElement {
  const box = el("input");
  box.type = "checkbox";
  box.checked = checked;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) box.dataset[k] = v;
  }
  if (onChange) box.addEventListener("change", () => onChange(box.checked));
  const lab = el("label");
  lab.append(box, document.createTextNode(label));
  return lab;
}

// ---- 供应商卡片 ----

interface EditPanelRefs {
  name: HTMLInputElement;
  baseUrl: HTMLInputElement;
  modelListUrl: HTMLInputElement;
  vision: HTMLInputElement;
  thinking: HTMLInputElement;
  modes: Map<string, HTMLInputElement>;
}

function buildEditPanel(p: ProviderView): { panel: HTMLFormElement; refs: EditPanelRefs } {
  const panel = el("form", "inline-form hidden") as HTMLFormElement;
  panel.hidden = true;

  const name = el("input") as HTMLInputElement;
  name.dataset.field = "name";
  name.placeholder = t("名称", locale);
  name.required = true;
  name.value = p.name;

  const baseUrl = el("input") as HTMLInputElement;
  baseUrl.dataset.field = "baseUrl";
  baseUrl.placeholder = "Base URL";
  baseUrl.required = true;
  baseUrl.value = p.baseUrl;

  const modelListUrl = el("input") as HTMLInputElement;
  modelListUrl.dataset.field = "modelListUrl";
  modelListUrl.className = "full";
  modelListUrl.placeholder = t("自定义模型列表 URL(留空则移除)", locale);
  modelListUrl.value = p.modelListUrl ?? "";

  const vision = checkbox(t("默认 vision", locale), p.defaultCapabilities.supportsVision, { cap: "supportsVision" });
  const thinking = checkbox(t("默认 thinking", locale), p.defaultCapabilities.supportsThinking, { cap: "supportsThinking" });
  const modes = new Map<string, HTMLInputElement>();
  for (const m of ALL_MODES) {
    modes.set(m, checkbox(m, p.modes.includes(m), { mode: m }));
  }

  const checks = el("div", "checks");
  checks.append(vision, thinking, ...modes.values(), el("span", "hint", t("模式集合", locale)));

  const save = el("button", "primary", t("保存", locale)) as HTMLButtonElement;
  save.type = "submit";
  const cancel = el("button", undefined, t("取消", locale)) as HTMLButtonElement;
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    panel.hidden = true;
  });
  const actions = el("div", "actions");
  actions.append(save, cancel);

  panel.append(name, baseUrl, modelListUrl, checks, actions);
  panel.addEventListener("submit", (e) => {
    e.preventDefault();
    const patch = {
      name: name.value.trim() || p.name,
      baseUrl: baseUrl.value.trim() || p.baseUrl,
      modelListUrl: modelListUrl.value.trim() || undefined,
      defaultCapabilities: {
        supportsVision: vision.querySelector("input")?.checked ?? p.defaultCapabilities.supportsVision,
        supportsThinking: thinking.querySelector("input")?.checked ?? p.defaultCapabilities.supportsThinking,
      },
      modes: ALL_MODES.filter((m) => modes.get(m)?.checked ?? false),
    };
    post({ type: "update_provider", id: p.id, patch });
    panel.hidden = true;
  });

  return { panel, refs: { name, baseUrl, modelListUrl, vision: vision.querySelector("input") as HTMLInputElement, thinking: thinking.querySelector("input") as HTMLInputElement, modes } };
}

function buildApiKeyPanel(p: ProviderView): HTMLFormElement {
  const panel = el("form", "inline-form hidden") as HTMLFormElement;
  panel.hidden = true;

  const input = el("input") as HTMLInputElement;
  input.className = "full";
  input.type = "password";
  input.placeholder = t("API Key(存入 secretStorage,不落盘明文)", locale);
  input.required = true;

  const save = el("button", "primary", t("保存", locale)) as HTMLButtonElement;
  save.type = "submit";
  const cancel = el("button", undefined, t("取消", locale)) as HTMLButtonElement;
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    panel.hidden = true;
  });
  const actions = el("div", "actions");
  actions.append(save, cancel);

  panel.append(input, actions);
  panel.addEventListener("submit", (e) => {
    e.preventDefault();
    const key = input.value.trim();
    if (!key) return;
    post({ type: "set_api_key", id: p.id, apiKey: key });
    input.value = "";
    panel.hidden = true;
  });
  return panel;
}

function renderProviderCard(p: ProviderView, active: boolean): HTMLElement {
  const card = el("div", `card${active ? " active" : ""}`);
  card.dataset.providerId = p.id;

  const head = el("div", "card-head");
  head.append(el("span", "card-name", p.name));
  if (active) head.append(el("span", "badge", t("当前", locale)));
  if (p.source) head.append(el("span", "badge src", p.source));
  const protocolLabel =
    p.protocol === "openai" ? t("OpenAI(聊天不可用)", locale) : t("Anthropic 兼容", locale);
  head.append(el("span", "badge protocol", protocolLabel));
  head.append(el("div", "card-url", p.baseUrl));
  card.append(head);

  const actions = el("div", "card-actions");
  const setActiveBtn = el("button", active ? undefined : "primary", t("设为当前", locale)) as HTMLButtonElement;
  setActiveBtn.disabled = active;
  setActiveBtn.addEventListener("click", () => post({ type: "set_active", id: p.id }));

  const { panel: editPanel, refs } = buildEditPanel(p);
  const editBtn = el("button", undefined, t("编辑", locale)) as HTMLButtonElement;
  editBtn.addEventListener("click", () => {
    // 每次展开都用当前值重填(期间 host 状态可能已变)
    refs.name.value = p.name;
    refs.baseUrl.value = p.baseUrl;
    refs.modelListUrl.value = p.modelListUrl ?? "";
    refs.vision.checked = p.defaultCapabilities.supportsVision;
    refs.thinking.checked = p.defaultCapabilities.supportsThinking;
    for (const m of ALL_MODES) {
      const box = refs.modes.get(m);
      if (box) box.checked = p.modes.includes(m);
    }
    editPanel.hidden = !editPanel.hidden;
  });

  const deleteBtn = el("button", "danger", t("删除", locale)) as HTMLButtonElement;
  deleteBtn.addEventListener("click", () => {
    // 两步确认:再次点击才真正删除(webview 中 confirm() 不可用)
    if (deleteBtn.dataset.confirm !== "1") {
      deleteBtn.dataset.confirm = "1";
      deleteBtn.textContent = t("确认删除?", locale);
      window.setTimeout(() => {
        deleteBtn.dataset.confirm = "";
        deleteBtn.textContent = t("删除", locale);
      }, 3000);
      return;
    }
    post({ type: "remove_provider", id: p.id });
  });

  const apiKeyBtn = el("button", undefined, t("配置 API Key", locale)) as HTMLButtonElement;
  const apiKeyPanel = buildApiKeyPanel(p);
  apiKeyBtn.addEventListener("click", () => {
    apiKeyPanel.hidden = !apiKeyPanel.hidden;
  });

  const refreshBtn = el("button", undefined, t("刷新模型", locale)) as HTMLButtonElement;
  refreshBtn.addEventListener("click", () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = t("刷新中…", locale);
    post({ type: "refresh_models", providerId: p.id });
    window.setTimeout(() => {
      refreshBtn.disabled = false;
      refreshBtn.textContent = t("刷新模型", locale);
    }, 3000);
  });

  const testBtn = el("button", undefined, t("测试连接", locale)) as HTMLButtonElement;
  testBtn.addEventListener("click", () => {
    testBtn.disabled = true;
    testBtn.textContent = t("测试中…", locale);
    post({ type: "test_connection", providerId: p.id });
    window.setTimeout(() => {
      testBtn.disabled = false;
      testBtn.textContent = t("测试连接", locale);
    }, 3000);
  });

  actions.append(setActiveBtn, editBtn, deleteBtn, apiKeyBtn, refreshBtn, testBtn);
  card.append(actions, editPanel, apiKeyPanel);
  return card;
}

function renderProviders(providers: ProviderView[], activeProviderId?: string): void {
  providerList.replaceChildren();
  if (!providers.length) {
    providerList.append(el("div", "empty", t("暂无供应商,请在上方新建。", locale)));
    return;
  }
  for (const p of providers) {
    providerList.append(renderProviderCard(p, p.id === activeProviderId));
  }
}

// ---- 模型列表 ----

function renderModels(models: ModelView[], activeProviderId?: string): void {
  modelList.replaceChildren();
  if (!activeProviderId) {
    modelList.append(el("div", "empty", t("请先创建并选择供应商。", locale)));
    return;
  }
  if (!models.length) {
    modelList.append(el("div", "empty", t("暂无模型(远程拉取失败时回退内置预设)。点击「刷新模型」重试。", locale)));
    return;
  }
  for (const m of models) {
    const row = el("div", "model-row");
    row.append(el("span", "model-id", m.id));
    row.append(el("span", "model-src", m.source));
    const caps = el("div", "model-cap");
    caps.append(
      checkbox("vision", m.capabilities.supportsVision, undefined, (next) => {
        post({ type: "set_capability", providerId: activeProviderId, modelId: m.id, supportsVision: next });
      }),
      checkbox("thinking", m.capabilities.supportsThinking, undefined, (next) => {
        post({ type: "set_capability", providerId: activeProviderId, modelId: m.id, supportsThinking: next });
      }),
    );
    row.append(caps);
    modelList.append(row);
  }
}

// ---- 事件绑定 ----

createForm.addEventListener("submit", (e) => {
  e.preventDefault();
  post({
    type: "create_provider",
    name: createName.value.trim(),
    baseUrl: createBaseUrl.value.trim(),
    modelListUrl: createModelListUrl.value.trim() || undefined,
    apiKey: createApiKey.value.trim() || undefined,
  });
  createName.value = "";
  createBaseUrl.value = "";
  createModelListUrl.value = "";
  createApiKey.value = "";
});

refreshModelsBtn.addEventListener("click", () => {
  post({ type: "refresh_models" });
});

importCcswitchBtn.addEventListener("click", () => {
  importCcswitchBtn.disabled = true;
  importCcswitchBtn.textContent = "导入中…";
  post({ type: "import_ccswitch" });
  // host 状态回流时由 renderState 恢复按钮;此处超时兜底
  window.setTimeout(() => {
    importCcswitchBtn.disabled = false;
    importCcswitchBtn.textContent = "从 cc-switch 导入";
  }, 6000);
});

// ---- host 消息 ----

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  if (msg.type === "state") {
    locale = msg.locale;
    renderProviders(msg.providers, msg.activeProviderId);
    renderModels(msg.models, msg.activeProviderId);
    importCcswitchBtn.disabled = false;
    importCcswitchBtn.textContent = t("从 cc-switch 导入", locale);
    applyLocale();
  } else if (msg.type === "toast") {
    showToast(msg.message, Boolean(msg.error));
  }
});

post({ type: "ready" });
