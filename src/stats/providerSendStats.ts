import type { ProviderMessage, ProviderToolResultContent } from "../agent/provider/types";
import { isCompactedBlock, isThinkingBlock } from "../agent/contextCompactor";

/**
 * 每次调用 provider.round 时发送给模型的一包消息的 token 组成统计。
 * 纯 TS 无 vscode 依赖,可单测。
 *
 * 目的:只记录"每种数据的 token 数"(不记录内容),积累后分析历史组成占比,
 * 为「历史 token 预算分配(压缩块/thinking/tail 按比例)」提供真实数据依据。
 */

export interface ProviderSendBreakdown {
  /** system + messages 全部 token(估算)。 */
  totalTokens: number;
  /** system 参数(基础 systemPrompt + Todo 块 + mode 段)。 */
  systemTokens: number;
  /** messages 数组合计 token。 */
  messagesTokens: number;
  /** [compacted] 四轨压缩块(需求/结论/说明/工具履历)。 */
  compactedBlockTokens: number;
  /** [thinking] 推理脉络块(独立 user 消息)。 */
  thinkingBlockTokens: number;
  /** user 普通文本消息(历史用户输入 + 当前轮输入;不含压缩块/thinking 块)。 */
  userTextTokens: number;
  /** user 消息中的 tool_result 块(工具输出原文/关键行)。 */
  toolResultTokens: number;
  /** assistant text 块(模型回复正文)。 */
  assistantTextTokens: number;
  /** assistant tool_use 块(工具名 + 参数 JSON)。 */
  toolUseTokens: number;
  /** assistant thinking 原文块(tail 内未压缩的推理过程)。 */
  assistantThinkingTokens: number;
  /** image 块(base64 按字节粗估)。 */
  imageTokens: number;
  /** 当前轮用户输入(最后一条 user 消息,不含压缩块/thinking 块)。 */
  currentRoundTokens: number;
  /** tail 部分 = messages - 压缩块 - thinking 块(保留区,含当前轮)。 */
  tailTokens: number;
  /** tail 消息条数(非压缩块/非 thinking 块的消息数)。 */
  tailMessageCount: number;
  /** 本次发送是否含压缩块。 */
  hasCompactedBlock: boolean;
  /**
   * 逐条明细:每条消息(或消息内每个块)的 kind + tokens + index。
   * 只记数字不记内容,用于定位「哪条消息/哪个块最大」(如超大的 tool_result)。
   */
  messageBreakdown: ProviderSendPart[];
  /** 本次估算耗时(ms):estimateProviderSendTokens 从开始到返回的耗时。 */
  preparedMs?: number;
}

/** 明细中一个部分的种类(与汇总字段一一对应)。 */
export type ProviderSendPartKind =
  | "compacted" // [compacted] 压缩块消息
  | "thinking_block" // [thinking] 推理脉络块消息
  | "user_text" // user 普通文本(text string / text 块)
  | "tool_result" // user tool_result 块
  | "image" // user image 块
  | "text" // assistant text 块
  | "tool_use" // assistant tool_use 块
  | "assistant_thinking"; // assistant thinking 原文块

export interface ProviderSendPart {
  /** 在 messages 数组中的下标。 */
  index: number;
  role: "user" | "assistant";
  kind: ProviderSendPartKind;
  tokens: number;
}

/** CJK(中/日/韩)字符范围。 */
const kCjkRe = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/;

/**
 * 文本 → token 粗估:CJK 每字 ≈ 1 token,其余每 4 字符 ≈ 1 token。
 * 统计占比用,±30% 误差可接受;不追求与 provider 精确一致。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (kCjkRe.test(ch)) cjk++;
    else other++;
  }
  return Math.max(1, cjk + Math.ceil(other / 4));
}

/** image 块 token 粗估:按 base64 解码后字节数,每 1024 字节 ≈ 1 token。 */
export function estimateImageTokens(data: string): number {
  if (!data) return 0;
  const bytes = Math.floor((data.length * 3) / 4);
  return Math.max(1, Math.ceil(bytes / 1024));
}

function toolResultText(content: ProviderToolResultContent): string {
  if (typeof content === "string") return content;
  return content.map((t) => t.text).join("\n");
}

/**
 * 单条消息的 token 估算(与整包分类口径一致):
 * - user string:[compacted]/[thinking] 与普通文本都按其内容估算(是否特殊块由调用方判断);
 * - user blocks:image + tool_result + text 累加;
 * - assistant:text + thinking 原文 + tool_use(参数 JSON)累加。
 */
export function estimateMessageTokens(msg: ProviderMessage): number {
  if (msg.role === "user") {
    if (typeof msg.content === "string") {
      return estimateTokens(msg.content);
    }
    let total = 0;
    for (const b of msg.content) {
      if (b.type === "image") {
        total += estimateImageTokens(b.source.data);
      } else if (b.type === "tool_result") {
        total += estimateTokens(toolResultText(b.content));
      } else if (b.type === "text") {
        total += estimateTokens(b.text);
      }
    }
    return total;
  }
  let total = 0;
  for (const b of msg.content) {
    if (b.type === "text") {
      total += estimateTokens(b.text);
    } else if (b.type === "thinking") {
      total += estimateTokens(b.thinking);
    } else if (b.type === "tool_use") {
      total += estimateTokens(JSON.stringify(b.input ?? ""));
    }
  }
  return total;
}

