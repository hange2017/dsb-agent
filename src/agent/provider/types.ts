import type { ToolDef } from "../tools/types";

export type ProviderBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export type ProviderToolUse = { id: string; name: string; input: Record<string, unknown> };

/** Provider 流停因;用于区分真结束与 max_tokens 截断。 */
export type ProviderStopReason = "end_turn" | "tool_use" | "max_tokens" | "other";

export type ProviderRoundResult = {
  blocks: ProviderBlock[];
  toolUses: ProviderToolUse[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /** 缓存命中的输入 token(Anthropic cache_read_input_tokens / DeepSeek prompt_cache_hit_tokens)。 */
    cacheReadTokens?: number;
    /** 未命中缓存的输入 token(Anthropic cache_creation_input_tokens / DeepSeek prompt_cache_miss_tokens)。 */
    cacheWriteTokens?: number;
  };
  /** 本轮停因;缺失时由上层做启发式兜底。 */
  stopReason?: ProviderStopReason;
};

export type ProviderAssistantContent = ProviderBlock[];

export type ProviderImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};

/**
 * tool_result 的 content:Anthropic 原生允许 string 或 text block 数组。
 * 引擎内部(api-history.json)坚持用 block 数组形状,string 仅用于测试/兼容旧快照读取。
 */
export type ProviderToolResultContent = string | Array<{ type: "text"; text: string }>;

export type ProviderUserBlock =
  | { type: "text"; text: string }
  | { type: "tool_result"; tool_use_id: string; content: ProviderToolResultContent }
  | ProviderImageBlock;

export type ProviderUserContent = string | ProviderUserBlock[];

export type ProviderMessage =
  | { role: "user"; content: ProviderUserContent }
  | { role: "assistant"; content: ProviderAssistantContent };

export type ProviderStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string };

export interface ProviderClient {
  /** 当前 client 绑定模型的能力自我介绍(只读)。 */
  readonly capabilities: import("../../providers/types").ModelCapabilities;
  round(
    messages: ProviderMessage[],
    opts: {
      system: string;
      tools: ToolDef[];
      signal?: AbortSignal;
      maxTokens?: number;
      /** 覆盖 capabilities.thinkingBudgetTokens;正整数时发 enabled+budget。 */
      thinkingBudgetTokens?: number;
      /** 显式禁用 thinking(即使模型声称支持);client 应发 thinking.disabled 且不读 thinking 流。 */
      thinkingDisabled?: boolean;
      /** Fallback 按子 client 重算动态预算用;缺省 0。 */
      lastInputTokens?: number;
    },
    onEvent: (ev: ProviderStreamEvent) => void,
  ): Promise<ProviderRoundResult>;
}
