/**
 * 冷存储浏览面板页面逻辑(纯 DOM,无框架)。
 * 协议:载入后 postMessage({ type: "ready" });
 * host 下发 { type:"state"; sessions; locale } / { type:"browse"; sessionId; entries } / { type:"toast"; ... };
 * 用户操作发送 browse / clear / delete / merge_all。
 */

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

import { t } from "../src/i18n/strings";

export interface SessionView {
  id: string;
  chunkCount: number;
  compacted: number;
  pruned: number;
}

export interface ChunkView {
  seq: number;
  type: "demand" | "conclusion" | "explanation" | "ledger";
  role: "user" | "assistant" | "tool";
  summary: string;
  content: string;
}

type HostMessage =
  | { type: "state"; sessions: SessionView[]; locale: "zh" | "en" }
  | { type: "browse"; sessionId: string; entries: ChunkView[] }
  | { type: "toast"; message: string; error?: boolean };

type WebviewMessage =
  | { type: "ready" }
  | { type: "browse"; sessionId: string }
  | { type: "clear"; sessionId: string }
  | { type: "delete"; sessionId: string }
  | { type: "merge_all" };

const post = (msg: WebviewMessage): void => vscode.postMessage(msg);

const statusEl = document.getElementById("status") as HTMLElement;
const sessionListEl = document.getElementById("sessionList") as HTMLElement;
const filterEl = document.getElementById("typeFilter") as HTMLSelectElement;
const chunkListEl = document.getElementById("chunkList") as HTMLElement;
const detailEl = document.getElementById("detailHeader") as HTMLElement;

let toastTimer: ReturnType<typeof setTimeout> | undefined;
let locale: "zh" | "en" = "zh";
let sessions: SessionView[] = [];
let currentEntries: ChunkView[] = [];
let currentSessionId: string | undefined;

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

/** 创建元素(text 用 textContent,避免把内容当 HTML 注入)。 */
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

function typeLabel(type: ChunkView["type"]): string {
  return t(
    type === "demand" ? "需求" : type === "conclusion" ? "结论" : type === "explanation" ? "说明" : "工具履历",
    locale,
  );
}

function renderSessions(): void {
  sessionListEl.replaceChildren();
  if (sessions.length === 0) {
    sessionListEl.append(el("div", "empty", t("暂无冷存储会话", locale)));
    return;
  }
  for (const s of sessions) {
    const card = el("div", "card session-card");
    const head = el("div", "card-head");
    const name = el("span", "card-name", s.id);
    const meta = el("span", "card-meta", `${s.chunkCount} ${t("块", locale)} · ${s.compacted} ${t("压缩", locale)} · ${s.pruned} ${t("淘汰", locale)}`);
    head.append(name, meta);
    const actions = el("div", "card-actions");
    const openBtn = el("button", "primary", t("浏览", locale));
    openBtn.addEventListener("click", () => {
      currentSessionId = s.id;
      detailEl.textContent = `${s.id} — ${s.chunkCount} ${t("块", locale)}`;
      post({ type: "browse", sessionId: s.id });
    });
    const clearBtn = el("button", undefined, t("清空", locale));
    clearBtn.addEventListener("click", () => {
      if (window.confirm(`${t("清空冷存储: {session}", locale, { session: s.id })}?`)) {
        post({ type: "clear", sessionId: s.id });
      }
    });
    const deleteBtn = el("button", "danger", t("删除", locale));
    deleteBtn.addEventListener("click", () => {
      if (window.confirm(`${t("删除冷存储: {session}", locale, { session: s.id })}?`)) {
        post({ type: "delete", sessionId: s.id });
      }
    });
    actions.append(openBtn, clearBtn, deleteBtn);
    card.append(head, actions);
    sessionListEl.append(card);
  }
}

function renderChunks(): void {
  chunkListEl.replaceChildren();
  const filter = filterEl.value;
  const entries = filter === "all" ? currentEntries : currentEntries.filter((c) => c.type === filter);
  if (entries.length === 0) {
    chunkListEl.append(el("div", "empty", t("暂无块", locale)));
    return;
  }
  for (const c of entries) {
    const card = el("div", "card");
    const head = el("div", "card-head");
    head.append(
      el("span", "card-name", `[r${c.seq}]`),
      el("span", "badge", typeLabel(c.type)),
      el("span", "badge role", c.role),
      el("span", "card-summary", c.summary),
    );
    const body = el("pre", "card-body hidden", c.content);
    const actions = el("div", "card-actions");
    const toggleBtn = el("button", undefined, t("展开", locale));
    toggleBtn.addEventListener("click", () => {
      const hidden = body.classList.toggle("hidden");
      toggleBtn.textContent = hidden ? t("展开", locale) : t("收起", locale);
    });
    actions.append(toggleBtn);
    card.append(head, body, actions);
    chunkListEl.append(card);
  }
}

function renderState(msg: Extract<HostMessage, { type: "state" }>): void {
  locale = msg.locale;
  sessions = msg.sessions;
  renderSessions();
  // 静态模板文案随语言重渲染
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key, locale);
  }
}

filterEl.addEventListener("change", renderChunks);

document.getElementById("refreshBtn")?.addEventListener("click", () => post({ type: "ready" }));
document.getElementById("mergeAllBtn")?.addEventListener("click", () => {
  if (window.confirm(t("合并去重全部会话冷存储?", locale))) {
    post({ type: "merge_all" });
  }
});

window.addEventListener("message", (ev: MessageEvent<HostMessage>) => {
  const msg = ev.data;
  if (msg.type === "state") renderState(msg);
  else if (msg.type === "browse") {
    currentSessionId = msg.sessionId;
    currentEntries = msg.entries;
    renderChunks();
  } else if (msg.type === "toast") showToast(msg.message, msg.error);
});

post({ type: "ready" });
