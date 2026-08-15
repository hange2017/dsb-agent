import type { ToolDef } from "./types";
import { TODO_TOOL_DEF } from "./todoTool";
import { SUBAGENT_DEF } from "../subagentRunner";
import { MEMORY_TOOL_DEFS } from "../memory/memoryTools";
import { CONTEXT_RECALL_TOOL_DEF } from "./contextRecallTool";

export const CORE_TOOLS: ToolDef[] = [
  {
    name: "Read",
    description: "读取工作区文件内容。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对路径" },
        offset: { type: "number", description: "起始行(1 基)" },
        limit: { type: "number", description: "最多行数" },
      },
      required: ["path"],
    },
  },
  {
    name: "Write",
    description: "新建或覆盖工作区文件。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        contents: { type: "string" },
      },
      required: ["path", "contents"],
    },
  },
  {
    name: "StrReplace",
    description: "在文件中替换精确字符串。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "Delete",
    description: "删除工作区文件。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "Glob",
    description: "按 glob 模式查找文件。",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "可选子目录" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "Grep",
    description: "用 ripgrep 搜索文件内容。",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "string" },
        case_insensitive: { type: "boolean" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "LS",
    description: "列出工作区目录条目。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "Bash",
    description: "以工作区为 cwd 执行 shell 命令。Windows 经 cmd.exe,Linux/macOS 经 /bin/bash;请按当前 OS 选择命令风格。",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "number" },
      },
      required: ["command"],
    },
  },
  {
    name: "PowerShell",
    description: "在 Windows 上以工作区为 cwd 执行 PowerShell 脚本(仅 Windows 可用)。适合文件/进程/系统管理等 cmd 不擅长的场景。",
    platforms: ["win32"],
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的 PowerShell 命令/脚本" },
        timeout_ms: { type: "number" },
      },
      required: ["command"],
    },
  },

  TODO_TOOL_DEF,
  {
    name: "WebSearch",
    description: "搜索网络,返回前 5 条结果。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
      },
      required: ["query"],
    },
  },
  {
    name: "WebFetch",
    description: "抓取网页正文文本(最长 20000 字符)。",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要抓取的 URL" },
      },
      required: ["url"],
    },
  },
  SUBAGENT_DEF,
  {
    name: "Workflow",
    description: "把一个复杂目标拆成多个子 agent 阶段执行(dependsOn 表达依赖,无依赖阶段并行)。输入 stages 为数组,每项 {id, prompt, dependsOn[]}。",
    input_schema: {
      type: "object",
      properties: {
        goal: { type: "string" },
        stages: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, prompt: { type: "string" }, dependsOn: { type: "array", items: { type: "string" } } },
            required: ["id", "prompt"],
          },
        },
      },
      required: ["goal", "stages"],
    },
  },
  ...MEMORY_TOOL_DEFS,
  CONTEXT_RECALL_TOOL_DEF,
];

/**
 * 把 MCP 服务器上报的工具转成 ToolDef:完整工具名为 `mcp__<server>__<tool>`,
 * description 前缀 `[MCP <server>]` 便于模型区分来源。执行侧按该命名约定拆回 server/tool。
 */
export function buildMcpToolDef(
  serverName: string,
  tool: { name: string; description?: string; input_schema: unknown },
): ToolDef {
  return {
    name: `mcp__${serverName}__${tool.name}`,
    description: `[MCP ${serverName}] ${tool.description ?? ""}`,
    input_schema: (tool.input_schema as Record<string, unknown>) ?? {},
  };
}
