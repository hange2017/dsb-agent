import { renderMarkdown } from "./format";
import { chipViewFromLabel, type ChipView } from "./chips";
import { classifyAttachFile } from "../src/context/fileClassify";
import { removeRefMarker } from "../src/context/composerMarkers";
import { t } from "../src/i18n/strings";
import type { HostToWebviewMessage, ProviderListItem, SuggestionItem, WebviewToHostMessage } from "../src/chat/protocol";
import type { CompactionStatsSnapshot } from "../src/agent/compactionStats";
import type { Capabilities, Mode, ModelInfo } from "../src/providers/types";
import { detectTrigger, type TriggerInfo } from "../src/chat/suggestions";
import { VimInput } from "./vim";
import type { TimelineStepMessage } from "../src/chat/protocol";
import { pickNavTarget, type NavAnchor } from "./navTargets";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const post = (msg: WebviewToHostMessage): void => vscode.postMessage(msg);

const messagesEl = document.getElementById("messages") as HTMLElement;
const emptyHint = document.getElementById("emptyHint") as HTMLElement;
const emptyEmoji = document.getElementById("emptyEmoji") as HTMLElement;
const emptyText = document.getElementById("emptyText") as HTMLElement;
const agentMood = document.getElementById("agentMood") as HTMLElement;
const dayPhaseEl = document.getElementById("dayPhase") as HTMLElement;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement;
const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLElement;
const newBtn = document.getElementById("newBtn") as HTMLButtonElement;
const sessionsBtn = document.getElementById("sessionsBtn") as HTMLButtonElement;
const providerSelect = document.getElementById("providerSelect") as HTMLSelectElement;
const modeSelect = document.getElementById("modeSelect") as HTMLSelectElement;
const modelSelect = document.getElementById("modelSelect") as HTMLSelectElement;
const usageRing = document.getElementById("usageRing") as HTMLElement;
const compactionBadge = document.getElementById("compactionBadge") as HTMLElement;
const compactionChart = document.getElementById("compactionChart") as HTMLElement;
const pendingChipsEl = document.getElementById("pendingChips") as HTMLElement;
const composerEl = document.getElementById("composer") as HTMLElement;
const attachBtn = document.getElementById("attachBtn") as HTMLButtonElement;
const attachInput = document.getElementById("attachInput") as HTMLInputElement;
const rocketEl = document.getElementById("rocket") as HTMLElement;
const idleMoodEl = document.getElementById("idleMood") as HTMLElement;
const sessionsPanel = document.getElementById("sessionsPanel") as HTMLElement;
const superPermBtn = document.getElementById("superPermBtn") as HTMLButtonElement;
const settingsBtn = document.getElementById("settingsBtn") as HTMLButtonElement;
const settingsOverlay = document.getElementById("settingsOverlay") as HTMLElement;
const settingsCloseBtn = document.getElementById("settingsCloseBtn") as HTMLButtonElement;
const openProviderSettingsBtn = document.getElementById("openProviderSettingsBtn") as HTMLButtonElement;
const openMemoryManagerBtn = document.getElementById("openMemoryManagerBtn") as HTMLButtonElement;
const openAgentSettingsBtn = document.getElementById("openAgentSettingsBtn") as HTMLButtonElement;
const languageSelect = document.getElementById("languageSelect") as HTMLSelectElement;
const vimModeCb = document.getElementById("vimModeCb") as HTMLInputElement;
const notificationsCb = document.getElementById("notificationsCb") as HTMLInputElement;
const permModeRadios = [...document.querySelectorAll<HTMLInputElement>('input[name="permMode"]')];
const suggestList = document.getElementById("suggestList") as HTMLUListElement;

// `/`、`@` 建议下拉状态
let suggestions: SuggestionItem[] = [];
let suggestIndex = 0;
let activeTrigger: TriggerInfo | null = null;
let suggestTimer: ReturnType<typeof setTimeout> | undefined;

interface MsgRecord {
  id: string;
  role: "user" | "assistant";
  el: HTMLElement;
  body: HTMLElement | null;
  final: HTMLElement | null;
  timeline: HTMLElement | null;
}

interface PendingChip extends ChipView {
  id: string;
}

const msgEls: Record<string, MsgRecord> = {};
let pendingChips: PendingChip[] = [];
// host 回显用户消息时,把本次发送携带的 chips 缩略挂上去
let queuedUserChips: ChipView[][] = [];
let busy = false;
let toastTimer: number | undefined;
let transientTimer: number | undefined;
// host 通过 init 消息下发 vim 模式开关;vim 输入框在 normal 模式下拦截导航键
let vimEnabled = false;

// ---- 历史重放渲染窗口 ----
// history_start/end 之间的事件先缓存,初始只渲染最近 kRenderRecentRounds 轮,
// 用户向上滚动到顶部附近时增量渲染更早的轮次,避免大会话一次性渲染卡顿。
const kRenderRecentRounds = 3; // 打开历史时渲染的最近轮数
const kLoadMoreRounds = 3; // 上滚到顶部时一次补渲染的轮数
let historyMode = false; // 是否处于历史重放缓存模式
let historyBuffer: HostToWebviewMessage[] = []; // 重放事件缓存(history_start/end 之间)
let pendingRounds: HostToWebviewMessage[][] = []; // 尚未渲染的更早轮次(时间升序,最旧在前)

// ---- 滚动跟随冻结 + ▲▼ 轮次导航 ----
let stickToBottom = true; // 是否跟随底部:用户上滚超过阈值后冻结,新内容不再拽动视口
let suppressStickCheck = false; // 程序滚动(导航/懒加载)期间屏蔽 stick 重算,防误判
let stickRaf = 0; // rAF 节流句柄(流式高频滚动只重算一次/帧)
let stickSuppressTimer: number | undefined; // 程序滚动结束恢复检查的定时器
let navAnchorEls = new Map<string, HTMLElement>(); // 锚点 id → DOM 元素(跳转高亮用)
const kStickThreshold = 64; // 距底多少 px 内视为「在底部」(≈滚轮一格,留缓冲)

/** 瞬态状态提示,不影响 busy 状态(附加错误等不该重新启用 Send)。 */
function showToast(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastTimer = undefined;
    if (!busy) {
      statusEl.textContent = "";
      statusEl.classList.remove("error");
    }
  }, 4000);
}

/** 瞬态 status 文本(如「已压缩上下文」):保持 busy,延迟后只清文本,不改变按钮/表情状态。 */
function scheduleTransientClear(delayMs: number): void {
  if (transientTimer !== undefined) window.clearTimeout(transientTimer);
  transientTimer = window.setTimeout(() => {
    transientTimer = undefined;
    if (busy) {
      statusEl.textContent = "";
      statusEl.classList.remove("error");
    }
  }, delayMs);
}

/** 非瞬态 status(开始/完成/错误)到达时,取消未决的瞬态清空,避免误清后续状态。 */
function cancelTransientClear(): void {
  if (transientTimer !== undefined) {
    window.clearTimeout(transientTimer);
    transientTimer = undefined;
  }
}

