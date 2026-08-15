import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import { execFile } from "child_process";
import { t } from "../i18n/strings";
import type { ApiKeyStore } from "../settings/apiKeyStore";
import type { Configuration } from "../settings/configuration";
import { VscodeNotifier } from "../notifications/notifier";
import { ChatController } from "./chatController";
import { ProjectRuntime } from "./projectRuntime";
import { AgentSession } from "../agent/agentLoop";
import { CompactionStats } from "../agent/compactionStats";
import { CheckpointStore } from "../agent/checkpoint";
import { AnthropicMessagesClient } from "../agent/provider/anthropicMessagesClient";
import { FallbackClient } from "../agent/provider/fallbackClient";
import { ToolExecutor } from "../agent/tools/executor";
import { loadAgentTemplates } from "../agent/agentTemplates";
import { TodoManager } from "../agent/tools/todoTool";
import type { SubagentFactory } from "../agent/subagentRunner";
import { buildSystemPrompt } from "../agent/systemPrompt";
import type { MemoryStore } from "../agent/memory/memoryStore";
import type { HookRunner } from "../hooks/hookRunner";
import { loadProjectContext } from "../projectContext";
import { ensureWorkspaceDsb } from "../projectContext/ensureWorkspaceDsb";
import { ensureProjectOverview } from "../projectContext/projectOverview";
import type { ActivityStatsStore } from "../stats/activityStats";
import type { StatsStore } from "../stats/statsStore";
import { SessionStore } from "../session/sessionStore";
import { ContextStore } from "../context/contextStore";
import { mergeMemoryIndex } from "../agent/memory/memoryStore";
import { buildDreamHint } from "../agent/memory/memoryDream";
import type { MarketplaceManager } from "../plugins/marketplace";
import type { McpRegistry } from "../mcp/mcpRegistry";
import type { WorktreeApi } from "../agent/worktree";
import type { SessionUiState } from "../settings/sessionUiState";
import type { ContextCapture } from "../context/contextCapture";
import type { ProviderStore } from "../providers/providerStore";
import type { ModelCatalog } from "../providers/modelCatalog";
import type { CapabilityRegistry } from "../providers/capabilityRegistry";
import { getConfiguredRipgrepPath } from "../util/ripgrepPath";

/** 执行 hook 命令的 execFile 封装(原 controller.runHookCommand 迁此,单一实现,注入 ProjectRuntime):
 * bash -c(Windows 下 cmd /c)执行并捕获输出;输入 JSON 走 stdin;失败不 reject(fail-open)。 */
function runHookCommandImpl(command: string, input: unknown): Promise<string> {
  return new Promise<string>((resolve) => {
    const isWin = process.platform === "win32";
    const child = execFile(
      isWin ? (process.env.ComSpec ?? "cmd.exe") : "/bin/bash",
      isWin ? ["/d", "/s", "/c", command] : ["-c", command],
      { timeout: 10_000 },
      (err, stdout, stderr) => {
        resolve(stdout || stderr || (err ? String(err.message ?? err) : ""));
      },
    );
    // 输入 JSON 写到子进程 stdin;hook 命令可能不读 stdin,写失败(EPIPE)不能炸掉宿主进程,
    // 故挂 error 监听 + try/catch(fail-open)。
    child.stdin?.on("error", () => {});
    try {
      child.stdin?.write(JSON.stringify(input ?? {}));
      child.stdin?.end();
    } catch {
      // 忽略 stdin 写入失败
    }
  });
}

