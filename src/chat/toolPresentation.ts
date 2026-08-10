/** 工具结果时间线展示:纯函数,不依赖 vscode。 */

export type DiffLine = { type: "same" | "add" | "del"; text: string };

import { t } from "../i18n/strings";

export type ToolBodyBlock =
  | { kind: "text"; label: string; content: string }
  | { kind: "table"; label: string; columns: string[]; rows: string[][] }
  | { kind: "diff"; label: string; hunks: DiffLine[] }
  | { kind: "file"; label: string; path: string; content: string }
  | { kind: "terminal"; label: string; content: string }
  | { kind: "list"; label: string; items: Array<{ title: string; detail?: string }> };

export type ToolPresentation = {
  displayName: string;
  headerSecondary?: string;
  summary?: string;
  body?: ToolBodyBlock[];
};

/** LCS 行 diff:返回 same/add/del 序列,供 webview 渲染绿加红删。 */
export function diffLines(oldLines: string[], newLines: string[]): DiffLine[] {
  const n = oldLines.length, m = newLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) { out.push({ type: "same", text: oldLines[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", text: oldLines[i] }); i++; }
    else { out.push({ type: "add", text: newLines[j] }); j++; }
  }
  while (i < n) out.push({ type: "del", text: oldLines[i++] });
  while (j < m) out.push({ type: "add", text: newLines[j++] });
  return out;
}

const kMaxBodyChars = 8000;
const kMaxTableRows = 200;

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || filePath;
}

function filePathOf(input: Record<string, unknown>): string | undefined {
  return asString(input.path) ?? asString(input.file_path);
}

function truncate(text: string, max = kMaxBodyChars): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated)`;
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function editSummary(oldStr: string, newStr: string): string {
  const oldLines = lineCount(oldStr);
  const newLines = lineCount(newStr);
  const added = Math.max(0, newLines - oldLines);
  const removed = Math.max(0, oldLines - newLines);
  if (added > 0 && removed > 0) {
    return `Added ${added} line${added !== 1 ? "s" : ""}, removed ${removed} line${removed !== 1 ? "s" : ""}`;
  }
  if (added > 0) return `Added ${added} line${added !== 1 ? "s" : ""}`;
  if (removed > 0) return `Removed ${removed} line${removed !== 1 ? "s" : ""}`;
  return "Modified";
}

function countNonEmptyLines(text: string | undefined): number {
  if (!text?.trim()) return 0;
  return text.split("\n").filter((l) => l.length > 0).length;
}

function showFull(content: string): ToolBodyBlock[] {
  return [{ kind: "text", label: "Show full", content: truncate(content) }];
}

function oneLine(text: string, max = 80): string {
  const line = text.split("\n")[0] ?? "";
  return line.length <= max ? line : `${line.slice(0, max)}…`;
}

/**
 * @brief 把工具名/入参/结果压成时间线展示结构。
 */
export function presentTool(
  name: string,
  input: unknown,
  result: string | undefined,
  status: "running" | "completed" | "error",
  locale: "zh" | "en" = "zh",
): ToolPresentation {
  const inp = asRecord(input);
  const err = status === "error";

  switch (name) {
    case "Read": {
      const fp = filePathOf(inp);
      let secondary = fp ? basename(fp) : undefined;
      const offset = typeof inp.offset === "number" ? inp.offset : undefined;
      const limit = typeof inp.limit === "number" ? inp.limit : undefined;
      if (secondary && offset !== undefined && limit !== undefined) {
        // 项目 Read 为 1 基 offset;时间线展示也按 1 基行号
        secondary = `${secondary} (lines ${offset}-${offset + limit - 1})`;
      } else if (secondary && offset !== undefined) {
        secondary = `${secondary} (from line ${offset})`;
      }
      return {
        displayName: "Read",
        headerSecondary: secondary,
        body: result ? [{ kind: "file", label: "Content", path: fp ?? "", content: truncate(result) }] : undefined,
      };
    }
    case "Write": {
      const fp = filePathOf(inp);
      const contents = asString(inp.contents) ?? "";
      const summary = err
        ? "Write failed"
        : status === "completed"
          ? `${lineCount(contents)} line${lineCount(contents) !== 1 ? "s" : ""}`
          : undefined;
      return {
        displayName: "Write",
        headerSecondary: fp ? basename(fp) : undefined,
        summary,
        body: contents ? [{ kind: "file", label: "Content", path: fp ?? "", content: truncate(contents) }] : undefined,
      };
    }
    case "StrReplace": {
      const fp = filePathOf(inp);
      const oldStr = asString(inp.old_string) ?? "";
      const newStr = asString(inp.new_string) ?? "";
      const summary = err ? "Edit failed" : status === "running" ? undefined : editSummary(oldStr, newStr);
      return {
        displayName: "Edit",
        headerSecondary: fp ? basename(fp) : undefined,
        summary,
        body: oldStr || newStr
          ? [{ kind: "diff", label: "Edit", hunks: diffLines(oldStr.split("\n"), newStr.split("\n")) }]
          : undefined,
      };
    }
    case "Delete": {
      const fp = filePathOf(inp);
      return {
        displayName: "Delete",
        headerSecondary: fp ? basename(fp) : undefined,
        summary: err ? result : status === "completed" ? "Deleted" : undefined,
      };
    }
    case "Glob": {
      const pattern = asString(inp.pattern) ?? "";
      const n = countNonEmptyLines(result);
      // 类型化:每个文件一行,渲染成表格
      const lines = (result ?? "").split("\n").filter((l) => l.trim() !== "");
      let summary: string | undefined;
      if (status === "completed" || status === "error") {
        if (err) summary = result?.slice(0, 120);
        else if (n === 0) summary = "No files found";
        else if (n === 1) summary = "Found 1 file";
        else summary = `Found ${n} files`;
      }
      return {
        displayName: "Glob",
        headerSecondary: pattern ? `pattern: "${pattern}"` : undefined,
        summary,
        body: lines.length
          ? [{ kind: "table", label: "Files", columns: [t("文件", locale)], rows: lines.slice(0, kMaxTableRows).map((l) => [l]) }]
          : undefined,
      };
    }
    case "Grep": {
      const pattern = asString(inp.pattern) ?? "";
      const bits: string[] = [];
      if (asString(inp.path)) bits.push(`in ${asString(inp.path)}`);
      if (asString(inp.glob)) bits.push(`glob: ${asString(inp.glob)}`);
      const n = countNonEmptyLines(result);
      let summary: string | undefined;
      if (status === "completed" || status === "error") {
        if (err) summary = result?.slice(0, 120);
        else if (n === 0) summary = "No matches found";
        else if (n === 1) summary = "1 line of output";
        else summary = `${n} lines of output`;
      }
      // 类型化:path:line:content → 表格;无匹配行回退文本块
      const rows: string[][] = [];
      for (const line of (result ?? "").split("\n")) {
        const m = line.match(/^(.+?):(\d+):(.*)$/);
        if (m) rows.push([m[1], m[2], m[3]]);
      }
      const sec = `"${pattern}"${bits.length ? ` (${bits.join(", ")})` : ""}`;
      return {
        displayName: "Grep",
        headerSecondary: pattern ? sec : undefined,
        summary,
        body: rows.length
          ? [{ kind: "table", label: "Matches", columns: [t("文件", locale), t("行", locale), t("内容", locale)], rows: rows.slice(0, kMaxTableRows) }]
          : result
            ? [{ kind: "text", label: "Show full", content: truncate(result) }]
            : undefined,
      };
    }
    case "LS": {
      const fp = filePathOf(inp) ?? asString(inp.path);
      const n = countNonEmptyLines(result);
      // 类型化:名/名/ → 表格,目录打 dir 标
      const lines = (result ?? "").split("\n").filter((l) => l.trim() !== "");
      const rows = lines.map((l) => [l.replace(/\/$/, ""), l.endsWith("/") ? "dir" : "file"]);
      return {
        displayName: "LS",
        headerSecondary: fp,
        summary:
          status === "completed" && !err
            ? n === 1
              ? "1 entry"
              : `${n} entries`
            : err
              ? result?.slice(0, 120)
              : undefined,
        body: rows.length ? [{ kind: "table", label: "Entries", columns: [t("名称", locale), t("类型", locale)], rows: rows.slice(0, kMaxTableRows) }] : undefined,
      };
    }
    case "Bash": {
      const command = asString(inp.command) ?? "";
      // 类型化:命令与输出合并为单个 terminal 块,webview 可做等宽/滚动
      const content = truncate([command ? `$ ${command}` : "", result ?? ""].filter(Boolean).join("\n\n"));
      const body: ToolBodyBlock[] | undefined = content ? [{ kind: "terminal", label: "Bash", content }] : undefined;
      return {
        displayName: "Bash",
        headerSecondary: command ? oneLine(command) : undefined,
        summary: err ? oneLine(result ?? "error", 120) : undefined,
        body,
      };
    }
    case "TodoWrite":
      return { displayName: "Update Todos" };
    case "WebSearch": {
      const query = asString(inp.query) ?? "";
      // 类型化:1. title / url / snippet 分块 → 列表;解析失败回退文本
      const blocks = (result ?? "").split(/\n(?=\d+\.\s)/).filter((b) => b.trim() !== "");
      const items: Array<{ title: string; detail: string }> = [];
      for (const b of blocks) {
        const [title, url, snippet] = b.split("\n").map((s) => s.trim());
        if (title && url) items.push({ title: title.replace(/^\d+\.\s*/, ""), detail: [url, snippet].filter(Boolean).join("\n") });
      }
      return {
        displayName: "Web Search",
        headerSecondary: query || undefined,
        body: items.length
          ? [{ kind: "list", label: "Results", items: items.slice(0, kMaxTableRows) }]
          : result
            ? [{ kind: "text", label: "Show full", content: truncate(result) }]
            : undefined,
      };
    }
    case "WebFetch": {
      const url = asString(inp.url) ?? "";
      return {
        displayName: "Web Fetch",
        headerSecondary: url || undefined,
        summary: err ? "Fetch failed" : status === "completed" && url ? `Fetched from ${url}` : undefined,
        body: result ? showFull(result) : undefined,
      };
    }
    case "Agent": {
      const desc = asString(inp.description) ?? (asString(inp.prompt) ? oneLine(asString(inp.prompt)!) : undefined);
      const prompt = asString(inp.prompt);
      return {
        displayName: "Agent",
        headerSecondary: desc,
        summary: status === "running" ? "派发子任务…" : undefined,
        body: prompt ? [{ kind: "text", label: "IN", content: truncate(prompt) }] : undefined,
      };
    }
    case "Workflow": {
      const goal = asString(inp.goal);
      return {
        displayName: "Workflow",
        headerSecondary: goal ? oneLine(goal) : undefined,
        summary: result ? oneLine(result, 120) : undefined,
        body: result ? showFull(result) : undefined,
      };
    }
    default: {
      const body: ToolBodyBlock[] = [];
      if (Object.keys(inp).length > 0) {
        body.push({ kind: "text", label: "IN", content: truncate(JSON.stringify(inp, null, 2)) });
      }
      if (result !== undefined) body.push({ kind: "text", label: "OUT", content: truncate(result) });
      return {
        displayName: name,
        summary: err ? oneLine(result ?? "error", 120) : undefined,
        body: body.length ? body : undefined,
      };
    }
  }
}