function scrollBottom(): void {
  if (!stickToBottom) return; // 用户已上滚冻结:新内容不拽动视口
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function hideEmptyHint(): void {
  emptyHint.style.display = "none";
}

// ---- rendering helpers ----

function renderChipView(chip: ChipView): HTMLElement {
  const el = document.createElement("span");
  el.className = "chip";
  if (chip.kind === "image" && chip.dataUrl) {
    const img = document.createElement("img");
    img.className = "chip-img";
    img.src = chip.dataUrl;
    el.append(img);
  }
  const label = document.createElement("span");
  label.className = "chip-label";
  label.textContent = chip.label;
  el.append(label);
  return el;
}

function renderUserMessage(id: string, text: string, chips: ChipView[] = []): void {
  const el = document.createElement("div");
  el.className = "msg user";
  const body = document.createElement("div");
  body.className = "body";
  body.innerHTML = renderMarkdown(text);
  markJumpableInText(body);
  el.append(body);
  for (const chip of chips) el.append(renderChipView(chip));
  maybeThumbsUp(el, text);
  messagesEl.append(el);
  msgEls[id] = { id, role: "user", el, body, final: null, timeline: null };
  hideEmptyHint();
}

/**
 * 给文本区(用户消息正文 / 助手 text 步骤)内的代码块标记可双击跳转:
 * 代码块首行形如 `path:line` 或路径形态(相对/绝对)时,双击打开对应文件并定位行。
 * 无路径信息的代码块(JSON/diff 片段等)保持原样,不标记。
 */
function markJumpableInText(root: HTMLElement): void {
  for (const pre of root.querySelectorAll<HTMLElement>("pre")) {
    const first = ((pre.querySelector("code")?.textContent ?? pre.textContent) ?? "").split("\n")[0].trim();
    if (!first || first.includes(" ")) continue;
    // path:line —— 路径部分需含 / \ 或 .(排除 "abc:12" 这类误判)
    const withLine = first.match(/^([^\s:]+(?:[/\\][^\s:]+)+|\.{1,2}[/\\][^\s:]+):(\d+)\s*$/);
    // 纯路径(相对 ./src/… 或绝对 /… 或 C:\…)
    const barePath = first.match(/^(?:\/|\.{1,2}[/\\]|[A-Za-z]:[\\/]|[\w.-]+[/\\])/);
    if (withLine) {
      pre.classList.add("jumpable");
      pre.dataset.jumpPath = withLine[1];
      pre.dataset.jumpLine = withLine[2];
      pre.title = t("双击跳转到文件", locale);
    } else if (barePath && !first.endsWith(":")) {
      pre.classList.add("jumpable");
      pre.dataset.jumpPath = first;
      pre.title = t("双击跳转到文件", locale);
    }
  }
}

function renderAssistantMessage(id: string, text: string): void {
  const el = document.createElement("div");
  el.className = "msg assistant";
  const timeline = document.createElement("div");
  timeline.className = "timeline";
  el.append(timeline);
  messagesEl.append(el);
  msgEls[id] = { id, role: "assistant", el, body: null, final: null, timeline };
  if (text) {
    // 旧会话重放:单条拼接助手文本 → 一条 final text 步
    upsertTimelineStep({
      type: "timeline_step",
      messageId: id,
      stepId: "text-replay",
      kind: "text",
      status: "completed",
      text,
      final: true,
    });
  }
  hideEmptyHint();
}

function timelineContainer(messageId: string): HTMLElement {
  const rec = messageId ? msgEls[messageId] : undefined;
  return rec?.timeline ?? messagesEl;
}

/** 把 message / timeline_step 事件应用到 DOM(实时与历史重放共用同一渲染路径)。 */
function applyEventToDom(ev: HostToWebviewMessage): void {
  if (ev.type === "message") {
    if (ev.role === "user") {
      const chips = queuedUserChips.length ? queuedUserChips.shift()! : [];
      renderUserMessage(ev.id, ev.text, chips);
    } else {
      renderAssistantMessage(ev.id, ev.text);
    }
  } else if (ev.type === "timeline_step") {
    upsertTimelineStep(ev);
  }
}

/** 按用户消息为界,把历史重放事件切成轮次(每轮 = 一条 user + 其后的 assistant 事件)。 */
function splitHistoryRounds(events: HostToWebviewMessage[]): HostToWebviewMessage[][] {
  const rounds: HostToWebviewMessage[][] = [];
  let cur: HostToWebviewMessage[] = [];
  for (const ev of events) {
    if (ev.type === "message" && ev.role === "user" && cur.length > 0) {
      rounds.push(cur);
      cur = [];
    }
    cur.push(ev);
  }
  if (cur.length > 0) rounds.push(cur);
  return rounds;
}

/** 历史重放结束:渲染最近 3 轮,更早的轮次缓存,等待上滚增量加载。 */
function renderHistoryWindow(): void {
  const rounds = splitHistoryRounds(historyBuffer);
  const take = Math.min(kRenderRecentRounds, rounds.length);
  const recent = rounds.slice(-take);
  pendingRounds = rounds.slice(0, -take);
  for (const round of recent) {
    for (const ev of round) applyEventToDom(ev);
  }
  // 已渲染内容不足以产生滚动条时,自动补渲染直到可滚动(否则用户无法上滚触发懒加载)
  while (pendingRounds.length > 0 && messagesEl.scrollHeight <= messagesEl.clientHeight) {
    const batchTake = Math.min(kLoadMoreRounds, pendingRounds.length);
    const batch = pendingRounds.splice(-batchTake);
    for (const round of batch) {
      for (const ev of round) applyEventToDom(ev);
    }
  }
  scrollBottom();
}

/** 上滚到顶部时增量渲染更早的轮次,插入到消息区顶部并补偿滚动位置(视口不跳动)。 */
function loadMoreHistoryRounds(): void {
  if (pendingRounds.length === 0) return;
  const take = Math.min(kLoadMoreRounds, pendingRounds.length);
  const batch = pendingRounds.splice(-take);
  const prevScrollTop = messagesEl.scrollTop;
  const prevHeight = messagesEl.scrollHeight;
  // 现有 DOM 全部摘到 frag,清空后渲染新批次(自然位于顶部),再把原 DOM 接回
  const frag = document.createDocumentFragment();
  while (messagesEl.firstChild) frag.append(messagesEl.firstChild);
  for (const round of batch) {
    for (const ev of round) applyEventToDom(ev);
  }
  messagesEl.append(frag);
  // 显式重设滚动位置:原 DOM 顶部保持在视口原位置(渲染过程 scrollBottom 的干扰被覆盖)
  messagesEl.scrollTop = prevScrollTop + (messagesEl.scrollHeight - prevHeight);
}

// ---- ▲▼ 轮次导航 ----
/** 实时收集当前消息区的 USER/DSB 锚点(DOM 序),并记录对应元素供跳转高亮。 */
function collectAnchors(): NavAnchor[] {
  navAnchorEls.clear();
  const anchors: NavAnchor[] = [];
  const base = messagesEl.getBoundingClientRect();
  const scrollTop = messagesEl.scrollTop;
  const add = (el: HTMLElement, kind: "user" | "dsb") => {
    const rect = el.getBoundingClientRect();
    const id = `${kind}-${anchors.length}`;
    navAnchorEls.set(id, el);
    anchors.push({
      id,
      kind,
      top: rect.top - base.top + scrollTop,
      bottom: rect.bottom - base.top + scrollTop,
    });
  };
  // USER 框 = 用户输入消息;DSB 框 = 助手最终回复(tl-step.tl-text.final)
  for (const el of messagesEl.querySelectorAll<HTMLElement>(".msg.user")) add(el, "user");
  for (const el of messagesEl.querySelectorAll<HTMLElement>(
    ".msg.assistant .tl-step.tl-text.final .tl-text-body",
  )) {
    add(el, "dsb");
  }
  anchors.sort((a, b) => a.top - b.top);
  return anchors;
}

/** 平滑跳到目标锚点并短暂高亮;程序滚动期间屏蔽 stick 重算。 */
function jumpToNav(anchor: NavAnchor): void {
  suppressStickCheck = true;
  const el = navAnchorEls.get(anchor.id);
  messagesEl.scrollTo({ top: Math.max(0, anchor.top - 16), behavior: "smooth" });
  if (el) {
    el.classList.remove("nav-flash");
    void el.offsetWidth; // 重启动画
    el.classList.add("nav-flash");
    el.addEventListener("animationend", () => el.classList.remove("nav-flash"), { once: true });
  }
  if (stickSuppressTimer !== undefined) window.clearTimeout(stickSuppressTimer);
  stickSuppressTimer = window.setTimeout(() => {
    suppressStickCheck = false;
  }, 500);
}

/** ▲:跳到上一个 USER 框;目标在未渲染历史里时先增量加载。 */
function onNavUp(): void {
  stickToBottom = false; // 向上查看即离开底部,冻结跟随
  let target = pickNavTarget(collectAnchors(), messagesEl.scrollTop, "up", false);
  let guard = 0;
  while (!target && pendingRounds.length > 0 && guard++ < 100) {
    loadMoreHistoryRounds();
    target = pickNavTarget(collectAnchors(), messagesEl.scrollTop, "up", false);
  }
  if (!target) return;
  jumpToNav(target);
}

/** ▼:跟随态回底部并恢复跟随;非跟随态跳下一个 DSB,无目标则兜底回底部。 */
function onNavDown(): void {
  if (stickToBottom) {
    suppressStickCheck = true;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (stickSuppressTimer !== undefined) window.clearTimeout(stickSuppressTimer);
    stickSuppressTimer = window.setTimeout(() => {
      suppressStickCheck = false;
    }, 300);
    return;
  }
  const target = pickNavTarget(collectAnchors(), messagesEl.scrollTop, "down", false);
  if (target) {
    jumpToNav(target);
    return;
  }
  stickToBottom = true; // 下方无 DSB:兜底回底部 + 恢复跟随
  suppressStickCheck = true;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  if (stickSuppressTimer !== undefined) window.clearTimeout(stickSuppressTimer);
  stickSuppressTimer = window.setTimeout(() => {
    suppressStickCheck = false;
  }, 300);
}

function findStepEl(container: HTMLElement, stepId: string): HTMLElement | undefined {
  return Array.from(container.children).find(
    (el) => el instanceof HTMLElement && el.dataset.stepId === stepId,
  ) as HTMLElement | undefined;
}

/** 工具类型 → 时间线动画表情(沿用户发送→agent 回复整条时间线,按任务穿插)。 */
const kToolEmojis: Record<string, string> = {
  Read: "📖",
  Write: "✏️",
  StrReplace: "✏️",
  Delete: "🗑️",
  Bash: "⚙️",
  Grep: "🔍",
  Glob: "🗂️",
  LS: "📁",
  WebSearch: "🔍",
  WebFetch: "🌐",
  Agent: "🤖",
  Workflow: "🧩",
  Memory: "🧠",
  MemoryWrite: "🧠",
  MemoryRead: "🧠",
  MemoryList: "🧠",
  MemoryDelete: "🧠",
  TodoWrite: "📋",
  TodoRead: "📋",
  TodoList: "📋",
};
/** running 时旋转的工具(齿轮/地球/大脑等),其余弹跳。 */
const kSpinTools = new Set(["Bash", "WebFetch", "Memory", "MemoryWrite", "MemoryRead", "MemoryList", "Workflow", "Agent", "ContextRecall"]);
function toolEmojiFor(name: string): string {
  return kToolEmojis[name] ?? "🛠️";
}
function toolEmojiSpin(name: string): boolean {
  return kSpinTools.has(name);
}
/** 在宿主容器头部插入/复用动画 emoji span;running 时按 spin/bounce 播放动画。 */
function ensureEmoji(host: HTMLElement, emoji: string, cls: string, running: boolean, spin: boolean): HTMLElement {
  let el = host.querySelector<HTMLElement>(`.${cls}`);
  if (!el) {
    el = document.createElement("span");
    el.className = cls;
    host.insertBefore(el, host.firstChild);
  }
  el.textContent = emoji;
  el.classList.toggle("spin", running && spin);
  el.classList.toggle("bounce", running && !spin);
  return el;
}

// 长内容折叠:把 table/diff/file/terminal 包进 max-height 容器,右下角 Click to expand 展开全文
function makeCollapsible(contentEl: HTMLElement): HTMLElement {  const wrap = document.createElement("div");
  wrap.className = "tl-collapse";
  const btn = document.createElement("button");
  btn.className = "tl-expand-btn";
  btn.textContent = "Click to expand";
  btn.addEventListener("click", () => {
    const expanded = wrap.classList.toggle("expanded");
    btn.textContent = expanded ? "Collapse" : "Click to expand";
    wrap.classList.toggle("has-expanded", true);
  });
  wrap.append(contentEl, btn);
  return wrap;
}

// 按 block.kind 分发:table/diff/file/terminal/list/text,输出与 task-1 类型一致
function renderBodyBlocks(main: HTMLElement, body?: Array<{ kind: string; label: string } & Record<string, unknown>>): void {
  main.querySelector(".tl-body")?.remove();
  if (!body?.length) return;
  const wrap = document.createElement("div");
  wrap.className = "tl-body";
  for (const block of body) {
    const det = document.createElement("details");
    det.className = "tl-block";
    const sum = document.createElement("summary");
    sum.textContent = block.label;
    det.append(sum);
    switch (block.kind) {
      case "table": {
        const cols = (block.columns as string[]) ?? [];
        const rows = (block.rows as string[][]) ?? [];
        // Grep 类结果(path:line:content)可双击跳转:表头含「文件」且含「行」时,行级标记跳转
        const pathIdx = cols.findIndex((c) => c === "文件" || c === "File" || c === "名称" || c === "Name");
        const lineIdx = cols.findIndex((c) => c === "行" || c === "Line");
        const table = document.createElement("table");
        table.className = "tl-table";
        const thead = document.createElement("thead");
        const tr = document.createElement("tr");
        for (const c of cols) { const th = document.createElement("th"); th.textContent = c; tr.append(th); }
        thead.append(tr);
        table.append(thead);
        const tbody = document.createElement("tbody");
        for (const row of rows) {
          const r = document.createElement("tr");
          for (const cell of row) { const td = document.createElement("td"); td.textContent = cell; r.append(td); }
          if (pathIdx >= 0 && row[pathIdx]) {
            r.classList.add("jumpable");
            r.dataset.jumpPath = row[pathIdx];
            if (lineIdx >= 0 && row[lineIdx]) r.dataset.jumpLine = row[lineIdx];
            r.title = t("双击跳转到文件", locale);
          }
          tbody.append(r);
        }
        table.append(tbody);
        det.append(makeCollapsible(table));
        break;
      }
      case "diff": {
        const div = document.createElement("div");
        div.className = "tl-diff";
        for (const h of (block.hunks as Array<{ type: string; text: string }>) ?? []) {
          const line = document.createElement("div");
          line.className = `d ${h.type}`;
          line.textContent = (h.type === "add" ? "+ " : h.type === "del" ? "- " : "  ") + h.text;
          div.append(line);
        }
        det.append(makeCollapsible(div));
        break;
      }
      case "file": {
        const fp = (block.path as string) ?? "";
        const p = document.createElement("div");
        p.className = "tl-file-path";
        p.textContent = fp;
        const pre = document.createElement("pre");
        pre.className = "tl-file";
        pre.textContent = block.content as string;
        if (fp) {
          // 双击 Read/Write 结果内容或路径 → 打开该文件
          p.classList.add("jumpable");
          p.dataset.jumpPath = fp;
          p.title = t("双击跳转到文件", locale);
          pre.classList.add("jumpable");
          pre.dataset.jumpPath = fp;
          pre.title = t("双击跳转到文件", locale);
        }
        det.append(p, makeCollapsible(pre));
        break;
      }
      case "terminal": {
        const pre = document.createElement("pre");
        pre.className = "tl-terminal";
        pre.textContent = block.content as string;
        det.append(makeCollapsible(pre));
        break;
      }
      case "list": {
        const ul = document.createElement("ul");
        ul.className = "tl-list";
        for (const it of (block.items as Array<{ title: string; detail?: string }>) ?? []) {
          const li = document.createElement("li");
          const b = document.createElement("b");
          b.textContent = it.title;
          li.append(b);
          if (it.detail) { const span = document.createElement("span"); span.textContent = it.detail; li.append(span); }
          ul.append(li);
        }
        det.append(ul);
        break;
      }
      default: {
        const pre = document.createElement("pre");
        pre.textContent = block.content == null ? "" : String(block.content);
        det.append(pre);
      }
    }
    wrap.append(det);
  }
  main.append(wrap);
}

function upsertTimelineStep(msg: TimelineStepMessage): void {
  const container = timelineContainer(msg.messageId);
  let step = findStepEl(container, msg.stepId);
  if (!step) {
    step = document.createElement("div");
    step.className = "tl-step";
    step.dataset.stepId = msg.stepId;
    const gutter = document.createElement("div");
    gutter.className = "tl-gutter";
    const dot = document.createElement("div");
    dot.className = "tl-dot";
    gutter.append(dot);
    const main = document.createElement("div");
    main.className = "tl-main";
    step.append(gutter, main);
    container.append(step);
  }

  const dot = step.querySelector(".tl-dot") as HTMLElement;
  const main = step.querySelector(".tl-main") as HTMLElement;
  step.dataset.kind = msg.kind;
  step.dataset.status = msg.status;

  if (msg.kind === "thinking") {
    dot.className = "tl-dot gray";
    let details = main.querySelector("details.tl-thinking") as HTMLDetailsElement | null;
    if (!details) {
      main.replaceChildren();
      details = document.createElement("details");
      details.className = "tl-thinking";
      const summary = document.createElement("summary");
      summary.className = "tl-thinking-summary";
      const content = document.createElement("div");
      content.className = "tl-thinking-content";
      details.append(summary, content);
      main.append(details);
    }
    const summary = details.querySelector("summary") as HTMLElement;
    const content = details.querySelector(".tl-thinking-content") as HTMLElement;
    const running = msg.status === "running";
    ensureEmoji(summary, "💭", "tl-think-emoji", running, false);
    const label = running ? "Thinking..." : `Thought for ${Math.round((msg.durationMs ?? 0) / 1000)}s`;
    // 保留 emoji span,替换其余文本节点
    for (const n of [...summary.childNodes]) {
      if (!(n instanceof HTMLElement)) summary.removeChild(n);
    }
    summary.append(document.createTextNode(` ${label}`));
    if (running) {
      if (msg.text !== undefined) content.textContent = msg.text;
    } else {
      if (msg.text !== undefined) content.textContent = msg.text;
    }
  } else if (msg.kind === "todos") {
    dot.className = "tl-dot green";
    main.replaceChildren();
    const head = document.createElement("div");
    head.className = "tl-header";
    const nameEl = document.createElement("span");
    nameEl.className = "tl-name";
    nameEl.textContent = "Update Todos";
    head.append(nameEl);
    ensureEmoji(head, "📋", "tl-todo-emoji", false, false);
    const list = document.createElement("ul");
    list.className = "tl-todos";
    for (const item of msg.items) {
      const li = document.createElement("li");
      li.className = item.done ? "done" : "pending";
      li.textContent = `${item.done ? "[✓]" : "[ ]"} ${item.content}`;
      list.append(li);
    }
    main.append(head, list);
  } else if (msg.kind === "text") {
    step.classList.add("tl-text");
    if (msg.final) step.classList.add("final");
    dot.className = msg.status === "running" ? "tl-dot gray pulse" : "tl-dot green";
    let body = main.querySelector(".tl-text-body") as HTMLElement | null;
    if (!body) {
      main.replaceChildren();
      body = document.createElement("div");
      body.className = "tl-text-body";
      main.append(body);
    }
    if (msg.status === "running") {
      if (msg.text !== undefined) body.textContent = msg.text;
    } else if (msg.text !== undefined) {
      body.innerHTML = renderMarkdown(msg.text);
      markJumpableInText(body);
    }
  } else {
    // tool
    dot.className = msg.status === "error" ? "tl-dot red" : "tl-dot green";
    if (msg.status === "running") dot.classList.add("pulse");
    let header = main.querySelector(".tl-header") as HTMLElement | null;
    let summaryEl = main.querySelector(".tl-summary") as HTMLElement | null;
    if (!header) {
      main.replaceChildren();
      header = document.createElement("div");
      header.className = "tl-header";
      const nameEl = document.createElement("span");
      nameEl.className = "tl-name";
      const sec = document.createElement("span");
      sec.className = "tl-secondary";
      header.append(nameEl, sec);
      summaryEl = document.createElement("div");
      summaryEl.className = "tl-summary";
      main.append(header, summaryEl);
    }
    const nameEl = header.querySelector(".tl-name") as HTMLElement;
    const sec = header.querySelector(".tl-secondary") as HTMLElement;
    // 工具类型动画表情:running 时播放(spin/bounce),完成后静态
    ensureEmoji(header, toolEmojiFor(msg.name), "tl-tool-emoji", msg.status === "running", toolEmojiSpin(msg.name));
    nameEl.textContent = msg.displayName;
    sec.textContent = msg.headerSecondary ? ` ${msg.headerSecondary}` : "";
    if (summaryEl) {
      summaryEl.textContent = msg.summary ?? "";
      summaryEl.hidden = !msg.summary;
    }
    renderBodyBlocks(main, msg.body);
  }
  scrollBottom();
}

function finalizeAssistant(messageId: string): void {
  // 正常路径:host 已在 done 时关闭末段 text(completed+final);此处仅防御遗漏
  const container = timelineContainer(messageId);
  const running = Array.from(container.querySelectorAll(".tl-step.tl-text")).find(
    (el) => el instanceof HTMLElement && el.dataset.status === "running",
  ) as HTMLElement | undefined;
  if (!running) return;
  const body = running.querySelector(".tl-text-body") as HTMLElement | null;
  const text = body?.textContent ?? "";
  upsertTimelineStep({
    type: "timeline_step",
    messageId,
    stepId: running.dataset.stepId ?? "text-final",
    kind: "text",
    status: "completed",
    text,
    final: true,
  });
}

/**
 * 折叠最近一轮(上一条 assistant 消息)的中间时间线:
 * 把「蓝色输入 ↔ 蓝色输出」之间的 thinking/tool/todos/过程 text 步骤移入可展开折叠条,
 * 历史轮次只留输入框 + 折叠条 + 蓝色输出,滚动翻查输入/输出对更高效。
 * 当前轮(仍有 running 步骤)不折叠,防御性跳过。
 */
function collapseLastRoundIntermediates(): void {
  const assistants = Object.values(msgEls).filter(
    (r): r is MsgRecord & { timeline: HTMLElement } => r.role === "assistant" && r.timeline !== null,
  );
  const last = assistants[assistants.length - 1];
  if (!last) return;
  // 已折叠过(存在折叠条)则跳过;未结束轮次(running 步骤)也跳过
  if (last.timeline.querySelector(".tl-collapsed")) return;
  const steps = Array.from(last.timeline.children).filter(
    (el): el is HTMLElement =>
      el instanceof HTMLElement && el.classList.contains("tl-step") && !el.classList.contains("final"),
  );
  if (steps.length === 0) return;
  if (steps.some((el) => el.dataset.status === "running")) return;

  const wrap = document.createElement("div");
  wrap.className = "tl-collapsed";
  const toggle = document.createElement("button");
  toggle.className = "tl-collapsed-toggle";
  const holder = document.createElement("div");
  holder.className = "tl-collapsed-steps";
  holder.hidden = true;
  for (const s of steps) holder.append(s);
  const label = (collapsed: boolean): string =>
    t(
      collapsed ? "中间过程 {n} 步 · 展开" : "中间过程 {n} 步 · 收起",
      locale,
      { n: String(steps.length) },
    );
  toggle.textContent = label(true);
  toggle.addEventListener("click", () => {
    const collapsed = holder.hidden;
    holder.hidden = !collapsed; // 展开
    toggle.textContent = label(!collapsed);
  });
  wrap.append(toggle, holder);
  // 折叠条插到蓝色输出之前:视觉上「输入 → 中间过程 → 输出」
  const finalEl = last.timeline.querySelector<HTMLElement>(".tl-step.tl-text.final");
  if (finalEl) last.timeline.insertBefore(wrap, finalEl);
  else last.timeline.append(wrap);
}

function renderPendingChips(): void {
  pendingChipsEl.replaceChildren();
  for (const chip of pendingChips) {
    const el = renderChipView(chip);
    el.style.cursor = "pointer";
    el.addEventListener("click", () => post({ type: "open_chip", id: chip.id }));
    const remove = document.createElement("button");
    remove.className = "chip-remove";
    remove.textContent = "×";
    remove.title = t("移除", locale);
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      removePendingChip(chip.id);
    });
    el.append(remove);
    pendingChipsEl.append(el);
  }
  pendingChipsEl.hidden = pendingChips.length === 0;
}

