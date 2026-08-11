import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/**
 * 设置 Webview 面板(供应商 + 模型 + 能力管理)。
 *
 * 本模块不依赖 src/providers/*(由并行任务创建),服务实现由主 agent 接线时注入。
 * 与面板侧(webview/providerSettings.ts)的通信协议:
 *   host → webview:{ type: "state"; providers; activeProviderId; models } | { type: "toast"; message; error? }
 *   webview → host:ready / create_provider / update_provider / remove_provider /
 *                 set_active / set_api_key / refresh_models / set_capability / import_ccswitch
 */

/** 供应商级能力(与 src/providers/types.ts 能力对齐,本地定义避免依赖)。 */
export interface ProviderCapabilities {
  supportsVision: boolean;
  supportsThinking: boolean;
  /** 可选思考强度预设(low/medium/high);supportsThinking 时经 effectiveThinkingBudgetTokens 派生预算。 */
  thinkingLevel?: "low" | "medium" | "high";
}

/** 面板渲染用的供应商视图。 */
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

/** 面板渲染用的模型视图。 */
export interface ModelView {
  id: string;
  capabilities: ProviderCapabilities;
  source: "builtin" | "remote" | "pinned";
}

/** 服务层最小接口(主 agent 用真实 ProviderStore/ModelCatalog/CapabilityRegistry 实现注入)。 */
export interface ProviderPanelServices {
  listProviders(): ProviderView[];
  getActiveProviderId(): string | undefined;
  /** 当前 UI 语言(设置面板文案跟随,zh=中文,en=英文)。 */
  getLocale(): "zh" | "en";
  createProvider(input: { name: string; baseUrl: string; modelListUrl?: string; apiKey?: string }): Promise<{ id: string }>;
  updateProvider(
    id: string,
    patch: Partial<{
      name: string;
      baseUrl: string;
      modelListUrl?: string;
      defaultCapabilities: ProviderCapabilities;
      modes: string[];
      pinnedModels?: string[];
    }>,
  ): Promise<void>;
  removeProvider(id: string): Promise<void>;
  setActiveProvider(id: string): Promise<void>;
  setApiKey(id: string, key: string): Promise<void>;
  resolveModels(providerId: string): ModelView[];
  refreshModels(providerId: string): Promise<void>;
  setCapabilityOverride(providerId: string, modelId: string, patch: Partial<ProviderCapabilities>): Promise<void>;
  importFromCcSwitch(): Promise<{ imported: number }>;
  /** 测试连接:发最小请求验证 baseUrl + API key。返回 { ok, message }。 */
  testConnection(providerId: string): Promise<{ ok: boolean; message: string }>;
  /**
   * 用宿主原生输入框配置 API Key(webview 内联表单在部分环境下展开无反应)。
   * 取消输入时 no-op。
   */
  promptApiKey(providerId: string): Promise<void>;
  /**
   * 用宿主原生输入框编辑名称/Base URL。
   * 取消输入时 no-op。
   */
  promptEditProvider(providerId: string): Promise<void>;
}

/** host → webview 消息。 */
export type ProviderPanelHostMessage =
  | {
      type: "state";
      providers: ProviderView[];
      activeProviderId?: string;
      models: ModelView[];
      /** UI 语言:zh=中文,en=英文。 */
      locale: "zh" | "en";
    }
  | { type: "toast"; message: string; error?: boolean };

/** webview → host 消息。 */
export type ProviderPanelMessage =
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
  | { type: "set_capability"; providerId: string; modelId: string; supportsVision?: boolean; supportsThinking?: boolean; thinkingLevel?: "low" | "medium" | "high"; vision?: boolean; thinking?: boolean }
  | { type: "import_ccswitch" }
  | { type: "test_connection"; providerId: string }
  | { type: "prompt_api_key"; id: string }
  | { type: "prompt_edit_provider"; id: string };

/**
 * 与 vscode.WebviewPanel 结构兼容的最小面板接口。
 * 真实 vscode.WebviewPanel 缺少 extensionUri,主 agent 装配时需包装一层:
 *   createProviderPanel({ webview: panel.webview, title: panel.title,
 *     onDidDispose: (cb) => void panel.onDidDispose(cb), extensionUri }, services);
 */
export interface VscodeWebviewPanelLike {
  readonly webview: {
    html: string;
    onDidReceiveMessage(cb: (msg: ProviderPanelMessage) => void): void;
    postMessage(msg: ProviderPanelHostMessage): Thenable<boolean>;
    /** 用于 CSP(真实 vscode.WebviewPanel 提供;缺失时渲染退化为空)。 */
    readonly cspSource?: string;
    /** 把本地资源 URI 转为 webview 可加载 URI(真实 vscode.WebviewPanel 提供)。 */
    asWebviewUri?(uri: vscode.Uri): vscode.Uri;
  };
  title?: string;
  onDidDispose(cb: () => void): void;
  /** 扩展根目录,用于定位 dist/webview 下的模板与资源。 */
  extensionUri: vscode.Uri;
}

/**
 * 创建并装配设置 Webview 面板:设置 HTML、处理 webview 消息、调用 services,
 * 每次变更后把最新状态 postMessage 回 webview。
 * deps.onError:测试连接等失败时的原生错误弹窗回调(extension 层注入 showErrorMessage)。
 */
