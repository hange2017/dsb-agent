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
  /** true = 本轮明确禁用模型侧思考(预算装不进 maxTokens,或能力不支持)。 */
  thinkingDisabled?: boolean;
  windowTokens: number;
  maxParallelTools: number;
  toolParallelMode: ToolParallelMode;
}

/** 消息是否含可发送的非空 content(空串/空数组/仅空 text 会触发网关 400)。 */
export function messageHasNonEmptyContent(msg: ProviderMessage): boolean {
  const content = msg.content;
  if (typeof content === "string") return content.length > 0;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.some((b) => {
    if (b.type === "text") return (b.text ?? "").length > 0;
    if (b.type === "thinking") return (b.thinking ?? "").length > 0;
    // tool_use / tool_result / image 等块本身即非空载荷
    return true;
  });
}

/** 丢弃空 content 消息,避免 `messages.N: all messages must have non-empty content`。 */
export function dropEmptyContentMessages(messages: ProviderMessage[]): ProviderMessage[] {
  return messages.filter(messageHasNonEmptyContent);
}

/** 无 thinking 能力时从 outbound 历史剥掉 thinking 块,避免部分网关 400。 */
export function stripThinkingBlocks(messages: ProviderMessage[]): ProviderMessage[] {
  return messages.flatMap<ProviderMessage>((msg) => {
    if (msg.role !== "assistant") return [msg];
    const kept = msg.content.filter((b): b is Exclude<ProviderBlock, { type: "thinking" }> => b.type !== "thinking");
    // 仅 thinking 的回合剥光后丢弃,不再用空 text 占位(空 content → API 400)
    if (kept.length === 0) return [];
    return [{ role: "assistant", content: kept }];
  });
}

/** 无 vision 时剥 user content 中的 image 块(含历史附件)。 */
export function stripImageBlocks(messages: ProviderMessage[]): ProviderMessage[] {
  return messages.flatMap<ProviderMessage>((msg) => {
    if (msg.role !== "user") return [msg];
    if (typeof msg.content === "string") return [msg];
    const kept = msg.content.filter((b): b is Exclude<ProviderUserBlock, { type: "image" }> => b.type !== "image");
    if (kept.length === 0) return []; // 纯图片消息剥光后丢弃,避免 content:""
    if (kept.length === 1 && kept[0].type === "text") {
      return [{ role: "user", content: kept[0].text }];
    }
    return [{ role: "user", content: kept }];
  });
}

const REPAIRED_TOOL_RESULT =
  "ERROR: tool_result missing (repaired locally). The original tool call did not complete or was dropped from history.";

function syntheticToolResult(toolUseId: string): ProviderUserBlock {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: [{ type: "text", text: REPAIRED_TOOL_RESULT }],
  };
}

function toolUseIdsInAssistant(msg: ProviderMessage): string[] {
  if (msg.role !== "assistant") return [];
  return msg.content.filter((b): b is Extract<ProviderBlock, { type: "tool_use" }> => b.type === "tool_use").map((b) => b.id);
}

function toolResultIdsInUser(msg: ProviderMessage | undefined): Set<string> {
  const ids = new Set<string>();
  if (!msg || msg.role !== "user" || typeof msg.content === "string") return ids;
  for (const b of msg.content) {
    if (b.type === "tool_result") ids.add(b.tool_use_id);
  }
  return ids;
}

function isToolResultUserMessage(msg: ProviderMessage | undefined): boolean {
  if (!msg || msg.role !== "user" || typeof msg.content === "string") return false;
  return msg.content.some((b) => b.type === "tool_result");
}

/**
 * 修复历史中孤儿 / 被污染的 tool_use 配对。
 * Anthropic 兼容 API 要求:assistant 的每个 tool_use,紧随其后的 user 消息必须
 * **只含**对应的 tool_result 块(不能夹 text/todo),否则 400。
 *
 * 场景:中断落盘、旧会话损坏、injectTodo 误并入 tool_result 消息。
 * 策略:缺 id 补合成 ERROR;混有非 tool_result 内容时拆成「纯 results → 其余」。
 */
