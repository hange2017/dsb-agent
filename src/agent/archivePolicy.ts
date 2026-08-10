/**
 * archivePolicy —— 老会话完整历史归档映射(纯函数,无 vscode 依赖)。
 *
 * 背景:冷存储(ContextStore)目前只在压缩发生时写入 head 原文;当用户切走/删除
 * 一个会话时,该会话的 API 历史(sessionStore .api.json)仍完整保存在磁盘,但
 * 冷存储里没有对应 chunk,ContextRecall 无法跨会话回查"整段历史"。
 *
 * 本模块提供"API 历史 → 冷存储 chunk"的同构映射(与 contextManager.stratify 的
 * chunk 生成规则一致:demand / ledger / conclusion / explanation / thinking),
 * 供会话切换(loadSession/newSession)与删除(deleteSession)时归档完整历史。
 * 归档后即使会话从列表删除,.context.json 仍保留原文,ContextRecall 可跨会话回查。
 */
import type { ProviderMessage, ProviderUserContent } from "./provider/types";
import type { ColdChunk } from "../context/contextStore";
import { makeSummary } from "../context/contextStore";
import { classifyAssistantText, summarizeToolUse, extractKeyLines, isCompactedBlock, isThinkingBlock } from "./contextCompactor";

/** 与 contextManager.toolResultText 相同的提取逻辑(user 消息中的 tool_result 文本)。 */
function toolResultText(content: ProviderUserContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "tool_result")
    .map((b) => {
      if (typeof b.content === "string") return b.content;
      return b.content.map((t) => t.text).join("\n");
    })
    .join("\n");
}

/**
 * 把完整 API 历史映射为冷存储 chunk 序列(seq 由调用方分配,这里返回无 seq 的块)。
 * 跳过压缩块([compacted] / [thinking] 标记的 user 消息)与空消息,避免重复归档。
 * 注意:与 contextManager.stratify 不同,这里不做"只保留增量新增"的截断——
 * 归档目标是"老会话完整历史",与压缩增量语义不同。
 */
export function sessionToChunks(messages: ProviderMessage[]): Omit<ColdChunk, "seq" | "ts">[] {
  const chunks: Omit<ColdChunk, "seq" | "ts">[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        const text = msg.content.trim();
        if (!text) continue;
        if (isCompactedBlock(text) || isThinkingBlock(text)) continue; // 压缩产物不入归档(避免重复)
        chunks.push({ type: "demand", role: "user", summary: makeSummary("demand", text), content: text });
        continue;
      }
      const resultText = toolResultText(msg.content).trim();
      if (!resultText) continue;
      const keyLines = extractKeyLines(resultText, true);
      const oneLine = keyLines.replace(/\n/g, " | ");
      chunks.push({ type: "ledger", role: "tool", summary: makeSummary("ledger", oneLine), content: keyLines });
      continue;
    }
    // assistant
    const textParts = msg.content.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text);
    const toolUses = msg.content.filter((b) => b.type === "tool_use");
    const thinkingBlocks = msg.content.filter((b) => b.type === "thinking").map((b) => (b as { type: "thinking"; thinking: string }).thinking);
    const text = textParts.join("\n").trim();
    const thinking = thinkingBlocks.join("\n\n").trim();
    if (thinking) {
      chunks.push({ type: "thinking", role: "assistant", summary: makeSummary("thinking", thinking), content: thinking });
    }
    if (text) {
      const { conclusion, explanation } = classifyAssistantText(text, toolUses.length > 0);
      const summary = makeSummary("explanation", text);
      if (conclusion.length > 0) {
        chunks.push({ type: "conclusion", role: "assistant", summary, content: conclusion.join("\n") });
      }
      if (explanation.length > 0) {
        chunks.push({ type: "explanation", role: "assistant", summary: makeSummary("explanation", explanation.join("\n")), content: explanation.join("\n") });
      }
    }
    for (const tu of toolUses) {
      const input = (tu as { input?: unknown }).input;
      chunks.push({
        type: "ledger",
        role: "tool",
        summary: summarizeToolUse((tu as { name: string }).name, input),
        content: `tool_use: ${(tu as { name: string }).name}`,
      });
    }
  }
  return chunks;
}