function removePendingChip(id: string): void {
  pendingChips = pendingChips.filter((c) => c.id !== id);
  renderPendingChips();
  // 同步 host:移除 chip 要递减 pendingImageCount/pendingDocumentCount,
  // 否则 5/10 上限会在合法附加时误拒。
  post({ type: "remove_chip", id });
}

function clearPendingChips(): void {
  pendingChips = [];
  renderPendingChips();
}

function insertAtCursor(ta: HTMLTextAreaElement, text: string): void {
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  const pos = start + text.length;
  ta.selectionStart = ta.selectionEnd = pos;
  ta.focus();
}

function setUsage(inputTokens?: number, outputTokens?: number): void {
  if (inputTokens === undefined) return;
  const pct = Math.min(100, Math.round((inputTokens / 128000) * 100));
  usageRing.style.setProperty("--pct", `${pct}%`);
  usageRing.textContent = `${pct}%`;
  usageRing.title =
    t("上下文用量:输入 {input} tokens", locale, { input: inputTokens }) +
    (outputTokens !== undefined ? t(" / 输出 {output}", locale, { output: outputTokens }) : "");
}

/** 空状态问候文案(按时段,与 updateDayPhase 同步)。 */
function emptyGreeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return t("早上好,开始今天的编码吧!", locale);
  if (h >= 11 && h < 13) return t("中午好,继续加油!", locale);
  if (h >= 13 && h < 17) return t("下午好,有什么需要帮忙的?", locale);
  if (h >= 17 && h < 21) return t("晚上好,随时待命!", locale);
  return t("夜深了,注意休息!", locale);
}

