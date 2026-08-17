import type { ProviderStopReason } from "./provider/types";

export type { ProviderStopReason };

export const kMaxTokensContinueUserText =
  "[续写] 上一轮输出因长度上限中断。请从中断处继续；需要改文件或执行命令时直接发起完整工具调用，不要重复已完成的步骤。";

export const kMaxTokensInterruptedAssistantText = "[输出中断]";

export const kMaxTokensContinueInfoText = "输出达上限,继续…";

export const kMaxTokensContinueLimit = 8;

export function normalizeStopReason(raw: unknown): ProviderStopReason | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") return "other";
  if (raw === "end_turn" || raw === "tool_use" || raw === "max_tokens") return raw;
  if (raw === "length") return "max_tokens";
  return "other";
}

export function needsMaxTokensContinue(input: {
  stopReason?: ProviderStopReason;
  outputTokens?: number;
  maxTokens: number;
  completeToolUseCount: number;
}): boolean {
  if (input.completeToolUseCount > 0) return false;
  if (input.stopReason === "end_turn" || input.stopReason === "tool_use") return false;
  if (input.stopReason === "max_tokens") return true;
  if (input.stopReason === undefined || input.stopReason === "other") {
    const out = input.outputTokens ?? 0;
    const cap = Math.max(1, input.maxTokens);
    return out >= Math.floor(cap * 0.98);
  }
  return false;
}
