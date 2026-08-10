import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { MemoryEntry } from "../agent/memory/memoryStore";
import { MemoryManager } from "../agent/memory/memoryManager";
import { t } from "../i18n/strings";

/**
 * 记忆管理 Webview 面板。
 *
 * 通信协议:
 *   host → webview:{ type: "state"; projectKey; project; global; locale } | { type: "toast"; message; error? }
 *   webview → host:ready / memory_write / memory_delete
 *
 * 数据读写全部委托 MemoryManager(引擎层,可单测),本模块只做消息路由与状态下发。
 */

/** host → webview 消息。 */
export type MemoryPanelHostMessage =
  | {
      type: "state";
      projectKey: string;
      project: MemoryEntry[];
      global: MemoryEntry[];
      locale: "zh" | "en";
    }
  | { type: "toast"; message: string; error?: boolean };

/** webview → host 消息。 */
export type MemoryPanelMessage =
  | { type: "ready" }
  | {
      type: "memory_write";
      scope: "project" | "global";
      name: string;
      description: string;
      body: string;
    }
  | { type: "memory_delete"; scope: "project" | "global"; name: string };

/** 与 vscode.WebviewPanel 结构兼容的最小面板接口(同 providerPanel)。 */
export interface VscodeWebviewPanelLike {
  readonly webview: {
    html: string;
    onDidReceiveMessage(cb: (msg: MemoryPanelMessage) => void): void;
    postMessage(msg: MemoryPanelHostMessage): Thenable<boolean>;
    readonly cspSource?: string;
    asWebviewUri?(uri: vscode.Uri): vscode.Uri;
  };
  title?: string;
  onDidDispose(cb: () => void): void;
  extensionUri: vscode.Uri;
}

/** 面板服务:由 extension 层用 MemoryManager 装配。 */
export interface MemoryPanelServices {
  getLocale(): "zh" | "en";
  list(): { projectKey: string; project: MemoryEntry[]; global: MemoryEntry[] };
  write(scope: "project" | "global", input: { name: string; description: string; body: string }): MemoryEntry;
  delete(scope: "project" | "global", name: string): void;
}

/** 创建并装配记忆管理面板。 */
export function createMemoryPanel(
  panel: VscodeWebviewPanelLike,
  services: MemoryPanelServices,
): void {
  panel.webview.html = renderHtml(panel.webview, panel.extensionUri);
  panel.webview.onDidReceiveMessage((msg) => {
    void handleMessage(msg, panel, services);
  });
  // 语言设置变更时刷新已打开面板,使界面文案即时跟随。
  const disposable = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("dsbAgent.language")) {
      void postState(panel, services);
    }
  });
  panel.onDidDispose(() => disposable.dispose());
}

function collectState(services: MemoryPanelServices): MemoryPanelHostMessage & { type: "state" } {
  const { projectKey, project, global } = services.list();
  return { type: "state", projectKey, project, global, locale: services.getLocale() };
}

function postState(panel: VscodeWebviewPanelLike, services: MemoryPanelServices): PromiseLike<void> {
  return panel.webview.postMessage(collectState(services)).then(() => {}, () => {});
}

function toast(panel: VscodeWebviewPanelLike, message: string, error = false): PromiseLike<void> {
  return panel.webview.postMessage({ type: "toast", message, error }).then(() => {}, () => {});
}

async function handleMessage(
  raw: MemoryPanelMessage,
  panel: VscodeWebviewPanelLike,
  services: MemoryPanelServices,
): Promise<void> {
  try {
    switch (raw.type) {
      case "ready":
        await postState(panel, services);
        break;
      case "memory_write":
        services.write(raw.scope, {
          name: raw.name,
          description: raw.description,
          body: raw.body,
        });
        await postState(panel, services);
        await toast(panel, t("已保存记忆: {name}", services.getLocale(), { name: raw.name }));
        break;
      case "memory_delete":
        services.delete(raw.scope, raw.name);
        await postState(panel, services);
        await toast(panel, t("已删除记忆: {name}", services.getLocale(), { name: raw.name }));
        break;
    }
  } catch (err) {
    await toast(panel, err instanceof Error ? err.message : String(err), true);
  }
}

/** 渲染模板:优先读 dist/webview/memoryPanel.html,缺失时退化为内联模板。 */
function renderHtml(webview: VscodeWebviewPanelLike["webview"], extensionUri: vscode.Uri): string {
  const cspSource = webview.cspSource ?? "";
  const resource = (rel: string): string => {
    const local = vscode.Uri.joinPath(extensionUri, "dist", "webview", rel);
    return webview.asWebviewUri ? webview.asWebviewUri(local).toString() : local.toString();
  };
  const styles = resource("styles.css");
  const scripts = resource("memoryPanel.js");
  const templatePath = path.join(extensionUri.fsPath, "dist", "webview", "memoryPanel.html");
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
<h1>记忆管理</h1>
<p>记忆管理模板缺失(dist/webview/memoryPanel.html 未生成),请重新构建扩展。</p>
<script src="\${scripts}"></script>
</body>
</html>`;
}

/** 供测试直接调用的消息处理(不依赖 webview 实例)。 */
export { handleMessage };
