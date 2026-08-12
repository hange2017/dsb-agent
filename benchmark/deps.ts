/**
 * 依赖装配:构造 ToolExecutor / PermissionManager / AgentSession 的全部注入依赖。
 * 全部复用 src/agent 引擎,不 import vscode;评测环境可 headless 运行。
 */
import * as path from "path";
import { AgentSession } from "../src/agent/agentLoop";
import { ToolExecutor } from "../src/agent/tools/executor";
import { MemoryStore } from "../src/agent/memory/memoryStore";
import { PermissionManager } from "../src/agent/permission";
import { PermissionRules } from "../src/agent/permissionRules";
import { buildSystemPrompt } from "../src/agent/systemPrompt";
import type { ProviderClient } from "../src/agent/provider/types";
import type { CostTracker } from "./stats";

export interface BuildSessionOptions {
  provider: ProviderClient;
  workspaceRoot: string;
  /** 上层工作目录:放 .memory 等与实例无关的数据。 */
  workDir: string;
  /** 附加的项目指令(可选;默认不注入任何 DSB 项目约定,保证评测可复现)。 */
  projectInstruction?: string;
  maxRounds?: number;
  windowTokensOverride?: number;
  historyTokenBudget?: number;
  ripgrepPath?: string;
  tracker: CostTracker;
}

/** 评测环境权限:bypass + 全放行 gateway(无交互)。 */
export function buildPermissionManager(): PermissionManager {
  return new PermissionManager({
    gateway: { request: async () => true },
    rules: new PermissionRules(),
    sessionMode: "bypassPermissions",
  });
}

/** 构建 AgentSession(打榜默认关闭记忆:空 MemoryStore;系统提示不注入技能/记忆)。 */
export function buildSession(opts: BuildSessionOptions): AgentSession {
  const memory = new MemoryStore(path.join(opts.workDir, ".memory"));
  const tools = new ToolExecutor(memory);
  const systemPrompt = buildSystemPrompt({
    workspaceRoot: opts.workspaceRoot,
    locale: "en",
    projectInstruction: opts.projectInstruction,
  });
  return new AgentSession({
    provider: opts.provider,
    tools,
    permissions: buildPermissionManager(),
    workspaceRoot: opts.workspaceRoot,
    ripgrepPath: opts.ripgrepPath,
    systemPrompt,
    maxRounds: opts.maxRounds ?? 200,
    windowTokensOverride: opts.windowTokensOverride,
    historyTokenBudget: opts.historyTokenBudget,
    onProviderSend: opts.tracker.onProviderSend,
    onProviderRound: opts.tracker.onProviderRound,
    onCompaction: opts.tracker.onCompaction,
  });
}
