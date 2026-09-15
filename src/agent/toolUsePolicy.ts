/**
 * tail 内 toolUse 精简策略(纯函数,无 vscode 依赖)。
 *
 * 背景:toolUse 占 tail 约 24.6%,其中 `Write.contents`、`StrReplace.old_string/new_string`、
 * `Workflow.stages[].prompt`、`Agent.task/system`
 * 属**瞬时参数**——模型自己刚写的内容,文件系统或执行状态已有副本
 * (Write/StrReplace 真实写盘),
 * 下一轮无需完整重读。
 *
 * 判据:按**字段语义**而非工具名。语义参数(path/command/pattern/query/goal/id/dependsOn)
 * 保留——模型要知道自己做了什么;瞬时参数摘要替换,保持 tool_use block 结构
 * (id/name/input 形态不变,API 兼容 + tool_result 锚点)。
 *
 * 处理时机与 toolResult 同一管道:每轮发送前,对「已执行且已消费」的 tool_use 做精简。
 */

import type { ProviderMessage } from "./provider/types";
import { makeSummary, type ColdChunk } from "../context/contextStore";

export type ToolUseAction = "keep" | "trim";

/** 值小于此字符数的瞬态字段不动(全局默认)。 */
export const TRANSIENT_FIELD_MIN_CHARS = 200;

/**
 * 按「工具.字段」细分的最小保留阈值(高于全局默认 → 该字段更多原文进上下文)。
 * 理由:Write.contents / StrReplace.new_string 是模型工作产物,若一写入就被
 * 摘要替换,模型在后续轮次看不到自己写过的内容,只能「复述省略标记」→ 污染。
 * 放宽后中小文件内容保留在上下文中,模型能基于真实内容继续工作、写后直接引用。
 * (阈值只影响「保留多少原文」,定型后字节仍恒定,不影响缓存前缀稳定性。)
 */
export const TRANSIENT_FIELD_MIN_CHARS_BY_KEY: Record<string, number> = {
  // 正文类字段是模型的「工作产物」:阈值放宽到「正常源文件整文件」量级,
  // 写普通文件(≤16k 字符 ≈ 400 行)时原文完整留在上下文,模型能看到自己写过什么,
  // 不再被迫把长文件拆成多个 <2k 的小文件。仅极端大写入才走「头尾预览」精简。
  "Write.contents": 16000,
  "StrReplace.new_string": 8000,
  // old_string 是「我当时改的是哪一段」的锚点(语义参数),不是可重建的瞬时垃圾:
  // 一旦被换成无预览的裸标记,模型下一轮读自己历史时只看到标记,
  // 会把标记当锚点复述 → 被 executor 拒绝(REFUSED),大粒度编辑无法进行。
  "StrReplace.old_string": 8000,
};

/** 正文类瞬态字段:精简时保留「头+尾」预览(而非无语义占位标记),模型仍能看到实际内容。 */
export const TRANSIENT_PREVIEW_FIELDS = new Set<string>([
  "Write.contents",
  "StrReplace.new_string",
  "StrReplace.old_string",
]);

/**
 * 锚点类瞬态字段(按**可重建性**分档中的 B 档):
 *  - 可重建档(A):`Write.contents`、`StrReplace.new_string`、`Workflow.stages[].prompt`、
 *    `Agent.task/system` —— 目标文件/参数在磁盘或调用方仍有真值,精简后可再取回,故可在**写前定型**时就精简。
 *  - 锚点档(B):`StrReplace.old_string` —— 替换一旦执行,磁盘上就**不存在**该旧文本的副本;
 *    它是「我当时改的是哪一段」的唯一语义线索,属**不可重建**。若在写前定型阶段就精简,
 *    模型下一轮读自己历史只看到标记,会把标记当锚点复述(→ REFUSED)。
 *  → 锚点档在写前定型阶段**不精简**(保留原文进入历史),仅在「已跌出近期窗口」后按预览 + `[r{seq}]` 处理。
 */
export const TRANSIENT_ANCHOR_FIELDS: Record<string, string[]> = {
  StrReplace: ["old_string"],
};

/** 该字段是否属「锚点档」(不可重建)。 */
export function isAnchorField(toolName: string, fieldName: string): boolean {
  return (TRANSIENT_ANCHOR_FIELDS[toolName] ?? []).includes(fieldName);
}

/**
 * 近期窗口:发送前精简「已消费 tool_use」时,最近 N 条**一律不精简**。
 * 理由(与 thinking 的 `THINKING_KEEP_RECENT_COUNT` 对齐):「已消费」只说明又过了一轮,
 * 被消费的内容往往正是**刚支撑完当前任务的工作集**(刚写的文件/刚做的编辑),不是垃圾。
 * 旧实现以「已消费」为低价值代理、按字段名一刀切精简,方向与事实相反。
 */
export const TOOL_USE_KEEP_RECENT_COUNT = 8;