/**
 * 统计一包待发送消息的 token 组成:按消息角色与块类型全种类分类。
 * - user string 消息:[compacted]/[thinking] 单独成类,其余为普通文本;
 * - user blocks 消息:image / tool_result / text 分开计;
 * - assistant 消息:text / thinking 原文 / tool_use(参数 JSON)分开计。
 */
export function estimateProviderSendTokens(system: string, messages: ProviderMessage[]): ProviderSendBreakdown {
  const t0 = Date.now();
  const systemTokens = estimateTokens(system);
  let compactedBlockTokens = 0;
  let thinkingBlockTokens = 0;
  let userTextTokens = 0;
  let toolResultTokens = 0;
  let assistantTextTokens = 0;
  let toolUseTokens = 0;
  let assistantThinkingTokens = 0;
  let imageTokens = 0;
  let tailMessageCount = 0;
  const messageBreakdown: ProviderSendPart[] = [];

  const countUserText = (n: number): void => {
    userTextTokens += n;
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (isCompactedBlock(msg.content)) {
          const t = estimateTokens(msg.content);
          compactedBlockTokens += t;
          messageBreakdown.push({ index: i, role: "user", kind: "compacted", tokens: t });
        } else if (isThinkingBlock(msg.content)) {
          const t = estimateTokens(msg.content);
          thinkingBlockTokens += t;
          messageBreakdown.push({ index: i, role: "user", kind: "thinking_block", tokens: t });
        } else {
          const t = estimateTokens(msg.content);
          countUserText(t);
          messageBreakdown.push({ index: i, role: "user", kind: "user_text", tokens: t });
          tailMessageCount++;
        }
      } else {
        let isTail = false;
        for (const b of msg.content) {
          if (b.type === "image") {
            const t = estimateImageTokens(b.source.data);
            imageTokens += t;
            messageBreakdown.push({ index: i, role: "user", kind: "image", tokens: t });
            isTail = true;
          } else if (b.type === "tool_result") {
            const t = estimateTokens(toolResultText(b.content));
            toolResultTokens += t;
            messageBreakdown.push({ index: i, role: "user", kind: "tool_result", tokens: t });
            isTail = true;
          } else if (b.type === "text") {
            const t = estimateTokens(b.text);
            countUserText(t);
            messageBreakdown.push({ index: i, role: "user", kind: "user_text", tokens: t });
            isTail = true;
          }
        }
        if (isTail) tailMessageCount++;
      }
    } else {
      for (const b of msg.content) {
        if (b.type === "text") {
          const t = estimateTokens(b.text);
          assistantTextTokens += t;
          messageBreakdown.push({ index: i, role: "assistant", kind: "text", tokens: t });
        } else if (b.type === "thinking") {
          const t = estimateTokens(b.thinking);
          assistantThinkingTokens += t;
          messageBreakdown.push({ index: i, role: "assistant", kind: "assistant_thinking", tokens: t });
        } else if (b.type === "tool_use") {
          const t = estimateTokens(JSON.stringify(b.input ?? ""));
          toolUseTokens += t;
          messageBreakdown.push({ index: i, role: "assistant", kind: "tool_use", tokens: t });
        }
      }
      tailMessageCount++;
    }
  }

  // 当前轮输入:最后一条非压缩块/非 thinking 块的 user 消息
  let currentRoundTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") {
      if (isCompactedBlock(m.content) || isThinkingBlock(m.content)) continue;
      currentRoundTokens = estimateTokens(m.content);
    } else {
      for (const b of m.content) {
        if (b.type === "text") currentRoundTokens += estimateTokens(b.text);
        else if (b.type === "image") currentRoundTokens += estimateImageTokens(b.source.data);
      }
    }
    break;
  }

  const messagesTokens =
    compactedBlockTokens +
    thinkingBlockTokens +
    userTextTokens +
    toolResultTokens +
    assistantTextTokens +
    toolUseTokens +
    assistantThinkingTokens +
    imageTokens;

  return {
    totalTokens: systemTokens + messagesTokens,
    systemTokens,
    messagesTokens,
    compactedBlockTokens,
    thinkingBlockTokens,
    userTextTokens,
    toolResultTokens,
    assistantTextTokens,
    toolUseTokens,
    assistantThinkingTokens,
    imageTokens,
    currentRoundTokens,
    tailTokens: messagesTokens - compactedBlockTokens - thinkingBlockTokens,
    tailMessageCount,
    hasCompactedBlock: compactedBlockTokens > 0,
    messageBreakdown,
    preparedMs: Date.now() - t0,
  };
}
