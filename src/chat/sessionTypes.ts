import type { AgentLoopEvent } from "../agent/agentLoop";
import type { PermissionManager } from "../agent/permission";
import type { ProviderMessage } from "../agent/provider/types";
import type { Capabilities } from "../providers/types";
import type { SdkImagePayload } from "../context/imageAttach";
import type { SessionEvent } from "../session/sessionTypes";
import type { HookRunner } from "../hooks/hookRunner";
import type { McpRegistry } from "../mcp/mcpRegistry";

export type SessionLike = {
  send: (
    text: string,
    onEvent: (ev: AgentLoopEvent) => void,
    opts?: { rawText?: string; images?: SdkImagePayload[] },
  ) => Promise<void>;
  cancel: () => void;
  /** 用户手动强制压缩上下文;失败时抛错,由命令层 toast。可选:旧实现/mock 可不提供。 */
  compactNow?: () => Promise<void>;
  /** 交互式追加:busy 期间把新消息排入队列,下一轮发送前注入。可选:旧实现/mock 可不提供。 */
  append?: (text: string) => void;
  /** 取走尚未注入的追加(send 结束后兜底自动重发用)。可选:旧实现/mock 可不提供。 */
  takePendingAppends?: () => string[];
};

export type CreateSessionFn = (opts: {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 当前模型能力(thinking/vision),构造 client 时传入;缺省开启。 */
  capabilities?: Capabilities;
  workspaceRoot: string;
  permissions: PermissionManager;
  sessionId: string;
  initialHistory?: ProviderMessage[];
  onRecord?: (ev: SessionEvent) => void;
  onPersist?: (messages: ProviderMessage[]) => void;
  /** 全量快照持久化(方向 3):宿主拆两处落盘(apiHistory + 压缩块快照)。缺省回退 onPersist。 */
  agentPersist?: (snap: { messages: ProviderMessage[]; compactedBlock?: string }) => void;
  mcp?: McpRegistry;
  hooks?: HookRunner;
  onWorkflowProgress?: (stageId: string, status: "running" | "done" | "error") => void;
  /** 预置压缩块快照(方向 3):会话恢复回退场景下注入上次持久化块;缺省不注入。 */
  compactedPreset?: string;
}) => Promise<SessionLike>;