/** 取「工具.字段」细分阈值,无细分回退全局默认。 */
export function fieldMinChars(toolName: string, fieldName: string): number {
  return TRANSIENT_FIELD_MIN_CHARS_BY_KEY[`${toolName}.${fieldName}`] ?? TRANSIENT_FIELD_MIN_CHARS;
}

/**
 * Transient summary marker prefix. Shared by generator (toolUsePolicy)
 * and guards (executor Write/StrReplace) for detection.
 */
export const TRANSIENT_SUMMARY_PREFIX = "[TRANSIENT-SUMMARY";
/** Summary template: warns NOT to write the marker into files. */
export function transientSummary(fieldName: string, chars: number): string {
  return `${TRANSIENT_SUMMARY_PREFIX} field=${fieldName} chars=${chars}] 瞬时参数省略标记(这不是模型写过的正文,禁止复述、禁止写入文件/记忆/清单);需要原文请用对应工具读回(记忆→MemoryRead,文件→Read)。`;
}
/** 正文类字段的精简形态:保留头尾预览 + 明确省略提示,避免模型看不到自己写过什么。 */
export function transientPreview(fieldName: string, text: string, head = 1200, tail = 400): string {
  const omitted = Math.max(0, text.length - head - tail);
  const h = text.slice(0, head);
  const tl = tail > 0 ? text.slice(text.length - tail) : "";
  return `${TRANSIENT_SUMMARY_PREFIX} field=${fieldName} chars=${text.length}] 此标记是工具参数的历史回显(非对话正文),禁止整段复述为 old_string/contents;下面仅是该参数的头尾预览(省略 ${omitted} 字符),完整内容请用 Read 分段读取。\n--- 预览·头 ---\n${h}\n--- 预览·尾 ---\n${tl}`;
}

/** Detect transient summary text (guard against echo-back writes). */
export function isTransientSummaryText(text: string): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim();
  // 严格判定:仅当内容**本身就是**省略标记(以标记开头)才为真;避免「引用该标记」的正常文档/编辑被误拒。
  // 形状校验(不看长度):真标记必以它开头且首行即标记本身;正文中「引用标记」的长文档不会命中。
  if (new RegExp("^\\[TRANSIENT-SUMMARY field=[^\\n]* chars=\\d+\\]").test(t.split("\n", 1)[0] ?? "")) return true;
  if (t.length > 320) return false;
  if (t.startsWith("[瞬时参数已省略")) return true;
  return t.startsWith("瞬时参数省略标记") && t.includes("禁止写入文件");
}

/**
 * 扫描「已落盘字节」中的瞬时参数占位标记行(写后自检用)。
 * 与 isTransientSummaryText 的分工:后者判「整段内容本身是不是标记」(写前拦截);
 * 本函数判「写入结果里是否夹带了标记行」(漏网兜底,按行扫描)。
 * 命中条件(逐行,去首尾空白后):
 *   1. 整行以 `[TRANSIENT-SUMMARY field=... chars=N]` 形状开头;或
 *   2. 整行以 `[瞬时参数已省略` 开头且整行长度 <= 320 字符。
 * 正文中「引用标记」的长文档不会命中(受整行长度/形状约束),避免误伤。
 */
export function scanTransientMarkerLines(text: string): string[] {
  if (typeof text !== "string" || text === "") return [];
  const hits: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\[TRANSIENT-SUMMARY field=[^\n]* chars=\d+\]/.test(line)) {
      hits.push(line.slice(0, 160));
      continue;
    }
    if (line.length <= 320 && line.startsWith("[瞬时参数已省略")) {
      hits.push(line.slice(0, 160));
    }
  }
  return hits;
}

/**
 * 瞬时参数(可重建)字段表。键为工具名,值为该工具 input 中可重建的大字段。
 * 未来新工具只需在此声明哪些字段瞬态。
 */
const TRANSIENT_FIELDS: Record<string, string[]> = {
  Write: ["contents"],
  StrReplace: ["old_string", "new_string"],
  Workflow: ["stages"],
  Agent: ["task", "system"],
  // 注:TodoWrite.content / MemoryWrite.body 已移出精简表:正文即语义主体,
  // 被替换成占位标记后模型会把标记当真实内容写回,造成记忆/清单数据损坏。
};

/** 把值转成文本做长度判断;对象/数组取 JSON 序列化长度。 */
function valueChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value === null || value === undefined) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/** 替换单个瞬态字段值为摘要文本;小值(按字段细分阈值)原样返回。 */
function trimTransientField(toolName: string, fieldName: string, value: unknown): unknown {
  const chars = valueChars(value);
  if (chars <= fieldMinChars(toolName, fieldName)) return value;
  const key = `${toolName}.${fieldName}`;
  if (TRANSIENT_PREVIEW_FIELDS.has(key) && typeof value === "string") {
    return transientPreview(fieldName, value);
  }
  return transientSummary(fieldName, chars);
}

