/**
 * tail 内 toolResult 精简策略(纯函数,无 vscode 依赖)。
 *
 * 背景:打点数据显示 toolResult 占 tail 约 36%,其中低密度工具
 * (Bash 日志、Grep 匹配列表、网页正文、子代理执行记录)重复传输成本高。
 * 本模块在「已被模型消费过」的 toolResult 进入下一轮发送前,按工具类型
 * 做规则精简或摘要兜底,保证不遗漏错误/定位/结论等关键信息。
 *
 * 处理时机分两阶段(对应设计 B+C):
 *  - push 时:原文进 tail,本轮模型基于最新结果决策;
 *  - 每轮发送前:已消费的 toolResult 替换为精简版(本模块产出方案,调用方执行)。
 */

import { estimateTokens } from "../stats/providerSendStats";
import type { ProviderMessage, ProviderToolResultContent } from "./provider/types";
import { makeSummary, type ColdChunk } from "../context/contextStore";

/** 把 tool_result 的 content(string 或 text block 数组)转成纯文本。 */
export function toolResultText(content: ProviderToolResultContent): string {
  if (typeof content === "string") return content;
  return content.map((t) => t.text).join("\n");
}

/**
 * 扫描 messages,找出「已被模型消费过」的 tool_result 消息。
 * 已消费判定:该 tool_result 消息之后已存在任何 assistant 消息
 * (说明模型看过结果并输出了下一轮)→ 可以精简;否则(最新未消费)保留原文。
 * 同时回溯最近的同 tool_use_id 的 tool_use 块,拿到工具名。
 */
export function findConsumedToolResults(
  messages: ProviderMessage[],
): Array<{ index: number; toolName: string }> {
  const out: Array<{ index: number; toolName: string }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user" || typeof msg.content === "string") continue;
    const consumed = messages.slice(i + 1).some((m) => m.role === "assistant");
    if (!consumed) continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      out.push({ index: i, toolName: findToolName(messages, i, block.tool_use_id) });
    }
  }
  return out;
}

/** 回溯最近一条同 id 的 tool_use 块,返回工具名;找不到返回空串。 */
function findToolName(messages: ProviderMessage[], beforeIndex: number, toolUseId: string): string {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const tu = m.content.find((b) => b.type === "tool_use" && b.id === toolUseId);
    if (tu && tu.type === "tool_use") return tu.name;
  }
  return "";
}

/** 精简动作:keep=不动;trim=规则裁剪;summarize=需 LLM 摘要(调用方执行)。 */
export type ToolResultAction = "keep" | "trim" | "summarize";

/**
 * 工具类别:
 *  - keep:高密度/小输出工具,永不规则精简;
 *  - trim:低密度工具,规则裁剪,trim 后仍超阈值升级摘要;
 *  - summarize:未知工具(MCP/插件),不做规则裁剪,超阈值直接摘要(避免误伤未知格式)。
 */
export type ToolResultClass = "keep" | "trim" | "summarize";

/** 阈值常量(设计文档第 3.6 节)。 */
export const TOOL_RESULT_TRIM = {
  /** 输出 tokens 低于此值 → 原样保留。 */
  minTokens: 800,
  /** 输出行数低于此值 → 原样保留。 */
  minLines: 20,
  /** trim 后仍超此 tokens → 升级为 LLM 摘要。 */
  summarizeAfterTrimTokens: 3000,
  /** 单行超长截断长度。 */
  maxLine: 160,
  /** Bash 成功输出:头部上下文行数。 */
  bashHead: 5,
  /** Bash 成功输出:尾部结论行数。 */
  bashTail: 30,
  /** Grep:每文件最多保留匹配条数。 */
  grepPerFile: 10,
  /** Grep:总输出行数上限。 */
  grepTotal: 200,
  /** WebFetch:头/尾保留行数。 */
  webHead: 20,
  webTail: 20,
  /** Workflow/Agent:每个阶段标题后保留的行数。 */
  stageLines: 3,
} as const;

/** 规则精简结果标记(模型看到后可重新调用工具获取全文)。 */
export const TRIMMED_MARKER = "[tool-result-trimmed]";
/** LLM 摘要结果标记。 */
export const SUMMARIZED_MARKER = "[tool-result-summarized]";

/** 从 toolResult 原文构造冷存储归档块(seq 由 ContextStore.append 分配)。 */
export function buildToolResultArchiveChunk(text: string): Omit<ColdChunk, "seq"> {
  return {
    type: "ledger",
    role: "tool",
    summary: makeSummary("ledger", text),
    content: text,
    ts: Date.now(),
  };
}