export function createProviderPanel(
  panel: VscodeWebviewPanelLike,
  services: ProviderPanelServices,
  deps: { onError?: (message: string) => void } = {},
): void {
  panel.webview.html = renderHtml(panel.webview, panel.extensionUri);
  panel.webview.onDidReceiveMessage((msg) => {
    // 返回 promise 以便调用方/测试可 await 消息处理完成
    return handleMessage(msg, panel, services, deps);
  });
}

/** 收集面板所需的完整状态(供应商列表 + 当前供应商 + 当前供应商的已解析模型)。 */
function collectState(services: ProviderPanelServices): ProviderPanelHostMessage & { type: "state" } {
  const providers = services.listProviders();
  const activeProviderId = services.getActiveProviderId();
  const activeId = activeProviderId ?? providers[0]?.id;
  const models = activeId ? services.resolveModels(activeId) : [];
  return { type: "state", providers, activeProviderId, models, locale: services.getLocale() };
}

function postState(panel: VscodeWebviewPanelLike, services: ProviderPanelServices): PromiseLike<void> {
  return panel.webview.postMessage(collectState(services)).then(() => {}, () => {});
}

function toast(panel: VscodeWebviewPanelLike, message: string, error = false): PromiseLike<void> {
  return panel.webview.postMessage({ type: "toast", message, error }).then(() => {}, () => {});
}

async function handleMessage(
  raw: ProviderPanelMessage,
  panel: VscodeWebviewPanelLike,
  services: ProviderPanelServices,
  deps: { onError?: (message: string) => void },
): Promise<void> {
  try {
    switch (raw.type) {
      case "ready":
        await postState(panel, services);
        break;
      case "create_provider": {
        const { id } = await services.createProvider({
          name: raw.name,
          baseUrl: raw.baseUrl,
          modelListUrl: raw.modelListUrl,
          apiKey: raw.apiKey || undefined,
        });
        if (raw.apiKey) await services.setApiKey(id, raw.apiKey);
        // 新建后直接设为当前,模型列表立即联动展示该供应商的模型
        await services.setActiveProvider(id);
        await postState(panel, services);
        break;
      }
      case "update_provider":
        await services.updateProvider(raw.id, raw.patch);
        await postState(panel, services);
        break;
      case "remove_provider":
        await services.removeProvider(raw.id);
        await postState(panel, services);
        break;
      case "set_active":
        await services.setActiveProvider(raw.id);
        await postState(panel, services);
        break;
      case "set_api_key":
        await services.setApiKey(raw.id, raw.apiKey);
        await postState(panel, services);
        break;
      case "refresh_models": {
        // 未指定供应商时回退到当前(或第一个)供应商
        const providerId =
          raw.providerId ??
          services.getActiveProviderId() ??
          services.listProviders()[0]?.id;
        if (providerId) {
          await services.refreshModels(providerId);
          await postState(panel, services);
        }
        break;
      }
      case "set_capability": {
        const patch: Partial<ProviderCapabilities> = {};
        if (raw.supportsVision !== undefined) patch.supportsVision = raw.supportsVision;
        else if (raw.vision !== undefined) patch.supportsVision = raw.vision;
        if (raw.supportsThinking !== undefined) patch.supportsThinking = raw.supportsThinking;
        else if (raw.thinking !== undefined) patch.supportsThinking = raw.thinking;
        if (raw.thinkingLevel !== undefined) patch.thinkingLevel = raw.thinkingLevel;
        await services.setCapabilityOverride(raw.providerId, raw.modelId, patch);
        await postState(panel, services);
        break;
      }
      case "import_ccswitch": {
        const result = await services.importFromCcSwitch();
        await postState(panel, services);
        await toast(
          panel,
          result.imported > 0 ? `已导入 ${result.imported} 个供应商` : "没有可导入的供应商",
          result.imported === 0,
        );
        break;
      }
      case "test_connection": {
        const result = await services.testConnection(raw.providerId);
        await toast(panel, result.message, !result.ok);
        if (!result.ok) {
          // 原生错误弹窗(用户要求测试消息不对必须弹窗提醒)
          deps.onError?.(result.message);
        }
        break;
      }
      case "prompt_api_key":
        await services.promptApiKey(raw.id);
        await postState(panel, services);
        break;
      case "prompt_edit_provider":
        await services.promptEditProvider(raw.id);
        await postState(panel, services);
        break;
    }
  } catch (err) {
    await toast(panel, err instanceof Error ? err.message : String(err), true);
  }
}

/** 渲染模板:优先读 dist/webview/providerSettings.html,缺失时退化为内联模板。 */
function renderHtml(webview: VscodeWebviewPanelLike["webview"], extensionUri: vscode.Uri): string {
  const cspSource = webview.cspSource ?? "";
  // 先算出本地资源路径,再经 asWebviewUri 转成 webview 可加载 URI(测试注入的 fake 无该方法时回退本地路径字符串)
  const resource = (rel: string): string => {
    const local = vscode.Uri.joinPath(extensionUri, "dist", "webview", rel);
    return webview.asWebviewUri ? webview.asWebviewUri(local).toString() : local.toString();
  };
  const styles = resource("styles.css");
  const scripts = resource("providerSettings.js");
  const templatePath = path.join(extensionUri.fsPath, "dist", "webview", "providerSettings.html");
  let template: string | undefined;
  try {
    template = fs.readFileSync(templatePath, "utf8");
  } catch {
    // dist/webview/providerSettings.html 缺失时退化为内联模板,面板不抛异常
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
<h1>Provider 设置</h1>
<p>设置面板模板缺失(dist/webview/providerSettings.html 未生成),请重新构建扩展。</p>
<script src="\${scripts}"></script>
</body>
</html>`;
}
