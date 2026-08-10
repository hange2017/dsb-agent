/**
 * Provider 设置面板页面逻辑(纯 DOM,无框架)。
 * 协议:载入后 postMessage({ type: "ready" });
 * host 下发 { type: "state"; providers; activeProviderId; models } / { type: "toast"; ... };
 * 用户操作发送 create_provider / update_provider / remove_provider / set_active /
 * set_api_key / prompt_api_key / prompt_edit_provider / refresh_models /
 * set_capability / import_ccswitch / test_connection。
 */

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

import { t } from "../src/i18n/strings";
import { DEFAULT_COMPAT_BASE_URL } from "../src/settings/providerChoices";

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
  | { type: "test_connection"; providerId: string }
  | { type: "prompt_api_key"; id: string }
  | { type: "prompt_edit_provider"; id: string };

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
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-placeholder]")) {
    const key = el.dataset.i18nPlaceholder;
    if (key) el.setAttribute("placeholder", t(key, locale));
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-aria-label]")) {
    const key = el.dataset.i18nAriaLabel;
    if (key) el.setAttribute("aria-label", t(key, locale));
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

// ---- 点击位置弹窗(popover)----
// 「配置 API Key」「编辑」在按钮点击位置弹出小窗直接输入保存,避免跳转/打断整体性。

let activePopover: HTMLElement | undefined;
let popoverCleanup: (() => void) | undefined;

function closePopover(): void {
  if (activePopover) activePopover.remove();
  activePopover = undefined;
  popoverCleanup?.();
  popoverCleanup = undefined;
}

function openPopover(anchor: HTMLElement, build: (container: HTMLElement) => void): void {
  closePopover();
  const pop = el("div", "popover");
  build(pop);
  document.body.append(pop);

  // 以按钮(anchor)为参考定位,贴近点击位置;视口边缘自动翻转/收拢
  const rect = anchor.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  const gap = 6;
  let top = rect.bottom + gap;
  if (top + popRect.height > window.innerHeight - 8 && rect.top - gap - popRect.height > 0) {
    top = rect.top - gap - popRect.height;
  }
  let left = rect.left;
  if (left + popRect.width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - 8 - popRect.width);
  }
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  activePopover = pop;

  const onDocMouseDown = (e: MouseEvent): void => {
    if (!pop.contains(e.target as Node)) closePopover();
  };
  const onEsc = (e: KeyboardEvent): void => {
    if (e.key === "Escape") closePopover();
  };
  document.addEventListener("mousedown", onDocMouseDown);
  window.addEventListener("keydown", onEsc);
  popoverCleanup = () => {
    document.removeEventListener("mousedown", onDocMouseDown);
    window.removeEventListener("keydown", onEsc);
  };
  const firstInput = pop.querySelector("input") as HTMLInputElement | null;
  firstInput?.focus();
}

/** 保存类按钮小助手(popover 内样式与卡片按钮一致)。 */
function popoverButton(text: string, primary: boolean): HTMLButtonElement {
  const btn = el("button", primary ? "primary" : undefined, text) as HTMLButtonElement;
  btn.type = "button";
  return btn;
}

function openApiKeyPopover(p: ProviderView, anchor: HTMLElement): void {
  openPopover(anchor, (pop) => {
    pop.append(el("div", "popover-title", t("配置 API Key", locale)));
    const input = el("input") as HTMLInputElement;
    input.type = "password";
    input.placeholder = "sk-...";
    input.className = "full";
    const actions = el("div", "popover-actions");
    const saveBtn = popoverButton(t("保存", locale), true);
    const cancelBtn = popoverButton(t("取消", locale), false);
    saveBtn.addEventListener("click", () => {
      const key = input.value.trim();
      if (!key) return;
      post({ type: "set_api_key", id: p.id, apiKey: key });
      closePopover();
    });
    cancelBtn.addEventListener("click", closePopover);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveBtn.click();
    });
    actions.append(saveBtn, cancelBtn);
    pop.append(input, actions);
  });
}

function openEditPopover(p: ProviderView, anchor: HTMLElement): void {
  openPopover(anchor, (pop) => {
    pop.append(el("div", "popover-title", t("编辑", locale)));
    const nameInput = el("input") as HTMLInputElement;
    nameInput.value = p.name;
    nameInput.placeholder = t("名称", locale);
    const urlInput = el("input") as HTMLInputElement;
    urlInput.value = p.baseUrl;
    urlInput.placeholder = "https://api.deepseek.com/anthropic";
    const modelListInput = el("input") as HTMLInputElement;
    modelListInput.value = p.modelListUrl ?? "";
    modelListInput.placeholder = t("自定义模型列表 URL(留空则移除)", locale);
    const actions = el("div", "popover-actions");
    const saveBtn = popoverButton(t("保存", locale), true);
    const cancelBtn = popoverButton(t("取消", locale), false);
    saveBtn.addEventListener("click", () => {
      const name = nameInput.value.trim() || p.name;
      const baseUrl = urlInput.value.trim() || p.baseUrl;
      post({
        type: "update_provider",
        id: p.id,
        patch: { name, baseUrl, modelListUrl: modelListInput.value.trim() || undefined },
      });
      closePopover();
    });
    cancelBtn.addEventListener("click", closePopover);
    actions.append(saveBtn, cancelBtn);
    pop.append(nameInput, urlInput, modelListInput, actions);
  });
}

// ---- 供应商卡片 ----
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
  const setActiveBtn = el("button", active ? undefined : "primary", t("设为当前使用", locale)) as HTMLButtonElement;
  setActiveBtn.type = "button";
  setActiveBtn.disabled = active;
  setActiveBtn.addEventListener("click", () => post({ type: "set_active", id: p.id }));

  const editBtn = el("button", undefined, t("编辑", locale)) as HTMLButtonElement;
  editBtn.type = "button";
  editBtn.addEventListener("click", () => openEditPopover(p, editBtn));

  const deleteBtn = el("button", "danger", t("删除", locale)) as HTMLButtonElement;
  deleteBtn.type = "button";
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
  apiKeyBtn.type = "button";
  apiKeyBtn.addEventListener("click", () => openApiKeyPopover(p, apiKeyBtn));

  const refreshBtn = el("button", undefined, t("刷新模型", locale)) as HTMLButtonElement;
  refreshBtn.type = "button";
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
  testBtn.type = "button";
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
  card.append(actions);
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
  createBaseUrl.value = DEFAULT_COMPAT_BASE_URL;
  createModelListUrl.value = "";
  createApiKey.value = "";
});

refreshModelsBtn.addEventListener("click", () => {
  post({ type: "refresh_models" });
});

importCcswitchBtn.addEventListener("click", () => {
  importCcswitchBtn.disabled = true;
  importCcswitchBtn.textContent = t("导入中…", locale);
  post({ type: "import_ccswitch" });
  // host 状态回流时由 renderState 恢复按钮;此处超时兜底
  window.setTimeout(() => {
    importCcswitchBtn.disabled = false;
    importCcswitchBtn.textContent = t("从 cc-switch 导入", locale);
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
