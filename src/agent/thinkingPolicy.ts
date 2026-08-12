/**
 * tail 内 thinking 原文精简策略(纯函数,无 vscode 依赖)。
 *
 * 背景:tail 内 thinking 原文(assistant `{ type: "thinking" }` 块)占 tail 约 30%,
 * 每次发送固定带着最近一轮的 thinking 原文。thinking 是模型推理草稿:
 * 决策结果在 text 块,长期脉络在压缩时生成的 `[thinking]` 块——tail 里的
 * thinking 原文属"临时思维",下一轮无需完整重读。
 *
 * 手段(已批准 v2):
 *  - 单条:保留尾部结论行(thinking 结尾通常是结论),前面删除,加标记;
 *  - 条数:已消费 thinking 只保留最近 KEEP_RECENT 条完整尾巴,
 *    更早的压成「最后一行结论」(避免条数随轮次线性增长);
 *  - 保持块结构 `{ type: "thinking" }`,同步操作零 LLM 成本。
 */

import type { ProviderMessage } from "./provider/types";

/** thinking 超过此字符数才精简;保留尾部结论的字符数(300 → 150 收紧)。 */
export const THINKING_TAIL_CHARS = 150;

/** 已消费 thinking 中,最近 N 条保留完整尾巴;更早的压成一行结论。 */
export const THINKING_KEEP_RECENT_COUNT = 10;

/** 截断标记:模型应知道详细推理已被精简,只剩结尾结论。 */
export const THINKING_TRIM_MARKER = "[thinking-trimmed:推理过程已精简,保留结尾结论]";

/** 旧 thinking(超出最近 N 条)的标记:只剩一行结论。 */
export const THINKING_OLD_MARKER = "[thinking-old:已消费历史推理,仅留结论]";

/**
 * 扫描 messages,找出「已被模型消费过」的 thinking 块(按时间升序)。
 * 已消费判定:该 assistant 消息(含 thinking)之后存在另一条 assistant 消息。
 */
export function findConsumedThinking(
  messages: ProviderMessage[],
): Array<{ index: number; blockIndex: number }> {
  const out: Array<{ index: number; blockIndex: number }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    if (!messages.slice(i + 1).some((m) => m.role === "assistant")) continue;
    for (let b = 0; b < msg.content.length; b++) {
      if (msg.content[b].type === "thinking") out.push({ index: i, blockIndex: b });
    }
  }
  return out;
}

/** 从尾部按完整行累积,总字符数不超过 tailChars。 */
function tailLines(text: string, tailChars: number): string {
  const lines = text.split("\n");
  const tail: string[] = [];
  let acc = 0;
  for (let i = lines.length - 1; i >= 0 && acc < tailChars; i--) {
    tail.unshift(lines[i]);
    acc += lines[i].length + 1;
  }
  return tail.join("\n");
}

/** 最后一个非空行(旧 thinking 只保留这一行作为「结论锚点」)。 */
function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line !== "") return line;
  }
  return undefined;
}

/**
 * 产出 thinking 精简方案。
 *
 * @param thinking 原文
 * @param rankFromLatest 0=最新一条已消费,越大越旧(缺省 0,向后兼容单条调用)。
 *
 * 规则:
 *  - 空 → keep;
 *  - rank >= KEEP_RECENT_COUNT(旧):压成一行结论 + 旧标记,不设长度豁免;
 *  - rank < KEEP_RECENT_COUNT(近):≤ 阈值 → keep(短 thinking 常含关键决策,不误删);
 *    > 阈值 → trim,保留尾部结论行 + 截断标记。
 */
export function planThinkingTrim(
  thinking: string,
  rankFromLatest = 0,
): { action: "keep" | "trim"; trimmed?: string } {
  const text = thinking ?? "";
  if (text.trim() === "") return { action: "keep" };
  // 幂等保护:已含精简标记的文本视为已定型,禁止二次改写(否则已入前缀的块会再次变化,
  // 造成「精简 → 再精简」两种字节形态 → 缓存前缀断裂)。
  if (text.includes(THINKING_TRIM_MARKER) || text.includes(THINKING_OLD_MARKER)) {
    return { action: "keep" };
  }
  if (rankFromLatest >= THINKING_KEEP_RECENT_COUNT) {
    const last = lastNonEmptyLine(text);
    if (last === undefined) return { action: "keep" };
    return { action: "trim", trimmed: `${THINKING_OLD_MARKER}\n${last}` };
  }
  if (text.length <= THINKING_TAIL_CHARS) return { action: "keep" };
  const tail = tailLines(text, THINKING_TAIL_CHARS);
  return { action: "trim", trimmed: `${THINKING_TRIM_MARKER}\n${tail}` };
}
