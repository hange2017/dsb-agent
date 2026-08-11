/**
 * DSB Agent 参数设置面板页面逻辑(纯 DOM,无框架)。
 * 协议:载入后 postMessage({ type: "ready" });
 * host 下发 { type: "state"; locale; config } / { type: "toast"; ... };
 * 用户点「保存」发送 budget_update(config)。
 * 三块比例滑块:拖动任一,其余等比例缩放,总和恒 100%。
 * 新增:窗口总长度(0=跟随模型)、触发比例、压缩后目标比例。
 */

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

import { t } from "../src/i18n/strings";

export interface BudgetSplitView {
  compacted: number;
  thinking: number;
  tail: number;
}

export interface AgentThinkingConfigView {
  /** 参数面板唯一 thinking 开关:处理侧是否开启 thinking 编排(镜像 dsbAgent.compaction.thinking)。 */
  compact: boolean;
}

export interface AgentBudgetConfigView {
  windowTokens: number;
  budget: number;
  split: BudgetSplitView;
  triggerPct: number;
  targetPct: number;
  thinking: AgentThinkingConfigView;
}

type HostMessage =
  | {
      type: "state";
      locale: "zh" | "en";
      config: AgentBudgetConfigView;
    }
  | { type: "toast"; message: string; error?: boolean };

type WebviewMessage =
  | { type: "ready" }
  | { type: "budget_update"; config: AgentBudgetConfigView }
  | { type: "reset_defaults" };

let locale: "zh" | "en" = "zh";

const windowTokensInput = document.getElementById("windowTokensInput") as HTMLInputElement;
const budgetInput = document.getElementById("budgetInput") as HTMLInputElement;
const compactedRange = document.getElementById("compactedRange") as HTMLInputElement;
const thinkingRange = document.getElementById("thinkingRange") as HTMLInputElement;
const tailRange = document.getElementById("tailRange") as HTMLInputElement;
const compactedPct = document.getElementById("compactedPct") as HTMLElement;
const thinkingPct = document.getElementById("thinkingPct") as HTMLElement;
const tailPct = document.getElementById("tailPct") as HTMLElement;
const compactedTokens = document.getElementById("compactedTokens") as HTMLElement;
const thinkingTokens = document.getElementById("thinkingTokens") as HTMLElement;
const tailTokens = document.getElementById("tailTokens") as HTMLElement;
const triggerPctInput = document.getElementById("triggerPctInput") as HTMLInputElement;
const targetPctInput = document.getElementById("targetPctInput") as HTMLInputElement;
const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const resetBtn = document.getElementById("resetBtn") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLElement;
const thinkingCompactChk = document.getElementById("thinkingCompactChk") as HTMLInputElement;

// 三个滑块当前值(整数百分比)
let pct = { compacted: 45, thinking: 20, tail: 35 };

function applyI18n(): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key, locale);
  }
}

function render(): void {
  compactedRange.value = String(pct.compacted);
  thinkingRange.value = String(pct.thinking);
  tailRange.value = String(pct.tail);
  compactedPct.textContent = `${pct.compacted}%`;
  thinkingPct.textContent = `${pct.thinking}%`;
  tailPct.textContent = `${pct.tail}%`;
  const budget = Math.max(0, Number(budgetInput.value) || 0);
  compactedTokens.textContent = String(Math.round((budget * pct.compacted) / 100));
  thinkingTokens.textContent = String(Math.round((budget * pct.thinking) / 100));
  tailTokens.textContent = String(Math.round((budget * pct.tail) / 100));
}

/** 拖动滑块 key,其余两个等比例缩放使总和 = 100。 */
function onRangeChange(key: "compacted" | "thinking" | "tail"): void {
  const v = Number((document.getElementById(`${key}Range`) as HTMLInputElement).value);
  const others = (["compacted", "thinking", "tail"] as const).filter((k) => k !== key);
  const sumOthers = pct[others[0]] + pct[others[1]];
  pct[key] = v;
  if (sumOthers > 0) {
    const remaining = 100 - v;
    const scale = remaining / sumOthers;
    let a = Math.round(pct[others[0]] * scale);
    let b = remaining - a;
    // 避免负值
    if (a < 0) {
      b += a;
      a = 0;
    }
    if (b < 0) {
      a += b;
      b = 0;
    }
    pct[others[0]] = a;
    pct[others[1]] = b;
  } else {
    // 其余全 0:平分剩余
    const remaining = 100 - v;
    pct[others[0]] = Math.floor(remaining / 2);
    pct[others[1]] = remaining - pct[others[0]];
  }
  render();
}

