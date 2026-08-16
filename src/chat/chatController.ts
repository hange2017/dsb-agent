import type { ApiKeyStore } from "../settings/apiKeyStore";
import type { Configuration } from "../settings/configuration";
import type { ProviderStore } from "../providers/providerStore";
import type { ModelCatalog } from "../providers/modelCatalog";
import type { CapabilityRegistry } from "../providers/capabilityRegistry";
import type { Capabilities, Mode, ModelInfo, ProviderDef } from "../providers/types";
import { NoopNotifier, type Notifier } from "../notifications/notifier";
import { t } from "../i18n/strings";
import { newMessageId, type HostToWebviewMessage, type SuggestionItem, type WebviewToHostMessage } from "./protocol";
import { presentTool } from "./toolPresentation";
import { filterByQuery, filterBuiltInCommands, stripTriggerToken } from "./suggestions";
import { suggestWorkspaceFiles } from "../agent/tools/workspaceFs";
import type { AgentLoopEvent } from "../agent/agentLoop";
import { modeToastText } from "../agent/modePolicy";
import type { CreateSessionFn } from "./sessionTypes";
import { AnthropicMessagesClient } from "../agent/provider/anthropicMessagesClient";
import { PermissionManager, type PermissionGateway, type PermissionMode } from "../agent/permission";
import type { SessionStore } from "../session/sessionStore";
import type { SessionSummary } from "../session/sessionTypes";
import { TodoManager } from "../agent/tools/todoTool";
import { CheckpointStore } from "../agent/checkpoint";
import type { WorktreeApi } from "../agent/worktree";
import type { MemoryEntry, MemoryStore } from "../agent/memory/memoryStore";
import { MemorySessionUiState, type SessionUiState } from "../settings/sessionUiState";
import { buildSessionProgressMemory } from "../session/sessionProgress";
import type { MarketplaceEntry, MarketplaceManager } from "../plugins/marketplace";
import type { MarketplacePluginRef } from "../plugins/types";
import { Recommender, type PluginCandidate, type RankedCandidate } from "../plugins/recommend";
import { marketplaceManifestPath } from "../plugins/marketplace";
import type { ContextChip, FileChip, SkillChip } from "../context/types";
import { acceptImages, toSdkImages, type SdkImagePayload } from "../context/imageAttach";
import { acceptDocuments, kMaxDocumentChars } from "../context/documentAttach";
import { assignDisplayLabels } from "../context/displayLabel";
import { formatChipLabel } from "../context/formatContext";
import { editorInsertText, wrapRef } from "../context/composerMarkers";
import type { ContextCapture } from "../context/contextCapture";
import { resolveInlineRefs } from "../context/promptBuilder";
import type { McpRegistry } from "../mcp/mcpRegistry";
import { parseMarketplaceManifest } from "../plugins/manifest";
import { formatSessionMarkdown, formatSessionJson, writeExport } from "./exportSession";
import { dreamMemory } from "../agent/memory/memoryDream";
import { SessionService } from "./sessionService";
import { ProjectRuntime } from "./projectRuntime";
import { ContextStore } from "../context/contextStore";
import { sessionToChunks } from "../agent/archivePolicy";
import { SlashCommandIndex, loadCommandDir } from "./slashCommands";
import type { ActivityStatsStore } from "../stats/activityStats";
import type { StatsStore } from "../stats/statsStore";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/** 发往 webview 的消息统一受 HostToWebviewMessage 判别联合约束:协议漂移(如 Workflow
 * 状态 "done" 写进 tool 行)现在会让 tsc 在编译期失败,而不是在 webview 里静默渲染异常。 */
type SendMessage = (message: HostToWebviewMessage) => void;

