/**
 * tail 内 toolUse 精简策略(纯函数,无 vscode 依赖)。
 *
 * 背景:toolUse 占 tail 约 24.6%,其中 `Write.contents`、`StrReplace.old_string/new_string`、
 * `Workflow.stages[].prompt`、`Agent.task/system`、`TodoWrite.content`、`MemoryWrite.body`
 * 属**瞬时参数**——模型自己刚写的内容,文件系统或执行状态已有副本
 * (Write/StrReplace 真实写盘、TodoWrite 内存清单、MemoryWrite 记忆存储),
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

/** 值小于此字符数的瞬态字段不动。 */
export const TRANSIENT_FIELD_MIN_CHARS = 200;

/**
 * Transient summary marker prefix. Shared by generator (toolUsePolicy)
 * and guards (executor Write/StrReplace) for detection.
 */
export const TRANSIENT_SUMMARY_PREFIX = "[TRANSIENT-SUMMARY";
/** Summary template: warns NOT to write the marker into files. */
export function transientSummary(fieldName: string, chars: number): string {
  return `${TRANSIENT_SUMMARY_PREFIX} field=${fieldName} chars=${chars}] 瞬时参数省略标记:禁止写入文件,请用 Read/StrReplace 重新读取真实内容。`;
}
/** Detect transient summary text (guard against echo-back writes). */
export function isTransientSummaryText(text: string): boolean {
  if (typeof text !== "string") return false;
  if (text.includes(TRANSIENT_SUMMARY_PREFIX)) return true;
  if (text.includes("[瞬时参数已省略")) return true;
  return text.includes("瞬时参数省略标记") && text.includes("禁止写入文件");
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
  // TodoWrite.content 写入 TodoManager 内存(list 可查回),MemoryWrite.body
  // 写入记忆持久化存储(MemoryRead 可读回)——均属可重建瞬时参数;
  // name/description/id/op/scope 等语义参数保留。
  TodoWrite: ["content"],
  MemoryWrite: ["body"],
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

/** 替换单个瞬态字段值为摘要文本;小值原样返回。 */
function trimTransientField(fieldName: string, value: unknown): unknown {
  const chars = valueChars(value);
  if (chars <= TRANSIENT_FIELD_MIN_CHARS) return value;
  return transientSummary(fieldName, chars);
}

/**
 * 递归裁剪 input 对象中的瞬态字段:
 *  - Workflow.stages:数组,每项 {id, prompt, dependsOn},prompt 为瞬态;
 *  - 其余瞬态字段为字符串,直接替换。
 * 返回新对象(仅在发生替换时),否则返回原 input 引用。
 */
function trimInput(input: unknown, fields: string[]): unknown {
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
        if (chars <= TRANSIENT_FIELD_MIN_CHARS) return stage;
        changed = true;
        return { ...s, prompt: transientSummary("stage prompt", chars) };
      });
      out[key] = trimmed;
    } else {
      const v = trimTransientField(key, out[key]);
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
): { action: ToolUseAction; trimmedInput?: unknown } {
  const fields = TRANSIENT_FIELDS[toolName];
  if (!fields) return { action: "keep" };
  const trimmed = trimInput(input, fields);
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
