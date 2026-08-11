import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { t } from "../i18n/strings";

/**
 * DSB Agent 参数设置 Webview 面板。
 *
 * 通信协议:
 *   host → webview:{ type: "state"; locale; config } | { type: "toast"; message; error? }
 *   webview → host:ready / budget_update / reset_defaults
 *
 * 数据读写全部委托 services(extension 层注入:读/写 vscode 配置),本模块只做消息路由与状态下发。
 * 后续新增参数区:扩展 config/消息类型 + 页面加卡片即可。
 */

/** 三块比例(压缩块/thinking/tail),调用方保证归一化。 */
export interface BudgetSplit {
  compacted: number;
  thinking: number;
  tail: number;
}

/** 思考模式配置(全局):镜像 dsbAgent.thinking.enabled + dsbAgent.thinking.level。
 *  level 为 "" 表示未设置(跟随模型级)。 */
export interface AgentThinkingConfig {
  enabled: boolean;
  level: "low" | "medium" | "high" | "";
}

/** 上下文预算配置(参数面板 5 项)。 */
export interface AgentBudgetConfig {
  /** 给大模型的输入最大长度(窗口);0 = 跟随模型能力。 */
  windowTokens: number;
  /** 历史信息总预算(tokens);0 = 关闭(回退现状)。 */
  budget: number;
  /** 三块比例(压缩块/thinking/tail)。 */
  split: BudgetSplit;
  /** 触发比例:每块 token ≥ 额定×该比例 → 压缩;缺省 0.75。 */
  triggerPct: number;
  /** 压缩后目标比例(滞回);缺省 0.5,须 < triggerPct。 */
  targetPct: number;
  /** 全局思考模式(enabled 总开关 + level 兜底强度)。 */
  thinking: AgentThinkingConfig;
}

/** host → webview 消息。 */
export type AgentSettingsHostMessage =
  | {
      type: "state";
      locale: "zh" | "en";
      config: AgentBudgetConfig;
    }
  | { type: "toast"; message: string; error?: boolean };

/** webview → host 消息。 */
export type AgentSettingsMessage =
  | { type: "ready" }
  | { type: "budget_update"; config: AgentBudgetConfig }
  | { type: "reset_defaults" };

/** 与 vscode.WebviewPanel 结构兼容的最小面板接口(同 memoryPanel)。 */
export interface VscodeWebviewPanelLike {
  readonly webview: {
    html: string;
    onDidReceiveMessage(cb: (msg: AgentSettingsMessage) => void): void;
    postMessage(msg: AgentSettingsHostMessage): Thenable<boolean>;
    readonly cspSource?: string;
    asWebviewUri?(uri: vscode.Uri): vscode.Uri;
  };
  title?: string;
  onDidDispose(cb: () => void): void;
  extensionUri: vscode.Uri;
}

/** 面板服务:由 extension 层用 vscode 配置装配。 */
export interface AgentSettingsServices {
  getLocale(): "zh" | "en";
  /** 当前上下文预算配置(5 项)。 */
  getBudget(): AgentBudgetConfig;
  /** 保存配置到 vscode 配置(Global);split 按和归一化防御。
   *  返回 Promise 时 host 会 await 完成后再回读下发(避免异步写未落盘就读到旧值)。 */
  updateBudget(config: AgentBudgetConfig): void | Promise<void>;
}

/** 归一化比例:非法/全 0 回退默认 45/20/35。 */
export function normalizeSplit(split: Partial<BudgetSplit> | undefined): BudgetSplit {
  const def: BudgetSplit = { compacted: 0.45, thinking: 0.2, tail: 0.35 };
  if (!split || typeof split !== "object") return { ...def };
  const c = Number(split.compacted);
  const t = Number(split.thinking);
  const l = Number(split.tail);
  if (![c, t, l].every((n) => Number.isFinite(n) && n > 0)) return { ...def };
  const sum = c + t + l;
  if (sum <= 0) return { ...def };
  return { compacted: c / sum, thinking: t / sum, tail: l / sum };
}

/** 归一化思考模式配置:非法 level 回退 ""(跟随模型),非法 enabled 回退 true。 */
export function normalizeThinkingConfig(t: Partial<AgentThinkingConfig> | undefined): AgentThinkingConfig {
  const level = t && ["low", "medium", "high"].includes(t.level as string) ? (t.level as AgentThinkingConfig["level"]) : "";
  const enabled = t ? t.enabled !== false : true;
  return { enabled, level };
}

