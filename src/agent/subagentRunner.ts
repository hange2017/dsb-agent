import type { AgentLoopEvent } from "./agentLoop";
import type { ToolDef } from "./tools/types";

export interface SubagentSession {
  send(text: string, onEvent: (ev: AgentLoopEvent) => void): Promise<string>;
  cancel(): void;
}

export type SubagentFactory = (opts: { systemPrompt: string; tools: ToolDef[] }) => SubagentSession;

export const MAX_SUBAGENT_DEPTH = 3;

/**
 * 运行一个子 agent 子任务。
 *
 * - 深度门禁:`depth >= MAX_SUBAGENT_DEPTH` 时拒绝(最多嵌套 MAX_SUBAGENT_DEPTH 层,
 *   `depth` 是调用会话的嵌套层数)。
 * - 失败传递:会话内模型错误/超轮次时,`send` 正常 resolve 且只经 `onEvent` 发 `error`
 *   事件,因此必须由工厂在 send 里检测 error 事件并 throw,这里 catch 后返回 ok:false。
 * - 取消级联:`signal` 是父会话的取消信号;abort 时调用 `session.cancel()` 让嵌套会话
 *   终止,并把本轮结果标记为 Aborted(而非误报成功)。
 */
export async function runSubagent(
  factory: SubagentFactory,
  task: string,
  system: string | undefined,
  depth: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; content: string }> {
  if (depth >= MAX_SUBAGENT_DEPTH) {
    return { ok: false, content: `ERROR: subagent depth exceeds ${MAX_SUBAGENT_DEPTH}` };
  }
  if (signal?.aborted) return { ok: false, content: "Aborted" };
  const systemPrompt = system
    ? `You are a focused sub-agent.\n${system}`
    : "You are a focused sub-agent. Complete the assigned task and report the result concisely.";
  const session = factory({ systemPrompt, tools: [] });
  try {
    const onAbort = (): void => session.cancel();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const answer = await session.send(task, () => {});
      if (signal?.aborted) return { ok: false, content: "Aborted" };
      return { ok: true, content: answer };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  } catch (err) {
    return { ok: false, content: `ERROR: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    session.cancel();
  }
}

/** Agent 工具定义:把子任务交给一个独立的子 agent 执行。 */
export const SUBAGENT_DEF: ToolDef = {
  name: "Agent",
  description: "把子任务交给一个独立的子 agent 执行并返回结果。适合需要独立上下文的长任务。",
  input_schema: {
    type: "object",
    properties: {
      task: { type: "string", description: "子任务描述" },
      system: { type: "string", description: "可选:子代理角色指令" },
      agent: { type: "string", description: "可选:使用已注册的子代理模板名(.dsb/agents/ 等)" },
    },
    required: ["task"],
  },
};
