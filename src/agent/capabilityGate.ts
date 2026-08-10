import type { ProviderBlock, ProviderMessage, ProviderUserBlock } from "./provider/types";
import type { ModelCapabilities } from "../providers/types";
import {
  effectiveContextWindowTokens,
  effectiveMaxOutputTokens,
  effectiveMaxParallelTools,
  effectiveThinkingBudgetTokens,
  effectiveToolParallelMode,
} from "../providers/capabilities";

export type ToolParallelMode = "read_safe" | "serial";

export interface PrepareRoundInput {
  caps: ModelCapabilities;
  messages: ProviderMessage[];
  /** 上一轮 usage.inputTokens;缺省 0(首轮等同静态 maxOutput)。 */
  lastInputTokens?: number;
  /** 给大模型的输入最大长度覆盖;>0 时替代模型能力窗口(影响 maxTokens 与 windowTokens)。 */
  windowTokensOverride?: number;
}

export interface PrepareRoundResult {
  outbound: ProviderMessage[];
  maxTokens: number;
  thinkingBudgetTokens?: number;
  windowTokens: number;
  maxParallelTools: number;
  toolParallelMode: ToolParallelMode;
}

/** 无 thinking 能力时从 outbound 历史剥掉 thinking 块,避免部分网关 400。 */
export function stripThinkingBlocks(messages: ProviderMessage[]): ProviderMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    const kept = msg.content.filter((b): b is Exclude<ProviderBlock, { type: "thinking" }> => b.type !== "thinking");
    if (kept.length === 0) {
      return { role: "assistant", content: [{ type: "text", text: "" }] };
    }
    return { role: "assistant", content: kept };
  });
}

/** 无 vision 时剥 user content 中的 image 块(含历史附件)。 */
export function stripImageBlocks(messages: ProviderMessage[]): ProviderMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "user") return msg;
    if (typeof msg.content === "string") return msg;
    const kept = msg.content.filter((b): b is Exclude<ProviderUserBlock, { type: "image" }> => b.type !== "image");
    if (kept.length === 0) {
      return { role: "user", content: "" };
    }
    if (kept.length === 1 && kept[0].type === "text") {
      return { role: "user", content: kept[0].text };
    }
    return { role: "user", content: kept };
  });
}

/** 按能力清洗即将发给模型的历史(幂等)。 */
export function sanitizeOutbound(caps: ModelCapabilities, messages: ProviderMessage[]): ProviderMessage[] {
  let out = messages;
  if (caps.supportsThinking === false) out = stripThinkingBlocks(out);
  if (caps.supportsVision === false) out = stripImageBlocks(out);
  return out;
}

/** 剩余窗约束 max_tokens:min(cap, remaining - reserve),至少 1。 */
export function dynamicMaxTokens(opts: {
  windowTokens: number;
  lastInputTokens: number;
  maxOutputTokens: number;
}): number {
  const { windowTokens, lastInputTokens, maxOutputTokens } = opts;
  const remaining = Math.max(0, windowTokens - Math.max(0, lastInputTokens));
  const reserve = Math.min(1024, Math.floor(windowTokens * 0.01));
  const room = Math.max(1, remaining - reserve);
  return Math.max(1, Math.min(maxOutputTokens, room));
}

/**
 * loop 能力消费中枢:outbound 清洗 + round opts + 并行策略。
 * Client 仍负责 thinking 线格式(disabled / enabled+budget)。
 */
export function prepareRound(input: PrepareRoundInput): PrepareRoundResult {
  const { caps, messages } = input;
  const lastInputTokens = input.lastInputTokens ?? 0;
  const windowTokens =
    input.windowTokensOverride && input.windowTokensOverride > 0
      ? input.windowTokensOverride
      : effectiveContextWindowTokens(caps);
  const outbound = sanitizeOutbound(caps, messages);
  const maxTokens = dynamicMaxTokens({
    windowTokens,
    lastInputTokens,
    maxOutputTokens: effectiveMaxOutputTokens(caps),
  });
  const thinkingBudgetTokens = effectiveThinkingBudgetTokens(caps);
  const maxParallelTools = effectiveMaxParallelTools(caps);
  const toolParallelMode = effectiveToolParallelMode(caps);
  const out: PrepareRoundResult = {
    outbound,
    maxTokens,
    windowTokens,
    maxParallelTools,
    toolParallelMode,
  };
  if (thinkingBudgetTokens !== undefined) out.thinkingBudgetTokens = thinkingBudgetTokens;
  return out;
}

/** 工具批结束后:每个 tool_use 槽位都必须有对应 tool_result(防 API 400)。 */
export function assertToolResultsComplete(
  slots: Array<
    { type: "tool_result"; tool_use_id: string; content: Array<{ type: "text"; text: string }> } | undefined
  >,
): asserts slots is Array<{ type: "tool_result"; tool_use_id: string; content: Array<{ type: "text"; text: string }> }> {
  if (slots.some((b) => b === undefined)) {
    throw new Error("Internal: missing tool_result after execute batch");
  }
}