/** 归一化 5 项配置:非法项回退默认;targetPct 须满足 0 < target < trigger ≤ 1。 */
export function normalizeConfig(cfg: Partial<AgentBudgetConfig> | undefined): AgentBudgetConfig {
  const def: AgentBudgetConfig = {
    windowTokens: 1000000,
    budget: 150000,
    split: { compacted: 0.45, thinking: 0.2, tail: 0.35 },
    triggerPct: 0.75,
    targetPct: 0.5,
    thinking: { enabled: true, level: "" },
  };
  if (!cfg || typeof cfg !== "object") {
    return { ...def, split: { ...def.split }, thinking: { ...def.thinking } };
  }
  const windowTokens = Number(cfg.windowTokens);
  const budget = Number(cfg.budget);
  let triggerPct = Number(cfg.triggerPct);
  if (!(Number.isFinite(triggerPct) && triggerPct > 0 && triggerPct <= 1)) triggerPct = def.triggerPct;
  let targetPct = Number(cfg.targetPct);
  if (!(Number.isFinite(targetPct) && targetPct > 0 && targetPct < 1 && targetPct < triggerPct)) {
    targetPct = def.targetPct;
  }
  return {
    windowTokens: Number.isFinite(windowTokens) && windowTokens >= 0 ? Math.floor(windowTokens) : def.windowTokens,
    budget: Number.isFinite(budget) && budget >= 0 ? Math.floor(budget) : def.budget,
    split: normalizeSplit(cfg.split),
    triggerPct,
    targetPct,
    thinking: normalizeThinkingConfig(cfg.thinking),
  };
}

/** 创建并装配参数设置面板。 */
export function createAgentSettingsPanel(
  panel: VscodeWebviewPanelLike,
  services: AgentSettingsServices,
): void {
  panel.webview.html = renderHtml(panel.webview, panel.extensionUri);
  panel.webview.onDidReceiveMessage((msg) => {
    void handleMessage(msg, panel, services);
  });
}

function collectState(services: AgentSettingsServices): AgentSettingsHostMessage & { type: "state" } {
  return { type: "state", locale: services.getLocale(), config: services.getBudget() };
}

function postState(panel: VscodeWebviewPanelLike, services: AgentSettingsServices): PromiseLike<void> {
  return panel.webview.postMessage(collectState(services)).then(() => {}, () => {});
}

function toast(panel: VscodeWebviewPanelLike, message: string, error = false): PromiseLike<void> {
  return panel.webview.postMessage({ type: "toast", message, error }).then(() => {}, () => {});
}

async function handleMessage(
  raw: AgentSettingsMessage,
  panel: VscodeWebviewPanelLike,
  services: AgentSettingsServices,
): Promise<void> {
  try {
    switch (raw.type) {
      case "ready":
        await postState(panel, services);
        break;
      case "budget_update": {
        const config = normalizeConfig(raw.config);
        // await 写配置完成后再回读下发,避免异步写未落盘时读到旧值(界面被刷回)
        await services.updateBudget(config);
        await postState(panel, services);
        await toast(panel, t("已保存上下文预算", services.getLocale()));
        break;
      }
      case "reset_defaults": {
        // 恢复默认 5 项:窗口 1M / 总预算 100K / 45-20-35 / 触发 75% / 目标 50%
        await services.updateBudget(normalizeConfig(undefined));
        await postState(panel, services);
        await toast(panel, t("已恢复默认参数", services.getLocale()));
        break;
      }
    }
  } catch (err) {
    await toast(panel, err instanceof Error ? err.message : String(err), true);
  }
}

/** 渲染模板:优先读 dist/webview/agentSettingsPanel.html,缺失时退化为内联模板。 */
function renderHtml(webview: VscodeWebviewPanelLike["webview"], extensionUri: vscode.Uri): string {
  const cspSource = webview.cspSource ?? "";
  const resource = (rel: string): string => {
    const local = vscode.Uri.joinPath(extensionUri, "dist", "webview", rel);
    return webview.asWebviewUri ? webview.asWebviewUri(local).toString() : local.toString();
  };
  const styles = resource("styles.css");
  const scripts = resource("agentSettingsPanel.js");
  const templatePath = path.join(extensionUri.fsPath, "dist", "webview", "agentSettingsPanel.html");
  let template: string | undefined;
  try {
    template = fs.readFileSync(templatePath, "utf8");
  } catch {
    // 模板缺失时退化为内联模板,面板不抛异常
  }
  return (template ?? fallbackHtml())
    .replaceAll("${styles}", styles)
    .replaceAll("${scripts}", scripts)
    .replaceAll("${cspSource}", cspSource);
}

function fallbackHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src \${cspSource} 'unsafe-inline'; script-src \${cspSource}; img-src \${cspSource} data:;">
<link href="\${styles}" rel="stylesheet">
</head>
<body>
<h1>DSB Agent 参数设置</h1>
<p>参数设置模板缺失(dist/webview/agentSettingsPanel.html 未生成),请重新构建扩展。</p>
<script src="\${scripts}"></script>
</body>
</html>`;
}

/** 供测试直接调用的消息处理(不依赖 webview 实例)。 */
export { handleMessage, normalizeSplit as _normalizeSplit, normalizeConfig as _normalizeConfig };
