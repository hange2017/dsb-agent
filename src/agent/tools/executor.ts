import { spawn, execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  deleteWorkspaceFile,
  globWorkspace,
  listWorkspaceDir,
  readWorkspaceFile,
  resolveWorkspacePath,
  strReplaceWorkspaceFile,
  writeWorkspaceFile,
} from "./workspaceFs";
import { CORE_TOOLS, buildMcpToolDef } from "./definitions";
import { filterToolDefs } from "./platformGate";
import { isTransientSummaryText } from "../toolUsePolicy";
import { platformInfo } from "../../util/platformInfo";
import { grepFallback } from "./grepFallback";
import { TodoManager } from "./todoTool";
import { defaultWebSearch, webFetch, webSearch, type WebSearchImpl } from "./webTools";
import { runSubagent, type SubagentFactory } from "../subagentRunner";
import { WorkflowRunner, type WorkflowStage } from "../workflow";
import { CheckpointStore } from "../checkpoint";
import type { MemoryEntry, MemoryStore } from "../memory/memoryStore";
import { mergeMemoryIndex } from "../memory/memoryStore";
import { normalizeMemoryScope } from "../memory/memoryTools";
import { findSimilarMemories } from "../memory/memorySimilar";
import type { McpRegistry } from "../../mcp/mcpRegistry";
import { fireHook, type HookRunner } from "../../hooks/hookRunner";
import { MAX_TOOL_RESULT_CHARS, type ToolDef, type ToolExecContext, type ToolExecResult } from "./types";
import { getConfiguredRipgrepPath, pickRipgrepPath } from "../../util/ripgrepPath";
import type { PluginToolSpec } from "../../plugins/types";
import { buildPluginToolDef, pluginToolQualifiedName } from "../../plugins/pluginTools";
import { contextRecallExecute, contextRecallUnavailable } from "./contextRecallTool";
import type { ContextStore } from "../../context/contextStore";

const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
const MAX_SHELL_TIMEOUT_MS = 300_000;
const MAX_STREAM_CHARS = 128 * 1024;
const PLUGIN_TOOL_TIMEOUT_MS = 30_000;

export type PluginCommandRunner = (
  commandPath: string,
  pluginDir: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<{ exit: number; stdout: string; stderr: string }>;


/**
 * 解析 rg 绝对路径。优先 ctx / activate 注入;再试 dist/bin 与扩展/宿主候选。
 * 动态 import @vscode/ripgrep 作补充(ESM-only,不可静态打进 CJS bundle)。
 * 切勿在无绝对路径时盲目 spawn("rg"):扩展宿主 PATH 通常没有 rg → ENOENT。
 */
async function resolveRgBinary(ctx: ToolExecContext): Promise<string | undefined> {
  const fromCtx = ctx.ripgrepPath;
  if (fromCtx && path.isAbsolute(fromCtx) && fs.existsSync(fromCtx)) return fromCtx;
  const configured = getConfiguredRipgrepPath();
  if (configured && fs.existsSync(configured)) return configured;

  // dist/extension.js → __dirname 为 dist;开发态可用 ../node_modules 平台包
  const distDir = typeof __dirname === "string" ? __dirname : undefined;
  const extensionPath = distDir ? path.join(distDir, "..") : undefined;
  if (extensionPath) {
    const picked = pickRipgrepPath({ extensionPath, distDir });
    if (picked) return picked;
  }

  try {
    const mod = (await import("@vscode/ripgrep")) as { rgPath?: string };
    if (typeof mod.rgPath === "string" && fs.existsSync(mod.rgPath)) return mod.rgPath;
  } catch {
    // ignore
  }
  // PATH 兜底:用户系统级安装了 rg 时可用(win32 上为 rg.exe)
  const fromPath = findRgOnPath();
  if (fromPath) return fromPath;
  return undefined;
}

/** 在 PATH 中查找 rg 可执行文件(win32 为 rg.exe)。 */
function findRgOnPath(): string | undefined {
  const names = process.platform === "win32" ? ["rg.exe", "rg"] : ["rg"];
  for (const name of names) {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!dir) continue;
      try {
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // ignore
      }
    }
  }
  return undefined;
}

