import type {
  ProviderBlock,
  ProviderClient,
  ProviderMessage,
  ProviderStreamEvent,
  ProviderUserBlock,
} from "./provider/types";
import type { ToolExecutor } from "./tools/executor";
import { TodoManager } from "./tools/todoTool";
import type { PermissionManager } from "./permission";
import type { SessionEvent } from "../session/sessionTypes";
import type { SdkImagePayload } from "../context/imageAttach";
import { fireHook, type HookRunner } from "../hooks/hookRunner";
import { ContextManager } from "./contextManager";
import type { ContextStore } from "../context/contextStore";
import { CompactionStats, type CompactionStatsSnapshot } from "./compactionStats";
import { estimateProviderSendTokens, type ProviderSendBreakdown } from "../stats/providerSendStats";
import { isCompactedBlock } from "./contextCompactor";
import type { ProviderRoundResult } from "./provider/types";

/** 一次 provider.round 的真实 usage(来自 API 响应 usage 字段;缓存字段按厂商字段名归一化)。 */
export type ProviderRoundUsage = NonNullable<ProviderRoundResult["usage"]>;
import {
  findConsumedToolResults,
  planToolResultTrim,
  toolResultText,
  TOOL_RESULT_SUMMARIZE_PROMPT,
  TRIMMED_MARKER,
  SUMMARIZED_MARKER,
} from "./toolResultPolicy";
import { findConsumedToolUses, planToolUseTrim } from "./toolUsePolicy";
import { findConsumedThinking, planThinkingTrim } from "./thinkingPolicy";
import type { CompactionRecord } from "../stats/compactionEvents";
import { isToolAllowed, modeSystemSegment, thinkingEnabledForMode, type AgentMode } from "./modePolicy";
import { effectiveContextWindowTokens } from "../providers/capabilities";
import { prepareRound, sanitizeOutbound, assertToolResultsComplete } from "./capabilityGate";
import { mapParallelBatches, runWithConcurrency } from "./tools/parallelSafe";