/** 在精简/摘要文本中嵌入 [r{seq}](已有则不重复)。 */
export function withToolResultRecallMarker(body: string, seq: number): string {
  const marker = `[r${seq}]`;
  if (body.includes(marker)) return body;
  return `${marker}\n${body}`;
}

/** 摘要 prompt:强制保留错误/定位/结论,不遗漏关键信息。 */
export const TOOL_RESULT_SUMMARIZE_PROMPT =
  "请用不超过 400 tokens 总结该工具执行结果。必须保留:错误信息与 exit code(如有)、文件路径与行号(如有)、结论性内容(输出末尾)。任何错误信息都不得遗漏。";

/** 高密度或小输出工具:永不规则精简。 */
const KEEP_TOOLS = new Set([
  "Read",
  "Write",
  "StrReplace",
  "Delete",
  "Glob",
  "LS",
  "TodoWrite",
  "MemoryWrite",
  "MemoryRead",
  "MemoryList",
  "MemoryDelete",
  "ContextRecall",
]);

/** 低密度工具:规则精简,trim 后仍超阈值升级摘要。 */
const TRIM_TOOLS = new Set([
  "Bash",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Agent",
]);

/** 按工具名分类。MCP/插件等未知工具 → summarize(保守,不破坏未知格式)。 */
export function classifyToolResult(toolName: string): ToolResultClass {
  if (!toolName) return "keep";
  if (KEEP_TOOLS.has(toolName)) return "keep";
  if (TRIM_TOOLS.has(toolName)) return "trim";
  return "summarize";
}

function clipLine(line: string, max = TOOL_RESULT_TRIM.maxLine): string {
  return line.length > max ? line.slice(0, max) + "…" : line;
}

/** 头尾折叠:保留 head 行 + tail 行,中间省略标记。 */
function headTail(lines: string[], head: number, tail: number): string {
  const total = lines.length;
  if (total <= head + tail + 2) return lines.map((l) => clipLine(l)).join("\n");
  return [
    ...lines.slice(0, head).map((l) => clipLine(l)),
    `… (省略 ${total - head - tail} 行)`,
    ...lines.slice(total - tail).map((l) => clipLine(l)),
  ].join("\n");
}

const ERROR_PATTERN = /error|failed|fatal|exception|panic|timed out|aborted|denied/i;

/** Bash:exit=N 开头(executor.formatShellOutput 固定格式)。成功 → 头尾折叠;失败 → 错误行全文。 */
function trimBash(content: string): string {
  const lines = (content ?? "").split("\n");
  const exitLine = lines.find((l) => /^exit=-?\d+/.test(l.trim()))?.trim() ?? "";
  const exitCode = Number(exitLine.replace(/^exit=(-?\d+).*$/, "$1")) || 0;
  const isError = exitCode !== 0 || ERROR_PATTERN.test(content ?? "");
  if (isError) {
    // 错因绝不丢:exit 行 + 所有错误行 + 头 2 尾 2 上下文
    const errLines = lines.filter((l) => ERROR_PATTERN.test(l));
    const context = [
      ...lines.slice(0, 2),
      ...lines.slice(-2),
    ];
    return [exitLine || "exit=?", ...errLines.map((l) => clipLine(l)), "…(错误信息已保留,其余省略)", ...context.map((l) => clipLine(l))].join("\n");
  }
  // 成功:exit 行 + 去空行/去连续重复行 + 头尾折叠
  const rest: string[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (t === "" || /^exit=-?\d+/.test(t)) continue;
    if (rest.length > 0 && rest[rest.length - 1] === t) continue;
    rest.push(t);
  }
  return [exitLine || "exit=0", headTail(rest, TOOL_RESULT_TRIM.bashHead, TOOL_RESULT_TRIM.bashTail)].join("\n");
}

