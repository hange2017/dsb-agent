import type { ApiKeyStore } from "../settings/apiKeyStore";
import type { Configuration } from "../settings/configuration";
import type { SessionStore } from "../session/sessionStore";
import type { SessionEvent, SessionSummary } from "../session/sessionTypes";
import type { PermissionManager } from "../agent/permission";
import type { ProviderMessage } from "../agent/provider/types";
import type { HookRunner } from "../hooks/hookRunner";
import type { McpRegistry } from "../mcp/mcpRegistry";
import type { TodoManager } from "../agent/tools/todoTool";
import type { CreateSessionFn, SessionLike } from "./sessionTypes";

export interface SessionServiceDeps {
  apiKeyStore: ApiKeyStore;
  configuration: Configuration;
  getWorkspaceCwd: () => string | undefined;
  sessionStore: SessionStore;
  createSession: CreateSessionFn;
  mcp?: McpRegistry;
  todo?: TodoManager;
  currentModel: () => string | undefined;
  makePermissions: () => PermissionManager;
  makeHooks: (workspaceRoot: string) => HookRunner;
  onWorkflowProgress?: (stageId: string, status: "running" | "done" | "error") => void;
  /** 供应商感知的 client 依赖(apiKey/baseUrl/model/capabilities)。缺省回退 apiKeyStore + configuration。 */
  getClientDeps?: () => Promise<{ apiKey: string; baseUrl: string; model: string; capabilities?: import("../providers/types").Capabilities }>;
  /** 会话切换/删除时的历史归档钩子(写入冷存储,供 ContextRecall 跨会话回查)。失败应 fail-open。 */
  archiveHistory?: (sessionId: string, history: ProviderMessage[]) => void;
}

export class SessionService {
  private session: SessionLike | undefined;
  private sessionPermissions: PermissionManager | undefined;
  private currentSessionId: string | undefined;
  private history: ProviderMessage[] = [];

  constructor(private readonly deps: SessionServiceDeps) {}

  getSession(): SessionLike | undefined { return this.session; }
  getSessionId(): string | undefined { return this.currentSessionId; }
  getSessionPermissions(): PermissionManager | undefined { return this.sessionPermissions; }
  historySnapshot(): ProviderMessage[] { return [...this.history]; }

  /** 当前无会话 id 时创建并保留一个(面板 init 预留会话槽位;随后 ensureSession 复用该 id)。 */
  ensureSessionId(): string {
    if (!this.currentSessionId) this.currentSessionId = this.deps.sessionStore.create();
    return this.currentSessionId;
  }

  /** 当前供应商感知的 client 依赖;未注入 getClientDeps 时回退旧逻辑。 */
  private async clientDeps(): Promise<{ apiKey: string; baseUrl: string; model: string; capabilities?: import("../providers/types").Capabilities }> {
    if (this.deps.getClientDeps) return await this.deps.getClientDeps();
    const apiKey = await this.deps.apiKeyStore.getApiKey();
    if (!apiKey) throw new Error("未设置 API Key");
    return {
      apiKey,
      baseUrl: this.deps.configuration.baseUrl(),
      model: this.deps.currentModel() ?? this.deps.configuration.model(),
    };
  }

  /** 复用主会话创建(不存在则新建)。onRecord/onPersist 绑定到当前 sessionId。 */
  async ensureSession(workspaceRoot: string): Promise<{ session: SessionLike; sessionId: string }> {
    if (this.session) return { session: this.session, sessionId: this.currentSessionId! };
    const d = await this.clientDeps();
    const sessionId = this.currentSessionId ?? this.deps.sessionStore.create();
    this.currentSessionId = sessionId;
    const permissions = this.deps.makePermissions();
    this.sessionPermissions = permissions;
    const session = await this.deps.createSession({
      apiKey: d.apiKey,
      baseUrl: d.baseUrl,
      model: d.model,
      capabilities: d.capabilities,
      workspaceRoot,
      permissions,
      sessionId,
      initialHistory: this.history,
      onRecord: (ev) => this.deps.sessionStore.append(sessionId, ev),
      onPersist: (msgs) => this.deps.sessionStore.saveApiHistory(sessionId, msgs),
      mcp: this.deps.mcp,
      hooks: this.deps.makeHooks(workspaceRoot),
      onWorkflowProgress: this.deps.onWorkflowProgress,
    });
    this.session = session;
    return { session, sessionId };
  }

