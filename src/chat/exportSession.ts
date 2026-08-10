/**
 * 会话导出纯逻辑模块:把 ProviderMessage[] 渲染成 Markdown 时间线或 JSON,
 * 并写入磁盘。不依赖 vscode,可在 node 环境下单测。
 *
 * 导出格式目标(2026-08-09 明确):
 *  - `/export md`  → `formatSessionMarkdown`:面向人阅读/再编辑的**互操作格式**。
 *    输出为 Markdown 时间线(user/assistant 分节、工具调用摘要、结果截断),
 *    跳过 image/thinking 块;任何 Markdown 渲染器/文档工具均可直接消费。
 *  - `/export json` → `formatSessionJson`:面向**机器续跑/调试**的内部格式。
 *    输出为 DSBAgent 特有的 ProviderMessage[] 形状(含 tool_use/tool_result 配对、
 *    thinking 块),与 `api-history`(`.api.json`)同构,可直接作为后续请求的
 *    `messages` 使用;**不承诺**与第三方对话格式(OpenAI/Claude 官方 JSONL)互通。
 *
 * 若未来需要第三方互通,建议新增 `--openai` / `--claude` 等转换器,而非改变
 * 现有两种格式的默认输出(保持向后兼容)。
 */

import * as fs from "fs";
import * as path from "path";
import type { ProviderMessage, ProviderBlock } from "../agent/provider/types";

/** 工具结果正文的最大展示字符数,超出截断并加注。 */
const kMaxToolResultChars = 2000;
/** 工具入参摘要的最大字符数。 */
const kMaxInputChars = 200;

/** 摘要入参:转紧凑 JSON,过长截断。 */
function summarizeInput(input: Record<string, unknown>): string {
  let s: string;
  try {
    s = JSON.stringify(input) ?? "";
  } catch {
    s = "";
  }
  if (s.length <= kMaxInputChars) return s;
  return `${s.slice(0, kMaxInputChars)}…`;
}

/** 截断工具结果正文。 */
function truncateResult(content: string): string {
  if (content.length <= kMaxToolResultChars) return content;
  const more = content.length - kMaxToolResultChars;
  return `${content.slice(0, kMaxToolResultChars)}\n\n…(truncated, ${more} more chars)`;
}

/** tool_result content 归一为可读文本:兼容原生 block 数组与 string 两种形状。 */
function toolResultText(content: string | Array<{ type: "text"; text: string }>): string {
  return Array.isArray(content) ? content.map((t) => t.text).join("\n") : content;
}

/**
 * 选一个不冲突的代码围栏:若内容本身含 ```,就加长到 ```` 等。
 * 保证任意 tool_result 内容都不会把 Markdown 代码块切断。
 */
function fenceFor(text: string): string {
  let fence = "```";
  while (text.includes(fence)) fence += "`";
  return fence;
}

/** 把单条消息渲染为 Markdown 小节;无可渲染内容时返回空串(不产出空分节)。 */
function renderMessage(
  msg: ProviderMessage,
  toolUseNames: Map<string, string>,
): string {
  const parts: string[] = [];

  if (msg.role === "user") {
    const blocks = Array.isArray(msg.content)
      ? msg.content
      : [{ type: "text" as const, text: msg.content }];
    const textParts: string[] = [];
    const results: Array<{ id: string; content: string }> = [];
    for (const b of blocks) {
      if (b.type === "text") {
        textParts.push(b.text);
      } else if (b.type === "tool_result") {
        results.push({ id: b.tool_use_id, content: toolResultText(b.content) });
      }
      // image 块:导出跳过
    }
    if (textParts.length > 0) {
      parts.push("## 👤 User\n\n" + textParts.join("\n\n"));
    }
    if (results.length > 0) {
      const bullets = results.map((r) => {
        const name = toolUseNames.get(r.id) ?? r.id;
        const fence = fenceFor(truncateResult(r.content));
        return `- **${name}**\n\n${fence}\n${truncateResult(r.content)}\n${fence}`;
      });
      parts.push(`**工具结果:**\n\n${bullets.join("\n\n")}`);
    }
  } else {
    const textParts: string[] = [];
    const toolUses: ProviderBlock[] = [];
    for (const b of msg.content) {
      if (b.type === "text") textParts.push(b.text);
      else if (b.type === "tool_use") toolUses.push(b);
      // thinking 块:导出跳过
    }
    if (textParts.length > 0) {
      parts.push("## 🤖 Assistant\n\n" + textParts.join("\n\n"));
    }
    if (toolUses.length > 0) {
      const bullets = toolUses.map((b) => {
        if (b.type !== "tool_use") return "";
        toolUseNames.set(b.id, b.name);
        const summary = summarizeInput(b.input);
        return summary ? `- \`${b.name}\` — \`${summary}\`` : `- \`${b.name}\``;
      });
      parts.push(`**工具调用:**\n\n${bullets.join("\n")}`);
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : "";
}

/**
 * 把消息列表渲染成可读时间线 Markdown:user/assistant 分节、正文、
 * 工具调用(name + input 摘要)与工具结果;image/thinking 块跳过。
 */
export function formatSessionMarkdown(messages: ProviderMessage[]): string {
  const toolUseNames = new Map<string, string>();
  const sections: string[] = [];
  for (const msg of messages) {
    const section = renderMessage(msg, toolUseNames);
    if (section) sections.push(section);
  }
  return sections.join("\n\n---\n\n") + "\n";
}

/** 把消息列表序列化为 pretty JSON(2 空格缩进)。 */
export function formatSessionJson(messages: ProviderMessage[]): string {
  return JSON.stringify(messages, null, 2);
}

/**
 * 确保 baseDir 存在(递归创建),写入 content,返回写入文件的完整路径。
 * 文件名形如 `${sessionId}.${ext}`。
 */
export function writeExport(
  baseDir: string,
  sessionId: string,
  content: string,
  ext: "md" | "json",
): string {
  fs.mkdirSync(baseDir, { recursive: true });
  const filePath = path.join(baseDir, `${sessionId}.${ext}`);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}