export class ChatViewProvider {
  public static readonly viewType = "dsbAgent.chat";
  private panel: vscode.WebviewPanel | undefined;
  private panelDisposed = false;
  private controller: ChatController | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly apiKeyStore: ApiKeyStore,
    private readonly configuration: Configuration,
    private readonly sessionsDir: string,
    /** 跨会话记忆存储(项目作用域):controller(/memory 命令)与 executor(memory 工具)共享同一实例。 */
    private readonly memory: MemoryStore,
    /** 全局共享记忆(跨项目):memory 工具 scope=global 时读写;注入 system prompt 时与项目记忆合并(B6)。 */
    private readonly globalMemory: MemoryStore,
    /** 插件市场管理器(引擎层,无 vscode 依赖):由 extension.ts 用 globalStorageUri 装配后注入。 */
    private readonly marketplace: MarketplaceManager,
    /** MCP 服务器注册表(引擎层,无 vscode 依赖):由 extension.ts 装配后注入,init 时连接并桥接进 executor。 */
    private readonly mcp: McpRegistry,
    /** 插件缓存目录(globalStorageUri.fsPath):供技能扫描的 plugin 层读取 `<dir>/plugins/...`。 */
    private readonly pluginCacheDir: string,
    /** 冷存储根目录(globalStorage/context/<projectKey>):Provider 级共享 ContextStore。 */
    private readonly contextRoot: string,
    /** git 工作树 API(引擎层,无 vscode 依赖):由 extension.ts 用真实 execFile 后端装配后注入,/worktree 命令使用。 */
    private readonly worktree: WorktreeApi,
    /** 上次会话 / 中断标志(globalState)。 */
    private readonly sessionUiState: SessionUiState,
    /** 编辑器/终端复制→粘贴 chip 提升。 */
    private readonly contextCapture: ContextCapture,
    /** 供应商存储(多供应商管理;缺省 undefined 时 controller 回退扁平配置)。 */
    private readonly providerStore?: ProviderStore,
    /** 模型目录(内置表 + 远程拉取 + 缓存)。 */
    private readonly modelCatalog?: ModelCatalog,
    /** per-model 能力解析。 */
    private readonly capabilityRegistry?: CapabilityRegistry,
    /** 默认 UI 语言(设置面板未显式选择时,来自 vscode.env.language 归一)。 */
    private readonly defaultLocale: "zh" | "en" = "zh",
    /** 每日活动统计(记录每天最后一次发送时间,供工作总结提醒);未注入时跳过。 */
    private readonly activityStats?: ActivityStatsStore,
    /** 统计大模块:通用事件日志;未注入时跳过打点。 */
    private readonly statsStore?: StatsStore,
  ) {}

  getController(): ChatController | undefined {
    return this.controller;
  }

  /** 在编辑器右侧(ViewColumn.Beside)打开聊天面板;已有面板则直接唤起。 */
  show(): void {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      try {
        ensureWorkspaceDsb(workspaceRoot, {
          extensions: vscode.extensions.all.map((e) => ({
            extensionPath: e.extensionPath,
            id: e.id,
          })),
        });
        // 首次进入项目:检查是否有「项目整体框架/模块功能」文档,没有则自动生成
        // .dsb/docs/project-overview.md(幂等:已有框架文档或已生成过则跳过)
        ensureProjectOverview(workspaceRoot);
      } catch {
        // fail-open:脚手架/框架文档失败不阻断打开聊天
      }
    }
    if (this.panel && !this.panelDisposed) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      ChatViewProvider.viewType,
      "DSBAgent",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true, // 面板隐藏时保留 webview 状态,切回不丢聊天
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "dist"),
          vscode.Uri.joinPath(this.extensionUri, "dist", "webview"),
        ],
      },
    );
    this.panel = panel;
    this.panelDisposed = false;
    panel.webview.html = this.renderHtml(panel.webview);

    // 会话级任务清单:AgentSession(注入 system prompt)与 ToolExecutor(TodoWrite 路由)
    // 共享同一实例,chatController 在 done 时读取它推给 webview。
    const todo = new TodoManager();
    // 项目运行时(组合根装配):规则/hooks/技能/插件缓存由它持有,chatController 委托调用。
    // runHookCommand 沿用原 controller 的 execFile 封装(单一实现,不再重复)。
    const projectRuntime = new ProjectRuntime({
      getWorkspaceCwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      extensions: vscode.extensions.all,
      pluginCacheDir: this.pluginCacheDir,
      runHookCommand: (command, input) => runHookCommandImpl(command, input),
    });
    // Provider 级共享冷存储:Controller 归档与 Session/Executor/ContextRecall 必须同一实例
    const sharedContextStore = new ContextStore(this.contextRoot);
    const controller = new ChatController(
      {
        apiKeyStore: this.apiKeyStore,
        configuration: this.configuration,
        providerStore: this.providerStore,
        modelCatalog: this.modelCatalog,
        capabilityRegistry: this.capabilityRegistry,
        getWorkspaceCwd: () =>
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        sessionStore: new SessionStore(this.sessionsDir),
        contextStore: sharedContextStore,
        projectRuntime,
        todo,
        memory: this.memory,
        sessionUiState: this.sessionUiState,
        marketplace: this.marketplace,
        mcp: this.mcp,
        extensions: vscode.extensions.all,
        pluginCacheDir: this.pluginCacheDir,
        activityStats: this.activityStats,
        statsStore: this.statsStore,
        // 原生通知(面板隐藏时):任务完成→信息、错误/待授权→警告;开关由 vscode 配置控制。
        // 通知尽力而为:异步 rejection(vscode Thenable 只保证 then,没有 catch)与同步 throw
        // 都要吞掉,避免 unhandled rejection,也不能打断调用方(如 makeGateway 的待授权流程)。
        notifier: new VscodeNotifier({
          info: (m) => {
            try {
              void vscode.window.showInformationMessage(m).then(() => {}, () => {});
            } catch {
              // 通知失败忽略
            }
          },
          warn: (m) => {
            try {
              void vscode.window.showWarningMessage(m).then(() => {}, () => {});
            } catch {
              // 通知失败忽略
            }
          },
          // 错误级:原生弹窗 + "打开供应商设置"按钮(用户要求测试消息不对必须弹窗提醒)
          error: (m) => {
            const openLabel = t("打开供应商设置", this.defaultLocale);
            try {
              void vscode.window
                .showErrorMessage(m, openLabel)
                .then((pick) => {
                  if (pick === openLabel) {
                    void vscode.commands.executeCommand("dsbAgent.providerSettings");
                  }
                })
                .then(
                  () => {},
                  () => {},
                );
            } catch {
              // 弹窗失败忽略
            }
          },
        }),
        worktree: this.worktree,
        contextCapture: this.contextCapture,
        isVisible: () => panel.visible,
        notificationsEnabled: () =>
          vscode.workspace.getConfiguration("dsbAgent").get<boolean>("enableNotifications", true),
        vimModeEnabled: () =>
          vscode.workspace.getConfiguration("dsbAgent").get<boolean>("vimMode", false),
        updatePermissionMode: async (mode) => {
          await vscode.workspace.getConfiguration("dsbAgent").update("permissionMode", mode, vscode.ConfigurationTarget.Global);
        },
        defaultLocale: this.defaultLocale,
        updateLanguage: async (language) => {
          await vscode.workspace.getConfiguration("dsbAgent").update("language", language, vscode.ConfigurationTarget.Global);
        },
        updateVimMode: async (enabled) => {
          await vscode.workspace.getConfiguration("dsbAgent").update("vimMode", enabled, vscode.ConfigurationTarget.Global);
        },
        updateNotifications: async (enabled) => {
          await vscode.workspace.getConfiguration("dsbAgent").update("enableNotifications", enabled, vscode.ConfigurationTarget.Global);
        },
        createSession: async ({ apiKey, baseUrl, model, capabilities, workspaceRoot, permissions, sessionId, initialHistory, onRecord, onPersist, mcp, hooks, onWorkflowProgress }) => {
          const activeProvider = this.providerStore?.getActive();
          const resolveModelCapabilities = (modelId: string) =>
            this.capabilityRegistry && activeProvider
              ? this.capabilityRegistry.resolve(activeProvider, modelId)
              : capabilities;
          const primary = new AnthropicMessagesClient({ apiKey, baseUrl, model, capabilities });
          const provider = new FallbackClient({
            primary,
            fallbacks: this.configuration.fallbackModels().map((fallbackModel) => ({
              model: fallbackModel,
              make: (m) =>
                new AnthropicMessagesClient({
                  apiKey,
                  baseUrl,
                  model: m,
                  capabilities: resolveModelCapabilities(m),
                }),
            })),
          });
          let tools: ToolExecutor;
          // 子代理工厂:创建共享 provider/tools/permissions/workspaceRoot 的嵌套 AgentSession,
          // 深度 = 调用会话深度 + 1(读取共享 executor 上由 Agent 分支同步的 subagentDepth),
          // send 把子会话流式文本聚合为返回内容。executor 尚未赋值,闭包只在 Agent 执行时才调用。
          const subagentFactory: SubagentFactory = ({ systemPrompt }) => {
            const nested = new AgentSession({
              provider,
              tools,
              permissions,
              workspaceRoot,
              systemPrompt,
              subagentDepth: tools.subagentDepth + 1,
              todo,
              ripgrepPath: getConfiguredRipgrepPath(),
            });
            return {
              // AgentSession.send 在模型错误/超轮次时正常 resolve 并只发 error 事件,
              // 这里检测 error 事件并 throw,让 runSubagent 的 catch 把它转成 ok:false,
              // 避免子代理失败被当作成功返回给父会话。
              send: async (text, onEvent) => {
                let out = "";
                let errMsg: string | undefined;
                await nested.send(text, (ev) => {
                  if (ev.type === "text_delta") out += ev.text;
                  if (ev.type === "error") errMsg = ev.message;
                  onEvent(ev);
                });
                if (errMsg !== undefined) throw new Error(errMsg);
                return out;
              },
              cancel: () => nested.cancel(),
            };
          };
          // 会话级 checkpoint 存储:编辑前快照写入 `<workspaceRoot>/.dsb/checkpoints/<sessionId>/`,
          // 父会话与子代理共享同一 executor(及同一 store)。子代理工厂尚未赋值时闭包
          // 只读,不会执行快照,故在此处构造注入是安全的。
          const checkpoints = new CheckpointStore(workspaceRoot, sessionId);
          // 本会话 provider_send 轮次计数(供前缀命中分析按会话精确配对相邻轮)
          const sendSeqBySession = new Map<string, number>();
          // mcp 注册表在 executor 构造时订阅 onTools(含对已连接工具的重放),MCP 工具并入 allToolDefs()
          // 子代理模板(项目/用户/插件 .dsb/agents)按名注入 executor(第 10 个位置参数),
          // Agent 工具的 `agent` 参数据此解析角色;未命中返回 undefined → executor 报 Unknown agent。
          const agentTemplates = loadAgentTemplates(workspaceRoot, os.homedir(), projectRuntime.pluginDirs());
          // 冷存储:与 Controller 共用 sharedContextStore(压缩/裁切/ContextRecall 同一内存+磁盘)
          const contextStore = sharedContextStore;
          tools = new ToolExecutor(
            this.memory,
            todo,
            undefined,
            subagentFactory,
            0,
            checkpoints,
            mcp,
            hooks,
            onWorkflowProgress,
            (name) => agentTemplates.find((t) => t.name === name),
            undefined,
            this.globalMemory,
            contextStore,
            undefined, // platform(默认 process.platform)
            this.statsStore,
          );
          tools.registerPluginTools(projectRuntime.pluginToolSpecs());
          // 项目上下文合并 4 层技能(项目/用户/VSCode 扩展/插件);扩展/插件层由本 Provider 注入
          const ctx = await loadProjectContext(workspaceRoot, {
            extensions: vscode.extensions.all,
            pluginCacheDir: this.pluginCacheDir,
          });
          // 记忆索引在组装 system prompt 时读取(与 projectInstruction/skillList 同路径),跨会话共享;
          // 项目作用域可见记忆 = 项目记忆 + 全局共享记忆(旧版全局记忆保留在根目录,所有项目可见);
          // skillList 来自 controller 装配的 SkillIndex(与 /skill 命令同一份索引);
          // dreamHint:SessionStart 检查「记忆条数 ≥ 5 且距上次整合 ≥ 7 天」,达标才注入提示
          const locale = this.controller?.locale ?? this.defaultLocale;
          // A5 压缩质量抽查回调:可开关控制是否真正执行抽查(发送 provider 请求)。
          // 关闭时不传回调 → agentLoop 的 runCompactionQa 不触发(省一次 provider 轮 + 不落盘)。
          const onCompactionQa = this.configuration.compactionQaEnabled()
            ? (ev: {
                sessionId: string;
                seq: number;
                answerable: boolean;
                qaMs: number;
                qaInputTokens: number;
                qaOutputTokens: number;
                inTokens: number;
                outTokens: number;
              }) => {
                // 统计详细级别 basic:仅不落盘(保留统计开关 full 控制)
                if (this.configuration.statsDetailLevel() === "basic") return;
                this.statsStore?.record("compaction_qa", ev);
              }
            : undefined;
          const session = new AgentSession({
            provider,
            tools,
            permissions,
            workspaceRoot,
            systemPrompt: buildSystemPrompt({
              workspaceRoot,
              projectInstruction: ctx.projectInstruction,
              skillList: this.controller?.skillList() ?? ctx.skills,
              memoryIndex: mergeMemoryIndex(
                this.memory.index("项目", { limit: 30, maxDescLen: 120 }),
                this.globalMemory.index("全局", { limit: 5, maxDescLen: 120 }),
              ) || undefined,
              rules: ctx.rules,
              locale,
              platform: process.platform,
              dreamHint: buildDreamHint(this.memory, locale),
              // 项目框架文档:首次进入项目自动生成,注入摘要供 agent 参考
              projectOverview: ctx.projectOverview,
            }),
            initialHistory,
            onRecord,
            onPersist,
            todo,
            hooks,
            ripgrepPath: getConfiguredRipgrepPath(),
            contextStore,
            sessionId,
            triggerRatio: this.configuration.compactionTriggerRatio(),
            // 历史 token 预算:总大小 + 三块比例(0 = 关闭回退现状)
            historyTokenBudget: this.configuration.historyTokenBudget(),
            budgetSplit: this.configuration.budgetSplit(),
            // v2 流水线:窗口总长度覆盖(0=跟随模型) + 触发/目标比例
            windowTokensOverride: this.configuration.contextWindowTokens(),
            triggerPct: this.configuration.compactionTriggerPct(),
            targetPct: this.configuration.compactionTargetPct(),
            // 每会话独立统计:thinking 压缩频率(对话轮次 + 压缩次数,滑动窗口 100)
            stats: new CompactionStats(),
            // 处理侧 thinking 开关:false 时「模型可先思考(请求仍带预算),但流程不处理 thinking」——剥离产出(不进历史/压缩/脉络)
            thinkingProcessEnabled: this.configuration.compactionThinkingEnabled(),
            // 发送前打点:记录每次 provider.round 的消息组成 token(只记数字不记内容)
            onProviderSend: (breakdown) => {
              const sendSeq = (sendSeqBySession.get(sessionId) ?? 0) + 1;
              sendSeqBySession.set(sessionId, sendSeq);
              this.statsStore?.record("provider_send", {
                ...(breakdown as unknown as Record<string, unknown>),
                sessionId,
                sendSeq,
              });
            },
            // 发送后打点:记录模型返回的真实 usage(含缓存命中 token),供命中率统计
            onProviderRound: (usage) => {
              this.statsStore?.record("provider_round", { ...usage, sessionId });
            },
            // 压缩打点:记录每次压缩的位置 × 原因 × before/after tokens(只记数字不记内容)
            onCompaction: (ev) => {
              // detailLevel=basic:只保留基础轮次统计,过滤 A7 压缩逐位置 llm 明细
              const payload =
                this.configuration.statsDetailLevel() === "basic" ? { ...ev, llmDetail: undefined } : ev;
              this.statsStore?.record("compaction", payload as unknown as Record<string, unknown>);
            },
            onCompactionQa,
          });
          return session;
        },
      },
      (message) => void panel.webview.postMessage(message),
    );
    this.controller = controller;

    panel.webview.onDidReceiveMessage((msg) => {
      // header 供应商下拉占位项(未配置供应商)选中 → 打开设置面板,不进入 controller
      if (msg && typeof msg === "object" && (msg as { type?: string }).type === "open_provider_settings") {
        void vscode.commands.executeCommand("dsbAgent.providerSettings");
        return;
      }
      if (msg && typeof msg === "object" && (msg as { type?: string }).type === "open_memory_manager") {
        void vscode.commands.executeCommand("dsbAgent.memoryManage");
        return;
      }
      if (msg && typeof msg === "object" && (msg as { type?: string }).type === "open_agent_settings") {
        void vscode.commands.executeCommand("dsbAgent.agentSettings");
        return;
      }
      void controller.handle(msg);
    });
    panel.onDidDispose(() => {
      // 面板关闭:写进度摘要兜底,尽力终止在途会话;清空引用,下次 show() 重建
      this.panelDisposed = true;
      try {
        controller.flushProgressMemory();
      } catch {
        // ignore
      }
      void controller.handle({ type: "cancel" }).catch(() => {});
      if (this.panel === panel) {
        this.panel = undefined;
        this.controller = undefined;
      }
    });
  }

  private renderHtml(webview: vscode.Webview): string {
    const base = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview"));
    const scripts = webview.asWebviewUri(vscode.Uri.joinPath(base, "main.js"));
    const styles = webview.asWebviewUri(vscode.Uri.joinPath(base, "styles.css"));
    const templatePath = path.join(this.extensionUri.fsPath, "dist", "webview", "index.html");
    let template: string | undefined;
    try {
      template = fs.readFileSync(templatePath, "utf8");
    } catch {
      // dist/webview/index.html 缺失时退化为内联模板,面板不抛异常
    }
    return (template ?? this.fallbackHtml(webview.cspSource))
      .replaceAll("${styles}", styles.toString())
      .replaceAll("${scripts}", scripts.toString())
      .replaceAll("${cspSource}", webview.cspSource);
  }

  private fallbackHtml(cspSource: string): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src ${cspSource}; img-src ${cspSource} data:;"><link href="\${styles}" rel="stylesheet"></head>
<body>
<header id="appHeader"><span id="appTitle">DSBAgent</span>
<button id="newBtn" title="新会话">＋</button><button id="superPermBtn" data-i18n="超级权限" title="超级权限:开启后 agent 无需确认即可执行任何操作">超级权限</button></header>
<main id="messages"></main>
<div id="emptyHint"></div>
<footer id="composer">
<textarea id="input" rows="1" placeholder="输入消息…(Enter 发送 / Shift+Enter 换行)"></textarea>
<div id="actions"><button id="sendBtn">发送</button><button id="stopBtn" hidden>停止</button><div id="status"></div></div>
</footer>
<script src="\${scripts}"></script>
</body></html>`;
  }
}