  /**
   * 一次性会话(隔离工作树任务):新建 sessionId,不触碰主会话状态。
   * 注意:不传 onWorkflowProgress —— 独立工作树会话没有 webview 时间线目标,
   * 传了反而会让 Workflow 工具发出 messageId 为空/过期的 timeline_step,与
   * 重接线前的 runAgentIn 行为保持一致。
   */
  async createStandalone(workspaceRoot: string): Promise<{ session: SessionLike; sessionId: string }> {
    const d = await this.clientDeps();
    const sessionId = this.deps.sessionStore.create();
    const permissions = this.deps.makePermissions();
    const session = await this.deps.createSession({
      apiKey: d.apiKey,
      baseUrl: d.baseUrl,
      model: d.model,
      capabilities: d.capabilities,
      workspaceRoot,
      permissions,
      sessionId,
      onRecord: (ev) => this.deps.sessionStore.append(sessionId, ev),
      onPersist: (msgs) => this.deps.sessionStore.saveApiHistory(sessionId, msgs),
      mcp: this.deps.mcp,
      hooks: this.deps.makeHooks(workspaceRoot),
    });
    return { session, sessionId };
  }

  loadSession(id: string): SessionEvent[] {
    // 切换到另一会话前,归档当前会话完整历史(冷存储;覆盖压缩未写入的尾部增量)
    if (this.currentSessionId && this.currentSessionId !== id && this.history.length > 0) {
      try {
        this.deps.archiveHistory?.(this.currentSessionId, this.history);
      } catch {
        // 归档失败不阻断切换(fail-open)
      }
    }
    this.cancel();
    this.session = undefined;
    this.sessionPermissions = undefined;
    this.currentSessionId = id;
    const events = this.deps.sessionStore.load(id);
    this.history = this.deps.sessionStore.loadApiHistory(id);
    if (this.history.length === 0) this.history = this.eventsToHistory(events);
    return events;
  }

  newSession(): void {
    if (this.currentSessionId && this.history.length > 0) {
      this.deps.archiveHistory?.(this.currentSessionId, this.history);
    }
    this.cancel();
    this.session = undefined;
    this.sessionPermissions = undefined;
    this.currentSessionId = undefined;
    this.history = [];
  }

  deleteSession(id: string): void {
    // 删除前归档完整历史到冷存储(即使会话删除,.context.json 仍保留,ContextRecall 可跨会话回查)
    try {
      const history = this.deps.sessionStore.loadApiHistory(id);
      if (history.length > 0) this.deps.archiveHistory?.(id, history);
    } catch {
      // 归档失败不阻断删除(fail-open)
    }
    this.deps.sessionStore.delete(id);
    if (this.currentSessionId === id) this.newSession();
  }

  listSessions(): SessionSummary[] {
    return this.deps.sessionStore.list();
  }

  cancel(): void {
    this.session?.cancel();
  }

  /** legacy 回退路径:旧会话无 api-history 时,把展示事件压成纯文本 user/assistant。 */
  private eventsToHistory(events: SessionEvent[]): ProviderMessage[] {
    const history: ProviderMessage[] = [];
    for (const ev of events) {
      if (ev.kind === "user") history.push({ role: "user", content: ev.text });
      else if (ev.kind === "assistant") history.push({ role: "assistant", content: [{ type: "text", text: ev.text }] });
    }
    return history;
  }
}