/** 本地时段图标:按系统时间显示早晨/中午/下午/傍晚/夜晚,位于 DSBAgent 标题左侧。 */
function updateDayPhase(): void {
  const now = new Date();
  const h = now.getHours();
  let icon: string;
  let label: string;
  if (h >= 5 && h < 11) {
    icon = "🌅";
    label = t("早晨", locale);
  } else if (h >= 11 && h < 13) {
    icon = "🌞";
    label = t("中午", locale);
  } else if (h >= 13 && h < 17) {
    icon = "☀️";
    label = t("下午", locale);
  } else if (h >= 17 && h < 21) {
    icon = "🌆";
    label = t("傍晚", locale);
  } else {
    icon = "🌙";
    label = t("夜晚", locale);
  }
  dayPhaseEl.textContent = icon;
  dayPhaseEl.title = t("{label} · {time}", locale, {
    label,
    time: now.toLocaleTimeString(),
  });
  // 空状态动态表情同步问候(仅空状态可见时)
  if (!emptyHint.hidden) {
    emptyEmoji.textContent = h >= 17 || h < 5 ? "🌙" : "👋";
    emptyText.textContent = emptyGreeting();
  }
}
updateDayPhase();
// 每 10 分钟校准一次时段(跨早晨/中午/傍晚等边界时自动切换)
setInterval(updateDayPhase, 10 * 60 * 1000);

