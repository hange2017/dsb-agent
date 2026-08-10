import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { ColdChunk, ColdChunkType } from "../context/contextStore";
import { ContextStore } from "../context/contextStore";
import { t } from "../i18n/strings";

/**
 * 冷存储浏览 Webview 面板。
 *
 * 通信协议:
 *   host → webview:{ type:"state"; sessions; locale } | { type:"browse"; sessionId; entries } | { type:"toast"; message; error? }
 *   webview → host:ready / browse {sessionId} / clear {sessionId} / delete {sessionId} / merge_all {}
 *
 * 数据读写全部委托 ContextStore(引擎层,可单测),本模块只做消息路由与状态下发。
 * 与 memoryPanel 同构:renderHtml 优先读 dist/webview/contextPanel.html,缺失退化为内联模板。
 */

/** 会话视图(列表用,不含块内容)。 */
export interface SessionView {
  id: string;
  chunkCount: number;
  compacted: number;
  pruned: number;
}

/** 块视图(浏览用,content 供展开)。 */
export interface ChunkView {
  seq: number;
  type: ColdChunkType;
  role: ColdChunk["role"];
  summary: string;
  content: string;
}

/** host → webview 消息。 */
export type ContextPanelHostMessage =
  | {
      type: "state";
      sessions: SessionView[];
      locale: "zh" | "en";
    }
  | {
      type: "browse";
      sessionId: string;
      entries: ChunkView[];
    }
  | { type: "toast"; message: string; error?: boolean };

/** webview → host 消息。 */
export type ContextPanelMessage =
  | { type: "ready" }
  | { type: "browse"; sessionId: string }
  | { type: "clear"; sessionId: string }
  | { type: "delete"; sessionId: string }
  | { type: "merge_all" };

/** 与 vscode.WebviewPanel 结构兼容的最小面板接口(同 memoryPanel)。 */
export interface VscodeWebviewPanelLike {
  readonly webview: {
    html: string;
    onDidReceiveMessage(cb: (msg: ContextPanelMessage) => void): void;
    postMessage(msg: ContextPanelHostMessage): Thenable<boolean>;
    readonly cspSource?: string;
    asWebviewUri?(uri: vscode.Uri): vscode.Uri;
  };
  title?: string;
  onDidDispose(cb: () => void): void;
  extensionUri: vscode.Uri;
}

/** 面板服务:由 extension 层用 ContextStore 装配。 */
export interface ContextPanelServices {
  getLocale(): "zh" | "en";
  list(): SessionView[];
  browse(sessionId: string): ChunkView[];
  clear(sessionId: string): void;
  delete(sessionId: string): void;
  mergeAll(): { merged: number; removed: number };
}

/** 基于 ContextStore 的默认实现(供 extension 装配与测试复用)。 */
export function contextPanelServicesFromStore(store: ContextStore, locale: () => "zh" | "en"): ContextPanelServices {
  const toView = (id: string): SessionView => {
    const { compacted, pruned } = store.stats(id);
    return { id, chunkCount: store.index(id).length, compacted, pruned };
  };
  return {
    getLocale: locale,
    list: () => store.listSessions().map(toView),
    browse: (id) =>
      store.load(id).map((c) => ({
        seq: c.seq,
        type: c.type,
        role: c.role,
        summary: c.summary,
        content: c.content,
      })),
    clear: (id) => store.clear(id),
    delete: (id) => store.delete(id),
    mergeAll: () => {
      const ids = store.listSessions();
      return ids.length === 0 ? { merged: 0, removed: 0 } : store.merge(ids, "__all__");
    },
  };
}

/** 创建并装配冷存储浏览面板。 */
export function createContextPanel(
  panel: VscodeWebviewPanelLike,
  services: ContextPanelServices,
): void {
  panel.webview.html = renderHtml(panel.webview, panel.extensionUri);
  panel.webview.onDidReceiveMessage((msg) => {
    void handleMessage(msg, panel, services);
  });
}

function collectState(services: ContextPanelServices): ContextPanelHostMessage & { type: "state" } {
  return { type: "state", sessions: services.list(), locale: services.getLocale() };
}

function postState(panel: VscodeWebviewPanelLike, services: ContextPanelServices): PromiseLike<void> {
  return panel.webview.postMessage(collectState(services)).then(() => {}, () => {});
}

function toast(panel: VscodeWebviewPanelLike, message: string, error = false): PromiseLike<void> {
  return panel.webview.postMessage({ type: "toast", message, error }).then(() => {}, () => {});
}

async function handleMessage(
  raw: ContextPanelMessage,
  panel: VscodeWebviewPanelLike,
  services: ContextPanelServices,
): Promise<void> {
  try {
    switch (raw.type) {
      case "ready":
        await postState(panel, services);
        break;
      case "browse": {
        const entries = services.browse(raw.sessionId);
        await panel.webview.postMessage({ type: "browse", sessionId: raw.sessionId, entries });
        break;
      }
      case "clear":
        services.clear(raw.sessionId);
        await postState(panel, services);
        await toast(panel, t("已清空冷存储: {session}", services.getLocale(), { session: raw.sessionId }));
        break;
      case "delete":
        services.delete(raw.sessionId);
        await postState(panel, services);
        await toast(panel, t("已删除冷存储: {session}", services.getLocale(), { session: raw.sessionId }));
        break;
      case "merge_all": {
        const { merged, removed } = services.mergeAll();
        await postState(panel, services);
        await toast(panel, t("冷存储合并去重完成: {merged} 条(去重 {removed})", services.getLocale(), { merged, removed }));
        break;
      }
    }
  } catch (err) {
    await toast(panel, err instanceof Error ? err.message : String(err), true);
  }
}

/** 渲染模板:优先读 dist/webview/contextPanel.html,缺失时退化为内联模板。 */
function renderHtml(webview: VscodeWebviewPanelLike["webview"], extensionUri: vscode.Uri): string {
  const cspSource = webview.cspSource ?? "";
  const resource = (rel: string): string => {
    const local = vscode.Uri.joinPath(extensionUri, "dist", "webview", rel);
    return webview.asWebviewUri ? webview.asWebviewUri(local).toString() : local.toString();
  };
  const styles = resource("styles.css");
  const scripts = resource("contextPanel.js");
  const templatePath = path.join(extensionUri.fsPath, "dist", "webview", "contextPanel.html");
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
<h1>冷存储浏览</h1>
<p>冷存储浏览模板缺失(dist/webview/contextPanel.html 未生成),请重新构建扩展。</p>
<script src="\${scripts}"></script>
</body>
</html>`;
}

/** 供测试直接调用的消息处理(不依赖 webview 实例)。 */
export { handleMessage };
