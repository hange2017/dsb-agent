export type ToolPlatform = NodeJS.Platform; // "win32" | "linux" | "darwin" | ...

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** 可选:仅在该平台集合暴露;缺省 = 全平台。 */
  platforms?: ToolPlatform[];
};

export type ToolExecContext = {
  workspaceRoot: string;
  signal?: AbortSignal;
  /** 当前会话的 subagent 嵌套深度;由 AgentSession 维护并传给 execute,Agent 工具用它限制递归。 */
  subagentDepth?: number;
  /** ripgrep 绝对路径;扩展宿主 PATH 通常无 `rg`,必须由 activate 注入。 */
  ripgrepPath?: string;
  /** 会话 id:ContextRecall 按会话回查冷存储;缺省 "default"。 */
  sessionId?: string;
  /** 平台门禁过滤与提示词构建用的平台;缺省 process.platform。测试可注入。 */
  platform?: NodeJS.Platform;
};

export type ToolExecResult = { ok: boolean; content: string };

export const MAX_TOOL_RESULT_CHARS = 100 * 1024;
