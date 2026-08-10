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
  mcp?: McpRegistry;
  hooks?: HookRunner;
  onWorkflowProgress?: (stageId: string, status: "running" | "done" | "error") => void;
}) => Promise<SessionLike>;