/** thinking 压缩频率徽章:显示「最近 N 次对话中发生 x 次 thinking 压缩」。 */
function setCompactionStats(stats: CompactionStatsSnapshot): void {
  const { windowCompactions, windowConversations, windowSize, totalCompactions } = stats;
  compactionBadge.textContent = t("思考压缩 {compactions}/{window}", locale, {
    compactions: String(windowCompactions),
    window: String(windowConversations),
  });
  compactionBadge.title = t(
    "最近 {window} 次对话中发生 {compactions} 次 thinking 压缩(累计 {total} 次);窗口 {size} 次对话。频繁触发时可在配置 dsbAgent.compaction.triggerRatio 调高阈值(默认 0.75)",
    locale,
    {
      window: String(windowConversations),
      compactions: String(windowCompactions),
      total: String(totalCompactions),
      size: String(windowSize),
    },
  );
  // 频率 ≥ 20%(窗口满 20 次)时警示:压缩成本偏高,建议调高触发阈值
  compactionBadge.classList.toggle("hot", windowConversations >= 20 && windowCompactions / windowConversations >= 0.2);
  renderCompactionTrend(stats);
}

/** 窗口趋势图:每个柱 = 最近一次对话内的 thinking 压缩次数(旧→新,最多 windowSize 根)。 */
function renderCompactionTrend(stats: CompactionStatsSnapshot): void {
  const { windowSeries, windowSize } = stats;
  compactionChart.replaceChildren();
  if (!windowSeries.length) return;
  const max = Math.max(1, ...windowSeries);
  windowSeries.forEach((n, i) => {
    const bar = document.createElement("div");
    bar.className = "bar" + (n > 0 ? " hit" : "");
    const h = n === 0 ? 2 : Math.max(4, Math.round((n / max) * 16));
    bar.style.height = `${h}px`;
    bar.title = t("第 {i} 次对话: {n} 次压缩", locale, {
      i: String(i + 1),
      n: String(n),
    });
    compactionChart.append(bar);
  });
  compactionChart.title = t("最近 {size} 次对话压缩趋势(柱高=压缩次数)", locale, {
    size: String(windowSize),
  });
}

function renderSessions(sessions: Array<{ id: string; title: string; updatedAt: number }>): void {
  sessionsPanel.replaceChildren();
  if (!sessions.length) {
    const empty = document.createElement("div");
    empty.className = "session-empty";
    empty.textContent = t("暂无会话", locale);
    sessionsPanel.append(empty);
    return;
  }
  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = "session-row";
    const title = document.createElement("span");
    title.className = "session-title";
    title.textContent = s.title;
    title.title = s.title;
    const del = document.createElement("button");
    del.className = "session-del";
    del.textContent = "×";
    del.title = t("删除会话", locale);
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      post({ type: "delete_session", id: s.id });
    });
    row.addEventListener("click", () => {
      post({ type: "load_session", id: s.id });
      sessionsPanel.hidden = true;
      sessionsBtn.classList.remove("active");
    });
    row.append(title, del);
    sessionsPanel.append(row);
  }
}

// ---- actions ----

function setBusy(next: boolean, info = ""): void {
  busy = next;
  sendBtn.hidden = next;
  stopBtn.hidden = !next;
  statusEl.textContent = info;
  // 动态 agent 状态表情:忙碌时🤔弹跳,空闲时😊浮动
  agentMood.textContent = next ? "🤔" : "😊";
  agentMood.classList.toggle("busy", next);
  agentMood.title = next ? t("agent 工作中…", locale) : t("agent 空闲", locale);
  // 火箭发送动画:busy 时显示;空闲躺平小人随状态淡出/淡入
  rocketEl.hidden = !next;
  updateIdleMood();
}

/** 鼠标是否悬停在输入框上(悬停时躺平小人敬礼致意并淡出)。 */
let hoveringInput = false;

/** 空闲躺平小人:仅在空闲且输入框为空时可见(输入文字/忙碌时淡出);
 *  鼠标悬停输入框时切换为敬礼 🫡 并淡出,移出后恢复躺平。 */
function updateIdleMood(): void {
  const visible = !busy && inputEl.value.trim() === "";
  idleMoodEl.style.opacity = visible ? "1" : "0";
  if (!visible) return;
  if (hoveringInput) {
    if (idleMoodEl.textContent !== "🫡") {
      idleMoodEl.textContent = "🫡";
      idleMoodEl.classList.add("saluting");
    }
  } else {
    idleMoodEl.textContent = "😴";
    idleMoodEl.classList.remove("saluting");
  }
}

/** 用户消息出现正向反馈时,弹出点赞回应动画。 */
function maybeThumbsUp(el: HTMLElement, text: string): void {
  if (!/(很棒|不错|太好了|厉害|谢谢|完美|赞|优秀|很好|good|great|awesome|thanks|nice|excellent)/i.test(text)) return;
  const badge = document.createElement("span");
  badge.className = "thumbs-pop";
  badge.textContent = "👍";
  el.append(badge);
  window.setTimeout(() => badge.remove(), 1600);
}

/** 完成礼花:该轮做过实际工作(有工具步骤)时,在回复框后弹出 🎉。 */
function maybeParty(messageId: string): void {
  const rec = msgEls[messageId];
  if (!rec || !rec.timeline) return;
  if (!rec.timeline.querySelector('.tl-step[data-kind="tool"]')) return;
  const pop = document.createElement("span");
  pop.className = "party-pop";
  pop.textContent = "🎉";
  rec.el.append(pop);
  window.setTimeout(() => pop.remove(), 1900);
}

function renderPluginRecommendations(items: Array<{ name: string; origin: string; reason: string; installable: boolean }>): void {
  const container = document.createElement("div");
  container.className = "plugin-recs";
  const title = document.createElement("div");
  title.className = "plugin-recs-title";
  title.textContent = t("推荐插件", locale);
  container.append(title);
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "plugin-recs-empty";
    empty.textContent = t("没有匹配的插件(试试其他关键词)", locale);
    container.append(empty);
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "plugin-recs-item";
    const info = document.createElement("div");
    info.className = "plugin-recs-info";
    const name = document.createElement("div");
    name.className = "plugin-recs-name";
    name.textContent = item.name;
    const origin = document.createElement("div");
    origin.className = "plugin-recs-origin";
    origin.textContent = item.reason ? `${item.origin} · ${item.reason}` : item.origin;
    info.append(name, origin);
    row.append(info);
    if (item.installable) {
      const install = document.createElement("button");
      install.className = "plugin-recs-install";
      install.textContent = t("安装", locale);
      install.addEventListener("click", () => {
        install.disabled = true;
        install.textContent = t("安装中…", locale);
        post({ type: "install_plugin", marketplace: item.origin, name: item.name });
      });
      row.append(install);
    }
    container.append(row);
  }
  messagesEl.append(container);
  hideEmptyHint();
  scrollBottom();
}

