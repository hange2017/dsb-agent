/**
 * 记忆管理面板页面逻辑(纯 DOM,无框架)。
 * 协议:载入后 postMessage({ type: "ready" });
 * host 下发 { type: "state"; projectKey; project; global; locale } / { type: "toast"; ... };
 * 用户操作发送 memory_write(scope/name/description/body)与 memory_delete(scope/name)。
 * 每个分区(项目/全局)顶部一个表单:点「新建记忆」展开;点条目「编辑」把数据填入该表单。
 */

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

import { t } from "../src/i18n/strings";

export interface MemoryEntryView {
  name: string;
  description: string;
  body: string;
  updatedAt: number;
}

type HostMessage =
  | {
      type: "state";
      projectKey: string;
      project: MemoryEntryView[];
      global: MemoryEntryView[];
      locale: "zh" | "en";
    }
  | { type: "toast"; message: string; error?: boolean };

type WebviewMessage =
  | { type: "ready" }
  | {
      type: "memory_write";
      scope: "project" | "global";
      name: string;
      description: string;
      body: string;
    }
  | { type: "memory_delete"; scope: "project" | "global"; name: string };

const post = (msg: WebviewMessage): void => vscode.postMessage(msg);

const statusEl = document.getElementById("status") as HTMLElement;
const projectKeyEl = document.getElementById("projectKeyLabel") as HTMLElement;

let toastTimer: ReturnType<typeof setTimeout> | undefined;
let locale: "zh" | "en" = "zh";

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

/** 创建元素(text 用 textContent,避免把用户输入当 HTML 注入)。 */
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

/** 分区:标题 + 新建按钮 + 表单 + 列表容器。 */
interface SectionRefs {
  newBtn: HTMLButtonElement;
  form: HTMLFormElement;
  name: HTMLInputElement;
  description: HTMLInputElement;
  body: HTMLTextAreaElement;
  list: HTMLElement;
}

function wireSection(scope: "project" | "global"): SectionRefs {
  const newBtn = document.getElementById(`${scope}NewBtn`) as HTMLButtonElement;
  const form = document.getElementById(`${scope}Form`) as HTMLFormElement;
  const name = document.getElementById(`${scope}Name`) as HTMLInputElement;
  const description = document.getElementById(`${scope}Description`) as HTMLInputElement;
  const body = document.getElementById(`${scope}Body`) as HTMLTextAreaElement;
  const list = document.getElementById(`${scope}List`) as HTMLElement;
  const cancel = document.getElementById(`${scope}Cancel`) as HTMLButtonElement;

  const reset = (): void => {
    form.hidden = true;
    form.reset();
    delete form.dataset.editing;
    newBtn.textContent = t("新建记忆", locale);
  };

  newBtn.addEventListener("click", () => {
    const next = form.hidden;
    form.hidden = !next;
    if (next) {
      delete form.dataset.editing;
      name.focus();
    }
  });
  cancel.addEventListener("click", reset);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    post({
      type: "memory_write",
      scope,
      name: (name.value ?? "").trim(),
      description: (description.value ?? "").trim(),
      body: (body.value ?? "").trim(),
    });
    reset();
  });

  return { newBtn, form, name, description, body, list };
}

function renderEntries(
  refs: SectionRefs,
  entries: MemoryEntryView[],
  scope: "project" | "global",
): void {
  refs.list.replaceChildren();
  if (entries.length === 0) {
    refs.list.append(el("div", "empty", t("暂无记忆", locale)));
    return;
  }
  for (const entry of entries) {
    const card = el("div", "card");
    const head = el("div", "card-head");
    head.append(
      el("span", "card-name", entry.name),
      el("span", "badge", scope === "project" ? t("项目", locale) : t("全局", locale)),
      el("span", "card-updated", new Date(entry.updatedAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US")),
    );
    card.append(head, el("div", "card-desc", entry.description));

    const body = el("pre", "card-body hidden", entry.body);
    const actions = el("div", "card-actions");
    const toggleBtn = el("button", undefined, t("展开", locale));
    toggleBtn.addEventListener("click", () => {
      const hidden = body.classList.toggle("hidden");
      toggleBtn.textContent = hidden ? t("展开", locale) : t("收起", locale);
    });
    actions.append(toggleBtn);

    const editBtn = el("button", "primary", t("编辑", locale));
    editBtn.addEventListener("click", () => {
      refs.name.value = entry.name;
      refs.description.value = entry.description;
      refs.body.value = entry.body;
      refs.form.dataset.editing = entry.name;
      refs.form.hidden = false;
      refs.newBtn.textContent = t("编辑记忆: {name}", locale, { name: entry.name });
      refs.name.focus();
    });
    actions.append(editBtn);

    const deleteBtn = el("button", "danger", t("删除", locale));
    deleteBtn.addEventListener("click", () => {
      if (window.confirm(`${t("删除记忆: {name}", locale, { name: entry.name })}?`)) {
        post({ type: "memory_delete", scope, name: entry.name });
      }
    });
    actions.append(deleteBtn);

    card.append(body, actions);
    refs.list.append(card);
  }
}

function renderState(msg: Extract<HostMessage, { type: "state" }>): void {
  locale = msg.locale;
  projectKeyEl.textContent = msg.projectKey;
  renderEntries(projectSection, msg.project, "project");
  renderEntries(globalSection, msg.global, "global");
  // 静态模板文案随语言重渲染(textContent / placeholder / title)
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key, locale);
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-placeholder]")) {
    const key = el.dataset.i18nPlaceholder;
    if (key) el.setAttribute("placeholder", t(key, locale));
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    const key = el.dataset.i18nTitle;
    if (key) el.title = t(key, locale);
  }
}

const projectSection = wireSection("project");
const globalSection = wireSection("global");

window.addEventListener("message", (ev: MessageEvent<HostMessage>) => {
  const msg = ev.data;
  if (msg.type === "state") renderState(msg);
  else if (msg.type === "toast") showToast(msg.message, msg.error);
});

post({ type: "ready" });