/** Grep:按文件分组限量、去重、保留 path:line 定位前缀。 */
function trimGrep(content: string): string {
  const lines = (content ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const seen = new Set<string>();
  const byFile = new Map<string, { kept: string[]; total: number }>();
  for (const l of lines) {
    if (seen.has(l)) continue;
    seen.add(l);
    const file = l.includes(":") ? l.split(":", 1)[0] : "";
    const key = file || "(其他)";
    const rec = byFile.get(key) ?? { kept: [], total: 0 };
    rec.total++;
    if (rec.kept.length < TOOL_RESULT_TRIM.grepPerFile) rec.kept.push(clipLine(l));
    byFile.set(key, rec);
  }
  const out: string[] = [];
  let keptTotal = 0;
  for (const [file, rec] of byFile) {
    if (keptTotal >= TOOL_RESULT_TRIM.grepTotal) {
      out.push(`… (还有 ${rec.total} 条匹配未列出)`);
      break;
    }
    out.push(...rec.kept);
    keptTotal += rec.kept.length;
    if (rec.kept.length < rec.total) {
      out.push(`… ${file} 还有 ${rec.total - rec.kept.length} 条匹配`);
    }
  }
  return out.join("\n");
}

/** WebFetch:去空行 + 头尾折叠。 */
function trimWebFetch(content: string): string {
  const lines = (content ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return headTail(lines, TOOL_RESULT_TRIM.webHead, TOOL_RESULT_TRIM.webTail);
}

/** Workflow/Agent:保留每个阶段标题行 + 阶段内前 stageLines 行。 */
function trimStages(content: string): string {
  const lines = (content ?? "").split("\n");
  const headingIdx = lines
    .map((l, i) => (/^#{1,3}\s+/.test(l.trim()) ? i : -1))
    .filter((i) => i >= 0);
  if (headingIdx.length === 0) {
    return headTail(lines.filter((l) => l.trim() !== ""), 6, 6);
  }
  const out: string[] = [];
  for (let i = 0; i < headingIdx.length; i++) {
    const start = headingIdx[i];
    const end = i + 1 < headingIdx.length ? headingIdx[i + 1] : lines.length;
    const section = lines.slice(start, end);
    out.push(clipLine(section[0]));
    const body = section.slice(1).filter((l) => l.trim() !== "");
    out.push(...body.slice(0, TOOL_RESULT_TRIM.stageLines).map((l) => clipLine(l)));
    if (body.length > TOOL_RESULT_TRIM.stageLines) {
      out.push(`… (该阶段省略 ${body.length - TOOL_RESULT_TRIM.stageLines} 行)`);
    }
  }
  return out.join("\n");
}

/** 通用头尾折叠(未知工具规则裁剪用)。 */
function trimGeneric(content: string): string {
  const lines = (content ?? "").split("\n").filter((l) => l.trim() !== "");
  return headTail(lines, 6, 6);
}

/** 按工具名执行规则裁剪;未知工具走通用规则。 */
export function trimToolResult(toolName: string, content: string): string {
  switch (toolName) {
    case "Bash":
      return trimBash(content);
    case "Grep":
      return trimGrep(content);
    case "WebFetch":
      return trimWebFetch(content);
    case "WebSearch":
      return trimGeneric(content);
    case "Workflow":
    case "Agent":
      return trimStages(content);
    default:
      return trimGeneric(content);
  }
}

export interface ToolResultTrimPlan {
  action: ToolResultAction;
  /** action=trim 时的精简内容。 */
  trimmed?: string;
}

/**
 * 产出精简方案(纯函数,不执行 LLM):
 *  - 小输出(< minTokens 或 < minLines)→ keep;
 *  - keep 类工具 → keep;
 *  - summarize 类(未知工具)→ 超阈值直接 summarize,否则 keep;
 *  - trim 类 → 规则裁剪;未压下去 → keep;仍超阈值 → summarize;否则 trim。
 */
export function planToolResultTrim(toolName: string, content: string): ToolResultTrimPlan {
  const text = content ?? "";
  if (text.trim() === "") return { action: "keep" };
  // 幂等:已精简/摘要(含 [r{n}] 归档标记)的块不再二次改写
  if (text.includes(TRIMMED_MARKER) || text.includes(SUMMARIZED_MARKER)) {
    return { action: "keep" };
  }
  const cls = classifyToolResult(toolName);
  if (cls === "keep") return { action: "keep" };
  const tokens = estimateTokens(text);
  if (tokens <= TOOL_RESULT_TRIM.minTokens) return { action: "keep" };
  if (text.split("\n").length <= TOOL_RESULT_TRIM.minLines) return { action: "keep" };
  if (cls === "summarize") {
    // 未知工具:不做规则裁剪,超阈值直接摘要
    return tokens > TOOL_RESULT_TRIM.summarizeAfterTrimTokens ? { action: "summarize" } : { action: "keep" };
  }
  const trimmed = trimToolResult(toolName, text);
  const trimmedTokens = estimateTokens(trimmed);
  if (trimmedTokens >= tokens) return { action: "keep" };
  if (trimmedTokens > TOOL_RESULT_TRIM.summarizeAfterTrimTokens) {
    return { action: "summarize" };
  }
  return { action: "trim", trimmed };
}