function send(): void {
  const text = inputEl.value.trim();
  if (!text || busy) return;
  // 新一轮对话开始:把上一轮「蓝色输入 ↔ 蓝色输出」之间的中间时间线折叠收起,
  // 只留可展开的折叠条,历史轮次紧凑显示,便于滚动翻查输入/输出对。
  collapseLastRoundIntermediates();
  if (pendingChips.length) {
    queuedUserChips.push([...pendingChips]);
    clearPendingChips();
  }
  inputEl.value = "";
  // /plugins 前缀走推荐流程,不进 agent 会话
  if (text === "/plugins" || text.startsWith("/plugins ")) {
    const query = text === "/plugins" ? "" : text.slice("/plugins ".length).trim();
    setBusy(true, t("推荐插件…", locale));
    post({ type: "recommend_plugins", query });
    return;
  }
  setBusy(true, t("等待模型…", locale));
  post({ type: "send", text });
}

function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ---- `/`、`@` 建议下拉 ----

function suggestionLabel(item: SuggestionItem): string {
  switch (item.kind) {
    case "command": return `/${item.name}`;
    case "skill": return item.name;
    case "file": return item.relativePath;
  }
}

function suggestionDetail(item: SuggestionItem): string {
  switch (item.kind) {
    case "command": return item.detail;
    case "skill": return item.description;
    case "file": return "";
  }
}

function hideSuggestions(): void {
  suggestions = [];
  suggestIndex = 0;
  activeTrigger = null;
  suggestList.hidden = true;
  suggestList.replaceChildren();
}

function renderSuggestions(): void {
  suggestList.replaceChildren();
  if (suggestions.length === 0) {
    suggestList.hidden = true;
    return;
  }
  suggestList.hidden = false;
  suggestions.forEach((item, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    if (i === suggestIndex) li.classList.add("active");
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = item.kind;
    const label = document.createElement("span");
    label.textContent = suggestionLabel(item);
    li.append(kind, label);
    const detail = suggestionDetail(item);
    if (detail) {
      const d = document.createElement("span");
      d.className = "detail";
      d.textContent = detail;
      li.append(d);
    }
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pickSuggestion(i);
    });
    suggestList.append(li);
  });
}

function requestSuggestions(): void {
  const cursor = inputEl.selectionStart ?? inputEl.value.length;
  const trigger = detectTrigger(inputEl.value, cursor);
  activeTrigger = trigger;
  if (!trigger) {
    hideSuggestions();
    return;
  }
  post({ type: "suggest", trigger: trigger.trigger, query: trigger.query });
}

function pickSuggestion(index: number): void {
  const item = suggestions[index];
  const trigger = activeTrigger;
  if (!item || !trigger) return;
  post({
    type: "pickSuggestion",
    item,
    triggerStart: trigger.start,
    triggerEnd: trigger.end,
    inputText: inputEl.value,
  });
}

/** 下拉打开时的按键导航;返回 true 表示已消费。 */
function handleSuggestionKey(e: KeyboardEvent): boolean {
  if (suggestList.hidden || suggestions.length === 0) return false;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    suggestIndex = (suggestIndex + 1) % suggestions.length;
    renderSuggestions();
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    suggestIndex = (suggestIndex - 1 + suggestions.length) % suggestions.length;
    renderSuggestions();
    return true;
  }
  if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    pickSuggestion(suggestIndex);
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    hideSuggestions();
    return true;
  }
  return false;
}

// ---- DOM wiring ----

sendBtn.addEventListener("click", send);
stopBtn.addEventListener("click", () => post({ type: "cancel" }));
newBtn.addEventListener("click", () => post({ type: "new_session" }));
sessionsBtn.addEventListener("click", () => {
  sessionsPanel.hidden = !sessionsPanel.hidden;
  sessionsBtn.classList.toggle("active", !sessionsPanel.hidden);
});
// 超级权限切换:开启后 agent 无需确认即可执行任何操作
superPermBtn.addEventListener("click", () => {
  const on = superPermBtn.classList.toggle("on");
  superPermBtn.setAttribute("aria-pressed", String(on));
  post({ type: "set_permission_mode", mode: on ? "bypassPermissions" : "default" });
});

// ---- 设置面板(语言 + 权限 + vim + 通知) ----

/** 当前 UI 语言:init / locale_changed 消息更新;所有文案经 t(key, locale) 渲染。 */
let locale: "zh" | "en" = "zh";
let vimMode = false;
let notificationsEnabled = true;

/** 重渲染所有 data-i18n 标注元素(语言切换即时生效,无需重载)。 */
function applyLocale(): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key, locale);
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    const key = el.dataset.i18nTitle;
    if (key) el.title = t(key, locale);
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-placeholder]")) {
    const key = el.dataset.i18nPlaceholder;
    if (key) el.setAttribute("placeholder", t(key, locale));
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-aria-label]")) {
    const key = el.dataset.i18nAriaLabel;
    if (key) el.setAttribute("aria-label", t(key, locale));
  }
  superPermBtn.textContent = t("超级权限", locale);
  vim.setLocale(locale);
  syncVisionUi();
}

function openSettings(): void {
  settingsOverlay.hidden = false;
}
function closeSettings(): void {
  settingsOverlay.hidden = true;
}

settingsBtn.addEventListener("click", openSettings);
settingsCloseBtn.addEventListener("click", closeSettings);

// 代码块/文件结果/内联路径/URL 双击跳转:事件委托到消息区
// - .jumpable[data-jump-path] → open_file(文件+可选行)
// - .jumpable[data-jump-url]  → open_url(外部链接)
messagesEl.addEventListener("dblclick", (e) => {
  const target = e.target as HTMLElement;
  const el = target.closest<HTMLElement>(".jumpable");
  if (!el) return;
  const jumpUrl = el.dataset.jumpUrl;
  if (jumpUrl) {
    post({ type: "open_url", url: jumpUrl });
    return;
  }
  const filePath = el.dataset.jumpPath;
  if (!filePath) return;
  const line = el.dataset.jumpLine ? Number(el.dataset.jumpLine) : undefined;
  post({ type: "open_file", path: filePath, line });
});

// 历史懒加载:上滚到接近顶部时增量渲染更早的轮次(初始只渲染最近 3 轮)
messagesEl.addEventListener("scroll", () => {
  if (pendingRounds.length === 0) return;
  if (messagesEl.scrollTop > 48) return;
  loadMoreHistoryRounds();
});
// 跟随状态检测:上滚超过阈值 → 冻结自动滚底;回到底部附近 → 恢复跟随
messagesEl.addEventListener("scroll", () => {
  if (stickRaf !== 0) return;
  stickRaf = requestAnimationFrame(() => {
    stickRaf = 0;
    if (suppressStickCheck) return;
    const d = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    stickToBottom = d <= kStickThreshold;
  });
});
const navUpBtn = document.getElementById("navUp") as HTMLButtonElement;
const navDownBtn = document.getElementById("navDown") as HTMLButtonElement;
navUpBtn.addEventListener("click", onNavUp);
navDownBtn.addEventListener("click", onNavDown);
openProviderSettingsBtn.addEventListener("click", () => {
  closeSettings();
  post({ type: "open_provider_settings" });
});
openMemoryManagerBtn.addEventListener("click", () => {
  closeSettings();
  post({ type: "open_memory_manager" });
});
openAgentSettingsBtn.addEventListener("click", () => {
  closeSettings();
  post({ type: "open_agent_settings" });
});
settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

languageSelect.addEventListener("change", () => {
  post({ type: "set_language", language: languageSelect.value as "" | "zh" | "en" });
});
for (const r of permModeRadios) {
  r.addEventListener("change", () => {
    post({ type: "set_permission_mode", mode: r.value as "default" | "acceptEdits" | "bypassPermissions" });
  });
}
vimModeCb.addEventListener("change", () => {
  post({ type: "set_vim_mode", enabled: vimModeCb.checked });
});
notificationsCb.addEventListener("change", () => {
  post({ type: "set_notifications", enabled: notificationsCb.checked });
});
// 输入框顶边拖拽调整高度:往上拖增高,往下拖变矮(48~400px)
const composerHandle = document.getElementById("composerHandle");
if (composerHandle) {
  let dragStartY = 0;
  let dragStartH = 0;
  let dragging = false;
  composerHandle.addEventListener("mousedown", (e) => {
    dragging = true;
    dragStartY = e.clientY;
    dragStartH = inputEl.offsetHeight;
    document.body.classList.add("resizing");
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const next = Math.min(400, Math.max(48, dragStartH + (dragStartY - e.clientY)));
    inputEl.style.height = `${next}px`;
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing");
  });
}