/**
 * 递归裁剪 input 对象中的瞬态字段:
 *  - Workflow.stages:数组,每项 {id, prompt, dependsOn},prompt 为瞬态;
 *  - 其余瞬态字段为字符串,直接替换。
 * 返回新对象(仅在发生替换时),否则返回原 input 引用。
 */
function trimInput(toolName: string, input: unknown, fields: string[]): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  const out: Record<string, unknown> = { ...record };
  let changed = false;

  for (const key of Object.keys(out)) {
    if (!fields.includes(key)) continue;
    if (key === "stages" && Array.isArray(out[key])) {
      // Workflow.stages:每项 prompt 瞬态,id/dependsOn 保留
      const trimmed = out[key].map((stage) => {
        if (typeof stage !== "object" || stage === null) return stage;
        const s = stage as Record<string, unknown>;
        if (typeof s.prompt !== "string") return stage;
        const chars = s.prompt.length;
        if (chars <= fieldMinChars(toolName, "stages")) return stage;
        changed = true;
        return { ...s, prompt: transientSummary("stage prompt", chars) };
      });
      out[key] = trimmed;
    } else {
      const v = trimTransientField(toolName, key, out[key]);
      if (v !== out[key]) {
        changed = true;
        out[key] = v;
      }
    }
  }
  return changed ? out : input;
}

/** 产出 tool_use 精简方案:瞬时字段超阈值 → trim;否则 keep。 */
export function planToolUseTrim(
  toolName: string,
  input: unknown,
  opts?: { skipAnchorFields?: boolean },
): { action: ToolUseAction; trimmedInput?: unknown } {
  const fields = TRANSIENT_FIELDS[toolName];
  if (!fields) return { action: "keep" };
  const effective = opts?.skipAnchorFields
    ? fields.filter((f) => !isAnchorField(toolName, f))
    : fields;
  if (effective.length === 0) return { action: "keep" };
  const trimmed = trimInput(toolName, input, effective);
  if (trimmed === input) return { action: "keep" };
  return { action: "trim", trimmedInput: trimmed };
}

/**
 * StrReplace.old_string 原文归档块(仅旧串在替换后文件系统无副本)。
 * 小值 / 已是省略标记 → undefined。
 */
export function buildStrReplaceOldStringArchiveChunk(
  input: unknown,
): Omit<ColdChunk, "seq"> | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const oldString = (input as Record<string, unknown>).old_string;
  if (typeof oldString !== "string") return undefined;
  if (isTransientSummaryText(oldString)) return undefined;
  if (oldString.length <= TRANSIENT_FIELD_MIN_CHARS) return undefined;
  return {
    type: "ledger",
    role: "tool",
    summary: makeSummary("ledger", oldString),
    content: oldString,
    ts: Date.now(),
  };
}

/** 把 [r{seq}] 缀到已精简的 old_string 摘要上。 */
export function withOldStringRecallMarker(trimmedInput: unknown, seq: number): unknown {
  if (typeof trimmedInput !== "object" || trimmedInput === null) return trimmedInput;
  const record = { ...(trimmedInput as Record<string, unknown>) };
  if (typeof record.old_string !== "string") return trimmedInput;
  const marker = `[r${seq}]`;
  if (record.old_string.includes(marker)) return record;
  record.old_string = `${record.old_string} ${marker}`;
  return record;
}

/**
 * 扫描 messages,找出「已执行且已消费」的 tool_use 块。
 * 判定:该 tool_use 之后存在同 id 的 tool_result(已执行),
 * 且该 tool_result 之后存在新的 assistant 消息(模型已基于结果继续)。
 */
export function findConsumedToolUses(
  messages: ProviderMessage[],
): Array<{ index: number; blockIndex: number; toolName: string }> {
  const out: Array<{ index: number; blockIndex: number; toolName: string }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    for (let b = 0; b < msg.content.length; b++) {
      const block = msg.content[b];
      if (block.type !== "tool_use") continue;
      if (isConsumedToolUse(messages, i, block.id)) {
        out.push({ index: i, blockIndex: b, toolName: block.name });
      }
    }
  }
  return out;
}

/** 该 tool_use id 之后是否存在同 id 的 tool_result,且其后存在 assistant。 */
function isConsumedToolUse(messages: ProviderMessage[], fromIndex: number, toolUseId: string): boolean {
  let foundResult = false;
  for (let j = fromIndex + 1; j < messages.length; j++) {
    const m = messages[j];
    if (m.role === "user" && Array.isArray(m.content)) {
      if (m.content.some((x) => x.type === "tool_result" && x.tool_use_id === toolUseId)) {
        foundResult = true;
        // 该 tool_result 之后的 assistant 才算消费;继续向后找
        continue;
      }
    }
    if (foundResult && m.role === "assistant") return true;
  }
  return false;
}
