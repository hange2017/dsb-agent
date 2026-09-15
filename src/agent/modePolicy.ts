export type AgentMode = "agent" | "plan" | "ask";

/** plan/ask 白名单:不在其中的工具(含 mcp__*、写/执行/子代理等)一律排除,比黑名单更安全。 */
const PLAN_ALLOWED = new Set(["Read", "Glob", "Grep", "LS", "WebSearch", "WebFetch", "MemoryRead", "ContextRecall", "TodoWrite"]);
const ASK_ALLOWED = new Set(["Read", "Glob", "Grep", "LS", "MemoryRead", "ContextRecall"]);

/** 该模式是否允许调用某工具;agent 恒真(与现网一致)。 */
export function isToolAllowed(mode: AgentMode, toolName: string): boolean {
  if (mode === "agent") return true;
  return (mode === "plan" ? PLAN_ALLOWED : ASK_ALLOWED).has(toolName);
}

/**
 * 模式说明段(**不再挂 system**,改由 agentLoop 作为任务锚的一部分投递到消息尾部)。
 * 返回空串表示无附加说明(agent 模式)。
 *
 * 为什么不挂 system:T2 起 system 必须跨轮字节恒定;挂 mode 段会让 system 变长,
 * 导致 tools + 全部 messages 前缀 miss。放消息尾部则只影响尾部,前缀照常命中。
 *
 * 注:tools 数组恒为**全量**(不再按模式过滤,避免工具 JSON 变化打断前缀)。
 * 故文案必须显式说明「列表中出现 ≠ 本模式可用」,执行层仍有 `isToolAllowed` 硬拒兜底。
 */
export function modeSystemSegment(mode: AgentMode): string {
  switch (mode) {
    case "plan":
      return "当前处于 Plan 模式:只能读取与搜索,禁止修改仓库、执行命令或调用子代理。请只给出方案,不要改动任何文件。(提示:工具列表中出现的写/执行类工具在本模式下不可用,调用会被拒绝。)";
    case "ask":
      return "当前处于 Ask 模式:只回答用户的提问,不要修改仓库、执行命令或调用子代理。(提示:工具列表中出现的写/执行类工具在本模式下不可用,调用会被拒绝。)";
    default:
      return "";
  }
}

/** 切换模式时 webview toast 文案。 */
export function modeToastText(mode: AgentMode): string {
  switch (mode) {
    case "plan":
      return "模式:Plan(只读:仅搜索/阅读,不修改/执行)";
    case "ask":
      return "模式:Ask(仅问答,不执行副作用)";
    default:
      return "模式:Agent(全量工具)";
  }
}

/**
 * thinking 独立压缩是否启用:仅 agent 模式开启;plan/ask 自动关闭
 * (省一次 LLM 调用,thinking 回退为剥离丢弃)。
 */
export function thinkingEnabledForMode(mode: AgentMode): boolean {
  return mode === "agent";
}