const vim = new VimInput(inputEl, { enabled: () => vimEnabled });
// 鼠标悬停输入框:躺平小人切换为敬礼并淡出(移出后恢复)
inputEl.addEventListener("mouseenter", () => {
  hoveringInput = true;
  updateIdleMood();
});
inputEl.addEventListener("mouseleave", () => {
  hoveringInput = false;
  updateIdleMood();
});
inputEl.addEventListener("keydown", (e) => {
  // 下拉打开时方向键/Enter/Tab/Esc 优先用于选择建议,不与 vim 冲突
  if (handleSuggestionKey(e)) return;
  if (vim.handleKey(e)) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
inputEl.addEventListener("input", () => {
  if (suggestTimer) clearTimeout(suggestTimer);
  suggestTimer = setTimeout(requestSuggestions, 150);
  updateIdleMood();
});

modeSelect.addEventListener("change", () => {
  post({ type: "set_mode", mode: modeSelect.value as "agent" | "plan" | "ask" });
});

function openProviderSettingsFromHeader(): void {
  post({ type: "open_provider_settings" });
}

providerSelect.addEventListener("mousedown", (e) => {
  // 仅占位项时:已选中再点同一 option 不会触发 change,必须在 mousedown 拦截并打开设置
  if (providerSelect.options.length === 1 && providerSelect.options[0].value === "") {
    e.preventDefault();
    openProviderSettingsFromHeader();
  }
});

providerSelect.addEventListener("change", () => {
  const id = providerSelect.value;
  if (!id) {
    openProviderSettingsFromHeader();
    return;
  }
  post({ type: "set_provider", providerId: id });
});

const MODEL_OPTIONS = ["deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"];
let currentCapabilities: Capabilities = { supportsVision: true, supportsThinking: true };
/** 最近一次下发的模型列表,供切换模型时同步 vision UI。 */
let lastModels: ModelInfo[] = [];

/** 按当前模型 vision 能力同步附加按钮:无 vision 时灰显并更新 tooltip,仍可附加文档。 */
function syncVisionUi(): void {
  const vision = currentCapabilities.supportsVision;
  attachBtn.classList.toggle("attach--no-vision", !vision);
  attachBtn.title = vision
    ? t("附加图片/文件", locale)
    : t("当前模型不支持图片(vision 已关闭),仍可附加文档", locale);
  attachBtn.setAttribute("aria-disabled", vision ? "false" : "true");
}

function applyCapabilitiesFromModel(modelId: string, models: ModelInfo[]): void {
  const info = models.find((m) => m.id === modelId) ?? models[0];
  if (!info) return;
  currentCapabilities = {
    supportsVision: info.capabilities.supportsVision,
    supportsThinking: info.capabilities.supportsThinking,
  };
  syncVisionUi();
}

/** 渲染供应商下拉(单供应商也显示名称,满足 header 展示当前供应商的需求)。 */
function renderProviderSelect(providers: ProviderListItem[]): void {
  providerSelect.replaceChildren();
  providerSelect.classList.toggle("provider-select--empty", providers.length === 0);
  if (providers.length === 0) {
    // 未配置供应商:占位项引导打开设置面板,而不是空下拉
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "⚠ " + t("未配置供应商(点击设置)", locale);
    opt.selected = true;
    providerSelect.append(opt);
    return;
  }
  for (const p of providers) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    opt.selected = p.active;
    providerSelect.append(opt);
  }
}

/** 渲染模式下拉:供应商 modes 优先,空则回退 agent/plan/ask。 */
function renderModes(modes: Mode[]): void {
  const list = modes.length ? modes : (["agent", "plan", "ask"] as Mode[]);
  modeSelect.replaceChildren();
  for (const m of list) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m === "agent" ? "Agent" : m === "plan" ? "Plan" : "Ask";
    modeSelect.append(opt);
  }
}

/** 渲染模型下拉:已解析模型优先,空则回退静态预设;fallbackModel 存在则选中它。 */
function renderModels(models: ModelInfo[], fallbackModel: string): void {
  if (models.length) lastModels = models;
  modelSelect.replaceChildren();
  const ids = models.length ? models.map((m) => m.id) : MODEL_OPTIONS;
  for (const id of ids) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    modelSelect.append(opt);
  }
  const target = ids.includes(fallbackModel) ? fallbackModel : (ids[0] ?? "");
  if (target) modelSelect.value = target;
}

/** 远程拉取中:下拉只显示"加载中…"并禁用(远程优先,避免误选本地预设)。 */
function renderModelsLoading(): void {
  modelSelect.replaceChildren();
  const opt = document.createElement("option");
  opt.value = "";
  opt.textContent = t("加载中…", locale);
  opt.disabled = true;
  opt.selected = true;
  modelSelect.append(opt);
}

// 初始兜底:host 尚未推送 init 前保持可选(供应商快照到来后会被 renderModels 覆盖)
renderModels([], "");
syncVisionUi();
modelSelect.addEventListener("change", () => {
  post({ type: "set_model", model: modelSelect.value });
  applyCapabilitiesFromModel(modelSelect.value, lastModels);
});

async function attachFiles(files: FileList | File[]): Promise<void> {
  if (busy) return;
  const list = Array.from(files);
  if (!list.length) return;
  const images: Array<{ mimeType: string; data: string; fileName?: string }> = [];
  const documents: Array<{ fileName: string; mimeType: string; data: string }> = [];
  const unsupported: string[] = [];
  let skippedImages = 0;
  for (const file of list) {
    const kind = classifyAttachFile(file.name, file.type || "");
    if (kind === "unsupported") {
      unsupported.push(file.name);
      continue;
    }
    if (kind === "image" && !currentCapabilities.supportsVision) {
      skippedImages += 1;
      continue;
    }
    const data = await readFileBase64(file);
    if (kind === "image") images.push({ mimeType: file.type || "application/octet-stream", data, fileName: file.name });
    else if (kind === "document") documents.push({ fileName: file.name, mimeType: file.type || "application/octet-stream", data });
  }
  if (unsupported.length) showToast(t("不支持的文件类型:{names}", locale, { names: unsupported.join(t("、", locale)) }), true);
  if (skippedImages > 0) {
    showToast(t("当前模型不支持图片输入(已禁用 vision)。可在设置面板为该模型开启 vision 能力。", locale), true);
  }
  if (images.length) post({ type: "attach_images", images });
  if (documents.length) post({ type: "attach_documents", documents });
}

attachBtn.addEventListener("click", () => {
  if (!busy) attachInput.click();
});
attachInput.addEventListener("change", () => {
  if (attachInput.files?.length) void attachFiles(attachInput.files);
  attachInput.value = "";
});