export type AgentLoopEvent =
  | { type: "status"; busy: boolean; info?: string }
  | { type: "info"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | {
      type: "tool_call";
      callId: string;
      name: string;
      status: "running" | "completed" | "error";
      input?: unknown;
      detail?: string;
    }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { type: "compaction_stats"; stats: CompactionStatsSnapshot }
  | { type: "done" }
  | { type: "error"; message: string };

const DEFAULT_MAX_ROUNDS = 1_000_000;
const DEFAULT_TRIGGER_RATIO = 0.75;

/**
 * 历史 token 预算防呆:任何入口(设置/程序)传进来的预算,不得让"压缩后历史"
 * (预算)逼近模型窗口——压缩后仍超窗会导致 400 或连续压缩。
 * 上限 = 窗口×0.7 − system/工具定义预留 4K;≤0 或预算未开启(0)时原样返回。
 */
export function clampHistoryTokenBudget(budget: number | undefined, windowTokens: number): number | undefined {
  if (budget === undefined || budget <= 0) return budget;
  const cap = Math.max(1, Math.floor(windowTokens * 0.7) - 4096);
  return Math.min(budget, cap);
}
/** 摘要请求失败时的兜底文本:压缩永远不阻断主循环。 */
const FALLBACK_SUMMARY = "已省略前文对话。";

// 兼容旧测试/调用方:stripThinkingBlocks 现定义在 capabilityGate。
export { stripThinkingBlocks } from "./capabilityGate";

export class AgentSession {
  // 压缩时整体替换为"摘要 + 尾部",故非 readonly
  private messages: ProviderMessage[] = [];
  private abortController: AbortController | undefined;
  private readonly todo: TodoManager;
  private readonly contextManager: ContextManager;
  /** A5:最近一次压缩事件(含 compactedSeqs),供 QA 抽查使用。 */
  private lastCompaction: CompactionRecord | undefined = undefined;
  private readonly hooks?: HookRunner;
  /** 最近一次 send 的事件通道:thinking 压缩/对话轮次统计变化时推送 compaction_stats。 */
  private currentOnEvent: ((ev: AgentLoopEvent) => void) | undefined;

  constructor(
    private readonly deps: {
      provider: ProviderClient;
      tools: ToolExecutor;
      permissions: PermissionManager;
      workspaceRoot: string;
      /** ripgrep 绝对路径,传入 Grep 工具上下文。 */
      ripgrepPath?: string;
      systemPrompt: string;
      todo?: TodoManager;
      contextManager?: ContextManager;
      maxRounds?: number;
      initialHistory?: ProviderMessage[];
      onRecord?: (ev: SessionEvent) => void;
      /** 持久化 API 历史真相源:send 结束 / compact 后收到完整 ProviderMessage[]。子代理不传,保持瞬态。 */
      onPersist?: (messages: ProviderMessage[]) => void;
      /** 可选冷存储:自建 ContextManager 时注入,压缩过程写入原文供 ContextRecall 回查。 */
      contextStore?: ContextStore;
      /** 冷存储按会话隔离;缺省 "default"。 */
      sessionId?: string;
      /** 压缩触发阈值(0~1);缺省 DEFAULT_TRIGGER_RATIO。 */
      triggerRatio?: number;
      /** thinking 压缩成本统计(对话轮次 + thinking 压缩次数,滑动窗口);缺省不统计。 */
      stats?: CompactionStats;
      /** 历史信息 token 总预算;0/缺省 = 关闭(现状)。 */
      historyTokenBudget?: number;
      /** 预算三块比例(压缩块/thinking/tail);缺省 45/20/35。 */
      budgetSplit?: { compacted: number; thinking: number; tail: number };
      /** 给大模型的输入最大长度覆盖;>0 时替代模型能力窗口。缺省跟随模型。 */
      windowTokensOverride?: number;
      /** 触发比例:每块 token ≥ 额定×该比例 → 压缩(流水线主触发);缺省 0.75。 */
      triggerPct?: number;
      /** 压缩后目标比例(滞回);缺省 0.5。 */
      targetPct?: number;
      /** 每次 provider.round 发送前的消息组成统计(只记 token 数,不记内容);缺省不回调。 */
      onProviderSend?: (breakdown: ProviderSendBreakdown) => void;
      /** 每次 provider.round 成功返回后,记录真实 usage(含缓存命中 token);缺省不回调。 */
      onProviderRound?: (usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        /** 调用阶段:chat = 主对话轮,compact = 压缩流程内部 summarize 调用。 */
        phase: "chat" | "compact";
        /** 本次 provider.round 总耗时(ms),便于区分对话/压缩延迟。 */
        roundMs: number;
      }) => void;
      /** 每次压缩的 4 位置 before/after token 统计(只记数字,不记内容);缺省不回调。 */
      onCompaction?: (ev: CompactionRecord) => void;
      /** A5:压缩质量抽查事件(压缩后对 [r{n}] 提问验证信息保真);缺省不回调 = 不触发 QA。 */
      onCompactionQa?: (ev: {
        sessionId: string;
        seq: number;
        answerable: boolean;
        qaMs: number;
        qaInputTokens: number;
        qaOutputTokens: number;
        inTokens: number;
        outTokens: number;
      }) => void;
      /** subagent 嵌套深度;顶层为 0,子代理工厂按 +1 创建嵌套会话。 */
      subagentDepth?: number;
      /** Hook 生命周期:会话创建时 SessionStart,每次运行结束时 Stop。 */
      hooks?: HookRunner;
    },
  ) {
    this.todo = this.deps.todo ?? new TodoManager();
    this.messages.push(...(this.deps.initialHistory ?? []));
    // 未注入 contextManager 时自建:用本会话 provider 单发一条"总结前文"请求,
    // 失败时返回兜底摘要,保证压缩不会让主循环崩溃。ContextManager 本体保持纯逻辑。
    const windowTokens =
      this.deps.windowTokensOverride && this.deps.windowTokensOverride > 0
        ? this.deps.windowTokensOverride
        : effectiveContextWindowTokens(this.deps.provider.capabilities);
    this.contextManager = this.deps.contextManager ?? new ContextManager({
      windowTokens,
      triggerRatio: this.deps.triggerRatio ?? DEFAULT_TRIGGER_RATIO,
      contextStore: this.deps.contextStore,
      sessionId: this.deps.sessionId ?? "default",
      summarize: (text, opts) => this.summarizeMessages(text, opts.maxTokens, opts.rules),
      onThinkingCompaction: () => this.recordThinkingCompaction(),
      onCompaction: (ev) => {
        // A5:缓存最近一次压缩事件(含 compactedSeqs),供 QA 抽查使用
        this.lastCompaction = ev;
        this.deps.onCompaction?.(ev);
      },
      historyTokenBudget: clampHistoryTokenBudget(this.deps.historyTokenBudget, windowTokens),
      budgetSplit: this.deps.budgetSplit,
      triggerPct: this.deps.triggerPct,
      targetPct: this.deps.targetPct,
    });
    this.hooks = this.deps.hooks;
    // SessionStart:会话创建时触发(构造器为同步,fire-and-forget;失败由 fireHook 吞掉)。
    if (this.hooks) void fireHook(this.hooks, "SessionStart", "", {});
  }

  getMessages(): ProviderMessage[] {
    return [...this.messages];
  }

  /**
   * 用户手动触发强制压缩:忽略 triggerRatio 阈值,直接调用 contextManager.compact 并同步持久化。
   * 与 send() 内自动压缩的 fail-open 不同,这里压缩失败会向上抛错,由命令层 toast 提示用户。
   */
  async compactNow(): Promise<void> {
    const compacted = await this.contextManager.compact(this.messages);
    // Compact 输出再过能力清洗,避免尾部历史 image/thinking 在后续 round/fallback 翻车。
    this.messages = sanitizeOutbound(this.deps.provider.capabilities, compacted);
    this.persistNow();
  }

  private record(ev: SessionEvent): void {
    this.deps.onRecord?.(ev);
  }

  /** 持久化当前 messages 快照:失败绝不阻断主循环(fail-open,与 hooks 同哲学)。 */
  private persistNow(): void {
    try {
      this.deps.onPersist?.(this.messages);
    } catch {
      // 持久化失败忽略:不影响 agent 运行
    }
  }

  /** thinking 压缩成本统计:记录一次压缩事件并推送 UI 快照(经最近 send 的事件通道)。 */
  private recordThinkingCompaction(): void {
    if (!this.deps.stats) return;
    this.deps.stats.recordThinkingCompaction();
    this.currentOnEvent?.({ type: "compaction_stats", stats: this.deps.stats.snapshot() });
  }

  /** 推送当前统计快照:对话轮次或压缩事件变化后调用,供 UI 显示「最近 N 次对话 x 次压缩」。 */
  private emitStats(onEvent: (ev: AgentLoopEvent) => void): void {
    if (!this.deps.stats) return;
    onEvent({ type: "compaction_stats", stats: this.deps.stats.snapshot() });
  }

  /** 调用 provider 单发一条"总结前文"请求,提取模型返回的文本作为摘要。失败时返回兜底摘要。rules 存在时作为完整 system 提示(thinking 压缩规则)。 */
  /**
   * A5:压缩质量抽查——对被压缩掉的 [r{n}] 序号提问,验证压缩块是否保留关键信息。
   * 独立 provider.round(不打 onProviderRound,避免污染对话轮次统计);
   * token 只记在 compaction_qa 事件上,聚合时单列扣减。
   */
  private async runCompactionQa(ev: CompactionRecord): Promise<void> {
    const seqs = ev.compactedSeqs ?? [];
    if (seqs.length === 0 || !this.deps.onCompactionQa) return;
    const seq = seqs[Math.floor(Math.random() * seqs.length)];
    const block = this.messages.find((m) => m.role === "user" && typeof m.content === "string" && isCompactedBlock(m.content));
    if (!block || typeof block.content !== "string") return;
    const qaStart = Date.now();
    try {
      const result = await this.deps.provider.round(
        [{ role: "user", content: block.content }],
        {
          system: `压缩质量抽查:下面是历史对话的压缩摘要块。请回答:[r${seq}] 对应的原始内容是什么?只回 1-2 句简要结论;不确定就回 UNKNOWN。`,
          tools: [],
          signal: this.abortController?.signal,
          maxTokens: 200,
        },
        () => {},
      );
      const answer = result.blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      const answerable = answer.length > 0 && !/^UNKNOWN$/i.test(answer);
      this.deps.onCompactionQa({
        sessionId: this.deps.sessionId ?? "default",
        seq,
        answerable,
        qaMs: Date.now() - qaStart,
        qaInputTokens: result.usage?.inputTokens ?? 0,
        qaOutputTokens: result.usage?.outputTokens ?? 0,
        inTokens: ev.beforeTokens,
        outTokens: ev.afterTokens,
      });
    } catch {
      // QA 失败静默:不影响主对话
      this.deps.onCompactionQa({
        sessionId: this.deps.sessionId ?? "default",
        seq,
        answerable: false,
        qaMs: Date.now() - qaStart,
        qaInputTokens: 0,
        qaOutputTokens: 0,
        inTokens: ev.beforeTokens,
        outTokens: ev.afterTokens,
      });
    }
  }

  private async summarizeMessages(text: string, maxTokens: number, rules?: string): Promise<string> {
    try {
      const message: ProviderMessage = { role: "user", content: text };
      const prepared = prepareRound({
        caps: this.deps.provider.capabilities,
        messages: [message],
        lastInputTokens: this.contextManager.getLastInputTokens?.() ?? 0,
      });
      const roundStart = Date.now();
      const result = await this.deps.provider.round(
        [message],
        {
          system:
            rules ??
            `请用不超过 ${maxTokens} tokens 的篇幅总结上述对话,保留关键决策、文件路径和结论,以便后续继续。`,
          tools: [],
          signal: this.abortController?.signal,
          // 调用方预算(explanation 800 / thinking 3500)真正生效,同时不超能力上限
          maxTokens: Math.min(prepared.maxTokens, maxTokens),
          lastInputTokens: this.contextManager.getLastInputTokens?.() ?? 0,
          ...(prepared.thinkingBudgetTokens !== undefined
            ? { thinkingBudgetTokens: prepared.thinkingBudgetTokens }
            : {}),
        },
        () => {},
      );
      // 压缩流程的 LLM 调用也打点(phase=compact),补齐压缩自身成本统计盲区
      if (result.usage) {
        this.deps.onProviderRound?.({
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          ...(result.usage.cacheReadTokens !== undefined ? { cacheReadTokens: result.usage.cacheReadTokens } : {}),
          ...(result.usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: result.usage.cacheWriteTokens } : {}),
          phase: "compact",
          roundMs: Date.now() - roundStart,
        });
      }
      const extracted = result.blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return extracted || FALLBACK_SUMMARY;
    } catch {
      return FALLBACK_SUMMARY;
    }
  }

  /**
   * tail 内已消费 toolUse 精简(同步,无 LLM 成本):
   * 瞬时参数(Write.contents / StrReplace.new_string / Workflow.stages[].prompt 等)
   * 替换为摘要文本,语义参数与 id/name 保留。失败不阻塞主循环。
   */
  private trimConsumedToolUses(): void {
    try {
      const targets = findConsumedToolUses(this.messages);
      if (targets.length === 0) return;
      for (const { index, blockIndex } of targets) {
        const msg = this.messages[index];
        if (msg.role !== "assistant") continue;
        const block = msg.content[blockIndex];
        if (block.type !== "tool_use") continue;
        const plan = planToolUseTrim(block.name, block.input);
        if (plan.action === "trim" && plan.trimmedInput !== undefined) {
          block.input = plan.trimmedInput as Record<string, unknown>;
        }
      }
    } catch {
      // 精简失败不阻塞主循环;下次发送前会重试
    }
  }

  /**
   * tail 内已消费 thinking 原文精简(同步,零 LLM 成本):
   * 超阈值 thinking 保留尾部结论行 + 截断标记,前面删除;
   * 保持 `{ type: "thinking" }` 块结构(API 要求)。失败不阻塞主循环。
   */
  private trimConsumedThinking(): void {
    try {
      const targets = findConsumedThinking(this.messages);
      if (targets.length === 0) return;
      // rankFromLatest:0=最新一条已消费,越早越大(用于「最近 N 条保留完整尾巴」)。
      const rankFromLatest = targets.length - 1;
      for (let t = 0; t < targets.length; t++) {
        const { index, blockIndex } = targets[t];
        const msg = this.messages[index];
        if (msg.role !== "assistant") continue;
        const block = msg.content[blockIndex];
        if (block.type !== "thinking") continue;
        const plan = planThinkingTrim(block.thinking, rankFromLatest - t);
        if (plan.action === "trim" && plan.trimmed !== undefined) {
          block.thinking = plan.trimmed;
        }
      }
    } catch {
      // 精简失败不阻塞主循环;下次发送前会重试
    }
  }

  /**
   * tail 内已消费 toolResult 精简(设计:两阶段处理中的阶段 2)。
   * 发送前调用:把已被模型消费过的低密度工具结果替换为规则精简版或 LLM 摘要,
   * 高密度工具(Read 等)与小输出原样保留。精简失败不阻塞发送(下次再试)。
   */
  private async trimConsumedToolResults(): Promise<void> {
    try {
      const targets = findConsumedToolResults(this.messages);
      if (targets.length === 0) return;
      for (const { index, toolName } of targets) {
        const msg = this.messages[index];
        if (msg.role !== "user" || typeof msg.content === "string") continue;
        for (const block of msg.content) {
          if (block.type !== "tool_result") continue;
          const text = toolResultText(block.content);
          const plan = planToolResultTrim(toolName, text);
          if (plan.action === "keep") continue;
          if (plan.action === "summarize") {
            const summary = await this.summarizeMessages(text, 400, TOOL_RESULT_SUMMARIZE_PROMPT);
            block.content = [{ type: "text", text: `${SUMMARIZED_MARKER}\n${summary}` }];
          } else if (plan.trimmed !== undefined) {
            block.content = [{ type: "text", text: `${TRIMMED_MARKER}\n${plan.trimmed}` }];
          }
        }
      }
    } catch {
      // 精简失败不阻塞主循环;下次发送前会重试
    }
  }

  async send(
    userText: string,
    onEvent: (ev: AgentLoopEvent) => void,
    opts?: { rawText?: string; images?: SdkImagePayload[]; mode?: AgentMode },
  ): Promise<void> {
    const { provider, tools, permissions, workspaceRoot, systemPrompt } = this.deps;
    const maxRounds = this.deps.maxRounds ?? DEFAULT_MAX_ROUNDS;

    // 无 vision 时忽略 opts.images,避免把 image blocks 发给不支持多模态的模型。
    const images =
      provider.capabilities.supportsVision === false ? [] : (opts?.images ?? []);
    const imageBlocks = images.map((img) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: img.mimeType, data: img.data },
    }));
    const userContent: string | ProviderUserBlock[] =
      imageBlocks.length > 0 ? [...imageBlocks, { type: "text", text: userText }] : userText;
    // 发送前的历史快照:压缩会把旧消息整体替换为摘要,仅靠 length 截断会留下稀疏空洞,
    // 所以回滚直接恢复快照,丢弃本轮的部分消息。
    const preSend = this.messages.slice();
    this.messages.push({ role: "user", content: userContent });
    // 对话轮次统计:一次 send = 一次对话(即使后续失败/取消也计入),并推送 UI 快照
    this.deps.stats?.beginConversation();
    this.currentOnEvent = onEvent;
    this.emitStats(onEvent);
    // 会话事件记录原始用户文本(rawText),不记录展开后的 prompt
    this.record({ kind: "user", text: opts?.rawText ?? userText, timestamp: Date.now() });
    const rollback = (): void => {
      this.messages = [...preSend];
    };

    onEvent({ type: "status", busy: true, info: "等待模型…" });
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    let terminal: { type: "done" } | { type: "error"; message: string } | undefined;

    try {
      for (let round = 0; round < maxRounds; round++) {
        // 每轮取一次 mode 与其 system 段(agent 为空串):工具过滤与硬拒都要用,放循环顶部保证作用域覆盖整个 round
        const mode = opts?.mode ?? "agent";
        const modeSeg = modeSystemSegment(mode);
        if (signal.aborted) {
          rollback();
          return;
        }
        // 上下文超阈值时压缩:旧消息替换为摘要,保留最近 4 条,保证后续轮次不超窗。
        // v2 流水线:needsCompaction(messages) 同时检查窗口兜底与 tail 自驱动(预算模式下)。
        if (this.contextManager.needsCompaction(this.messages)) {
          try {
            // plan/ask 模式关闭 thinking 压缩(省一次 LLM 调用,thinking 剥离丢弃)
            this.contextManager.setThinkingEnabled?.(thinkingEnabledForMode(mode));
            const compacted = await this.contextManager.compact(this.messages);
            this.messages = sanitizeOutbound(provider.capabilities, compacted);
            this.persistNow(); // compact 后立刻同步持久化,避免「JSONL 全量、内存已摘要」分叉
            // A5:压缩质量抽查(自动压缩且配置了回调时才触发;手动 compactNow 不掺入)
            if (this.deps.onCompactionQa && this.lastCompaction) {
              void this.runCompactionQa(this.lastCompaction);
            }
            onEvent({ type: "info", text: "已压缩上下文" });
          } catch {
            // 注入的 ContextManager 摘要失败时不阻断主循环:保持原消息继续
            onEvent({ type: "info", text: "上下文压缩失败,继续原对话" });
          }
        }
        const forward: (ev: ProviderStreamEvent) => void = (ev) => {
          if (ev.type === "text_delta") {
            onEvent({ type: "text_delta", text: ev.text });
          } else onEvent({ type: "thinking_delta", text: ev.text });
        };

        let result;
        let roundStart = 0;
        let roundParallel: { mode: "read_safe" | "serial"; maxParallelTools: number } = {
          mode: "read_safe",
          maxParallelTools: 8,
        };
        try {
          // tail 内已消费 toolResult / toolUse / thinking 精简:在 prepareRound / 打点之前,让打点反映真实发送
          this.trimConsumedToolUses();
          this.trimConsumedThinking();
          await this.trimConsumedToolResults();
          // 每轮把任务清单拼到 system prompt 末尾,base systemPrompt 保持原样
          const roundSystem = `${systemPrompt}\n\n${this.todo.toPromptBlock()}${modeSeg ? `\n\n${modeSeg}` : ""}`;
          const prepared = prepareRound({
            caps: provider.capabilities,
            messages: this.messages,
            lastInputTokens: this.contextManager.getLastInputTokens?.() ?? 0,
            windowTokensOverride: this.deps.windowTokensOverride,
          });
          roundParallel = {
            mode: prepared.toolParallelMode,
            maxParallelTools: prepared.maxParallelTools,
          };
          // 每轮通告核心 + MCP 工具定义,按模式白名单过滤:plan/ask 下写工具与 mcp__ 不暴露给模型
          // 传原始 messages + lastInputTokens:Fallback 会按子 client caps 重 prepare;直连 client 入口再 sanitize。
          const lastInputTokens = this.contextManager.getLastInputTokens?.() ?? 0;
          // 发送前打点:记录这一包消息的 token 组成(只记数字不记内容),供历史占比统计
          roundStart = Date.now();
          this.deps.onProviderSend?.(estimateProviderSendTokens(roundSystem, this.messages));
          result = await provider.round(this.messages, {
            system: roundSystem,
            tools: tools.allToolDefs().filter((d) => isToolAllowed(mode, d.name)),
            signal,
            maxTokens: prepared.maxTokens,
            lastInputTokens,
            ...(prepared.thinkingBudgetTokens !== undefined
              ? { thinkingBudgetTokens: prepared.thinkingBudgetTokens }
              : {}),
          }, forward);
          // Fallback 切模型后 capabilities 可能已变:热更新压缩窗(有覆盖时保持覆盖)。
          this.contextManager.setWindowTokens?.(
            this.deps.windowTokensOverride && this.deps.windowTokensOverride > 0
              ? this.deps.windowTokensOverride
              : effectiveContextWindowTokens(provider.capabilities),
          );
        } catch (err) {
          rollback();
          if (signal.aborted) return; // 取消是正常操作,静默返回,不发 error 事件
          const message = err instanceof Error ? err.message : String(err);
          terminal = { type: "error", message };
          return;
        }
        if (signal.aborted) {
          rollback();
          return;
        }
        if (result.usage) {
          onEvent({ type: "usage", inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens });
          this.deps.onProviderRound?.({
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            ...(result.usage.cacheReadTokens !== undefined ? { cacheReadTokens: result.usage.cacheReadTokens } : {}),
            ...(result.usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: result.usage.cacheWriteTokens } : {}),
            phase: "chat",
            roundMs: Date.now() - roundStart,
          });
        }
        this.contextManager.track(result.usage);

        // 去掉 SSE 稀疏下标留下的空洞;以实际入历史的 tool_use 块为准收集待执行列表,
        // 避免 blocks 含 tool_use 但 toolUses 因缺 content_block_stop 为空时直接 done 留下孤儿。
        // 防御:若 provider 只把解析后的 input 放在 toolUses 里、blocks 仍是 start 时的 {},
        // 落盘前把 input 合并进 blocks,防止空参数污染会话历史(诱发后续空 Bash 等失败)。
        const toolUseById = new Map(result.toolUses.map((t) => [t.id, t]));
        const assistantBlocks = result.blocks
          .filter((b): b is ProviderBlock => b != null)
          .map((b) => {
            if (b.type !== "tool_use") return b;
            const fromUses = toolUseById.get(b.id);
            return fromUses ? { ...b, input: fromUses.input } : b;
          });
        const toolUses = assistantBlocks
          .filter((b): b is Extract<ProviderBlock, { type: "tool_use" }> => b.type === "tool_use")
          .map((b) => toolUseById.get(b.id) ?? { id: b.id, name: b.name, input: b.input });
        this.messages.push({ role: "assistant", content: assistantBlocks });

        if (toolUses.length === 0) {
          terminal = { type: "done" };
          return;
        }

        // 同一条 assistant 的全部 tool_result 必须落在紧随其后的一条 user 消息里;
        // 拆成多条会触发 Anthropic 兼容 API 400(tool_use without tool_result immediately after)。
        // content 用 Anthropic 原生 block 数组形状落盘(api-history.json 保持原生结构;
        // UI/日志走 onEvent detail 的可读格式,不依赖此形状)。
        const toolResultBlocks: Array<
          { type: "tool_result"; tool_use_id: string; content: Array<{ type: "text"; text: string }> } | undefined
        > = new Array(toolUses.length);
        try {
          type Prepared =
            | { index: number; kind: "error"; content: string; name: string; input: Record<string, unknown>; detail: string }
            | { index: number; kind: "run"; toolUse: (typeof toolUses)[number] };

          const prepared: Prepared[] = [];
          for (let i = 0; i < toolUses.length; i++) {
            const toolUse = toolUses[i];
            if (signal.aborted) {
              rollback();
              return;
            }
            if (!isToolAllowed(mode, toolUse.name)) {
              const detail = `Tool not allowed in ${mode} mode`;
              onEvent({
                type: "tool_call",
                callId: toolUse.id,
                name: toolUse.name,
                status: "error",
                input: toolUse.input,
                detail,
              });
              this.record({
                kind: "tool",
                name: toolUse.name,
                status: "error",
                detail,
                input: toolUse.input,
                timestamp: Date.now(),
              });
              prepared.push({ index: i, kind: "error", content: `ERROR: ${detail}`, name: toolUse.name, input: toolUse.input, detail });
              continue;
            }
            onEvent({
              type: "tool_call",
              callId: toolUse.id,
              name: toolUse.name,
              status: "running",
              input: toolUse.input,
            });
            const decision = await permissions.check(toolUse.name, toolUse.input);
            if (decision.decision === "deny") {
              onEvent({
                type: "tool_call",
                callId: toolUse.id,
                name: toolUse.name,
                status: "error",
                input: toolUse.input,
                detail: decision.reason,
              });
              this.record({
                kind: "tool",
                name: toolUse.name,
                status: "error",
                detail: decision.reason,
                input: toolUse.input,
                timestamp: Date.now(),
              });
              prepared.push({
                index: i,
                kind: "error",
                content: `ERROR: Permission denied: ${decision.reason}`,
                name: toolUse.name,
                input: toolUse.input,
                detail: decision.reason,
              });
              continue;
            }
            prepared.push({ index: i, kind: "run", toolUse });
          }

          for (const p of prepared) {
            if (p.kind === "error") {
              toolResultBlocks[p.index] = {
                type: "tool_result",
                tool_use_id: toolUses[p.index].id,
                content: [{ type: "text", text: p.content }],
              };
            }
          }

          const runItems = prepared.filter((p): p is Extract<Prepared, { kind: "run" }> => p.kind === "run");
          const batches = mapParallelBatches(
            runItems.map((p) => p.toolUse.name),
            roundParallel,
          );

          const executeOne = async (item: Extract<Prepared, { kind: "run" }>): Promise<void> => {
            if (signal.aborted) {
              const err = new Error("Aborted");
              err.name = "AbortError";
              throw err;
            }
            const { toolUse, index } = item;
            const execResult = await tools.execute(toolUse.name, toolUse.input, {
              workspaceRoot,
              signal,
              subagentDepth: this.deps.subagentDepth ?? 0,
              ripgrepPath: this.deps.ripgrepPath,
              sessionId: this.deps.sessionId ?? "default",
            });
            onEvent({
              type: "tool_call",
              callId: toolUse.id,
              name: toolUse.name,
              status: execResult.ok ? "completed" : "error",
              input: toolUse.input,
              detail: execResult.content,
            });
            this.record({
              kind: "tool",
              name: toolUse.name,
              status: execResult.ok ? "completed" : "error",
              detail: execResult.content,
              input: toolUse.input,
              timestamp: Date.now(),
            });
            toolResultBlocks[index] = {
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: [{ type: "text", text: execResult.content }],
            };
          };

          for (const batch of batches) {
            if (signal.aborted) {
              rollback();
              return;
            }
            const slice = runItems.slice(batch.start, batch.end);
            if (batch.parallel) {
              await runWithConcurrency(slice, roundParallel.maxParallelTools, (item) => executeOne(item));
            } else {
              for (const item of slice) {
                if (signal.aborted) {
                  rollback();
                  return;
                }
                await executeOne(item);
              }
            }
          }

          assertToolResultsComplete(toolResultBlocks);
        } catch (err) {
          // 工具轮内意外异常(权限网关/执行/落盘等)必须回滚到 preSend:保证 finally 里 persistNow
          // 落盘的快照不含孤儿 tool_use(Anthropic 兼容 API 会因 tool_use 无 tool_result 而 400)。
          // Abort invariant:rollback 到 preSend,finally 持久化合法快照(无能力语义变更)。
          rollback();
          if (signal.aborted) return; // 取消是正常操作,静默返回,不发 error 事件
          const message = err instanceof Error ? err.message : String(err);
          terminal = { type: "error", message };
          return;
        }
        this.messages.push({
          role: "user",
          content: toolResultBlocks,
        });
      }
      rollback();
      terminal = { type: "error", message: `Exceeded max tool rounds (${maxRounds})` };
    } finally {
      this.abortController = undefined;
      onEvent({ type: "status", busy: false });
      if (terminal) {
        onEvent(terminal);
      }
      // 任意终态下 this.messages 都是合法快照(done 保留终态;error/abort 已 rollback 到 preSend),
      // 在此保存即「以最后一次稳定状态为准」。必须放在 if (terminal) 之外,abort 也要落盘。
      this.persistNow();
      // Stop:每次运行结束(done/error/取消)时触发,fire-and-forget 不延迟收尾事件
      void fireHook(this.hooks, "Stop", "", {});
    }
  }

  cancel(): void {
    this.abortController?.abort();
  }
}