export function truncateToolResult(text: string, max: number = MAX_TOOL_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const marker = "\n...[truncated]...";
  return text.slice(0, Math.max(0, max - marker.length)) + marker;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${field} must be a non-empty string`);
  return value;
}

/** 把内容压成单行预览(供 Write/StrReplace 的 tool_result 回显,给模型「我写了什么」的锚点)。 */
function oneLinePreview(text: string, max = 120): string {
  const line = text.split("\n").filter((l) => l.trim()).join(" ") || "(empty)";
  return line.length > max ? line.slice(0, max) + "…" : line;
}

function asOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Expected a number");
  return value;
}

function accumulateStream(current: string, chunk: string): string {
  if (current.length >= MAX_STREAM_CHARS) return current;
  const next = current + chunk;
  return next.length > MAX_STREAM_CHARS ? next.slice(0, MAX_STREAM_CHARS) : next;
}

/** Bash 工具描述按平台生成,让模型知道当前 shell 与命令风格。 */
function bashToolDescription(platform: NodeJS.Platform): string {
  const info = platformInfo(platform);
  return `以工作区为 cwd 执行 shell 命令(当前 shell: ${info.shell})。命令风格: ${info.commandStyle}。`;
}

function errorResult(message: string): ToolExecResult {
  return { ok: false, content: truncateToolResult(`ERROR: ${message}`) };
}

function formatShellOutput(exit: number, stdout: string, stderr: string, extra?: string): string {
  const parts = [`exit=${exit}`];
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(stderr);
  if (extra) parts.push(extra);
  return parts.join("\n");
}

function runShell(command: string, cwd: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<ToolExecResult> {
  if (signal?.aborted) return Promise.resolve({ ok: false, content: formatShellOutput(-1, "", "", "Aborted") });
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = isWin
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], { cwd })
      : spawn("/bin/bash", ["-lc", command], { cwd, detached: true });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const killChild = (): void => {
      try {
        if (!isWin && child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        // ignore
      }
    };
    const finish = (ok: boolean, content: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ok, content });
    };
    child.stdout?.on("data", (c: Buffer) => { stdout = accumulateStream(stdout, c.toString()); });
    child.stderr?.on("data", (c: Buffer) => { stderr = accumulateStream(stderr, c.toString()); });

    const timer = setTimeout(() => {
      killChild();
      finish(false, formatShellOutput(-1, stdout, stderr, "Command timed out"));
    }, timeoutMs);

    const onAbort = (): void => {
      killChild();
      finish(false, formatShellOutput(-1, stdout, stderr, "Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.on("error", (err) => finish(false, formatShellOutput(-1, stdout, stderr, err.message)));
    child.on("close", (code) => {
      const exit = code ?? -1;
      // 产品约定:非零退出也视为「执行完成并输出了结果」(含退出码),只有 abort/超时/无法启动才算失败
      finish(true, formatShellOutput(exit, stdout, stderr));
    });
  });
}

function runPowerShell(command: string, cwd: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<ToolExecResult> {
  if (signal?.aborted) return Promise.resolve({ ok: false, content: formatShellOutput(-1, "", "", "Aborted") });
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const killChild = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    };
    const finish = (ok: boolean, content: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ok, content });
    };
    child.stdout?.on("data", (c: Buffer) => { stdout = accumulateStream(stdout, c.toString()); });
    child.stderr?.on("data", (c: Buffer) => { stderr = accumulateStream(stderr, c.toString()); });
    const timer = setTimeout(() => {
      killChild();
      finish(false, formatShellOutput(-1, stdout, stderr, "Command timed out"));
    }, timeoutMs);
    const onAbort = (): void => {
      killChild();
      finish(false, formatShellOutput(-1, stdout, stderr, "Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.on("error", (err) => finish(false, formatShellOutput(-1, stdout, stderr, err.message)));
    child.on("close", (code) => {
      const exit = code ?? -1;
      finish(true, formatShellOutput(exit, stdout, stderr));
    });
  });
}

async function runGrep(input: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolExecResult> {
  const pattern = asString(input.pattern, "pattern");
  const args = ["--line-number", "--no-heading", "--color=never"];
  if (input.case_insensitive === true) args.push("-i");
  if (typeof input.glob === "string" && input.glob) args.push("--glob", input.glob);
  args.push("--", pattern);
  const userPath = typeof input.path === "string" && input.path ? input.path : ".";
  const resolved = resolveWorkspacePath(ctx.workspaceRoot, userPath);
  const searchPath = path.relative(ctx.workspaceRoot, resolved) || ".";
  args.push(searchPath);

  const rgBinary = await resolveRgBinary(ctx);
  if (!rgBinary) {
    // 无 rg:降级为纯 Node 行扫描(慢但永远可用),避免 Windows 等无 rg 环境 Grep 完全失效。
    const fallback = grepFallback(pattern, {
      root: ctx.workspaceRoot,
      path: userPath,
      glob: typeof input.glob === "string" && input.glob ? input.glob : undefined,
      caseInsensitive: input.case_insensitive === true,
    });
    if (fallback.ok) return { ok: true, content: truncateToolResult(fallback.content) };
    return {
      ok: false,
      content: truncateToolResult(
        "ERROR: ripgrep (rg) not found; fallback search failed: " +
          fallback.content +
          ". Install @vscode/ripgrep or run npm run build.",
      ),
    };
  }

  return new Promise((resolve) => {
    const signal = ctx.signal;
    if (signal?.aborted) {
      resolve({ ok: false, content: "Aborted" });
      return;
    }
    const child = spawn(rgBinary, args, { cwd: ctx.workspaceRoot });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (ok: boolean, content: string): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve({ ok, content });
    };
    const onAbort = (): void => {
      child.kill("SIGTERM");
      finish(false, "Aborted");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (c: Buffer) => { stdout = accumulateStream(stdout, c.toString()); });
    child.stderr?.on("data", (c: Buffer) => { stderr = accumulateStream(stderr, c.toString()); });
    child.on("error", (err) => finish(false, err.message));
    child.on("close", (code) => {
      if (code === 0) finish(true, stdout || "(no matches)");
      else if (code === 1) finish(true, "(no matches)");
      else finish(false, stderr || stdout || `ripgrep exited with code ${code}`);
    });
  });
}

export class ToolExecutor {
  readonly toolDefs: ToolDef[] = CORE_TOOLS;
  /** 每个 MCP 服务器已上报的工具定义(按服务器覆盖,connectAll 重复/重连不会叠加)。 */
  private readonly mcpServerDefs = new Map<string, ToolDef[]>();
  /** 插件字面工具:合格名 → 规格。 */
  private readonly pluginTools = new Map<string, PluginToolSpec>();

  /**
   * 当前会话的 subagent 嵌套深度。executor 可能被父/子会话共享,深度不能是只读实例状态,
   * 而由调用会话经 ctx.subagentDepth 同步(见 Agent 分支);子代理工厂据此 +1 生成嵌套会话,
   * 从而让递归深度逐层递增并在 MAX_SUBAGENT_DEPTH 处终止。
   */
  subagentDepth: number;

  constructor(
    // 跨会话记忆:memory 工具分支无条件使用,故为必填(TS 必填参数不能位于可选参数之后,放首位)。
    private readonly memory: MemoryStore,
    private readonly todo: TodoManager = new TodoManager(),
    private readonly webSearchImpl: WebSearchImpl = defaultWebSearch,
    private readonly subagentFactory?: SubagentFactory,
    initialSubagentDepth = 0,
    private readonly checkpoints?: CheckpointStore,
    private readonly mcp?: McpRegistry,
    /** Hook 生命周期:工具执行前(PreToolUse)/成功后(PostToolUse)触发。 */
    private readonly hooks?: HookRunner,
    /** Workflow 工具阶段进度回调(stageId, running|done|error),由 controller 透传为 webview 进度行。 */
    private readonly onWorkflowProgress?: (stageId: string, status: "running" | "done" | "error") => void,
    /** Agent 工具 `agent` 参数按名解析模板,返回的 system 作为子代理角色;未配置时该参数不可用。 */
    private readonly getAgentTemplate?: (name: string) => { system: string } | undefined,
    /** 测试可注入;默认 bash 执行 commandPath,stdin=JSON。 */
    private readonly runPluginCommand?: PluginCommandRunner,
    /** 全局共享记忆(跨项目):memory 工具 scope=global 时读写;缺省时回退到项目 memory。 */
    private readonly globalMemory?: MemoryStore,
    /** 冷存储:ContextRecall 回查压缩前原文;缺省时该工具 fail-open。 */
    private readonly contextStore?: ContextStore,
    /** 平台门禁用平台;缺省 process.platform。测试可注入。 */
    private readonly platform?: NodeJS.Platform,
  ) {
    this.subagentDepth = initialSubagentDepth;
    this.mcp?.onTools((tools) => {
      if (tools.length === 0) return;
      const server = tools[0].serverName;
      this.mcpServerDefs.set(server, tools.map((t) => buildMcpToolDef(t.serverName, t)));
    });
  }

  /** 注册已安装插件的字面工具(会话创建时注入;同名覆盖)。 */
  registerPluginTools(specs: PluginToolSpec[]): void {
    for (const spec of specs) {
      this.pluginTools.set(pluginToolQualifiedName(spec.pluginName, spec.name), spec);
    }
  }

  /** 循环对外通告的工具定义:核心工具 + MCP + 插件工具,按平台门禁过滤。 */
  allToolDefs(): ToolDef[] {
    const mcp: ToolDef[] = [];
    for (const defs of this.mcpServerDefs.values()) mcp.push(...defs);
    const plugin = [...this.pluginTools.values()].map(buildPluginToolDef);
    const platform = this.platform ?? process.platform;
    return filterToolDefs([...this.toolDefs, ...mcp, ...plugin], platform).map((d) =>
      d.name === "Bash" ? { ...d, description: bashToolDescription(platform) } : d,
    );
  }

  async execute(name: string, input: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolExecResult> {
    await fireHook(this.hooks, "PreToolUse", name, input);
    try {
      const result = await this.dispatch(name, input, ctx);
      if (result.ok) await fireHook(this.hooks, "PostToolUse", name, input);
      return result;
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }

  /** 核心分发:mcp__ / plugin__ 转发,其余走核心 switch。 */
  private async dispatch(name: string, input: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolExecResult> {
    const platform = ctx.platform ?? this.platform ?? process.platform;
    if (name.startsWith("mcp__")) return await this.executeMcp(name, input);
    const pluginSpec = this.pluginTools.get(name);
    if (pluginSpec) {
      if (pluginSpec.platforms && pluginSpec.platforms.length > 0 && !pluginSpec.platforms.includes(platform)) {
        return errorResult(`Tool ${name} is not available on ${platform}`);
      }
      return await this.executePluginTool(pluginSpec, input, ctx);
    }
    const def = CORE_TOOLS.find((t) => t.name === name);
    if (!def) return errorResult(`Unknown tool: ${name}`);
    const root = ctx.workspaceRoot;
    switch (name) {
        case "Read": {
          const filePath = asString(input.path, "path");
          // 逃逸/符号链接逃逸是安全拒绝,保持 ok:false(红);先于 try 抛出,由 execute 兜底成 errorResult
          resolveWorkspacePath(root, filePath);
          try {
            const content = readWorkspaceFile(root, filePath, { offset: asOptionalNumber(input.offset), limit: asOptionalNumber(input.limit) });
            return { ok: true, content: truncateToolResult(content) };
          } catch (err) {
            const code = (err as NodeJS.ErrnoException)?.code;
            // 文件系统权限错误是真实失败,保持红;仅「文件不存在」等输出型结果标完成(绿)
            if (code === "EACCES" || code === "EPERM") throw err;
            return { ok: true, content: truncateToolResult(err instanceof Error ? err.message : String(err)) };
          }
        }
        case "Write": {
          const filePath = asString(input.path, "path");
          const contents = typeof input.contents === "string" ? input.contents : "";
          if (isTransientSummaryText(contents)) {
            return errorResult(
              `REFUSED: contents 疑似瞬时参数省略标记(transient summary),拒绝写入 ${filePath}。
上下文中的省略标记不是真实内容,禁止复述或写入文件。
请先用 Read 读取真实内容(长文件请分段 offset/limit),再以完整内容重试。`
            );
          }
          this.checkpoints?.snapshot(resolveWorkspacePath(root, filePath));
          writeWorkspaceFile(root, filePath, contents);
          const written = fs.statSync(resolveWorkspacePath(root, filePath));
          const lineCount = contents.length === 0 ? 0 : contents.split("\n").length;
          return { ok: true, content: `Wrote ${filePath} (${written.size} bytes, ${lineCount} lines) · 内容预览: ${oneLinePreview(contents)}` };
        }
        case "StrReplace": {
          const filePath = asString(input.path, "path");
          const oldString = asString(input.old_string, "old_string");
          const newString = asString(input.new_string, "new_string");
          if (isTransientSummaryText(newString) || isTransientSummaryText(oldString)) {
            return errorResult(`REFUSED: old_string/new_string 疑似瞬时参数省略标记,拒绝修改 ${filePath}。
上下文中的省略标记不是真实内容,禁止复述或写入文件。
请先用 Read 读取真实内容(长文件请分段 offset/limit),再以完整内容重试。`);
          }
          const full = resolveWorkspacePath(root, filePath); // 逃逸保持红:在 try 外抛
          this.checkpoints?.snapshot(full); // 快照失败也必须红(真实失败,非「无匹配」)
          try {
            const { replacements } = strReplaceWorkspaceFile(root, filePath, oldString, newString, input.replace_all === true);
            return { ok: true, content: `Replaced ${replacements} occurrence(s) in ${filePath} · new_string 预览: ${oneLinePreview(newString)}` };
          } catch (err) {
            const code = (err as NodeJS.ErrnoException)?.code;
            // 文件系统权限错误是真实失败,保持红;仅「无匹配」标完成(绿)
            if (code === "EACCES" || code === "EPERM") throw err;
            return { ok: true, content: `No match for old_string in ${filePath}` };
          }
        }
        case "Delete": {
          const filePath = asString(input.path, "path");
          this.checkpoints?.snapshot(resolveWorkspacePath(root, filePath));
          deleteWorkspaceFile(root, filePath);
          return { ok: true, content: `Deleted ${filePath}` };
        }
        case "Glob": {
          const pattern = asString(input.pattern, "pattern");
          const content = globWorkspace(root, pattern, typeof input.path === "string" ? input.path : undefined);
          return { ok: true, content: content || "(no matches)" };
        }
        case "Grep": {
          const result = await runGrep(input, ctx);
          return result.ok ? result : errorResult(result.content);
        }
        case "LS": {
          const dirPath = asString(input.path, "path");
          const content = listWorkspaceDir(root, dirPath);
          return { ok: true, content: content || "(empty)" };
        }
        case "Bash": {
          const command = asString(input.command, "command");
          const requested = asOptionalNumber(input.timeout_ms);
          const timeoutMs = Math.min(requested !== undefined && requested > 0 ? requested : DEFAULT_SHELL_TIMEOUT_MS, MAX_SHELL_TIMEOUT_MS);
          const result = await runShell(command, root, ctx.signal, timeoutMs);
          return result;
        }
        case "PowerShell": {
          if (platform !== "win32") {
            return errorResult(`PowerShell is not available on ${platform}`);
          }
          const command = asString(input.command, "command");
          const requested = asOptionalNumber(input.timeout_ms);
          const timeoutMs = Math.min(requested !== undefined && requested > 0 ? requested : DEFAULT_SHELL_TIMEOUT_MS, MAX_SHELL_TIMEOUT_MS);
          const result = await runPowerShell(command, root, ctx.signal, timeoutMs);
          return result;
        }
        case "TodoWrite": {
          const op = asString(input.op, "op");
          if (op === "list") return { ok: true, content: this.todo.toPromptBlock() };
          // add/update 后返回「最新完整清单」作为 tool_result:清单状态经由消息尾部
          // (tool_result)传播给模型,无需再注入 system / 追加伪 user 消息,
          // 且每条变更后模型都能看到最新状态,避免基于旧快照重复执行。
          if (op === "add") {
            this.todo.add(asString(input.content, "content"));
            return { ok: true, content: this.todo.toPromptBlock() };
          }
          if (op === "update") {
            const ok = this.todo.update(asString(input.id, "id"), input.done === true);
            return { ok, content: ok ? this.todo.toPromptBlock() : "Todo not found" };
          }
          if (op === "clear") { this.todo.clear(); return { ok: true, content: "Cleared todos" }; }
          return errorResult(`Unknown op: ${op}`);
        }
        case "WebSearch": {
          const query = asString(input.query, "query");
          return await webSearch(query, this.webSearchImpl);
        }
        case "WebFetch": {
          const url = asString(input.url, "url");
          return await webFetch(url);
        }
        case "Agent": {
          if (!this.subagentFactory) return errorResult("Agent tool disabled");
          // 共享 executor:深度取自调用会话的 ctx,同步后供子代理工厂读取
          this.subagentDepth = ctx.subagentDepth ?? 0;
          const task = asString(input.task, "task");
          // agent 参数:按名解析已注册模板,模板 system 作为子代理角色;指定了但未命中就报错,
          // 避免静默降级成通用子代理导致角色指令丢失。
          const agentName = typeof input.agent === "string" && input.agent ? input.agent : undefined;
          const template = agentName ? this.getAgentTemplate?.(agentName) : undefined;
          if (agentName && !template) return errorResult(`Unknown agent: ${agentName}`);
          const system = template ? template.system : (typeof input.system === "string" ? input.system : undefined);
          const r = await runSubagent(this.subagentFactory, task, system, this.subagentDepth, ctx.signal);
          return r.ok ? { ok: true, content: r.content } : errorResult(r.content);
        }
        case "Workflow": {
          if (!this.subagentFactory) return errorResult("Workflow disabled");
          // 与 Agent 分支同理:同步当前会话深度,阶段子会话经共享 executor 的 subagentDepth+1 逐层递增
          this.subagentDepth = ctx.subagentDepth ?? 0;
          const goal = asString(input.goal, "goal");
          const stagesRaw = input.stages;
          if (!Array.isArray(stagesRaw) || stagesRaw.length === 0) return errorResult("stages must be a non-empty array");
          // 阶段级运行时校验:schema 的 required 只是建议,executor 必须亲自把关。
          // id/prompt 用 asString(抛错由 execute 的 try/catch 转成 errorResult,与其余工具分支一致)。
          const stages: WorkflowStage[] = [];
          const seenIds = new Set<string>();
          for (let i = 0; i < stagesRaw.length; i++) {
            const s = stagesRaw[i];
            if (s === null || typeof s !== "object") return errorResult(`stages[${i}] must be an object`);
            const rec = s as Record<string, unknown>;
            const id = asString(rec.id, `stages[${i}].id`);
            const prompt = asString(rec.prompt, `stages[${i}].prompt`);
            if (seenIds.has(id)) return errorResult(`duplicate stage id: ${id}`);
            seenIds.add(id);
            let dependsOn: string[];
            if (rec.dependsOn === undefined) dependsOn = [];
            else if (Array.isArray(rec.dependsOn)) {
              for (let j = 0; j < rec.dependsOn.length; j++) {
                if (typeof rec.dependsOn[j] !== "string") return errorResult(`stages[${i}].dependsOn[${j}] must be a string`);
              }
              dependsOn = rec.dependsOn as string[];
            } else {
              return errorResult(`stages[${i}].dependsOn must be an array of strings`);
            }
            stages.push({ id, prompt, dependsOn });
          }
          const runner = new WorkflowRunner({
            runStage: async (prompt) => {
              // 阶段经 runSubagent 执行,透传父会话取消信号(abort → session.cancel,
              // 结果标记 Aborted)与嵌套深度门禁,避免 Workflow 阶段脱离取消链、
              // 用户 Stop 后仍在跑的阶段(以及尚在队列中的阶段)各自跑满整轮 LLM。
              const r = await runSubagent(this.subagentFactory!, prompt, undefined, this.subagentDepth, ctx.signal);
              // ok:false(取消/深度超限/阶段失败)映射为 ERROR 文本,让 WorkflowRunner 把
              // 它当作阶段结果继续推进,而不是从工具执行里抛出中断整个工作流。
              return r.ok ? r.content : `ERROR: ${r.content}`;
            },
            onProgress: (stageId, status) => { this.onWorkflowProgress?.(stageId, status); },
          });
          const { final } = await runner.run({ goal, stages });
          return { ok: true, content: final };
        }
        case "MemoryWrite": {
          const name = asString(input.name, "name");
          const description = asString(input.description, "description");
          const body = asString(input.body, "body");
          // pinned 显式布尔才覆盖;缺省走 write() 的继承语义(新条目 false,更新保留旧值)
          const pinned = typeof input.pinned === "boolean" ? input.pinned : undefined;
          const e: MemoryEntry = { name, description, body, updatedAt: Date.now(), ...(pinned === undefined ? {} : { pinned }) };
          // auto/project → 项目记忆;global → 全局共享记忆(无全局实例时回退项目)
          const scope = normalizeMemoryScope(input.scope);
          const store = scope === "global" ? (this.globalMemory ?? this.memory) : this.memory;
          store.write(e);
          // 启发式相似检测:写入前比对既有条目,返回候选提示(同名更新不算重复)。
          // 让 agent 在"新增重复条目"与"覆盖/合并既有条目"之间做判断。
          const similar = findSimilarMemories(store.list(), name, description);
          let content = `Memory written: ${e.name} (scope: ${scope === "global" ? "global" : "project"})`;
          if (similar.length > 0) {
            content +=
              "\n\n⚠ 检测到相似记忆(可能重复,建议核对后合并或复用既有条目,而非新增堆积):\n" +
              similar.map((s) => `- ${s.name}: ${s.description} (相似度 ${Math.round(s.score * 100)}%)`).join("\n");
          }
          return { ok: true, content };
        }
        case "MemoryRead": {
          const name = asString(input.name, "name");
          const scope = normalizeMemoryScope(input.scope);
          // 无全局实例时 global 操作回退项目 store(与 write/delete 一致,fail-open)。
          const globalStore = this.globalMemory ?? this.memory;
          // auto → 项目优先,未命中回退全局;global → 只读全局(或回退的项目 store)
          let e = scope === "global" ? globalStore.get(name) : this.memory.get(name);
          let hitStore: MemoryStore | undefined = e ? (scope === "global" ? globalStore : this.memory) : undefined;
          if (!e && scope !== "global") {
            e = globalStore.get(name);
            if (e) hitStore = globalStore;
          }
          if (e && hitStore) {
            // 触碰计数:命中哪个 store 就记录该条目的访问(影响索引加权排序)
            hitStore.touch(name);
            return { ok: true, content: `${e.name}\n${e.body}` };
          }
          return { ok: false, content: `Memory not found: ${name}` };
        }
        case "MemoryList": {
          const scope = normalizeMemoryScope(input.scope);
          // auto → 合并项目 + 全局(带作用域标记,与系统提示注入的索引一致);global → 只列全局
          const globalStore = this.globalMemory ?? this.memory;
          const projectEntries = scope === "global" ? [] : this.memory.list();
          const globalEntries = scope === "global" ? globalStore.list() : this.globalMemory ? globalStore.list() : [];
          // 触碰计数:列表浏览视为访问,条目在加权排序中变"新鲜"(与被读一致)
          for (const x of projectEntries) this.memory.touch(x.name);
          for (const x of globalEntries) globalStore.touch(x.name);
          const projectIndex = scope === "global" ? "" : this.memory.index("项目");
          const globalIndex =
            scope === "global" ? globalStore.index("全局") : this.globalMemory ? this.globalMemory.index("全局") : "";
          const idx = mergeMemoryIndex(projectIndex, globalIndex);
          return { ok: true, content: idx || "(no memories)" };
        }
        case "MemoryDelete": {
          const name = asString(input.name, "name");
          // auto/project → 只删项目记忆(避免误删全局同名);global → 显式删全局
          const scope = normalizeMemoryScope(input.scope);
          const store = scope === "global" ? (this.globalMemory ?? this.memory) : this.memory;
          store.delete(name);
          return { ok: true, content: `Deleted: ${name} (scope: ${scope === "global" ? "global" : "project"})` };
        }
        case "ContextRecall": {
          // 无冷存储 fail-open:不报错,提示不可用
          if (!this.contextStore) return contextRecallUnavailable();
          const sessionId = typeof ctx.sessionId === "string" ? ctx.sessionId : "default";
          return contextRecallExecute(this.contextStore, sessionId, input);
        }
        default:
          return errorResult(`Unknown tool: ${name}`);
      }
  }

  private async executePluginTool(
    spec: PluginToolSpec,
    input: Record<string, unknown>,
    ctx: ToolExecContext,
  ): Promise<ToolExecResult> {
    const runner = this.runPluginCommand ?? defaultPluginCommandRunner;
    try {
      const { exit, stdout, stderr } = await runner(spec.commandPath, spec.pluginDir, input, ctx.signal);
      if (exit === 0) {
        return { ok: true, content: truncateToolResult(stdout || "(empty)") };
      }
      return errorResult(stderr || stdout || `plugin tool exited with code ${exit}`);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }

  /** MCP 工具分支:按 `mcp__<server>__<tool>` 拆回服务器与工具名,经 registry 转发。
   * 权限在调用前由 AgentSession 的 PermissionManager.check 统一把关(M2),此处不重复。
   * 防御性懒连接:目标服务器尚未 spawn 时先补连——但能走到这里说明 agentLoop 已先跑过
   * permissions.check(首用确认),spawn 因此始终在用户批准之后发生。 */
  private async executeMcp(name: string, input: Record<string, unknown>): Promise<ToolExecResult> {
    if (!this.mcp) return errorResult(`MCP not configured: ${name}`);
    const rest = name.slice("mcp__".length);
    const sep = rest.indexOf("__");
    if (sep < 0) return errorResult(`Invalid MCP tool name: ${name}`);
    const server = rest.slice(0, sep);
    const tool = rest.slice(sep + 2);
    if (!(await this.mcp.ensureConnected(server))) {
      return errorResult(`MCP server not connected: ${server}`);
    }
    try {
      const content = await this.mcp.callTool(server, tool, input);
      const text = content
        .map((c) => (typeof c.text === "string" ? c.text : ""))
        .filter((s) => s.length > 0)
        .join("\n");
      return { ok: true, content: truncateToolResult(text || JSON.stringify(content)) };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }
}

function defaultPluginCommandRunner(
  commandPath: string,
  pluginDir: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const isWin = process.platform === "win32";
    const child = execFile(
      isWin ? (process.env.ComSpec ?? "cmd.exe") : "/bin/bash",
      isWin ? ["/d", "/s", "/c", commandPath] : [commandPath],
      { cwd: pluginDir, timeout: PLUGIN_TOOL_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const errno = err as NodeJS.ErrnoException & { killed?: boolean };
        if (errno?.killed) {
          reject(new Error("plugin tool timed out"));
          return;
        }
        const exit = err && typeof (err as { code?: unknown }).code === "number"
          ? ((err as { code: number }).code)
          : err
            ? 1
            : 0;
        resolve({
          exit,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "") || (err && exit === 1 ? err.message : ""),
        });
      },
    );
    const onAbort = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      child.stdin?.write(JSON.stringify(input));
      child.stdin?.end();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
