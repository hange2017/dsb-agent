import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { ChatViewProvider } from "./chat/chatViewProvider";
import { MemoryStore } from "./agent/memory/memoryStore";
import { SecretStorageApiKeyStore } from "./settings/apiKeyStore";
import { Configuration } from "./settings/configuration";
import { createGitBackend, MarketplaceManager } from "./plugins/marketplace";
import { McpRegistry } from "./mcp/mcpRegistry";
import { createGitWorktree } from "./agent/worktree";
import { ProjectScope, realGit } from "./agent/projectScope";
import { migrateLegacySessions } from "./session/sessionStore";
import { VscodeSessionUiState } from "./settings/sessionUiState";
import { ContextCapture } from "./context/contextCapture";
import { ContextStore } from "./context/contextStore";
import { configureRipgrepPath, pickRipgrepPath } from "./util/ripgrepPath";
import { ProviderStore, isProviderNameTaken, type SecretStore } from "./providers/providerStore";
import { ModelCatalog, sanitizeProviderUrl } from "./providers/modelCatalog";
import { CapabilityRegistry } from "./providers/capabilityRegistry";
import { importFromCcSwitch } from "./providers/ccSwitchImport";
import { AnthropicMessagesClient } from "./agent/provider/anthropicMessagesClient";
import { t } from "./i18n/strings";
import { noProviderChoices, DEFAULT_COMPAT_BASE_URL } from "./settings/providerChoices";
import { createProviderPanel } from "./settings/providerPanel";
import { createMemoryPanel } from "./settings/memoryPanel";
import { createContextPanel, contextPanelServicesFromStore } from "./settings/contextPanel";
import { createAgentSettingsPanel } from "./settings/agentSettingsPanel";
import { MemoryManager } from "./agent/memory/memoryManager";
import { ActivityStatsStore, DailySummaryReminder } from "./stats/activityStats";
import { StatsStore } from "./stats/statsStore";
import type { ProviderDef } from "./providers/types";
import type { ApiKeyStore } from "./settings/apiKeyStore";

let activeProvider: ChatViewProvider | undefined;

/** 设置面板变更后把供应商列表同步到 Agent 顶栏(不重置会话)。 */
function syncChatProviderUi(): void {
  activeProvider?.getController()?.syncProviderUi();
}

/** 旧扁平配置迁移:providers 为空且 baseUrl 被用户自定义过 → 生成 legacy 供应商并迁移旧 API key。 */
async function migrateLegacyConfig(
  providerStore: ProviderStore,
  configuration: Configuration,
  apiKeyStore: ApiKeyStore,
): Promise<void> {
  if (providerStore.list().length > 0) return;
  const baseUrl = configuration.baseUrl();
  if (!baseUrl || baseUrl === "https://api.deepseek.com/anthropic") return;
  const legacy: ProviderDef = {
    id: "legacy",
    name: "Legacy",
    baseUrl,
    defaultCapabilities: { supportsVision: false, supportsThinking: true },
    modes: ["agent", "plan", "ask"],
    source: "manual",
    createdAt: Date.now(),
  };
  providerStore.upsert(legacy);
  await providerStore.setActive("legacy");
  const oldKey = await apiKeyStore.getApiKey();
  if (oldKey) await providerStore.setApiKey("legacy", oldKey);
}