export function repairToolUseResultPairs(messages: ProviderMessage[]): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    out.push(msg);
    const useIds = toolUseIdsInAssistant(msg);
    if (useIds.length === 0) continue;

    const next = messages[i + 1];
    const present = toolResultIdsInUser(next);
    const missing = useIds.filter((id) => !present.has(id));

    if (isToolResultUserMessage(next)) {
      const blocks = next.content as ProviderUserBlock[];
      const resultBlocks = blocks.filter((b) => b.type === "tool_result");
      const otherBlocks = blocks.filter((b) => b.type !== "tool_result");
      const needsSplit = otherBlocks.length > 0;
      const needsFill = missing.length > 0;
      if (!needsSplit && !needsFill) {
        continue; // 纯净完整配对
      }
      const pureResults = [...resultBlocks, ...missing.map(syntheticToolResult)];
      out.push({ role: "user", content: pureResults });
      if (needsSplit) {
        // 把误并入的 text/todo 挪到 tool_result 之后
        if (otherBlocks.length === 1 && otherBlocks[0].type === "text") {
          out.push({ role: "user", content: otherBlocks[0].text });
        } else {
          out.push({ role: "user", content: otherBlocks });
        }
      }
      i += 1; // 已消费原 next
      continue;
    }

    // 下一条缺失 / 是普通 user 文本 / 是另一条 assistant → 中间插入合成结果
    out.push({ role: "user", content: useIds.map(syntheticToolResult) });
  }
  return out;
}

/** 按能力清洗即将发给模型的历史(幂等);并修复 tool_use/tool_result 配对。 */
export function sanitizeOutbound(caps: ModelCapabilities, messages: ProviderMessage[]): ProviderMessage[] {
  let out = repairToolUseResultPairs(messages);
  if (caps.supportsThinking === false) out = stripThinkingBlocks(out);
  if (caps.supportsVision === false) out = stripImageBlocks(out);
  // 落盘损坏 / thinking 全剥 / 空占位:统一剔除,防止网关 400 non-empty content
  return dropEmptyContentMessages(out);
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

/** Anthropic 扩展思考的预算下限(协议硬约束:budget_tokens >= 1024)。 */
export const kMinThinkingBudgetTokens = 1024;

/** 启用 thinking 时为正文保留的最小输出额度:避免预算把 max_tokens 吃光、只产出思考。 */
export const kThinkingOutputReserveTokens = 1024;

/**
 * thinking 参数解析:保证「发出的 thinking 组合协议自洽」。
 *
 * 规则(按 Anthropic 扩展思考硬约束 `budget_tokens < max_tokens` 推导,并额外保证正文有额度):
 *   ① 预算 + 正文预留 ≤ maxTokens → 原样启用;
 *   ② 超出 → 收敛为 `maxTokens - 正文预留`;
 *   ③ 收敛后 < 1024(协议下限)→ 禁用。
 * 为什么必须做:压缩摘要把 maxTokens 钳到 800/200,而能力预算仍是 medium=4096,
 * 旧行为原样透传 → `budget_tokens >= max_tokens` 违规,严格端点 400,
 * 且压缩调用被 catch 静默降级为兜底文案(压缩块变空、任务地图丢失);
 * 即便端点宽容接受,额度也全被思考吃掉(实测 51,428 tok 返回后未被采用)。
 */
export function resolveThinkingParams(
  caps: ModelCapabilities,
  maxTokens: number,
  opts?: { thinkingDisabled?: boolean },
): { thinkingBudgetTokens?: number; thinkingDisabled?: boolean } {
  if (caps.supportsThinking !== true) return { thinkingDisabled: true };
  if (opts?.thinkingDisabled === true) return { thinkingDisabled: true };
  const budget = effectiveThinkingBudgetTokens(caps);
  if (budget === undefined) return {};
  // ① 原预算 + 正文预留都装得下 → 原样(主对话常规路径,行为不变)。
  if (budget + kThinkingOutputReserveTokens <= maxTokens) return { thinkingBudgetTokens: budget };
  // ② 超出 → 收敛,把多余的输出额度还给正文。
  const fit = maxTokens - kThinkingOutputReserveTokens;
  // ③ 收敛后连协议下限(1024)都不到 → 禁用。
  //    典型:压缩摘要 explanation maxTokens=800 / resummarize 200 —— 这类任务本就不需要推理预算,
  //    旧行为是把 medium=4096 原样透传,既违规(4096 >= 800)又让模型把额度全烧在思考上。
  return fit >= kMinThinkingBudgetTokens ? { thinkingBudgetTokens: fit } : { thinkingDisabled: true };
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
  const thinking = resolveThinkingParams(caps, maxTokens);
  const maxParallelTools = effectiveMaxParallelTools(caps);
  const toolParallelMode = effectiveToolParallelMode(caps);
  const out: PrepareRoundResult = {
    outbound,
    maxTokens,
    windowTokens,
    maxParallelTools,
    toolParallelMode,
  };
  if (thinking.thinkingBudgetTokens !== undefined) out.thinkingBudgetTokens = thinking.thinkingBudgetTokens;
  if (thinking.thinkingDisabled === true) out.thinkingDisabled = true;
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