function currentSplit(): BudgetSplitView {
  const sum = pct.compacted + pct.thinking + pct.tail || 100;
  return {
    compacted: pct.compacted / sum,
    thinking: pct.thinking / sum,
    tail: pct.tail / sum,
  };
}

function currentConfig(): AgentBudgetConfigView {
  return {
    windowTokens: Math.max(0, Number(windowTokensInput.value) || 0),
    budget: Math.max(0, Number(budgetInput.value) || 0),
    split: currentSplit(),
    triggerPct: (Math.max(1, Math.min(100, Number(triggerPctInput.value) || 75)) / 100),
    targetPct: (Math.max(1, Math.min(100, Number(targetPctInput.value) || 50)) / 100),
    thinking: {
      compact: thinkingCompactChk.checked,
    },
  };
}

function postSave(): void {
  vscode.postMessage({ type: "budget_update", config: currentConfig() } satisfies WebviewMessage);
  saveBtn.disabled = true;
}

compactedRange.addEventListener("input", () => onRangeChange("compacted"));
thinkingRange.addEventListener("input", () => onRangeChange("thinking"));
tailRange.addEventListener("input", () => onRangeChange("tail"));
budgetInput.addEventListener("input", render);
budgetInput.addEventListener("change", () => {
  saveBtn.disabled = false;
});
windowTokensInput.addEventListener("change", () => {
  saveBtn.disabled = false;
});
triggerPctInput.addEventListener("change", () => {
  saveBtn.disabled = false;
});
targetPctInput.addEventListener("change", () => {
  saveBtn.disabled = false;
});
thinkingCompactChk.addEventListener("change", () => {
  saveBtn.disabled = false;
});
saveBtn.addEventListener("click", postSave);

// 恢复默认:两段式确认(3 秒内再点才生效),避免误触
let resetArmed = false;
let resetTimer: ReturnType<typeof setTimeout> | undefined;
resetBtn.addEventListener("click", () => {
  if (!resetArmed) {
    resetArmed = true;
    resetBtn.classList.add("confirm");
    resetBtn.textContent = t("确认恢复默认?", locale);
    resetTimer = window.setTimeout(() => {
      resetArmed = false;
      resetBtn.classList.remove("confirm");
      resetBtn.textContent = t("恢复默认参数", locale);
    }, 3000);
    return;
  }
  resetArmed = false;
  if (resetTimer) clearTimeout(resetTimer);
  resetBtn.classList.remove("confirm");
  resetBtn.textContent = t("恢复默认参数", locale);
  vscode.postMessage({ type: "reset_defaults" } satisfies WebviewMessage);
});

window.addEventListener("message", (ev) => {
  const msg = ev.data as HostMessage;
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "state": {
      locale = msg.locale;
      const cfg = msg.config;
      windowTokensInput.value = String(cfg.windowTokens);
      budgetInput.value = String(cfg.budget);
      triggerPctInput.value = String(Math.round(cfg.triggerPct * 100));
      targetPctInput.value = String(Math.round(cfg.targetPct * 100));
      thinkingCompactChk.checked = cfg.thinking?.compact ?? true;
      pct = {
        compacted: Math.round(cfg.split.compacted * 100),
        thinking: Math.round(cfg.split.thinking * 100),
        tail: Math.round(cfg.split.tail * 100),
      };
      // 归一化显示(整数化可能总和 ≠ 100,用 tail 兜底)
      const sum = pct.compacted + pct.thinking + pct.tail;
      if (sum !== 100 && sum > 0) {
        pct.tail = 100 - pct.compacted - pct.thinking;
      }
      saveBtn.disabled = false;
      applyI18n();
      render();
      statusEl.textContent = "";
      break;
    }
    case "toast": {
      statusEl.textContent = msg.message;
      statusEl.classList.toggle("error", !!msg.error);
      if (!msg.error) {
        saveBtn.disabled = true;
        window.setTimeout(() => {
          statusEl.textContent = "";
        }, 2500);
      }
      break;
    }
  }
});

vscode.postMessage({ type: "ready" } satisfies WebviewMessage);