inputEl.addEventListener("paste", (e) => {
  const cd = e.clipboardData;
  if (!cd) return;
  const files: File[] = [];
  if (cd.files?.length) {
    files.push(...Array.from(cd.files));
  } else if (cd.items) {
    for (const item of Array.from(cd.items)) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  const text = cd.getData("text") ?? "";
  if (files.length || text) e.preventDefault();
  if (files.length) void attachFiles(files);
  if (text) post({ type: "paste", text });
});

["dragenter", "dragover"].forEach((ev) => {
  composerEl.addEventListener(ev, (e) => {
    e.preventDefault();
    composerEl.classList.add("composer--drag");
  });
});
composerEl.addEventListener("dragleave", (e) => {
  e.preventDefault();
  composerEl.classList.remove("composer--drag");
});
composerEl.addEventListener("drop", (e) => {
  e.preventDefault();
  composerEl.classList.remove("composer--drag");
  const dt = e.dataTransfer;
  if (dt?.files?.length) void attachFiles(dt.files);
});

// ---- host messages ----

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case "init":
      vimEnabled = msg.vimMode;
      superPermBtn.classList.toggle("on", msg.permissionMode === "bypassPermissions");
      superPermBtn.setAttribute("aria-pressed", String(msg.permissionMode === "bypassPermissions"));
      if (msg.hasKey) {
        emptyHint.textContent = t("在下方输入消息,开始对话(model: {model})", msg.locale, { model: msg.model });
      } else {
        emptyHint.textContent = t("尚未设置 API Key。运行命令:DSBAgent: Set API Key", msg.locale);
      }
      renderProviderSelect(msg.providers);
      renderModes(msg.modes);
      renderModels(msg.models, msg.model);
      currentCapabilities = msg.currentCapabilities;
      syncVisionUi();
      // 设置面板状态同步
      locale = msg.locale;
      vimMode = msg.vimMode;
      notificationsEnabled = msg.notificationsEnabled;
      vimModeCb.checked = vimMode;
      notificationsCb.checked = notificationsEnabled;
      for (const r of permModeRadios) r.checked = r.value === msg.permissionMode;
      applyLocale();
      break;
    case "locale_changed":
      locale = msg.locale;
      applyLocale();
      break;
    case "models_updated":
      if (msg.source === "loading") {
        renderModelsLoading();
      } else {
        renderModels(msg.models ?? [], msg.models?.[0]?.id ?? "");
        renderModels(msg.models ?? [], msg.models?.[0]?.id ?? "");
        applyCapabilitiesFromModel(modelSelect.value, msg.models ?? []);
      }
      break;
    case "provider_changed":
      if (msg.providers) {
        // 设置面板同步:带完整列表,替换「未配置」占位
        renderProviderSelect(msg.providers);
      } else {
        // 兼容旧消息:仅更新选中项;若仍是空占位则追加当前供应商
        const existing = [...providerSelect.options]
          .filter((o) => o.value !== "")
          .map((o) => ({
            id: o.value,
            name: o.textContent ?? o.value,
            active: o.value === msg.providerId,
          }));
        if (existing.length === 0 && msg.providerId) {
          renderProviderSelect([{ id: msg.providerId, name: msg.providerName, active: true }]);
        } else {
          renderProviderSelect(existing.map((p) => ({ ...p, active: p.id === msg.providerId })));
        }
      }
      renderModes(msg.modes);
      renderModels(msg.models, msg.models[0]?.id ?? "");
      currentCapabilities = msg.capabilities;
      syncVisionUi();
      // 保存/切换供应商后同步「尚未设置 API Key」空状态提示
      if (msg.hasKey !== undefined && !emptyHint.hidden) {
        emptyHint.textContent = msg.hasKey
          ? t("在下方输入消息,开始对话(model: {model})", locale, { model: modelSelect.value })
          : t("尚未设置 API Key。运行命令:DSBAgent: Set API Key", locale);
      }
      break;
    case "message":
      if (historyMode) {
        historyBuffer.push(msg);
        break;
      }
      applyEventToDom(msg);
      scrollBottom();
      break;
    case "stream": {
      const stepId = msg.stepId;
      if (!stepId) break;
      const container = timelineContainer(msg.messageId);
      const step = findStepEl(container, stepId);
      const body = step?.querySelector(".tl-text-body") as HTMLElement | null;
      if (body) {
        body.textContent = (body.textContent ?? "") + msg.text;
        scrollBottom();
      }
      break;
    }
    case "tool":
      // 旧协议兼容:降级为简单工具步骤
      upsertTimelineStep({
        type: "timeline_step",
        messageId: msg.messageId,
        stepId: `legacy-${msg.name}-${msg.status}`,
        kind: "tool",
        name: msg.name,
        displayName: msg.name,
        status: msg.status,
        summary: msg.detail,
        body: msg.detail ? [{ label: "Show full", content: msg.detail }] : undefined,
      });
      break;
    case "timeline_step":
      if (historyMode) {
        historyBuffer.push(msg);
        break;
      }
      upsertTimelineStep(msg);
      break;
    case "history_start":
      historyMode = true;
      historyBuffer = [];
      pendingRounds = [];
      stickToBottom = true;
      break;
    case "history_end":
      historyMode = false;
      renderHistoryWindow();
      break;
    case "status":
      setBusy(msg.busy, msg.info ?? "");
      statusEl.classList.toggle("error", Boolean(msg.error));
      if (msg.transient) {
        scheduleTransientClear(2000);
      } else {
        cancelTransientClear();
      }
      break;
    case "toast":
      showToast(msg.message, Boolean(msg.error));
      break;
    case "usage":
      setUsage(msg.inputTokens, msg.outputTokens);
      break;
    case "compaction_stats":
      setCompactionStats(msg.stats);
      break;
    case "sessions":
      renderSessions(msg.sessions);
      break;
    case "chipsAttached": {
      for (const c of msg.chips) {
        const view = chipViewFromLabel(c.kind, c.label);
        pendingChips.push(
          view.kind === "image"
            ? { id: c.id, kind: "image", label: view.label, dataUrl: c.dataUrl ?? "" }
            : { id: c.id, kind: "text", label: view.label },
        );
      }
      renderPendingChips();
      for (const t of msg.insertTexts) insertAtCursor(inputEl, t);
      break;
    }
    case "chipRemoved":
      pendingChips = pendingChips.filter((c) => c.id !== msg.id);
      if (msg.label) inputEl.value = removeRefMarker(inputEl.value, msg.label);
      renderPendingChips();
      break;
    case "pasteHandled":
      if (!msg.consumed && msg.text) insertAtCursor(inputEl, msg.text);
      break;
    case "assistant_done":
      finalizeAssistant(msg.messageId);
      maybeParty(msg.messageId);
      break;
    case "todos":
      // 底部面板已移除;清单改由 timeline_step kind=todos 展示
      break;
    case "plugin_recommendations":
      renderPluginRecommendations(msg.items);
      break;
    case "plugin_installed":
      showToast(msg.message, !msg.ok);
      break;
    case "suggestions":
      suggestions = msg.items;
      suggestIndex = 0;
      renderSuggestions();
      break;
    case "suggestionPicked": {
      inputEl.value = msg.inputText;
      const caret = msg.caret ?? inputEl.value.length;
      inputEl.setSelectionRange(caret, caret);
      if (msg.insertText) insertAtCursor(inputEl, msg.insertText);
      for (const c of msg.chips ?? []) {
        const view = chipViewFromLabel(c.kind, c.label);
        pendingChips.push(
          view.kind === "image"
            ? { id: c.id, kind: "image", label: view.label, dataUrl: view.dataUrl ?? "" }
            : { id: c.id, kind: "text", label: view.label },
        );
      }
      renderPendingChips();
      hideSuggestions();
      break;
    }
    case "ask_permission": {
      const bar = document.createElement("div");
      bar.className = "permission-bar";
      const label = document.createElement("span");
      label.textContent = t("允许执行:{tool}?", locale, { tool: msg.toolName });
      const makeButton = (text: string, onClick: () => void): HTMLButtonElement => {
        const b = document.createElement("button");
        b.textContent = text;
        b.addEventListener("click", onClick);
        return b;
      };
      bar.append(label);
      if (msg.detail) {
        const det = document.createElement("span");
        det.className = "permission-detail";
        det.textContent = msg.detail;
        bar.append(det);
      }
      bar.append(
        makeButton(t("允许", locale), () => {
          post({ type: "permission_response", askId: msg.askId, approved: true });
          bar.remove();
        }),
        makeButton(t("拒绝", locale), () => {
          post({ type: "permission_response", askId: msg.askId, approved: false });
          bar.remove();
        }),
        makeButton(t("总是允许", locale), () => {
          post({ type: "approve_once", toolName: msg.toolName });
          post({ type: "permission_response", askId: msg.askId, approved: true });
          bar.remove();
        }),
      );
      messagesEl.append(bar);
      scrollBottom();
      break;
    }
    case "reset":
      messagesEl.replaceChildren();
      stickToBottom = true;
      suppressStickCheck = false;
      if (stickSuppressTimer !== undefined) {
        window.clearTimeout(stickSuppressTimer);
        stickSuppressTimer = undefined;
      }
      for (const key of Object.keys(msgEls)) delete msgEls[key];
      queuedUserChips.length = 0;
      clearPendingChips();
      historyMode = false;
      historyBuffer = [];
      pendingRounds = [];
      setBusy(false, "");
      statusEl.classList.remove("error");
      usageRing.style.setProperty("--pct", "0%");
      usageRing.textContent = "—";
      compactionBadge.textContent = t("思考压缩 —", locale);
      compactionBadge.title = t("thinking 压缩频率", locale);
      compactionBadge.classList.remove("hot");
      compactionChart.replaceChildren();
      emptyHint.style.display = "";
      emptyEmoji.textContent = "👋";
      emptyText.textContent = emptyGreeting();
      agentMood.textContent = "😊";
      agentMood.classList.remove("busy");
      break;
  }
});

post({ type: "ready" });