/** 管理供应商 QuickPick 流程:新建/切换/编辑/删除/配 key/刷新模型/cc-switch 导入。 */
async function manageProviders(
  providerStore: ProviderStore,
  modelCatalog: ModelCatalog,
  secret: SecretStore,
  locale: "zh" | "en" = "zh",
): Promise<void> {
  const refresh = async (): Promise<void> => {
    const active = providerStore.getActive();
    if (!active) {
      void vscode.window.showWarningMessage(t("尚未配置供应商", locale));
      return;
    }
    try {
      const apiKey = (await providerStore.getApiKey(active.id)) ?? (await secret.get("dsbApiKey")) ?? undefined;
      await modelCatalog.fetchModels(active, { apiKey: apiKey || undefined, force: true });
      void vscode.window.showInformationMessage(t("已刷新模型列表({count} 个模型)", locale, { count: modelCatalog.resolveModels(active).length }));
    } catch (err) {
      void vscode.window.showWarningMessage(t("刷新模型列表失败,已回退内置预设: {error}", locale, { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  const createFlow = async (): Promise<void> => {
    const name = await vscode.window.showInputBox({ prompt: t("供应商名称(如 默认兼容端点)", locale), placeHolder: t("名称", locale) });
    if (!name) return;
    if (isProviderNameTaken(providerStore.list(), name)) {
      void vscode.window.showErrorMessage(t("供应商名称已存在: {name}", locale, { name: name.trim() }));
      return;
    }
    const baseUrl = await vscode.window.showInputBox({
      prompt: t("Anthropic 兼容 API Base URL", locale),
      placeHolder: "https://api.deepseek.com/anthropic",
    });
    if (!baseUrl) return;
    const apiKey = await vscode.window.showInputBox({ prompt: t("API Key(可稍后配置)", locale), password: true, placeHolder: "sk-..." });
    const def: ProviderDef = {
      id: `p_${Math.random().toString(36).slice(2, 10)}`,
      name: name.trim(),
      baseUrl,
      defaultCapabilities: { supportsVision: false, supportsThinking: true },
      modes: ["agent", "plan", "ask"],
      protocol: "anthropic", // 扩展仅支持 Anthropic 兼容协议
      source: "manual",
      createdAt: Date.now(),
    };
    providerStore.upsert(def);
    await providerStore.setActive(def.id);
    if (apiKey) await providerStore.setApiKey(def.id, apiKey);
    void vscode.window.showInformationMessage(t("已创建并切换到供应商 {name}", locale, { name: def.name }));
  };

  const editFlow = async (p: ProviderDef): Promise<void> => {
    const action = await vscode.window.showQuickPick(
      [
        { label: t("切换到此供应商", locale), action: "switch" },
        { label: t("配置 API Key", locale), action: "key" },
        { label: t("编辑 Base URL", locale), action: "url" },
        { label: t("删除供应商", locale), action: "delete" },
      ],
      { placeHolder: t("供应商: {name}", locale, { name: p.name }) },
    );
    if (!action) return;
    if (action.action === "switch") {
      await providerStore.setActive(p.id);
      void vscode.window.showInformationMessage(t("已切换到 {name}", locale, { name: p.name }));
      activeProvider?.getController()?.handle({ type: "set_provider", providerId: p.id });
    } else if (action.action === "key") {
      const key = await vscode.window.showInputBox({ prompt: t("API Key({name})", locale, { name: p.name }), password: true, placeHolder: "sk-..." });
      if (key) {
        await providerStore.setApiKey(p.id, key);
        void vscode.window.showInformationMessage(t("API Key 已保存", locale));
      }
    } else if (action.action === "url") {
      const url = await vscode.window.showInputBox({ prompt: t("Anthropic 兼容 API Base URL", locale), value: p.baseUrl });
      if (url) {
        providerStore.upsert({ ...p, baseUrl: url });
        void vscode.window.showInformationMessage(t("Base URL 已更新", locale));
      }
    } else if (action.action === "delete") {
      const confirm = await vscode.window.showWarningMessage(t("删除供应商 {name}?", locale, { name: p.name }), { modal: true }, t("删除", locale));
      if (confirm === t("删除", locale)) {
        providerStore.remove(p.id);
        void vscode.window.showInformationMessage(t("已删除 {name}", locale, { name: p.name }));
      }
    }
  };

  const importCcSwitchFlow = async (): Promise<void> => {
    try {
      const r = await importFromCcSwitch({
        secret,
        writer: {
          updateSetting: async (key, value) => {
            await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global);
          },
        },
        existing: providerStore.list(),
      });
      if (r.imported.length === 0) {
        void vscode.window.showInformationMessage(t("未在 cc-switch 中发现可导入的兼容供应商(检查 ~/.cc-switch 与 ~/.claude/settings.json)", locale));
        return;
      }
      await providerStore.setActive(r.imported[0].id);
      void vscode.window.showInformationMessage(`已从 cc-switch 导入 ${r.imported.length} 个供应商并切换`);
    } catch (err) {
      void vscode.window.showErrorMessage(`导入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 备选项只列当前扩展支持的协议(Anthropic 兼容);不兼容的在设置面板管理
  const allProviders = providerStore.list();
  const compatible = allProviders.filter((p) => p.protocol !== "openai");
  const incompatible = allProviders.filter((p) => p.protocol === "openai");
  if (allProviders.length === 0) {
    // 无供应商:推荐式引导(内置模板一键创建 / cc-switch 导入 / 手动创建)
    const choice = await vscode.window.showQuickPick(
      noProviderChoices(locale).map((c) => ({ label: c.label, detail: c.detail, action: c.action })),
      { placeHolder: t("尚未配置供应商,选择一个方式开始", locale) },
    );
    if (!choice) return;
    if (choice.action === "template") {
      const def: ProviderDef = {
        id: `p_${Math.random().toString(36).slice(2, 10)}`,
        name: "默认兼容端点",
        baseUrl: DEFAULT_COMPAT_BASE_URL,
        defaultCapabilities: { supportsVision: false, supportsThinking: true },
        modes: ["agent", "plan", "ask"],
        protocol: "anthropic",
        source: "manual",
        createdAt: Date.now(),
      };
      providerStore.upsert(def);
      await providerStore.setActive(def.id);
      void vscode.window.showInformationMessage(t("已创建默认兼容端点供应商,可在设置面板配置 API Key 后开始对话", locale));
      void vscode.commands.executeCommand("dsbAgent.providerSettings");
    } else if (choice.action === "ccswitch") {
      await importCcSwitchFlow();
    } else {
      await createFlow();
    }
    return;
  }
  const activeId = providerStore.getActive()?.id;
  const pick = await vscode.window.showQuickPick(
    [
      ...compatible.map((p) => ({
        label: p.id === activeId ? `$(check) ${p.name}` : p.name,
        description: p.baseUrl,
        detail: p.id === activeId ? t("当前供应商", locale) : undefined,
        provider: p,
      })),
      ...(incompatible.length > 0
        ? [
            {
              label: t("管理不兼容供应商(设置面板)", locale),
              detail: t("{count} 个供应商协议暂不支持(仅 Anthropic 兼容),可在设置面板编辑或删除", locale, { count: incompatible.length }),
              openSettings: true as const,
            },
          ]
        : []),
      { label: t("新建供应商", locale), detail: t("创建并切换到新供应商", locale), create: true },
      { label: t("从 cc-switch 导入", locale), detail: t("读取 ~/.cc-switch 中已配置的兼容供应商", locale), ccSwitch: true },
      { label: t("刷新当前供应商模型列表", locale), detail: t("远程拉取 /v1/models 并缓存", locale), refresh: true },
    ],
    { placeHolder: t("管理供应商", locale) },
  );
  if (!pick) return;
  if ("create" in pick) await createFlow();
  else if ("ccSwitch" in pick) await importCcSwitchFlow();
  else if ("refresh" in pick) await refresh();
  else if ("openSettings" in pick) void vscode.commands.executeCommand("dsbAgent.providerSettings");
  else if ("provider" in pick && pick.provider) await editFlow(pick.provider);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Grep 必须用绝对路径:扩展宿主 PATH 通常没有 `rg`(否则 spawn rg ENOENT)
  configureRipgrepPath(
    pickRipgrepPath({
      extensionPath: context.extensionPath,
      appRoot: vscode.env.appRoot,
      distDir: path.join(context.extensionPath, "dist"),
    }),
  );

  const apiKeyStore = new SecretStorageApiKeyStore(context.secrets);

  const configuration = new Configuration({
    getString: (key: string) => {
      const v = vscode.workspace.getConfiguration().get(key);
      if (typeof v === "boolean") {
        return v ? "true" : "false";
      }
      // 数字/字符串配置都转字符串(historyTokenBudget 等 number 配置若丢弃会回退默认)
      if (typeof v === "number") {
        return String(v);
      }
      return typeof v === "string" ? v : "";
    },
    getJson: <T,>(key: string) => vscode.workspace.getConfiguration().get<T>(key) as T,
  });

  // 供应商存储:定义写 VS Code settings(可见可备份),API key 写 secretStorage(不落盘明文)。
  // 当前供应商/模型 id 也写 settings,重启保留。
  const secretAdapter = {
    get: async (key: string) => await context.secrets.get(key),
    set: async (key: string, value: string) => {
      await context.secrets.store(key, value);
    },
    delete: async (key: string) => {
      await context.secrets.delete(key);
    },
  };
  const providerStore = new ProviderStore({
    reader: {
      getJson: <T,>(key: string) => vscode.workspace.getConfiguration().get<T>(key) as T,
    },
    writer: {
      updateSetting: async (key, value) => {
        await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global);
      },
    },
    secret: secretAdapter,
  });
  const modelCatalog = new ModelCatalog();
  const capabilityRegistry = new CapabilityRegistry();
  // 旧扁平配置(baseUrl/model/apiKey)迁移为首个 legacy 供应商
  void migrateLegacyConfig(providerStore, configuration, apiKeyStore);

  // 自愈:清洗历史配置里的不可见字符(BOM / 零宽空格等),避免拼接模型列表 URL 时 404。
  // ProviderStore.list() 经 normalizeProviderDef 已返回清洗值,直接回写即可幂等落盘。
  try {
    const dirty = providerStore.list();
    if (dirty.length > 0) {
      const raw = vscode.workspace.getConfiguration().get<unknown[]>("dsbAgent.providers");
      const DIRTY_RE = /[\u200B-\u200D\uFEFF\u00A0]|\/+$/;
      const needsWrite =
        Array.isArray(raw) &&
        raw.some((r) => {
          if (typeof r !== "object" || r === null) return false;
          const rec = r as { baseUrl?: unknown; modelListUrl?: unknown };
          return (
            (typeof rec.baseUrl === "string" && DIRTY_RE.test(rec.baseUrl)) ||
            (typeof rec.modelListUrl === "string" && DIRTY_RE.test(rec.modelListUrl))
          );
        });
      if (needsWrite) {
        for (const p of dirty) providerStore.upsert(p);
      }
    }
  } catch {
    // 自愈失败不阻塞启动
  }

  // 项目作用域:同一 git 仓库(含不同 worktree 目录)归一到同一个 projectKey,
  // 会话/记忆按项目隔离。git 读取失败回退到工作区路径 slug(fail-open)。
  const projectScope = new ProjectScope(realGit, () =>
    vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [],
  );
  const projectKey = await projectScope.current();

  // 跨会话记忆存储:controller 与 executor 共享,目录默认 `~/.dsb/memory`,可配置覆盖。
  // 记忆按项目隔离:根实例是全局记忆(兼容旧版 ~/.dsb/memory/*.json),项目实例落在
  // `<dir>/<projectKey>/` 子目录。工具与 /memory 命令默认操作项目记忆(B5 提供 scope 参数,
  // B6 注入时合并全局 + 项目索引)。
  const memoryRoot = new MemoryStore(configuration.memoryDir());
  const memory = memoryRoot.scoped(projectKey);
  // 每日活动统计:记录每天最后一次发送时间,按项目 key 分目录;供工作总结提醒使用。
  const activityStats = new ActivityStatsStore(path.join(path.dirname(configuration.memoryDir()), "stats", projectKey));
  // 统计大模块:通用事件日志(JSONL,按天分文件),供未来使用方式/参数调优分析。
  const statsStore = new StatsStore(path.join(path.dirname(configuration.memoryDir()), "stats", projectKey));
  // 旧版会话文件(直接落在 sessionsRoot 根下)迁移到 `<sessionsRoot>/<projectKey>/`,
  // 会话 id 不变,lastSessionId 指向的旧会话仍可恢复。
  const sessionsRoot = vscode.Uri.joinPath(context.globalStorageUri, "sessions").fsPath;
  try {
    migrateLegacySessions(sessionsRoot, projectKey);
  } catch {
    // 迁移失败不阻断激活;旧会话仍留在原目录,下次启动重试
  }
  const sessionsDir = path.join(sessionsRoot, projectKey);

  // 冷存储根目录:按项目隔离,压缩前的上下文原文落在
  // `<globalStorage>/context/<projectKey>/<sessionId>.context.json`。
  const contextRoot = path.join(context.globalStorageUri.fsPath, "context", projectKey);
  fs.mkdirSync(contextRoot, { recursive: true });

  // 插件市场管理器:引擎层纯 TS(无 vscode 依赖),缓存落在扩展全局存储目录,
  // 内部自建 marketplaces/ 与 plugins/ 子目录。git 源用 `git clone` CLI 后端(execFile,无新依赖);
  // 测试注入 stub GitLike 走同一接口。
  const marketplace = new MarketplaceManager({
    cacheDir: context.globalStorageUri.fsPath,
    git: createGitBackend(),
  });

  // MCP 服务器注册表:引擎层纯 TS(无 vscode 依赖),由 controller init 时读工作区 .mcp.json 并连接。
  const mcp = new McpRegistry();

  // git 工作树 API:后台任务在隔离工作树中运行,不污染主分支。git exec 用 execFile("git",...);
  // getDefaultBranch 用 `git symbolic-ref refs/remotes/origin/HEAD` 回退 master。getBase 在命令时解析当前工作区。
  const worktree = createGitWorktree(() => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "");

  // 上次会话 / 中断标志按项目隔离:globalState key 带 projectKey 前缀,
  // 不同项目恢复各自的 lastSessionId,互不串扰(旧版无前缀 key 作为升级回退)。
  const sessionUiState = new VscodeSessionUiState(context.globalState).scoped(projectKey);

  const contextCapture = new ContextCapture();

  // UI 语言:设置面板显式选择(dsbAgent.language)优先,否则跟随 VS Code 界面语言
  const defaultLocale: "zh" | "en" =
    configuration.language() || (vscode.env.language.toLowerCase().startsWith("zh") ? "zh" : "en");

  const provider = new ChatViewProvider(
    context.extensionUri,
    apiKeyStore,
    configuration,
    sessionsDir,
    memory,
    memoryRoot,
    marketplace,
    mcp,
    context.globalStorageUri.fsPath,
    contextRoot,
    worktree,
    sessionUiState,
    contextCapture,
    providerStore,
    modelCatalog,
    capabilityRegistry,
    defaultLocale,
    activityStats,
    statsStore,
  );
  activeProvider = provider;

  // 每日工作总结提醒:使用 ≥3 个工作日后,按平均收工时间提前 20 分钟提醒;
  // 点击「生成」→ 打开面板并让 agent 构建当日总结、按工程进度更新项目文档。
  const summaryReminder = new DailySummaryReminder({
    stats: activityStats,
    now: () => new Date(),
    notify: async (info) => {
      const summarizeLabel = t("生成今日总结并更新项目文档", defaultLocale);
      const dismissLabel = t("稍后", defaultLocale);
      const action = await vscode.window.showInformationMessage(
        t("今天到你的平均收工时间({time})了。要生成本日工作总结,并按工程进度更新项目文档吗?", defaultLocale, {
          time: info.avgTime,
        }),
        summarizeLabel,
        dismissLabel,
      );
      if (action === summarizeLabel) {
        try {
          await vscode.commands.executeCommand("dsbAgent.open");
          const c = activeProvider?.getController();
          if (c) await c.requestDailySummary();
          else await vscode.window.showInformationMessage(t("请打开 DSBAgent 面板,发送消息即可生成总结", defaultLocale));
        } catch {
          // 生成失败不阻断
        }
      }
      return action === summarizeLabel ? "summarize" : "dismiss";
    },
  });
  summaryReminder.start();
  context.subscriptions.push({ dispose: () => summaryReminder.stop() });

  contextCapture.setOnCaptured((chip) => {
    activeProvider?.getController()?.addPendingChips([chip]);
  });
  contextCapture.register(context);
  // 右侧聊天面板(WebviewPanel in ViewColumn.Beside),状态栏按钮作为常驻入口
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = "$(bot) DSBAgent";
  statusBar.tooltip = t("在右侧打开 DSBAgent 聊天面板", defaultLocale);
  statusBar.command = "dsbAgent.open";
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("dsbAgent.open", async () => {
      // 首次引导:无任何供应商时提示创建
      if (providerStore.list().length === 0) {
        const createLabel = t("创建供应商", defaultLocale);
        const skipLabel = t("跳过", defaultLocale);
        const action = await vscode.window.showInformationMessage(
          t("尚未配置 AI 供应商。创建供应商后即可开始对话(名称 + Base URL + API Key)。", defaultLocale),
          createLabel,
          skipLabel,
        );
        if (action === createLabel) {
          // 直接打开设置面板(含新建表单),避免 InputBox 与聊天 webview 抢焦点难用
          void vscode.commands.executeCommand("dsbAgent.providerSettings");
        }
      }
      provider.show();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dsbAgent.manageProviders", async () => {
      await manageProviders(providerStore, modelCatalog, secretAdapter, defaultLocale);
      // 管理后刷新面板(供应商/模型联动)
      activeProvider?.getController()?.handle({ type: "set_provider", providerId: providerStore.getActive()?.id ?? "" }).catch(() => {});
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dsbAgent.providerSettings", async () => {
      const panel = vscode.window.createWebviewPanel(
        "dsbAgent.providerSettings",
        t("供应商设置", defaultLocale),
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, "dist"),
            vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
          ],
        },
      );
      createProviderPanel(
        {
          webview: panel.webview,
          title: panel.title,
          onDidDispose: (cb) => void panel.onDidDispose(cb),
          extensionUri: context.extensionUri,
        },
        {
          listProviders: () => providerStore.list(),
          getActiveProviderId: () => providerStore.getActive()?.id,
          getLocale: () => configuration.language() || (vscode.env.language.toLowerCase().startsWith("zh") ? "zh" : "en"),
          createProvider: async (input) => {
            if (isProviderNameTaken(providerStore.list(), input.name)) {
              throw new Error(t("供应商名称已存在: {name}", defaultLocale, { name: input.name.trim() }));
            }
            const def: ProviderDef = {
              id: `p_${Math.random().toString(36).slice(2, 10)}`,
              name: input.name.trim(),
              baseUrl: input.baseUrl.trim().replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "").replace(/\/+$/, ""),
              ...(input.modelListUrl?.trim()
                ? { modelListUrl: input.modelListUrl.trim().replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "") }
                : {}),
              defaultCapabilities: { supportsVision: false, supportsThinking: true },
              modes: ["agent", "plan", "ask"],
              protocol: "anthropic", // 扩展仅支持 Anthropic 兼容协议
              source: "manual",
              createdAt: Date.now(),
            };
            providerStore.upsert(def);
            await providerStore.setActive(def.id);
            if (input.apiKey) await providerStore.setApiKey(def.id, input.apiKey);
            syncChatProviderUi();
            return { id: def.id };
          },
          updateProvider: async (id, patch) => {
            const p = providerStore.get(id);
            if (!p) return;
            if (patch.name !== undefined && isProviderNameTaken(providerStore.list(), patch.name, id)) {
              throw new Error(t("供应商名称已存在: {name}", defaultLocale, { name: patch.name.trim() }));
            }
            const { modes, ...rest } = patch;
            providerStore.upsert({
              ...p,
              ...rest,
              ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
              modes: modes ? (modes as ProviderDef["modes"]) : p.modes,
            });
            syncChatProviderUi();
          },
          removeProvider: async (id) => {
            providerStore.remove(id);
            syncChatProviderUi();
          },
          setActiveProvider: async (id) => {
            await providerStore.setActive(id);
            syncChatProviderUi();
          },
          setApiKey: async (id, key) => {
            await providerStore.setApiKey(id, key);
            syncChatProviderUi();
          },
          promptApiKey: async (id) => {
            const p = providerStore.get(id);
            if (!p) return;
            const key = await vscode.window.showInputBox({
              prompt: t("API Key({name})", defaultLocale, { name: p.name }),
              password: true,
              placeHolder: "sk-...",
            });
            if (key) {
              await providerStore.setApiKey(id, key);
              void vscode.window.showInformationMessage(t("API Key 已保存", defaultLocale));
              syncChatProviderUi();
            }
          },
          promptEditProvider: async (id) => {
            const p = providerStore.get(id);
            if (!p) return;
            const name = await vscode.window.showInputBox({
              prompt: t("供应商名称(如 默认兼容端点)", defaultLocale),
              value: p.name,
              placeHolder: t("名称", defaultLocale),
            });
            if (name === undefined) return;
            const trimmedName = name.trim() || p.name;
            if (isProviderNameTaken(providerStore.list(), trimmedName, id)) {
              void vscode.window.showErrorMessage(t("供应商名称已存在: {name}", defaultLocale, { name: trimmedName }));
              return;
            }
            const baseUrl = await vscode.window.showInputBox({
              prompt: t("Anthropic 兼容 API Base URL", defaultLocale),
              value: p.baseUrl,
              placeHolder: "https://api.deepseek.com/anthropic",
            });
            if (baseUrl === undefined) return;
            const modelListUrl = await vscode.window.showInputBox({
              prompt: t("自定义模型列表 URL(留空则移除)", defaultLocale),
              value: p.modelListUrl ?? "",
              placeHolder: t("可选", defaultLocale),
            });
            if (modelListUrl === undefined) return;
            const nextUrl = sanitizeProviderUrl(baseUrl) || p.baseUrl;
            providerStore.upsert({
              ...p,
              name: trimmedName,
              baseUrl: nextUrl,
              modelListUrl: modelListUrl.trim() ? sanitizeProviderUrl(modelListUrl) : undefined,
            });
            void vscode.window.showInformationMessage(t("供应商已更新", defaultLocale));
            syncChatProviderUi();
          },
          resolveModels: (providerId) => {
            const p = providerStore.get(providerId);
            return p ? modelCatalog.resolveModels(p) : [];
          },
          refreshModels: async (providerId) => {
            const p = providerStore.get(providerId);
            if (!p) return;
            const apiKey = (await providerStore.getApiKey(providerId)) ?? undefined;
            if (!apiKey?.trim()) {
              throw new Error(t("未配置 API Key,请先保存密钥", defaultLocale));
            }
            // force 跳过 TTL 但不先清缓存:失败时仍保留上次成功列表
            await modelCatalog.fetchModels(p, { apiKey, force: true });
          },
          setCapabilityOverride: async (providerId, modelId, patch) => {
            const p = providerStore.get(providerId);
            if (!p) return;
            const next = capabilityRegistry.buildOverride(p, modelId, patch);
            providerStore.upsert({ ...p, capabilityOverrides: next });
          },
          importFromCcSwitch: async () => {
            const r = await importFromCcSwitch({
              secret: secretAdapter,
              writer: {
                updateSetting: async (key, value) => {
                  await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global);
                },
              },
              existing: providerStore.list(),
            });
            // import 直接写 settings;把导入项灌入 store 内存,避免 list() 仍读旧快照
            for (const def of r.imported) {
              providerStore.upsert(def);
            }
            syncChatProviderUi();
            return { imported: r.imported.length };
          },
          testConnection: async (providerId) => {
            const p = providerStore.get(providerId);
            if (!p) return { ok: false, message: t("供应商不存在", defaultLocale) };
            const apiKey = await providerStore.getApiKey(providerId);
            if (!apiKey) return { ok: false, message: t("未配置 API Key,请先保存密钥", defaultLocale) };
            // 测试模型:优先 pinned → 已解析第一模型 → 配置默认(保证真实存在的模型名)
            const models = modelCatalog.resolveModels(p);
            const model = p.pinnedModels?.[0] ?? models[0]?.id ?? configuration.model();
            const client = new AnthropicMessagesClient({
              apiKey,
              baseUrl: p.baseUrl,
              model,
              capabilities: { supportsVision: false, supportsThinking: false },
            });
            try {
              await client.round(
                [{ role: "user", content: "ping" }],
                { system: "", tools: [], signal: AbortSignal.timeout(15_000) },
                () => {},
              );
              return { ok: true, message: t("连接成功", defaultLocale) };
            } catch (err) {
              return { ok: false, message: err instanceof Error ? err.message : String(err) };
            }
          },
        },
        {
          // 测试连接失败等:原生错误弹窗(用户要求测试消息不对必须弹窗提醒)
          onError: (message) => {
            void vscode.window.showErrorMessage(t("供应商连接失败: {error}", defaultLocale, { error: message }));
          },
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dsbAgent.setApiKey", async () => {
      const current = await apiKeyStore.getApiKey();
      const value = await vscode.window.showInputBox({
        prompt: t("API Key", defaultLocale),
        password: true,
        placeHolder: current ? t("输入新 key 覆盖(留空取消)", defaultLocale) : "sk-...",
      });
      if (value) {
        await apiKeyStore.setApiKey(value);
        void vscode.window.showInformationMessage(t("API Key 已保存", defaultLocale));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dsbAgent.newSession", () => {
      provider.show();
      provider.getController()?.newSession();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dsbAgent.listSessions", async () => {
      provider.show();
      const items = (provider.getController()?.listSessions() ?? []).map(({ id, title }) => ({ label: title, description: id }));
      const pick = await vscode.window.showQuickPick(items);
      if (pick?.description) {
        await provider.getController()?.handle({ type: "load_session", id: pick.description });
        provider.show();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dsbAgent.rewind", async () => {
      provider.show();
      // 通过 controller 获取当前会话快照最多的文件列表,选择后 restore
      const files = provider.getController()?.rewindCandidates() ?? [];
      if (files.length === 0) {
        void vscode.window.showInformationMessage(t("当前会话没有可回退的快照", defaultLocale));
        return;
      }
      const pick = await vscode.window.showQuickPick(files, {
        placeHolder: t("选择要回退的文件(恢复到最近一次编辑前)", defaultLocale),
      });
      if (pick) provider.getController()?.rewind(pick);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dsbAgent.memory", async () => {
      provider.show();
      const controller = provider.getController();
      const entries = controller?.memoryList() ?? [];
      if (entries.length === 0) {
        void vscode.window.showInformationMessage(t("暂无持久记忆", defaultLocale));
        return;
      }
      const pick = await vscode.window.showQuickPick(
        entries.map((e) => ({ label: e.name, description: e.description })),
        { placeHolder: t("选择记忆查看正文(可删除)", defaultLocale) },
      );
      if (!pick) return;
      const entry = entries.find((e) => e.name === pick.label);
      if (!entry) return;
      const deleteLabel = t("删除", defaultLocale);
      const action = await vscode.window.showInformationMessage(entry.body, deleteLabel);
      if (action === deleteLabel) {
        controller?.memoryDelete(entry.name);
        void vscode.window.showInformationMessage(t("已删除记忆: {name}", defaultLocale, { name: entry.name }));
      }
    }),
  );

  // 记忆管理面板:按项目/全局分区浏览、新建、编辑、删除记忆。
  context.subscriptions.push(
    vscode.commands.registerCommand("dsbAgent.memoryManage", async () => {
      const panel = vscode.window.createWebviewPanel(
        "dsbAgent.memoryManage",
        t("记忆管理", defaultLocale),
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, "dist"),
            vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
          ],
        },
      );
      createMemoryPanel(
        {
          webview: panel.webview,
          title: panel.title,
          onDidDispose: (cb) => void panel.onDidDispose(cb),
          extensionUri: context.extensionUri,
        },
        {
          getLocale: () => configuration.language() || (vscode.env.language.toLowerCase().startsWith("zh") ? "zh" : "en"),
          list: () => {
            const mgr = new MemoryManager(memory, memoryRoot, projectKey);
            return { projectKey: mgr.key(), ...mgr.list() };
          },
          write: (scope, input) => new MemoryManager(memory, memoryRoot, projectKey).write(scope, input),
          delete: (scope, name) => new MemoryManager(memory, memoryRoot, projectKey).delete(scope, name),
        },
      );
    }),
  );

  // 冷存储浏览面板:按会话浏览被压缩替换出上下文的原文,支持清空/删除/合并去重。
  context.subscriptions.push(
    vscode.commands.registerCommand("dsbAgent.contextBrowse", async () => {
      const panel = vscode.window.createWebviewPanel(
        "dsbAgent.contextBrowse",
        t("冷存储浏览", defaultLocale),
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, "dist"),
            vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
          ],
        },
      );
      createContextPanel(
        {
          webview: panel.webview,
          title: panel.title,
          onDidDispose: (cb) => void panel.onDidDispose(cb),
          extensionUri: context.extensionUri,
        },
        contextPanelServicesFromStore(
          new ContextStore(contextRoot),
          () => configuration.language() || (vscode.env.language.toLowerCase().startsWith("zh") ? "zh" : "en"),
        ),
      );
    }),
  );

  // 参数设置面板:当前含「上下文预算」(总 token + 三块比例);后续参数区在此扩展。
  context.subscriptions.push(
    vscode.commands.registerCommand("dsbAgent.agentSettings", async () => {
      const panel = vscode.window.createWebviewPanel(
        "dsbAgent.agentSettings",
        t("DSB Agent 参数设置", defaultLocale),
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, "dist"),
            vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
          ],
        },
      );
      createAgentSettingsPanel(
        {
          webview: panel.webview,
          title: panel.title,
          onDidDispose: (cb) => void panel.onDidDispose(cb),
          extensionUri: context.extensionUri,
        },
        {
          getLocale: () =>
            configuration.language() || (vscode.env.language.toLowerCase().startsWith("zh") ? "zh" : "en"),
          getBudget: () => ({
            windowTokens: configuration.contextWindowTokens(),
            budget: configuration.historyTokenBudget(),
            split: configuration.budgetSplit(),
            triggerPct: configuration.compactionTriggerPct(),
            targetPct: configuration.compactionTargetPct(),
          }),
          updateBudget: async (config) => {
            // await 写配置完成,确保保存后回读能拿到新值(异步写未落盘会导致界面刷回旧值)
            const cfg = vscode.workspace.getConfiguration();
            await cfg.update(
              "dsbAgent.contextWindowTokens",
              config.windowTokens,
              vscode.ConfigurationTarget.Global,
            );
            await cfg.update(
              "dsbAgent.compaction.historyTokenBudget",
              config.budget,
              vscode.ConfigurationTarget.Global,
            );
            await cfg.update(
              "dsbAgent.compaction.budgetSplit",
              { compacted: config.split.compacted, thinking: config.split.thinking, tail: config.split.tail },
              vscode.ConfigurationTarget.Global,
            );
            await cfg.update("dsbAgent.compaction.triggerPct", config.triggerPct, vscode.ConfigurationTarget.Global);
            await cfg.update("dsbAgent.compaction.targetPct", config.targetPct, vscode.ConfigurationTarget.Global);
          },
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dsbAgent.mcpConnect", async () => {
      provider.show(); // 确保右侧面板存在(show 同步构造 controller)
      const controller = provider.getController();
      if (!controller) return;
      try {
        const n = await controller.mcpConnect();
        void vscode.window.showInformationMessage(
          n > 0 ? t("已连接 {count} 个 MCP 服务器", defaultLocale, { count: n }) : t("未发现可连接的 MCP 服务器(检查工作区 .mcp.json)", defaultLocale),
        );
      } catch (err) {
        void vscode.window.showErrorMessage(t("连接 MCP 服务器失败: {error}", defaultLocale, { error: err instanceof Error ? err.message : String(err) }));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dsbAgent.pluginAdd", async () => {
      provider.show();
      const controller = provider.getController();
      if (!controller) return;

      // 常见源快速选择(source 为 null 表示手动输入自定义源)
      const choices: Array<{ item: vscode.QuickPickItem; source: string | null }> = [
        {
          item: {
            label: "$(github) obra/superpowers-marketplace",
            description: t("superpowers 技能市场(github 源)", defaultLocale),
          },
          source: "obra/superpowers-marketplace",
        },
        {
          item: {
            label: "$(verified) anthropics/claude-plugins-official",
            description: t("Anthropic 公开插件目录(第三方源)", defaultLocale),
          },
          source: "anthropics/claude-plugins-official",
        },
        {
          item: {
            label: "$(github) avivsinai/skills-marketplace",
            description: t("中央插件市场(兼容常见清单格式)", defaultLocale),
          },
          source: "avivsinai/skills-marketplace",
        },
        {
          item: {
            label: t("手动输入自定义源…", defaultLocale),
            description: "owner/repo | npm:pkg | https://…/marketplace.json | ./本地路径 | …/repo.git",
          },
          source: null,
        },
      ];
      const pick = await vscode.window.showQuickPick(choices.map((c) => c.item), {
        placeHolder: t("选择常见源,或手动输入自定义源", defaultLocale),
      });
      if (!pick) return;
      const chosen = choices.find((c) => c.item === pick);

      let source: string;
      if (chosen?.source) {
        source = chosen.source;
      } else {
        const input = await vscode.window.showInputBox({
          prompt: t("插件市场源", defaultLocale),
          placeHolder: "owner/repo | npm:pkg | https://…/marketplace.json | ./本地路径 | …/repo.git",
        });
        if (!input) return;
        source = input;
      }
      try {
        const entry = await controller.marketplaceAdd(source);
        void vscode.window.showInformationMessage(t("已添加插件市场: {name}", defaultLocale, { name: entry.name }));
      } catch (err) {
        void vscode.window.showErrorMessage(t("添加插件市场失败: {error}", defaultLocale, { error: err instanceof Error ? err.message : String(err) }));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dsbAgent.pluginInstall", async () => {
      provider.show();
      const controller = provider.getController();
      if (!controller) return;
      const markets = controller.marketplaceList();
      if (markets.length === 0) {
        void vscode.window.showInformationMessage(t("暂无已添加的插件市场,先用 DSBAgent: Add Marketplace 添加", defaultLocale));
        return;
      }
      const marketPick = await vscode.window.showQuickPick(
        markets.map((m) => ({ label: m.name, description: m.path })),
        { placeHolder: t("选择插件市场", defaultLocale) },
      );
      if (!marketPick) return;
      let plugins: vscode.QuickPickItem[];
      try {
        plugins = controller.marketplacePlugins(marketPick.label).map((p) => ({
          label: p.name,
          description: p.description ?? "",
        }));
      } catch (err) {
        void vscode.window.showErrorMessage(t("读取市场清单失败: {error}", defaultLocale, { error: err instanceof Error ? err.message : String(err) }));
        return;
      }
      if (plugins.length === 0) {
        void vscode.window.showInformationMessage(t("该市场没有插件", defaultLocale));
        return;
      }
      const pluginPick = await vscode.window.showQuickPick(plugins, {
        placeHolder: t("选择要安装的插件", defaultLocale),
      });
      if (!pluginPick) return;
      try {
        // 安装期间持续显示阶段进度(克隆/校验…),直到结束或出错
        const dest = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: t("安装插件: {name}", defaultLocale, { name: pluginPick.label }),
          },
          async (progress) => {
            progress.report({ message: t("准备安装…", defaultLocale) });
            return controller.marketplaceInstall(marketPick.label, pluginPick.label, (stage) => {
              progress.report({ message: stage });
            });
          },
        );
        void vscode.window.showInformationMessage(t("已安装插件到: {dest}", defaultLocale, { dest }));
      } catch (err) {
        void vscode.window.showErrorMessage(t("安装插件失败: {error}", defaultLocale, { error: err instanceof Error ? err.message : String(err) }));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dsbAgent.plugins", () => {
      provider.show();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dsbAgent.skill", async () => {
      provider.show();
      const controller = provider.getController();
      if (!controller) return;
      const skills = controller.skillList();
      if (skills.length === 0) {
        void vscode.window.showInformationMessage(t("暂无可用技能(项目/用户/VSCode 扩展/插件 4 层均未发现)", defaultLocale));
        return;
      }
      const pick = await vscode.window.showQuickPick(
        skills.map((s) => ({ label: s.name, description: s.description })),
        { placeHolder: t("选择要调用的技能", defaultLocale) },
      );
      if (pick) await controller.invokeSkill(pick.label);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dsbAgent.hooks", async () => {
      provider.show();
      // 展示当前工作区生效的 hook 规则(settings + 已装插件),供验证 hook 生命周期装配
      const controller = provider.getController();
      if (!controller) return;
      const rules = controller.hookConfig();
      if (rules.length === 0) {
        void vscode.window.showInformationMessage(t("当前未配置 hook(.dsb/settings.json 或插件 hooks)", defaultLocale));
        return;
      }
      const pick = await vscode.window.showQuickPick(
        rules.map((r) => ({ label: `${r.event} · ${r.matcher}`, description: r.command })),
        { placeHolder: t("当前生效的 hook 规则(仅展示,不在此触发)", defaultLocale) },
      );
      if (pick) void vscode.window.showInformationMessage(`${pick.label}\n${pick.description}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dsbAgent.worktreeRun", async () => {
      provider.show();
      const controller = provider.getController();
      if (!controller) return;
      const description = await vscode.window.showInputBox({
        prompt: t("任务描述", defaultLocale),
        placeHolder: t("要在隔离 git 工作树中执行的子 Agent 任务", defaultLocale),
      });
      if (!description) return;
      try {
        await controller.runInWorktree(async (wtPath) => {
          // 在隔离工作树内用一个子 AgentSession 执行任务描述
          await controller.runAgentIn(wtPath, description);
        });
        void vscode.window.showInformationMessage(t("隔离工作树任务完成(工作树已清理)", defaultLocale));
      } catch (err) {
        void vscode.window.showErrorMessage(t("隔离工作树任务失败: {error}", defaultLocale, { error: err instanceof Error ? err.message : String(err) }));
      }
    }),
  );

  // 激活即自动在右侧打开聊天面板
  provider.show();
}

export function deactivate(): void {
  try {
    activeProvider?.getController()?.flushProgressMemory();
  } catch {
    // ignore
  }
  activeProvider = undefined;
}