function truncateFileText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n…[truncated ${text.length - maxChars} chars]`;
}

export class ChatController {
  constructor(
    private readonly deps: {
      apiKeyStore: ApiKeyStore;
      configuration: Configuration;
      getWorkspaceCwd: () => string | undefined;
      sessionStore: SessionStore;
      createSession: CreateSessionFn;
      todo?: TodoManager;
      /** 跨会话记忆存储,供 /memory 命令枚举与删除。 */
      memory: MemoryStore;
      /** 上次会话 id / 中断标志(生产用 VscodeSessionUiState;测用 MemorySessionUiState)。 */
      sessionUiState?: SessionUiState;
      /** 插件市场管理器(引擎层,无 vscode 依赖),由 extension.ts 装配后注入;供 /plugin 命令使用。 */
      marketplace?: MarketplaceManager;
      /** MCP 服务器注册表(引擎层,无 vscode 依赖),由 extension.ts 装配后注入;init 时读 .mcp.json 并连接。 */
      mcp?: McpRegistry;
      /** VSCode 扩展列表(chatViewProvider 传 vscode.extensions.all),供技能索引扫描 extension 层。 */
      extensions?: ReadonlyArray<{ extensionPath: string; id?: string }>;
      /** 插件缓存目录(globalStorageUri.fsPath),供技能索引扫描 plugin 层。 */
      pluginCacheDir?: string;
      /** 通知器(引擎层,无 vscode 依赖):任务完成/错误/待授权时调用;生产由 chatViewProvider 注入 VscodeNotifier。 */
      notifier?: Notifier;
      /** 面板是否可见:仅面板隐藏时才发原生通知。 */
      isVisible?: () => boolean;
      /** 通知开关:返回是否允许发通知(扩展层从 vscode 配置读取)。 */
      notificationsEnabled?: () => boolean;
      /** vim 模式开关:webview 输入框是否启用 vim 模式(扩展层从 vscode 配置读取,经 init 消息下发)。 */
      vimModeEnabled?: () => boolean;
      /** 持久化权限模式到用户配置(扩展层写 vscode 设置,Global 目标,重启保留)。 */
      updatePermissionMode?: (mode: PermissionMode) => Promise<void>;
      /** git 工作树 API(引擎层,无 vscode 依赖):/worktree 命令在隔离工作树中跑后台任务,由 extension.ts 装配。 */
      worktree?: WorktreeApi;
      /** 项目运行时服务(规则/hooks/技能/插件缓存)。由 chatViewProvider 装配后注入;
       * 未注入时(测试等场景)自建降级实例(runHookCommand 为 no-op,规则/hooks/技能仍可用)。 */
      projectRuntime?: ProjectRuntime;
      /** 编辑器/终端复制捕获;粘贴提升为 chip 时使用。 */
      contextCapture?: ContextCapture;
      /** 粘贴是否提升为 chip;默认读 dsbAgent.autoChipsOnPaste(true)。 */
      autoChipsOnPaste?: () => boolean;
      /** 供应商存储(多供应商管理)。未注入时(测试等场景)回退扁平配置行为。 */
      providerStore?: ProviderStore;
      /** 模型目录(内置表 + 远程拉取 + 缓存)。未注入时回退空模型列表。 */
      modelCatalog?: ModelCatalog;
      /** per-model 能力解析。未注入时默认 vision/thinking 均开启。 */
      capabilityRegistry?: CapabilityRegistry;
      /** 每日活动统计(记录每天最后一次发送时间,供工作总结提醒)。未注入时跳过记录。 */
      activityStats?: ActivityStatsStore;
      /** 统计大模块:通用事件日志(JSONL);未注入时跳过打点。 */
      statsStore?: StatsStore;
      /** 界面语言(设置面板切换前的默认值,来自 vscode.env.language 归一)。 */
      defaultLocale?: "zh" | "en";
      /** 冷存储(跨会话历史归档):会话切换/删除时把完整 API 历史写入冷存储供 ContextRecall 回查。缺省跳过归档。 */
      contextStore?: ContextStore;
      /** 设置面板切换语言后持久化(extension 层写 dsbAgent.language,Global)。 */
      updateLanguage?: (language: "" | "zh" | "en") => Promise<void>;
      /** 设置面板切换 vim 模式后持久化(extension 层写 dsbAgent.vimMode)。 */
      updateVimMode?: (enabled: boolean) => Promise<void>;
      /** 设置面板切换通知开关后持久化(extension 层写 dsbAgent.enableNotifications)。 */
      updateNotifications?: (enabled: boolean) => Promise<void>;
    },
    private readonly post: SendMessage,
  ) {
    // 会话级任务清单;未注入时自建实例(测试等场景),生产由 ChatViewProvider 共享同一实例
    this.todo = this.deps.todo ?? new TodoManager();
    this.memory = this.deps.memory;
    this.sessionUiState = this.deps.sessionUiState ?? new MemorySessionUiState();
    this.marketplace = this.deps.marketplace;
    this.mcp = this.deps.mcp;
    this.extensions = this.deps.extensions ?? [];
    this.pluginCacheDir = this.deps.pluginCacheDir ?? "";
    this.notifier = this.deps.notifier ?? new NoopNotifier();
    this.isVisible = this.deps.isVisible ?? (() => false);
    this.notificationsEnabled = this.deps.notificationsEnabled ?? (() => true);
    this.vimModeEnabled = this.deps.vimModeEnabled ?? (() => false);
    this.contextCapture = this.deps.contextCapture;
    this.autoChipsOnPaste =
      this.deps.autoChipsOnPaste ??
      (() => this.deps.configuration.autoChipsOnPaste?.() ?? true);
    // 防御式读取:测试注入的部分 configuration mock 可能没有 permissionMode
    this.permissionMode = this.deps.configuration.permissionMode?.() ?? "default";
    // ProjectRuntime 由组合根(chatViewProvider)注入;未注入时自建降级实例(生产总是注入)。
    // 降级 runHookCommand 为 no-op:仅测试等场景生效(钩子不执行),生产 execFile 实现只在 provider 一处。
    this.projectRuntime =
      this.deps.projectRuntime ??
      new ProjectRuntime({
        getWorkspaceCwd: this.deps.getWorkspaceCwd,
        extensions: this.deps.extensions,
        pluginCacheDir: this.deps.pluginCacheDir,
        runHookCommand: async () => "",
      });
    // SessionService 由 controller 自建:makePermissions/makeHooks/onWorkflowProgress 闭包
    // 依赖本 controller 的 gateway/post/rules,无法在组合根构造。
    this.sessionService = new SessionService({
      apiKeyStore: this.deps.apiKeyStore,
      configuration: this.deps.configuration,
      getWorkspaceCwd: this.deps.getWorkspaceCwd,
      sessionStore: this.deps.sessionStore,
      createSession: this.deps.createSession,
      mcp: this.deps.mcp,
      currentModel: () => this.currentModel,
      makePermissions: () =>
        new PermissionManager({
          gateway: this.makeGateway(),
          rules: this.projectRuntime.getRules(),
          sessionMode: this.permissionMode,
        }),
      makeHooks: (workspaceRoot) => this.projectRuntime.buildHookRunner(workspaceRoot),
      onWorkflowProgress: (stageId, status) => this.postWorkflowProgress(stageId, status),
      getClientDeps: () => this.clientDeps(),
      // 会话切换/删除时归档完整 API 历史到冷存储(跨会话 ContextRecall 回查);
      // 归档失败不影响会话流程(fail-open)。
      archiveHistory: (sessionId, history) => {
        try {
          if (!this.deps.contextStore || history.length === 0) return;
          const chunks = sessionToChunks(history);
          if (chunks.length === 0) return;
          // 归档 chunk 的 seq 须与压缩 chunk 的 [r{n}] 不冲突:从现有最大 seq 之后续接。
          const maxSeq = this.deps.contextStore
            .index(sessionId)
            .reduce((m, e) => Math.max(m, e.seq), 0);
          const now = Date.now();
          this.deps.contextStore.append(
            sessionId,
            chunks.map((c, i) => ({ ...c, seq: maxSeq + 1 + i, ts: now })),
          );
        } catch {
          // 归档失败忽略(冷存储本身 fail-open)
        }
      },
    });
  }

  private readonly projectRuntime: ProjectRuntime;
  private readonly sessionService: SessionService;
  private readonly todo: TodoManager;
  private readonly memory: MemoryStore;
  private readonly sessionUiState: SessionUiState;
  private readonly marketplace: MarketplaceManager | undefined;
  private readonly mcp: McpRegistry | undefined;
  private readonly extensions: ReadonlyArray<{ extensionPath: string; id?: string }>;
  private readonly pluginCacheDir: string;
  private readonly notifier: Notifier;
  private readonly isVisible: () => boolean;
  private readonly notificationsEnabled: () => boolean;
  private readonly vimModeEnabled: () => boolean;
  private readonly autoChipsOnPaste: () => boolean;
  private readonly contextCapture: ContextCapture | undefined;
  /** 权限模式:default=严格(询问),bypassPermissions=宽松(全放行)。来自配置,可经设置面板切换并持久化。 */
  private permissionMode: PermissionMode = "default";
  /** 设置面板选择的语言:""=跟随界面,zh/en=显式指定。 */
  private language: "" | "zh" | "en" = "";
  /** 当前生效 UI 语言(设置面板选择或默认跟随界面)。 */
  get locale(): "zh" | "en" {
    return this.language || this.deps.defaultLocale || "zh";
  }
  private readonly pendingAsks = new Map<string, { resolve: (v: boolean) => void }>();
  /** 当前轮次的助手消息 id:Workflow 阶段进度行挂在它下面。 */
  private currentAssistantId: string | undefined;
  /** 每轮 assistant 消息的 thinking 累计文本:流式 delta 合并为同一 timeline 步骤。 */
  private thinkingText = new Map<string, string>();
  /** thinking 开始时间(ms),用于 Thought for Ns。 */
  private thinkingStartedAt = new Map<string, number>();
  /** 当前进行中的文本步骤 id:text_delta 首次到达时创建,工具/思考/终态时关闭。 */
  private openTextStep: string | null = null;
  /** 文本步骤序号:每段回答一个独立 timeline 步骤,按时间线顺序排列。 */
  private textStepSeq = 0;
  /** 开放 text 步的纯文本缓冲(stepId → text)。 */
  private textBuffers = new Map<string, string>();
  /** tool_call input 缓存(callId → input),completed 缺省时回退。 */
  private toolInputs = new Map<string, unknown>();
  private currentMode: "agent" | "plan" | "ask" = "agent";
  private currentModel: string | undefined;

  // ---- 供应商/模型/能力 快照(未注入 providerStore 时回退扁平配置) ----
  private activeProvider(): ProviderDef | undefined {
    return this.deps.providerStore?.getActive();
  }

  /** 仅当前扩展支持协议(Anthropic 兼容)的供应商,用于 header 下拉/切换备选项。 */
  private compatibleProviders(): ProviderDef[] {
    return (this.deps.providerStore?.list() ?? []).filter((p) => p.protocol !== "openai");
  }

  private currentCapabilities(): Capabilities {
    const provider = this.activeProvider();
    const model = this.currentModel ?? this.deps.configuration.model();
    if (this.deps.capabilityRegistry && provider) {
      return this.deps.capabilityRegistry.resolve(provider, model);
    }
    return { supportsVision: true, supportsThinking: true };
  }

  private currentModels(): ModelInfo[] {
    const provider = this.activeProvider();
    if (!provider || !this.deps.modelCatalog) return [];
    return this.deps.modelCatalog.resolveModels(provider);
  }

  private currentModes(): Mode[] {
    return this.activeProvider()?.modes ?? ["agent", "plan", "ask"];
  }

  /** 构造 AnthropicMessagesClient 的统一依赖:API key 优先当前供应商,回退旧 apiKeyStore。 */
  private async clientDeps(): Promise<{ apiKey: string; baseUrl: string; model: string; capabilities: Capabilities }> {
    const provider = this.activeProvider();
    let apiKey = "";
    if (provider) {
      apiKey = (await this.deps.providerStore?.getApiKey(provider.id)) ?? "";
    }
    if (!apiKey) apiKey = (await this.deps.apiKeyStore.getApiKey()) ?? "";
    return {
      apiKey,
      baseUrl: provider?.baseUrl ?? this.deps.configuration.baseUrl(),
      model: this.currentModel ?? this.deps.configuration.model(),
      capabilities: this.currentCapabilities(),
    };
  }
  private pendingImageCount = 0;
  private pendingDocumentCount = 0;
  /** 已附加、尚未随 send 消费的 chips(图片 + 文档等) */
  private currentChips: ContextChip[] = [];
  /** host 内部发送互斥锁,不依赖 webview 的 busy 标志 */
  private busy = false;
  /** /plugins 智能推荐器:关键词粗筛(BM25 简化版)+ LLM 排序,失败降级回关键词顺序。 */
  private readonly recommender: Recommender = new Recommender({
    collectCandidates: () => this.collectCandidates(),
    rank: (query, candidates) => this.rankByLLM(query, candidates),
  });

  /** 当前工作区生效的 hook 规则(settings + 插件),供 dsbAgent.hooks 命令展示。 */
  hookConfig(): Array<{ event: string; matcher: string; command: string }> {
    return this.projectRuntime.hookConfig();
  }

  private makeGateway(): PermissionGateway {
    return {
      request: (toolName: string, detail: string) =>
        new Promise<boolean>((resolve) => {
          const askId = newMessageId();
          this.pendingAsks.set(askId, { resolve });
          this.post({ type: "ask_permission", askId, toolName, detail });
          // 待授权通知:仅面板隐藏时提示,避免与面板内授权 UI 重复
          if (this.notificationsEnabled() && !this.isVisible()) {
            try {
              this.notifier.warn("DSBAgent", t("需要授权工具调用", this.locale));
            } catch {
              // 通知失败不阻断授权流程:待授权结果仍经 pendingAsks 正常回调
            }
          }
        }),
    };
  }

  private clearPendingAsks(): void {
    for (const { resolve } of this.pendingAsks.values()) resolve(false);
    this.pendingAsks.clear();
  }

  async handlePermissionResponse(askId: string, approved: boolean): Promise<void> {
    const pending = this.pendingAsks.get(askId);
    if (!pending) return;
    this.pendingAsks.delete(askId);
    pending.resolve(approved);
  }

  async handle(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        await this.init();
        break;
      case "send":
        await this.send(message.text);
        break;
      case "append":
        this.appendMessage(message.text);
        break;
      case "cancel":
        this.sessionService.cancel();
        break;
      case "new":
      case "new_session":
        this.newSession();
        break;
      case "load_session":
        this.loadSession(message.id);
        break;
      case "delete_session":
        this.deleteSession(message.id);
        break;
      case "set_mode":
        this.currentMode = message.mode;
        // 模式切换即时反馈:webview toast 说明当前限制(plan/ask 为只读子集)
        this.post({ type: "toast", message: modeToastText(message.mode) });
        break;
      case "set_model":
        this.currentModel = message.model;
        break;
      case "set_provider":
        void this.handleSetProvider(message.providerId);
        break;
      case "attach_images":
        await this.handleAttachImages(message.images);
        break;
      case "attach_documents":
        await this.handleAttachDocuments(message.documents);
        break;
      case "permission_response":
        await this.handlePermissionResponse(message.askId, message.approved);
        break;
      case "approve_once":
        this.sessionService.getSessionPermissions()?.approveOnce(message.toolName);
        break;
      case "remove_chip":
        this.removeChip(message.id);
        break;
      case "paste":
        this.handlePaste(message.text);
        break;
      case "open_chip":
        await this.openChip(message.id);
        break;
      case "open_file":
        await this.openFile(message.path, message.line);
        break;
      case "open_url":
        await this.openUrl(message.url);
        break;
      case "skill_command":
        await this.invokeSkill(message.name);
        break;
      case "recommend_plugins":
        await this.recommendPlugins(message.query);
        break;
      case "install_plugin":
        await this.installPlugin(message.marketplace, message.name);
        break;
      case "set_permission_mode":
        await this.setPermissionMode(message.mode);
        break;
      case "set_language":
        this.handleSetLanguage(message.language);
        break;
      case "set_vim_mode":
        this.handleSetVimMode(message.enabled);
        break;
      case "set_notifications":
        this.handleSetNotifications(message.enabled);
        break;
      case "suggest":
        this.handleSuggest(message.trigger, message.query);
        break;
      case "pickSuggestion":
        await this.handlePickSuggestion(message);
        break;
    }
  }

  listSessions(): SessionSummary[] {
    return this.sessionService.listSessions();
  }

  /** 所有跨会话记忆(新→旧),供 /memory 命令枚举。 */
  memoryList(): MemoryEntry[] {
    return this.memory.list();
  }

  /** 删除一条跨会话记忆,供 /memory 命令调用。 */
  memoryDelete(name: string): void {
    this.memory.delete(name);
  }

  /** 已添加的插件市场(名称→落盘路径),供 /pluginInstall 命令枚举。 */
  marketplaceList(): MarketplaceEntry[] {
    return this.marketplace?.list() ?? [];
  }

  /** 添加一个插件市场源(local/github/git/url/npm),返回市场条目。 */
  async marketplaceAdd(source: string): Promise<MarketplaceEntry> {
    if (!this.marketplace) throw new Error("MarketplaceManager not wired");
    return this.marketplace.add(source);
  }

  /** 已安装市场的插件引用清单,供 /pluginInstall 命令枚举可选插件。 */
  marketplacePlugins(name: string): MarketplacePluginRef[] {
    const mp = this.marketplaceList().find((m) => m.name === name);
    if (!mp) throw new Error(`Marketplace not installed: ${name}`);
    return parseMarketplaceManifest(marketplaceManifestPath(mp.path)).plugins;
  }

  /** 从已安装市场安装插件到插件缓存目录,返回落盘目录。onProgress 汇报阶段(克隆/校验…)。 */
  async marketplaceInstall(marketplaceName: string, pluginName: string, onProgress?: (stage: string) => void): Promise<string> {
    if (!this.marketplace) throw new Error("MarketplaceManager not wired");
    return this.marketplace.install(marketplaceName, pluginName, onProgress);
  }

  /** 切换权限模式(严格/宽松):立即作用于当前会话权限,并持久化到用户配置。 */
  private async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionMode = mode;
    this.sessionService.getSessionPermissions()?.setMode(mode);
    if (this.deps.updatePermissionMode) {
      try {
        await this.deps.updatePermissionMode(mode);
      } catch {
        // 持久化失败不阻断切换
      }
    }
    this.post({
      type: "toast",
      message:
        mode === "bypassPermissions"
          ? t("超级权限已开启:agent 可执行任何操作,不再逐项确认", this.locale)
          : mode === "acceptEdits"
            ? t("权限模式:自动接受编辑(Write/StrReplace/Delete 免确认)", this.locale)
            : t("超级权限已关闭:严格模式", this.locale),
    });
  }

  /** 设置面板切换语言:更新 locale、持久化(空=跟随界面语言)、广播 webview 重渲染。 */
  private handleSetLanguage(language: "" | "zh" | "en"): void {
    this.language = language;
    if (this.deps.updateLanguage) {
      try {
        void this.deps.updateLanguage(language);
      } catch {
        // 持久化失败不阻断切换
      }
    }
    this.post({ type: "locale_changed", locale: this.locale });
  }

  /** 设置面板切换 vim 模式:持久化到用户配置,toast 反馈。 */
  private async handleSetVimMode(enabled: boolean): Promise<void> {
    if (this.deps.updateVimMode) {
      try {
        await this.deps.updateVimMode(enabled);
      } catch {
        // 持久化失败不阻断切换
      }
    }
    this.post({
      type: "toast",
      message: enabled ? t("vim 模式已开启", this.locale) : t("vim 模式已关闭", this.locale),
    });
  }

  /** 设置面板切换通知开关:持久化到用户配置,toast 反馈。 */
  private async handleSetNotifications(enabled: boolean): Promise<void> {
    if (this.deps.updateNotifications) {
      try {
        await this.deps.updateNotifications(enabled);
      } catch {
        // 持久化失败不阻断切换
      }
    }
    this.post({
      type: "toast",
      message: enabled ? t("通知已开启", this.locale) : t("通知已关闭", this.locale),
    });
  }

  /** 全部技能(名称+描述),供系统提示词 `## 可用技能` 与 /skill 命令 QuickPick 枚举。 */
  skillList(): Array<{ name: string; description: string }> {
    return this.projectRuntime.skillList();
  }

  /** 调用技能:读取 SKILL.md 全文并注入一次对话(发 send)。未找到时提示 toast。 */
  async invokeSkill(name: string): Promise<void> {
    const res = await this.projectRuntime.getSkillIndex().invokeSkill(name);
    if (!res.ok) {
      this.post({ type: "toast", message: res.content, error: true });
      return;
    }
    await this.send(res.content);
  }

  /** 命令索引:内置 /new 等 + 项目/用户/插件命令。每次重建(仿 getSkillIndex),安装插件后即见。 */
  private getSlashIndex(): SlashCommandIndex {
    const idx = new SlashCommandIndex();
    const cwd = this.deps.getWorkspaceCwd();
    const home = os.homedir();
    if (cwd) {
      const proj = loadCommandDir(path.join(cwd, ".dsb", "commands"), "project");
      const projectCmds = proj.length ? proj : loadCommandDir(path.join(cwd, ".claude", "commands"), "project");
      for (const cmd of projectCmds) idx.add(cmd);
    }
    const user = loadCommandDir(path.join(home, ".dsb", "commands"), "user");
    const userCmds = user.length ? user : loadCommandDir(path.join(home, ".claude", "commands"), "user");
    for (const cmd of userCmds) idx.add(cmd);
    for (const dir of this.projectRuntime.pluginDirs()) {
      for (const cmd of loadCommandDir(path.join(dir, "commands"), "plugin")) idx.add(cmd);
    }
    return idx;
  }

  /**
   * /plugins 命令:回显用户输入,做关键词粗筛 + LLM 排序,把推荐清单发给 webview。
   * 失败时给明确错误(不静默),且不阻塞后续对话。
   */
  async recommendPlugins(query: string): Promise<void> {
    const q = query.trim();
    this.post({ type: "message", id: newMessageId(), role: "user", text: q ? `/plugins ${q}` : "/plugins" });
    try {
      const ranked = await this.recommender.recommend(q);
      const items = ranked.map((r) => ({
        name: r.candidate.name,
        origin: r.candidate.origin,
        reason: r.reason,
        installable: r.candidate.source === "marketplace",
      }));
      this.post({ type: "plugin_recommendations", items });
      this.post({ type: "status", busy: false, info: t("完成", this.locale) });
    } catch (err) {
      this.post({
        type: "status",
        busy: false,
        info: t("插件推荐失败: {error}", this.locale, { error: err instanceof Error ? err.message : String(err) }),
        error: true,
      });
    }
  }

  /** `/` 建议:命令(内置 + 项目/用户/插件)+ 技能;`@` 建议:项目文件。 */
  private handleSuggest(trigger: "@" | "/", query: string): void {
    if (trigger === "/") {
      const commands: SuggestionItem[] = filterBuiltInCommands(query);
      const commandItems: SuggestionItem[] = filterByQuery(
        this.getSlashIndex().listForPrompt(),
        query,
        (s) => s.name,
      ).map((c) => ({ kind: "command", name: c.name, detail: c.description }));
      const skills: SuggestionItem[] = filterByQuery(
        this.projectRuntime.skillList(),
        query,
        (s) => s.name,
      ).map((s) => ({ kind: "skill", name: s.name, description: s.description }));
      this.post({ type: "suggestions", items: [...commands, ...commandItems, ...skills].slice(0, 40) });
      return;
    }
    const cwd = this.deps.getWorkspaceCwd();
    const files: SuggestionItem[] = (cwd ? suggestWorkspaceFiles(cwd, query, 40) : []).map((p) => ({
      kind: "file",
      relativePath: p,
    }));
    this.post({ type: "suggestions", items: files });
  }

  /** 选中建议:重写输入;命令执行 / 技能注入 / 文件复用文档附着管线变成 chip。 */
  private async handlePickSuggestion(msg: {
    item: SuggestionItem;
    triggerStart: number;
    triggerEnd: number;
    inputText: string;
  }): Promise<void> {
    const nextInput = stripTriggerToken(msg.inputText, msg.triggerStart, msg.triggerEnd);
    const caret = msg.triggerStart;
    const item = msg.item;
    if (item.kind === "command") {
      switch (item.name) {
        case "new":
          this.newSession();
          break;
        case "plugins":
          void this.recommendPlugins("");
          break;
        case "cancel":
          this.sessionService.cancel();
          break;
        case "help":
          this.post({
            type: "toast",
            message: t("命令:/new 新会话 · /plugins 推荐插件 · /cancel 停止 · /compact 压缩上下文 · /export md|json 导出对话 · /memory dream 整合记忆 · /help 帮助;技能用 /<技能名>", this.locale),
          });
          break;
        case "compact": {
          const session = this.sessionService.getSession();
          if (!session?.compactNow) {
            this.post({ type: "toast", message: t("当前没有可压缩的会话", this.locale), error: true });
            break;
          }
          try {
            await session.compactNow();
            this.post({ type: "toast", message: t("已压缩上下文", this.locale) });
          } catch (err) {
            this.post({
              type: "toast",
              message: t("压缩失败: {error}", this.locale, { error: err instanceof Error ? err.message : String(err) }),
              error: true,
            });
          }
          break;
        }
        case "export": {
          const arg = nextInput.trim().toLowerCase();
          const ext = arg === "json" ? "json" : arg === "md" ? "md" : undefined;
          if (!ext) {
            this.post({ type: "toast", message: t("用法:/export md 或 /export json", this.locale), error: true });
            break;
          }
          const sessionId = this.sessionService.getSessionId();
          const cwd = this.deps.getWorkspaceCwd();
          if (!sessionId) {
            this.post({ type: "toast", message: t("当前没有会话可导出", this.locale), error: true });
            break;
          }
          if (!cwd) {
            this.post({ type: "toast", message: t("请先打开一个工作区文件夹", this.locale), error: true });
            break;
          }
          const messages = this.deps.sessionStore.loadApiHistory(sessionId);
          if (messages.length === 0) {
            this.post({ type: "toast", message: t("会话历史为空,无可导出内容", this.locale), error: true });
            break;
          }
          try {
            const content = ext === "md" ? formatSessionMarkdown(messages) : formatSessionJson(messages);
            const file = writeExport(path.join(cwd, ".dsb", "exports"), sessionId, content, ext);
            this.post({ type: "toast", message: t("已导出: {file}", this.locale, { file }) });
          } catch (err) {
            this.post({
              type: "toast",
              message: t("导出失败: {error}", this.locale, { error: err instanceof Error ? err.message : String(err) }),
              error: true,
            });
          }
          break;
        }
        case "memory": {
          const arg = nextInput.trim().toLowerCase();
          if (arg !== "dream") {
            this.post({ type: "toast", message: t("用法:/memory dream 整合记忆", this.locale), error: true });
            break;
          }
          try {
            const result = await this.dreamMemoryNow();
            this.post({ type: "toast", message: t("记忆已整合: {before} 条 → {after} 条", this.locale, { before: result.before, after: result.after }) });
          } catch (err) {
            this.post({
              type: "toast",
              message: t("记忆整合失败: {error}", this.locale, { error: err instanceof Error ? err.message : String(err) }),
              error: true,
            });
          }
          break;
        }
        default: {
          // 项目/用户/插件命令:body 作为 prompt 发送;未命中(未知命令)提示 toast
          const res = this.getSlashIndex().invokeCommand(item.name);
          if (res.ok) {
            await this.send(res.content);
          } else {
            this.post({ type: "toast", message: res.content, error: true });
          }
        }
      }
      this.post({ type: "suggestionPicked", inputText: nextInput, caret });
      return;
    }
    if (item.kind === "skill") {
      // 与 @ 文件一致:挂 SkillChip + 插入反引号标记,不立即 send;用户可继续编辑后再发
      const info = this.projectRuntime.getSkillIndex().all().find((s) => s.name === item.name);
      const body = this.projectRuntime.getSkillIndex().loadSkill(item.name);
      if (!info || body === undefined) {
        this.post({ type: "toast", message: t("未找到技能: {name}", this.locale, { name: item.name }), error: true });
        this.post({ type: "suggestionPicked", inputText: nextInput, caret });
        return;
      }
      const chip: SkillChip = {
        kind: "skill",
        id: newMessageId(),
        name: info.name,
        absolutePath: path.join(info.path, "SKILL.md"),
        text: truncateFileText(body, kMaxDocumentChars),
      };
      const withLabels = assignDisplayLabels(this.currentChips, [chip]);
      this.currentChips.push(...withLabels);
      this.post({
        type: "suggestionPicked",
        inputText: nextInput,
        caret,
        insertText: wrapRef(formatChipLabel(withLabels[0]!)),
        chips: withLabels.map((c) => ({
          id: c.id,
          kind: c.kind,
          label: formatChipLabel(c),
        })),
      });
      return;
    }
    // file → FileChip(读 utf8,截断后挂 pending)
    const cwd = this.deps.getWorkspaceCwd();
    if (!cwd) {
      this.post({ type: "suggestionPicked", inputText: nextInput, caret });
      return;
    }
    const full = path.join(cwd, item.relativePath);
    try {
      const text = truncateFileText(fs.readFileSync(full, "utf8"), kMaxDocumentChars);
      const chip: FileChip = {
        kind: "file",
        id: newMessageId(),
        relativePath: item.relativePath,
        absolutePath: full,
        text,
      };
      const withLabels = assignDisplayLabels(this.currentChips, [chip]);
      this.currentChips.push(...withLabels);
      const chips = withLabels.map((c) => ({
        id: c.id,
        kind: c.kind,
        label: formatChipLabel(c),
      }));
      this.post({
        type: "suggestionPicked",
        inputText: nextInput,
        caret,
        insertText: wrapRef(formatChipLabel(withLabels[0]!)),
        chips,
      });
    } catch {
      this.post({ type: "toast", message: t("读取文件失败: {path}", this.locale, { path: item.relativePath }), error: true });
      this.post({ type: "suggestionPicked", inputText: nextInput, caret });
    }
  }

  /** 安装插件:调 MarketplaceManager.install → 回 plugin_installed;SkillIndex 每次重建,装完即见新技能。 */
  async installPlugin(marketplaceName: string, pluginName: string): Promise<void> {
    if (!this.marketplace) {
      this.post({ type: "plugin_installed", ok: false, message: "MarketplaceManager 未装配" });
      return;
    }
    this.post({ type: "status", busy: true, info: t("安装插件…", this.locale) });
    try {
      const dest = await this.marketplace.install(marketplaceName, pluginName, (stage) => {
        this.post({ type: "status", busy: true, info: stage });
      });
      this.post({ type: "status", busy: false, info: t("完成", this.locale) });
      this.post({ type: "plugin_installed", ok: true, message: t("已安装插件 {name}({dest})", this.locale, { name: pluginName, dest }) });
    } catch (err) {
      this.post({ type: "status", busy: false, info: t("安装失败", this.locale), error: true });
      this.post({ type: "plugin_installed", ok: false, message: t("安装插件失败: {error}", this.locale, { error: err instanceof Error ? err.message : String(err) }) });
    }
  }

  /**
   * 在隔离 git 工作树中运行后台任务:创建 worktree → 跑 task(收到工作树路径)→ remove,
   * 主分支不被污染。任务抛错时工作树照常清理,错误向上传播;清理失败也不得掩盖任务
   * 的原始错误(finally 里的 remove 抛错会替换掉任务错误,这里改为:原错误优先重抛,
   * 仅当任务本身成功时才抛 remove 错误)。
   */
  async runInWorktree(task: (wtPath: string) => Promise<void>): Promise<void> {
    if (!this.deps.worktree) throw new Error("Worktree not wired");
    const base = this.deps.getWorkspaceCwd();
    if (!base) throw new Error(t("请先打开一个工作区文件夹", this.locale));
    const wt = await this.deps.worktree.create(base);
    let taskError: unknown;
    try {
      await task(wt.path);
    } catch (err) {
      taskError = err;
    }
    try {
      // remove 必须在仓库目录内执行:扩展宿主进程 cwd 不保证是工作区(常为 $HOME),
      // 不带 cwd 会让 `git worktree remove` 找不到仓库、工作树残留注册。
      await this.deps.worktree.remove(wt.path, { cwd: base });
    } catch (removeErr) {
      if (taskError !== undefined) {
        this.post({
          type: "toast",
          message: t("工作树清理失败(任务结果不受影响): {error}", this.locale, { error: removeErr instanceof Error ? removeErr.message : String(removeErr) }),
          error: true,
        });
        throw taskError;
      }
      throw removeErr;
    }
    if (taskError !== undefined) throw taskError;
  }

  /** 在指定工作区根上运行一个一次性子会话(隔离工作树任务用):复用 createSession 装配,workspaceRoot 指向工作树。 */
  async runAgentIn(workspaceRoot: string, description: string): Promise<void> {
    // apiKey 守卫保留(与 send 同理由):无 key 时在发消息前抛错,行为与改造前一致;
    // createStandalone 内部同样校验(未设置 API Key)。
    const d = await this.clientDeps();
    if (!d.apiKey) throw new Error(t("未设置 API Key", this.locale));
    this.post({ type: "message", id: newMessageId(), role: "user", text: description });
    const assistantId = newMessageId();
    this.post({ type: "message", id: assistantId, role: "assistant", text: "" });
    this.projectRuntime.refreshRules(workspaceRoot);
    const { session } = await this.sessionService.createStandalone(workspaceRoot);
    await session.send(description, (ev) => this.onAgentEvent(ev, assistantId));
  }

  /** 收集推荐候选:已装市场插件 + VSCode 扩展 + 4 层技能。市场清单解析失败给出明确错误,不静默跳过。 */
  private collectCandidates(): PluginCandidate[] {
    const out: PluginCandidate[] = [];
    if (this.marketplace) {
      for (const m of this.marketplace.list()) {
        try {
          const manifest = parseMarketplaceManifest(marketplaceManifestPath(m.path));
          for (const p of manifest.plugins) {
            out.push({ name: p.name, source: "marketplace", origin: m.name, description: p.description, skills: [] });
          }
        } catch (err) {
          this.post({ type: "toast", message: t("读取插件市场 {name} 失败: {error}", this.locale, { name: m.name, error: err instanceof Error ? err.message : String(err) }), error: true });
        }
      }
    }
    for (const ext of this.extensions) {
      out.push({
        name: ext.id ?? path.basename(ext.extensionPath),
        source: "extension",
        origin: "vscode",
        description: "",
        skills: [],
      });
    }
    for (const s of this.projectRuntime.getSkillIndex().all()) {
      out.push({ name: s.name, source: "skill", origin: s.path, description: s.description, skills: [s.name] });
    }
    return out;
  }

  /**
   * /memory dream:用 LLM 整合跨会话记忆(合并相似/去重/摘要),失败抛错不写记忆。
   * 成功后把 lastDreamAt 落到 `<项目记忆目录>/meta.json`(dreamDue 双闸门的冷却依据)。
   * 复用 rankByLLM 的 AnthropicMessagesClient 装配:无 key 时抛错,由命令层 toast。
   */
  private async dreamMemoryNow(): Promise<{ before: number; after: number }> {
    const d = await this.clientDeps();
    if (!d.apiKey) throw new Error(t("未设置 API Key", this.locale));
    const client = new AnthropicMessagesClient(d);
    const llm = async (prompt: string): Promise<string> => {
      const result = await client.round(
        [{ role: "user", content: prompt }],
        { system: "你是记忆整理助手。基于给定记忆条目输出整合 JSON,规则见用户消息。只输出 JSON。", tools: [] },
        () => {},
      );
      return result.blocks
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
    };
    const result = await dreamMemory(this.memory, llm);
    this.memory.writeDreamAt(Date.now());
    return result;
  }

  /**
   * LLM 排序:单发一条消息要求按相关度对候选排序(只输出 JSON 数组)。
   * 任何失败(无 key / 网络 / 解析)降级为按 keywordFilter 原顺序返回(score=0.5, reason="关键词匹配")。
   */
  private async rankByLLM(query: string, candidates: PluginCandidate[]): Promise<RankedCandidate[]> {
    try {
      const d = await this.clientDeps();
      if (!d.apiKey) return this.keywordFallback(candidates);
      const client = new AnthropicMessagesClient(d);
      const system = "你是插件推荐引擎。按用户描述的相关度对候选排序。只输出 JSON 数组: [{index, score(0-1), reason}]";
      const listing = candidates.map((c, i) => `${i}. ${c.name} — ${c.description}`).join("\n");
      const result = await client.round(
        [{ role: "user", content: `用户需求: ${query}\n候选插件:\n${listing}` }],
        { system, tools: [] },
        () => {},
      );
      const text = result.blocks
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      return this.alignRankJson(text, candidates);
    } catch {
      return this.keywordFallback(candidates);
    }
  }

  /** 把模型返回的 JSON 与 shortlist 对齐:过滤无效 index,未覆盖的候选按原顺序补在末尾。 */
  private alignRankJson(text: string, candidates: PluginCandidate[]): RankedCandidate[] {
    const ranked: RankedCandidate[] = [];
    const seen = new Set<number>();
    for (const item of this.extractRankArray(text)) {
      const idx = item.index;
      if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length || seen.has(idx)) continue;
      seen.add(idx);
      const score = typeof item.score === "number" && item.score >= 0 && item.score <= 1 ? item.score : 0.5;
      ranked.push({ candidate: candidates[idx], score, reason: String(item.reason ?? "").slice(0, 200) });
    }
    for (let i = 0; i < candidates.length; i++) {
      if (!seen.has(i)) ranked.push({ candidate: candidates[i], score: 0.5, reason: t("关键词匹配", this.locale) });
    }
    return ranked;
  }

  /** 从模型输出中抽取 JSON 数组(容忍 markdown 围栏/前后缀文字);解析失败返回空数组。 */
  private extractRankArray(text: string): Array<{ index: number; score: number; reason?: unknown }> {
    const match = text.match(/\[[\s\S]*\]/);
    const raw = match ? match[0] : text;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((x): x is Record<string, unknown> => x !== null && typeof x === "object")
        .map((x) => ({ index: Number(x.index), score: Number(x.score), reason: x.reason }));
    } catch {
      return [];
    }
  }

  /** LLM 排序失败时的降级:候选已按 keywordFilter 排好序,原样返回即可。 */
  private keywordFallback(candidates: PluginCandidate[]): RankedCandidate[] {
    return candidates.map((c) => ({ candidate: c, score: 0.5, reason: t("关键词匹配", this.locale) }));
  }

  /**
   * 显式连接 MCP 服务器(用户 opt-in,由 dsbAgent.mcpConnect 命令调用)。
   * 连接后各会话 executor 经 onTools 实时收到工具定义并入 allToolDefs。返回已连接服务器数。
   */
  async mcpConnect(): Promise<number> {
    if (!this.mcp) return 0;
    const cwd = this.deps.getWorkspaceCwd();
    if (cwd) this.mcp.loadFromMcpJson(cwd);
    await this.mcp.connectAll();
    return this.mcp.connectedCount();
  }

  /**
   * 当前会话有快照的原文件路径列表(快照数量多→少),供 /rewind 命令枚举候选。
   * CheckpointStore 是无状态目录型存储,按 `当前工作区 + 会话 id` 重建即可读同一目录,
   * 无需持有会话实例。
   */
  rewindCandidates(): string[] {
    const store = this.currentCheckpointStore();
    return store ? store.files() : [];
  }

  /** 恢复指定文件到最近一份快照并提示;Agent 运行中或无可回退时提示但不执行。 */
  rewind(file: string): void {
    if (this.busy) {
      this.post({ type: "toast", message: t("Agent 运行中,不能回退文件", this.locale), error: true });
      return;
    }
    const store = this.currentCheckpointStore();
    if (!store || store.list(file).length === 0) {
      this.post({ type: "toast", message: t("该文件没有可回退的快照", this.locale), error: true });
      return;
    }
    try {
      store.restore(file);
    } catch (err) {
      this.post({ type: "toast", message: t("回退失败:{error}", this.locale, { error: err instanceof Error ? err.message : String(err) }), error: true });
      return;
    }
    this.post({ type: "toast", message: t("已回退 {file}", this.locale, { file: path.basename(file) }) });
  }

  private currentCheckpointStore(): CheckpointStore | undefined {
    const cwd = this.deps.getWorkspaceCwd();
    const sessionId = this.sessionService.getSessionId();
    if (!cwd || !sessionId) return undefined;
    return new CheckpointStore(cwd, sessionId);
  }

  private async init(): Promise<void> {
    this.projectRuntime.refreshRules();
    const apiKey = await this.deps.apiKeyStore.getApiKey();
    const provider = this.activeProvider();
    const providerKey = provider ? await this.deps.providerStore?.getApiKey(provider.id) : undefined;
    const providers = this.compatibleProviders().map((p) => ({ id: p.id, name: p.name, active: p.id === provider?.id }));
    this.post({ type: "sessions", sessions: this.sessionService.listSessions() });
    this.post({
      type: "init",
      cwd: this.deps.getWorkspaceCwd() ?? "",
      hasKey: Boolean(providerKey ?? apiKey),
      model: this.deps.configuration.model(),
      vimMode: this.vimModeEnabled(),
      permissionMode: this.permissionMode,
      providers,
      models: this.currentModels(),
      modes: this.currentModes(),
      currentCapabilities: this.currentCapabilities(),
      locale: this.locale,
      notificationsEnabled: this.notificationsEnabled(),
    });
    // 模型列表远程优先:init 后异步拉取(缓存未过期则直接复用),结果经 models_updated 下发
    void this.refreshActiveModels();
    // 自动恢复上次会话:禁止 init 无脑 create 空 JSONL(M2-3)
    const lastId = this.sessionUiState.getLastSessionId();
    if (lastId && this.deps.sessionStore.exists(lastId)) {
      this.loadSession(lastId);
      const interrupted = this.sessionUiState.getInterrupted();
      if (interrupted && interrupted.sessionId === lastId) {
        this.post({
          type: "toast",
          message: t("上次会话未完成,已恢复。发送消息即可继续。", this.locale),
        });
      }
    }
    // MCP:只解析 .mcp.json 配置(知道有哪些服务器),不在这里 spawn 服务器进程——
    // 连接推迟到显式 mcpConnect 命令或首次调用某工具时(权限批准后)进行,避免面板一开就拉起进程。
    const cwd = this.deps.getWorkspaceCwd();
    if (cwd && this.mcp) {
      this.mcp.loadFromMcpJson(cwd);
    }
  }

  /** 添加 chips(终端命令等外部捕获路径),并通知 webview 插入反引号标记。 */
  addPendingChips(chips: ContextChip[]): void {
    if (chips.length === 0) {
      return;
    }
    this.attachChips(chips, []);
  }

  private chipView(chip: ContextChip): { id: string; kind: string; label: string; dataUrl?: string } {
    const view = { id: chip.id, kind: chip.kind, label: formatChipLabel(chip) };
    if (chip.kind === "image") {
      return { ...view, dataUrl: `data:${chip.mimeType};base64,${chip.data}` };
    }
    return view;
  }

  private attachChips(incoming: ContextChip[], insertTexts: string[]): void {
    const withLabels = assignDisplayLabels(this.currentChips, incoming);
    this.currentChips.push(...withLabels);
    const chips = withLabels.map((chip) => this.chipView(chip));
    const texts =
      insertTexts.length > 0
        ? insertTexts
        : withLabels.map((c) => wrapRef(formatChipLabel(c)));
    this.post({ type: "chipsAttached", chips, insertTexts: texts });
  }

  private handlePaste(text: string): void {
    if (!this.autoChipsOnPaste() || !this.contextCapture) {
      this.post({ type: "pasteHandled", consumed: false, text });
      return;
    }
    const promoted = this.contextCapture.consumePasteAsChips(text);
    if (promoted.length === 0) {
      this.post({ type: "pasteHandled", consumed: false, text });
      return;
    }
    const chip = promoted[0]!;
    const [labeled] = assignDisplayLabels(this.currentChips, [chip]);
    let insert = wrapRef(formatChipLabel(labeled));
    if (labeled.kind === "editor") {
      const pasteMode = labeled.startLine === labeled.endLine ? "fullLine" : "multiLine";
      insert = editorInsertText(labeled, pasteMode);
    }
    this.attachChips([chip], [insert]);
  }

  private async openChip(id: string): Promise<void> {
    const chip = this.currentChips.find((c) => c.id === id);
    if (!chip) {
      return;
    }
    let vscode: typeof import("vscode");
    try {
      vscode = await import("vscode");
    } catch {
      return;
    }
    if (chip.kind === "document") {
      this.post({
        type: "status",
        busy: this.busy,
        info: chip.truncated ? `Document: ${chip.fileName} (truncated)` : `Document: ${chip.fileName}`,
      });
      return;
    }
    if (chip.kind === "image") {
      this.post({
        type: "status",
        busy: this.busy,
        info: chip.fileName ? `Image: ${chip.fileName}` : "Image attachment",
      });
      return;
    }
    if (chip.kind === "editor" || chip.kind === "file") {
      const uri = vscode.Uri.file(chip.absolutePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      if (chip.kind === "editor") {
        const start = new vscode.Position(Math.max(0, chip.startLine - 1), 0);
        const endLine = Math.max(0, chip.endLine - 1);
        const end = new vscode.Position(endLine, doc.lineAt(endLine).text.length);
        editor.selection = new vscode.Selection(start, end);
        editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
      }
      return;
    }
    if (chip.kind === "skill" || chip.kind === "rule") {
      const uri = vscode.Uri.file(chip.absolutePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      return;
    }
    const match = vscode.window.terminals.find((t) => t.name === chip.terminalName);
    (match ?? vscode.window.activeTerminal)?.show();
  }

  /** 消息正文内联链接双击跳转:外部 URL 交给系统浏览器打开。 */
  private async openUrl(rawUrl: string): Promise<void> {
    const url = (rawUrl ?? "").trim();
    if (!/^https?:\/\/\S+$/i.test(url)) return;
    try {
      const vscode = await import("vscode");
      await vscode.env.openExternal(vscode.Uri.parse(url));
    } catch {
      this.post({ type: "toast", message: t("无法打开链接:{url}", this.locale, { url }), error: true });
    }
  }

  /** 对话页面代码块双击跳转:打开文件并定位到行(相对路径按工作区根解析,失败 toast)。 */
  private async openFile(rawPath: string, line?: number): Promise<void> {
    const raw = (rawPath ?? "").trim();
    if (!raw) return;
    let vscode: typeof import("vscode");
    try {
      vscode = await import("vscode");
    } catch {
      return;
    }
    // 相对路径(以 ./ ../ 开头或不含盘符/绝对前缀)按工作区根拼接
    let full = raw;
    if (!path.isAbsolute(full)) {
      const ws = this.deps.getWorkspaceCwd();
      if (ws) full = path.join(ws, raw);
    }
    try {
      const uri = vscode.Uri.file(full);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      if (line !== undefined && Number.isFinite(line) && line >= 1) {
        const pos = new vscode.Position(Math.min(line - 1, doc.lineCount - 1), 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    } catch {
      this.post({ type: "toast", message: t("无法打开文件:{path}", this.locale, { path: raw }), error: true });
    }
  }

  /** 每日工作总结提醒的「生成」动作:发一条内部消息,让 agent 构建当天工作总结并按工程进度更新项目文档。 */
  async requestDailySummary(): Promise<void> {
    const prompt = [
      "请生成本日工作总结并更新项目文档:",
      "- 回顾今天完成的改动与进度(结合会话历史与 git 变更),列出完成项、进行中项、遇到的问题;",
      "- 按工程和项目进度更新项目整体文档(如 `.dsb/docs/project-overview.md` 或 `docs/` 下架构/模块文档),保持框架信息与当前代码一致;",
      "- 输出精炼,重点是可留作明日接续的进展与待办。",
    ].join("\n");
    await this.send(prompt, { recordActivity: false });
  }

  private handleAttachImages(images: Array<{ mimeType: string; data: string; fileName?: string }>): void {
    if (!this.currentCapabilities().supportsVision) {
      this.post({
        type: "toast",
        message: t("当前模型不支持图片输入(已禁用 vision)。可在设置面板为该模型开启 vision 能力。", this.locale),
        error: true,
      });
      return;
    }
    const { accepted, errors } = acceptImages(this.pendingImageCount, images, () => newMessageId());
    this.pendingImageCount += accepted.length;
    if (accepted.length > 0) {
      this.attachChips(accepted, []);
    }
    if (errors.length) {
      this.post({ type: "toast", message: errors.join("; "), error: true });
    }
  }

  private async handleAttachDocuments(documents: Array<{ fileName: string; mimeType: string; data: string }>): Promise<void> {
    const { accepted, errors } = await acceptDocuments(this.pendingDocumentCount, documents, () => newMessageId());
    this.pendingDocumentCount += accepted.length;
    if (accepted.length > 0) {
      this.attachChips(accepted, []);
    }
    if (errors.length) {
      this.post({ type: "toast", message: errors.join("; "), error: true });
    }
  }

  private removeChip(id: string): void {
    const idx = this.currentChips.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const [chip] = this.currentChips.splice(idx, 1);
    if (chip.kind === "image") this.pendingImageCount = Math.max(0, this.pendingImageCount - 1);
    else if (chip.kind === "document") this.pendingDocumentCount = Math.max(0, this.pendingDocumentCount - 1);
    this.post({ type: "chipRemoved", id, label: formatChipLabel(chip) });
  }

  newSession(): void {
    this.projectRuntime.refreshRules();
    this.sessionService.newSession();
    this.clearPendingAsks();
    this.pendingImageCount = 0;
    this.pendingDocumentCount = 0;
    this.currentChips = [];
    this.todo.clear();
    this.sessionUiState.setInterrupted(undefined);
    const id = this.sessionService.ensureSessionId();
    this.sessionUiState.setLastSessionId(id);
    this.post({ type: "reset" });
    this.post({ type: "sessions", sessions: this.sessionService.listSessions() });
  }

  /** 切换供应商:持久化 activeProviderId、重置会话(避免新旧供应商消息混入)、广播联动。 */
  private async handleSetProvider(providerId: string): Promise<void> {
    const store = this.deps.providerStore;
    const provider = store?.get(providerId);
    if (!store || !provider) {
      this.post({ type: "toast", message: t("供应商不存在: {id}", this.locale, { id: providerId }), error: true });
      return;
    }
    if (provider.protocol === "openai") {
      this.post({
        type: "toast",
        message: t("供应商 {name} 的协议暂不支持(仅支持 Anthropic 兼容协议),请在设置面板调整或删除", this.locale, { name: provider.name }),
        error: true,
      });
      return;
    }
    await store.setActive(providerId);
    this.currentModel = undefined; // 切供应商后模型回到该供应商默认
    this.newSession();
    await this.broadcastProviderUi(provider);
    this.post({ type: "toast", message: t("已切换到供应商 {name}", this.locale, { name: provider.name }) });
    // 模型列表远程优先:切换后异步拉取该供应商模型列表
    void this.refreshActiveModels();
  }

  /**
   * 设置面板增删改供应商后同步 Agent 顶栏,不重置会话。
   * (webview 仅在 init 时拉过一次列表;不主动推送会导致「设置里有供应商、顶栏仍未配置」。)
   */
  syncProviderUi(): void {
    const provider = this.activeProvider();
    void this.broadcastProviderUi(provider);
    void this.refreshActiveModels();
  }

  private async broadcastProviderUi(provider: ProviderDef | undefined): Promise<void> {
    const providers = this.compatibleProviders().map((p) => ({
      id: p.id,
      name: p.name,
      active: p.id === provider?.id,
    }));
    const providerKey = provider ? await this.deps.providerStore?.getApiKey(provider.id) : undefined;
    const apiKey = await this.deps.apiKeyStore.getApiKey();
    this.post({
      type: "provider_changed",
      providerId: provider?.id ?? "",
      providerName: provider?.name ?? "",
      providers,
      models: this.currentModels(),
      modes: this.currentModes(),
      capabilities: this.currentCapabilities(),
      hasKey: Boolean(providerKey ?? apiKey),
    });
  }

  /**
   * 远程优先拉取当前供应商模型列表并广播:
   * - 缓存未过期(hasFreshCache)直接复用,不闪烁 loading;
   * - 成功 → models_updated(remote);
   * - 失败 → 回退(旧缓存或内置全表)+ models_updated(builtin)+ 错误 toast。
   */
  private async refreshActiveModels(): Promise<void> {
    const provider = this.activeProvider();
    if (!provider || !this.deps.modelCatalog) return;
    if (!this.deps.modelCatalog.hasFreshCache(provider.id)) {
      this.post({ type: "models_updated", providerId: provider.id, source: "loading" });
    }
    try {
      const apiKey =
        (await this.deps.providerStore?.getApiKey(provider.id)) ??
        (await this.deps.apiKeyStore.getApiKey()) ??
        undefined;
      await this.deps.modelCatalog.fetchModels(provider, { apiKey: apiKey || undefined });
      this.post({
        type: "models_updated",
        providerId: provider.id,
        source: "remote",
        models: this.currentModels(),
      });
    } catch (err) {
      this.post({
        type: "models_updated",
        providerId: provider.id,
        source: "builtin",
        models: this.currentModels(),
      });
      this.post({
        type: "toast",
        message: t("模型列表拉取失败,已回退内置预设: {error}", this.locale, { error: err instanceof Error ? err.message : String(err) }),
        error: true,
      });
    }
  }

  private loadSession(id: string): void {
    this.projectRuntime.refreshRules();
    const events = this.sessionService.loadSession(id);
    this.clearPendingAsks();
    this.pendingImageCount = 0;
    this.pendingDocumentCount = 0;
    this.currentChips = [];
    this.todo.replaceAll(this.deps.sessionStore.loadTodos(id));
    // replaceAll 会同步已完成项内嵌的 - [ ] → - [x];立刻落盘,避免重启后旧脏清单再次误导模型
    try {
      this.deps.sessionStore.saveTodos(id, this.todo.list());
    } catch {
      // 清单落盘失败不阻断加载
    }
    this.sessionUiState.setLastSessionId(id);
    this.post({ type: "reset" });
    // 历史重放边界标记:webview 据此进入/退出「缓存模式」,初始只渲染最近 3 轮,
    // 用户向上滚动时才增量渲染更早的轮次,避免大会话一次性渲染卡顿。
    this.post({ type: "history_start" });
    let currentAssistantId = "";
    let textSeq = 0;
    let lastTextStepId: string | undefined;
    let sawExplicitFinal = false;

    const ensureAssistantShell = (): string => {
      if (currentAssistantId) return currentAssistantId;
      currentAssistantId = newMessageId();
      this.post({ type: "message", id: currentAssistantId, role: "assistant", text: "" });
      return currentAssistantId;
    };

    const markLastTextFinalIfNeeded = (): void => {
      if (sawExplicitFinal || !lastTextStepId || !currentAssistantId) return;
      // 旧会话无 final 字段:该轮最后一段 text 视为蓝框终稿
      this.post({
        type: "timeline_step",
        messageId: currentAssistantId,
        stepId: lastTextStepId,
        kind: "text",
        status: "completed",
        final: true,
      });
    };

    for (const ev of events) {
      if (ev.kind === "user") {
        markLastTextFinalIfNeeded();
        currentAssistantId = "";
        textSeq = 0;
        lastTextStepId = undefined;
        sawExplicitFinal = false;
        this.post({ type: "message", id: newMessageId(), role: "user", text: ev.text });
      } else if (ev.kind === "assistant") {
        const messageId = ensureAssistantShell();
        textSeq += 1;
        const stepId = `text-${textSeq}`;
        lastTextStepId = stepId;
        const final = ev.final === true;
        if (final) sawExplicitFinal = true;
        this.post({
          type: "timeline_step",
          messageId,
          stepId,
          kind: "text",
          status: "completed",
          text: ev.text,
          ...(final ? { final: true } : {}),
        });
      } else if (ev.kind === "thinking") {
        const messageId = ensureAssistantShell();
        this.post({
          type: "timeline_step",
          messageId,
          stepId: "thinking",
          kind: "thinking",
          status: "completed",
          durationMs: ev.durationMs,
          text: ev.text,
        });
      } else if (ev.kind === "tool") {
        const messageId = ensureAssistantShell();
        const presentation =
          ev.presentation ??
          presentTool(ev.name, ev.input, ev.detail, ev.status === "running" ? "running" : ev.status, this.locale);
        this.post({
          type: "timeline_step",
          messageId,
          stepId: `tool-${ev.name}-${ev.timestamp}`,
          kind: "tool",
          name: ev.name,
          displayName: presentation.displayName,
          status: ev.status,
          headerSecondary: presentation.headerSecondary,
          summary: presentation.summary,
          body: presentation.body,
        });
      }
    }
    markLastTextFinalIfNeeded();
    const todos = this.todo.list();
    if (todos.length > 0) {
      const messageId = currentAssistantId || newMessageId();
      if (!currentAssistantId) {
        this.post({ type: "message", id: messageId, role: "assistant", text: "" });
      }
      this.post({
        type: "timeline_step",
        messageId,
        stepId: "todos",
        kind: "todos",
        status: "completed",
        items: todos,
      });
    }
    this.post({ type: "history_end" });
  }

  private deleteSession(id: string): void {
    // 先判断是否为当前会话:deleteSession 内部对当前会话会重置 currentSessionId,
    // 必须在调用前捕获,才能决定走 controller 侧 newSession 清理还是仅刷新列表。
    const wasCurrent = this.sessionService.getSessionId() === id;
    this.sessionService.deleteSession(id);
    if (wasCurrent) this.newSession();
    else this.post({ type: "sessions", sessions: this.sessionService.listSessions() });
  }

  /**
   * 交互式追加:busy 期间把新消息排入 agent 队列,下一轮发送前注入(追加按钮);
   * 空闲时视为普通新消息直接发送。不展开 @引用/图片(追加仅文本,保持轻量)。
   */
  private appendMessage(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!this.busy) {
      void this.send(trimmed);
      return;
    }
    const session = this.sessionService.getSession();
    if (!session?.append) {
      this.post({ type: "toast", message: t("当前会话不可用,无法追加", this.locale), error: true });
      return;
    }
    session.append(trimmed);
    this.post({ type: "status", busy: true, info: t("已追加,等待模型处理…", this.locale), transient: true });
  }

  private async send(userText: string, opts?: { recordActivity?: boolean }): Promise<void> {
    if (this.busy) return; // 不依赖 webview 的 busy 标志,host 内部互斥
    this.busy = true;
    // 每日活动统计:记录本次发送时间(提醒器触发的内部消息不计入,避免拉晚平均收工时间)
    if (opts?.recordActivity !== false) {
      try {
        this.deps.activityStats?.recordActivity(new Date());
      } catch {
        // 统计失败不影响发送
      }
    }
    // 统计大模块:通用事件打点(只记录长度,不落消息内容,隐私友好)
    try {
      this.deps.statsStore?.record("message_sent", { textLen: userText.length });
    } catch {
      // 打点失败不影响发送
    }
    try {
      const d = await this.clientDeps();
      const cwd = this.deps.getWorkspaceCwd();
      if (!d.apiKey) {
        this.post({ type: "status", busy: false, info: "未设置 API Key。运行命令:DSBAgent: Set API Key", error: true });
        return;
      }
      if (!cwd) {
        this.post({ type: "status", busy: false, info: "请先打开一个工作区文件夹", error: true });
        return;
      }

      // 内联引用展开:`` `@label` `` 形式的引用把 doc/file prompt block 拼进 prompt,
      // 图片只留 `[Image ref: label]` 占位;消费掉的 chips 从 currentChips 移除。
      const { prompt, imageChips } = resolveInlineRefs(userText, this.currentChips);
      this.currentChips = [];
      this.pendingImageCount = 0;
      this.pendingDocumentCount = 0;

      const userMsgId = newMessageId();
      this.post({ type: "message", id: userMsgId, role: "user", text: userText });

      // apiKey 守卫保留(与 runAgentIn 同理由):无 key 时在发消息前提示,不产生幻影用户消息;
      // ensureSession 内部同样校验(未设置 API Key)。规则必须在 ensureSession 前刷新,
      // 让 makePermissions 闭包读到的 getRules() 是最新工作区约定设置。
      this.projectRuntime.refreshRules();
      const { session, sessionId } = await this.sessionService.ensureSession(cwd);
      this.sessionUiState.setLastSessionId(sessionId);
      this.sessionUiState.setInterrupted({ sessionId, at: Date.now() });

      const assistantId = newMessageId();
      this.currentAssistantId = assistantId;
      this.thinkingText.clear();
      this.thinkingStartedAt.clear();
      this.toolInputs.clear();
      this.openTextStep = null;
      this.textStepSeq = 0;
      this.textBuffers.clear();
      this.post({ type: "message", id: assistantId, role: "assistant", text: "" });

      // 模型收到展开后的 prompt;rawText 用于会话事件落盘,与 UI 气泡保持一致。
      // mode 透传给 session:plan/ask 只读子集在系统提示词与工具白名单里生效(见 modePolicy)。
      const opts: { rawText: string; images?: SdkImagePayload[]; mode?: "agent" | "plan" | "ask" } = {
        rawText: userText,
        mode: this.currentMode,
      };
      if (this.currentCapabilities().supportsVision && imageChips.length > 0) {
        opts.images = toSdkImages(imageChips);
      }
      await session.send(prompt, (ev) => this.onAgentEvent(ev, assistantId), opts);
    } finally {
      this.busy = false;
      // 交互式追加残留兜底:send 自然结束(done/error)时队列仍有未注入的追加
      // (模型在最后输出轮,无下一轮可注入)→ 作为新对话轮自动发出。
      // 用户点停止时 AgentSession.cancel() 已清空队列,不会触发补发。
      // await 兜底:让一次 handle(send) 完整覆盖「追加轮」,而非 fire-and-forget;
      // 第二轮已取空队列,不会递归。
      try {
        const pending = this.sessionService.getSession()?.takePendingAppends?.() ?? [];
        if (pending.length > 0) {
          await this.send(pending.join("\n"));
        }
      } catch {
        // 兜底失败不阻断原 send 返回
      }
    }
  }

  private ensureTextStep(assistantId: string): string {
    if (this.openTextStep) return this.openTextStep;
    this.textStepSeq += 1;
    const stepId = `text-${this.textStepSeq}`;
    this.openTextStep = stepId;
    this.textBuffers.set(stepId, "");
    this.post({
      type: "timeline_step",
      messageId: assistantId,
      stepId,
      kind: "text",
      status: "running",
    });
    return stepId;
  }

  private closeTextStep(assistantId: string, final: boolean): void {
    if (!this.openTextStep) return;
    const stepId = this.openTextStep;
    const text = this.textBuffers.get(stepId) ?? "";
    this.openTextStep = null;
    this.textBuffers.delete(stepId);
    this.post({
      type: "timeline_step",
      messageId: assistantId,
      stepId,
      kind: "text",
      status: "completed",
      text,
      ...(final ? { final: true } : {}),
    });
    if (!text.trim()) return;
    const sessionId = this.sessionService.getSessionId();
    if (sessionId) {
      this.deps.sessionStore.append(sessionId, {
        kind: "assistant",
        text,
        ...(final ? { final: true } : { final: false }),
        timestamp: Date.now(),
      });
    }
  }

  private finishThinking(assistantId: string): void {
    const text = this.thinkingText.get(assistantId);
    if (!text) return;
    const started = this.thinkingStartedAt.get(assistantId) ?? Date.now();
    const durationMs = Math.max(0, Date.now() - started);
    this.post({
      type: "timeline_step",
      messageId: assistantId,
      stepId: "thinking",
      kind: "thinking",
      status: "completed",
      durationMs,
      // 不带 text:webview 保留已累计内容
    });
    const sessionId = this.sessionService.getSessionId();
    if (sessionId) {
      this.deps.sessionStore.append(sessionId, {
        kind: "thinking",
        text,
        durationMs,
        timestamp: Date.now(),
      });
    }
    this.thinkingText.delete(assistantId);
    this.thinkingStartedAt.delete(assistantId);
  }

  private postToolStep(
    assistantId: string,
    callId: string,
    name: string,
    status: "running" | "completed" | "error",
    input: unknown,
    detail?: string,
  ): void {
    const presentation = presentTool(name, input, detail, status, this.locale);
    this.post({
      type: "timeline_step",
      messageId: assistantId,
      stepId: callId,
      kind: "tool",
      name,
      displayName: presentation.displayName,
      status,
      headerSecondary: presentation.headerSecondary,
      summary: presentation.summary,
      body: presentation.body,
    });
    if (name === "TodoWrite" && status === "completed") {
      this.post({
        type: "timeline_step",
        messageId: assistantId,
        stepId: "todos",
        kind: "todos",
        status: "completed",
        items: this.todo.list(),
      });
      const sid = this.sessionService.getSessionId();
      if (sid) this.deps.sessionStore.saveTodos(sid, this.todo.list());
    }
  }

  private onAgentEvent(ev: AgentLoopEvent, assistantId: string): void {
    // 注意:交互式追加(user_message)会把 currentAssistantId 切到新轮,
    // 因此各 case 一律经 current() 取当前 id(user_message 之前回退入参)。
    const current = (): string => this.currentAssistantId ?? assistantId;
    switch (ev.type) {
      case "status":
        this.post({ type: "status", busy: ev.busy, info: ev.info });
        break;
      case "info":
        // 压缩发生在轮次之间,agent 仍在运行:保持 busy,避免 UI 中途 idle(允许发消息/隐藏停止按钮)
        // transient:webview 端 2 秒后自动清空该提示文本,不改变 busy 状态
        this.post({ type: "status", busy: true, info: ev.text, transient: true });
        break;
      case "user_message":
        // 交互式追加在引擎层注入:关闭当前 assistant 时间线(视为一段完成),
        // 新开 user 框 + assistant 框,后续事件流向新的 currentAssistantId。
        this.closeTextStep(current(), true);
        this.finishThinking(current());
        this.post({ type: "assistant_done", messageId: current() });
        this.thinkingText.clear();
        this.thinkingStartedAt.clear();
        this.toolInputs.clear();
        this.openTextStep = null;
        this.textStepSeq = 0;
        this.textBuffers.clear();
        const nextAssistantId = newMessageId();
        this.currentAssistantId = nextAssistantId;
        this.post({ type: "message", id: newMessageId(), role: "user", text: ev.text });
        this.post({ type: "message", id: nextAssistantId, role: "assistant", text: "" });
        break;
      case "text_delta": {
        this.finishThinking(current());
        const stepId = this.ensureTextStep(current());
        this.textBuffers.set(stepId, (this.textBuffers.get(stepId) ?? "") + ev.text);
        this.post({ type: "stream", messageId: current(), text: ev.text, stepId });
        break;
      }
      case "thinking_delta": {
        this.closeTextStep(current(), false);
        if (!this.thinkingStartedAt.has(current())) {
          this.thinkingStartedAt.set(current(), Date.now());
        }
        const next = (this.thinkingText.get(current()) ?? "") + ev.text;
        this.thinkingText.set(current(), next);
        this.post({
          type: "timeline_step",
          messageId: current(),
          stepId: "thinking",
          kind: "thinking",
          status: "running",
          text: next,
        });
        break;
      }
      case "tool_call": {
        this.closeTextStep(current(), false);
        this.finishThinking(current());
        if (ev.input !== undefined) this.toolInputs.set(ev.callId, ev.input);
        const input = ev.input ?? this.toolInputs.get(ev.callId);
        this.postToolStep(current(), ev.callId, ev.name, ev.status, input, ev.detail);
        if (ev.status !== "running") this.toolInputs.delete(ev.callId);
        break;
      }
      case "usage":
        this.post({ type: "usage", inputTokens: ev.inputTokens, outputTokens: ev.outputTokens });
        break;
      case "compaction_stats":
        // 对话轮次 / thinking 压缩统计:header 徽章显示「最近 N 次对话 x 次压缩」
        this.post({ type: "compaction_stats", stats: ev.stats });
        break;
      case "error":
        this.closeTextStep(current(), false);
        this.finishThinking(current());
        this.post({ type: "status", busy: false, info: ev.message, error: true });
        // 错误级原生弹窗:不受面板可见性/通知开关约束(用户要求配好 key 后测试消息不对必须弹窗)
        try {
          this.notifier.error("DSBAgent", ev.message);
        } catch {
          // 弹窗失败不阻断流程(与待授权通知同策略)
        }
        break;
      case "done": {
        this.closeTextStep(current(), true);
        this.finishThinking(current());
        this.sessionUiState.setInterrupted(undefined);
        this.writeProgressMemory();
        this.post({ type: "assistant_done", messageId: current() });
        this.post({ type: "status", busy: false, info: t("完成", this.locale) });
        if (this.notificationsEnabled() && !this.isVisible()) this.notifier.info("DSBAgent", t("任务完成", this.locale));
        break;
      }
    }
  }

  /** Workflow 阶段进度:经 executor.onWorkflowProgress 转发到当前助手时间线。 */
  private postWorkflowProgress(stageId: string, status: "running" | "done" | "error"): void {
    const label = status === "running" ? t("运行中", this.locale) : status === "done" ? t("完成", this.locale) : t("出错", this.locale);
    const mapped = status === "done" ? "completed" : status;
    const messageId = this.currentAssistantId ?? "";
    const presentation = presentTool("Workflow", { goal: stageId }, t("阶段 {stage} {label}", this.locale, { stage: stageId, label }), mapped);
    this.post({
      type: "timeline_step",
      messageId,
      stepId: `workflow-${stageId}`,
      kind: "tool",
      name: "Workflow",
      displayName: presentation.displayName,
      status: mapped,
      headerSecondary: presentation.headerSecondary,
      summary: presentation.summary,
      body: presentation.body,
    });
  }

  /** 面板关闭 / deactivate 时兜底写进度摘要(失败只告警)。 */
  flushProgressMemory(): void {
    try {
      this.writeProgressMemory();
    } catch (err) {
      console.warn(`flushProgressMemory failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private writeProgressMemory(): void {
    if (!this.memory) return;
    const sessionId = this.sessionService.getSessionId();
    const workspaceRoot = this.deps.getWorkspaceCwd();
    if (!sessionId || !workspaceRoot) return;
    const sid = sessionId;
    try {
      this.deps.sessionStore.saveTodos(sid, this.todo.list());
    } catch {
      // todos 落盘失败不阻断进度记忆
    }
    const entry = buildSessionProgressMemory({
      workspaceRoot,
      sessionId: sid,
      events: this.deps.sessionStore.load(sid),
      todos: this.todo.list(),
    });
    try {
      this.memory.write(entry);
    } catch (err) {
      console.warn(`writeProgressMemory failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
