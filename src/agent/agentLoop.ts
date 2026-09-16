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
import {
  needsMaxTokensContinue,
  kMaxTokensContinueUserText,
  kMaxTokensInterruptedAssistantText,
  kMaxTokensContinueInfoText,
  kMaxTokensContinueLimit,
} from "./maxTokensContinue";

/** 一次 provider.round 的真实 usage(来自 API 响应 usage 字段;缓存字段按厂商字段名归一化)。 */
export type ProviderRoundUsage = NonNullable<ProviderRoundResult["usage"]>;
import {
  findConsumedToolResults,
  planToolResultTrim,
  toolResultText,
  TOOL_RESULT_SUMMARIZE_PROMPT,
  TRIMMED_MARKER,
  SUMMARIZED_MARKER,
  buildToolResultArchiveChunk,
  withToolResultRecallMarker,
} from "./toolResultPolicy";
import {
  findConsumedToolUses,
  planToolUseTrim,
  buildStrReplaceOldStringArchiveChunk,
  withOldStringRecallMarker,
  TOOL_USE_KEEP_RECENT_COUNT,
} from "./toolUsePolicy";
import {
  findConsumedThinking,
  planThinkingTrim,
  buildThinkingArchiveChunk,
  withRecallMarker,
} from "./thinkingPolicy";
import { ToolRepeatTracker, type ToolRepeatHit } from "./toolRepeatDetector";
import { TurnSummaryStats, type TurnSummary, type TurnEndReason } from "./turnSummary";
import type { ColdChunk } from "../context/contextStore";
import type { CompactionRecord } from "../stats/compactionEvents";
import { isToolAllowed, modeSystemSegment, thinkingEnabledForMode, type AgentMode } from "./modePolicy";
import { effectiveContextWindowTokens } from "../providers/capabilities";
import type { ModelCapabilities } from "../providers/types";
import {
  prepareRound,
  resolveThinkingParams,
  sanitizeOutbound,
  assertToolResultsComplete,
  repairToolUseResultPairs,
} from "./capabilityGate";
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
  | { type: "user_message"; text: string }
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

/** todo 注入:能并入普通 user 则改 messages 尾部;否则不注入(绝不进 system、绝不追加伪 user)。 */
export type TodoInjection = ProviderMessage[];

/**
 * 任务锚固定提示(有未完成待办):字节恒定,跨轮可缓存;提醒目标/清单位置与历史回查入口。
 * P0-3:仅在**确有未完成待办**时使用 —— 否则"继续推进"会把纯状态汇报(如「现在重启了」)
 * 读成「继续未竟的历史任务」,实测引发 56 轮/151 次工具调用的失控(见
 * `.dsb/docs/2026-09-16-任务地图放大子任务实证与修复.md`)。
 */
export const TASK_ANCHOR_HINT =
  "〔任务锚〕按下面清单继续推进;需要更早的历史原文时,用 ContextRecall(seq=n) 回查压缩块中的 [r{n}] 行。";

/**
 * 任务锚固定提示(无未完成待办,P0-3):不再宣称"继续推进",避免历史需求被读成待办。
 * 地图中的「近期需求/更早的需求」是**历史需求**,无完成度判定,不能当作待办执行。
 *
 * P0-6(去复述):旧文案是**条件句**("若本轮消息未给出明确指令,请只回应本条消息"),模型每轮都要
 * 重新判断一次"本轮有没有明确指令",并把判断结果**写进正文**(实测同一句式连出 10 个 round:
 * "任务锚无待办,但你这条是明确提问(70K 何时生效),我继续查完再答"),既烧输出又经 conclusions 轨
 * 回流进地图、下轮再投,自我强化。现改为**纯声明式**并显式禁止复述/确认本段:
 * 语义完全等价(仍是"别自行继续历史任务"),但不再要求模型求值,故没有可写出来的判断结论。
 * 字节仍恒定(跨轮可缓存)。
 *
 * P0-6(B 去标签):idle 路径**不再自称「任务锚」**。实证复述句几乎全部以标签开头
 * ("任务锚显示无待办" / "锚显示无待办" / "任务锚无待办") —— 模型引用的是**标签名**本身;
 * 保留标签等于每轮递一个可被引用的名词。行动指令(「按清单继续推进」)只保留在**有 pending** 的
 * `TASK_ANCHOR_HINT` 分支,idle 分支退化为「只读参考」标签,不给模型"锚"这个把柄。
 */
export const TASK_ANCHOR_HINT_IDLE =
  "〔只读参考·历史上下文〕以下内容不是待办、无需在回复中说明或确认,直接回应本轮用户消息即可;不要自行继续历史任务。需要更早的原文时用 ContextRecall(seq=n) 回查 [r{n}] 行。";

/**
 * 「下一步」段固定标题:由**真实未完成待办**生成(非历史需求)。
 * 单独成段是为了让模型每轮都能一眼看到"还没做什么",而不必自行从清单里筛 `- [ ]`。
 */
export const NEXT_STEP_TITLE = "### 下一步";

/** 下一步最多列出的条目数(超出只影响显示,不影响清单本身)。 */
const NEXT_STEP_MAX_ITEMS = 3;

/**
 * 由「未完成待办」的内容生成 `### 下一步` 段;无未完成项返回空串。
 * 只接受**pending**项的文本(调用方负责过滤 done),故不存在"把已完成当待办"的风险。
 */
export function buildNextStepSection(pending: string[] | undefined): string {
  const items = (pending ?? [])
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s !== "")
    .slice(0, NEXT_STEP_MAX_ITEMS);
  if (items.length === 0) return "";
  return [NEXT_STEP_TITLE, ...items.map((s) => `- ${s}`)].join("\n");
}

/**
 * 组合任务锚文本(固定提示 + 会话目标 + 下一步 + 最新清单)。
 * `goalLine` 可选:非空时输出单行 `**会话目标:** <最新需求>`(压缩块需求轨最新一条 = 当前任务)。
 *   历史(2026-09-16):此处原为 `mapLines`(6 段常驻任务地图)。地图的「已做/结果」两段
 *   构成自我强化闭环 —— 模型自己的过程旁白 → 结论轨 → 地图「结果」段 → 锚 → 回喂自身,
 *   实测让「现在重启了」5 个字跑 56 轮。整块删除,只保留「把目标放到消息尾部」这个真价值。
 * `pendingTodos` 为**未完成**待办的文本(通常取 TodoManager.list() 里 done=false 的 content);
 * 有值时注入 `### 下一步` —— 这是锚里唯一宣称"待办"的地方,且来源是真实 todo 状态。
 */
export function buildTaskAnchor(
  todoBlock: string,
  goalLine?: string,
  pendingTodos?: string[],
  modeNote?: string,
): string {
  const goal = goalLine && goalLine.trim().length > 0 ? `**会话目标:** ${goalLine.trim()}\n` : "";
  const next = buildNextStepSection(pendingTodos);
  // P0-3:提示语按"是否确有未完成待办"选择。两个信号取并集(调用方 pendingTodos 为准,
  // 清单里仍有 `- [ ]` 项时同样视为有活)——避免"无待办却催继续推进"诱导模型重复劳动。
  const hasUnchecked = /^-\s*\[ \]/m.test(todoBlock);
  const hint = next.length > 0 || hasUnchecked ? TASK_ANCHOR_HINT : TASK_ANCHOR_HINT_IDLE;
  // 模式说明(T2):原先挂在 system 后缀,会让 system 变长 → tools + 全部 messages miss;
  // 现改由锚投递到消息尾部,mode 切换只影响尾部字节,前缀照常命中。
  const mode = modeNote && modeNote.length > 0 ? `${modeNote}\n` : "";
  return `${hint}\n${mode}${goal}${next ? `${next}\n` : ""}${todoBlock}`;
}

/**
 * 把最新任务清单(todo)作为「任务锚」注入本轮请求(仅请求视图,不进持久历史)。
 * 目的:让模型在**每一轮**(含工具执行轮)都能看到当前计划与历史回查入口,
 * 修复「工具轮里看不到计划 → 多轮迷失目标」。
 * 变化点尽量落在消息尾部,锚之前的前缀跨轮稳定可缓存。
 * - 尾部为普通 user 字符串:并入其 content 前部(首轮常见路径)。
 * - 尾部为 user block 数组(非 tool_result):最前面插入 text 块。
 * - 尾部为 tool_result 的 user:在同一 user 消息的 tool_result **之后**追加 text 块
 *   (Anthropic 允许 tool_result 后跟 text;不追加独立 user 消息,避免角色不交替导致 400)。
 *   兼容性兜底:opts.anchorOnToolResult === false 时该分支回退为不注入。
 * - 尾部为 assistant / 空:不注入,原样返回。
 * - 绝不挂 system 后缀(system 字节变化会让 tools + messages 前缀全 miss)。
 * - 不修改入参数组。
 */
export function injectTodoIntoMessages(
  messages: ProviderMessage[],
  todoBlock: string,
  opts?: {
    anchorOnToolResult?: boolean;
    /** 单行会话目标(压缩块需求轨最新一条 = 当前任务);非空时输出 `**会话目标:** …`。 */
    goalLine?: string;
    pendingTodos?: string[];
    /** 模式说明(T2):原先挂 system 后缀,现随锚投递到消息尾部。 */
    modeNote?: string;
  },
): TodoInjection {
  const hasGoal = (opts?.goalLine?.trim().length ?? 0) > 0;
  const hasPending = (opts?.pendingTodos?.length ?? 0) > 0;
  const hasMode = (opts?.modeNote?.length ?? 0) > 0;
  // 清单为空但**存在会话目标**时仍需注入 —— 目标行是锚的一部分,尾部锚是它唯一的投递通道。
  // T2:仅 mode 说明也存在时同样要注入(plan/ask 且无清单/目标时它是唯一投递通道)。
  if (todoBlock.length === 0 && !hasGoal && !hasPending && !hasMode) return messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return messages;
  const anchor = buildTaskAnchor(todoBlock, opts?.goalLine, opts?.pendingTodos, opts?.modeNote);
  const content = last.content;
  const merged = messages.slice(0, -1);
  if (typeof content === "string") {
    merged.push({ role: "user", content: `${anchor}\n\n${content}` });
    return merged;
  }
  const isToolResultMsg = content.some((b) => b.type === "tool_result");
  if (isToolResultMsg) {
    if (opts?.anchorOnToolResult === false) return messages;
    merged.push({ role: "user", content: [...content, { type: "text" as const, text: anchor }] });
    return merged;
  }
  merged.push({ role: "user", content: [{ type: "text" as const, text: anchor }, ...content] });
  return merged;
}


// 兼容旧测试/调用方:stripThinkingBlocks 现定义在 capabilityGate。
export { stripThinkingBlocks } from "./capabilityGate";

export class AgentSession {
  // 压缩时整体替换为"摘要 + 尾部",故非 readonly
  private messages: ProviderMessage[] = [];
  private abortController: AbortController | undefined;
  /** 交互式追加队列:busy 期间用户追加的新消息,下一轮循环顶部注入(只 push,前缀稳定)。 */
  private readonly pendingAppends: string[] = [];
  private readonly todo: TodoManager;
  private readonly contextManager: ContextManager;
  /** A5:最近一次压缩事件(含 compactedSeqs),供 QA 抽查使用。 */
  private lastCompaction: CompactionRecord | undefined = undefined;
  private readonly hooks?: HookRunner;
  /** 重复调用检测器(会话内状态,只读旁路;缺省回调时不使用)。 */
  private readonly repeatTracker = new ToolRepeatTracker();
  /** 轮次档案累加器:一次 send = 一份档案,收尾经 onTurnSummary 落盘(纯旁路)。 */
  private readonly turnStats = new TurnSummaryStats();
  /** 最近一次 send 的事件通道:thinking 压缩/对话轮次统计变化时推送 compaction_stats。 */
  private currentOnEvent: ((ev: AgentLoopEvent) => void) | undefined;
  /** 实际使用的 provider(原样,无总开关包装)。 */
  private readonly effectiveProvider: ProviderClient;

  constructor(
    private readonly deps: {
      provider: ProviderClient;
      /** 处理侧 thinking 开关:false 时「模型可先思考(请求仍带预算),但流程不处理 thinking」——产出的 thinking 剥离(不进历史/压缩/脉络),缺省 true。 */
      thinkingProcessEnabled?: boolean;
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
      /** 全量快照持久化(方向 3):宿主拆两处落盘(apiHistory + 压缩块快照)。缺省回退 onPersist。 */
      agentPersist?: (snap: { messages: ProviderMessage[]; compactedBlock?: string }) => void;
      /** 可选冷存储:自建 ContextManager 时注入,压缩过程写入原文供 ContextRecall 回查。 */
      contextStore?: ContextStore;
      /** 工具执行轮是否也注入任务锚(默认 true);个别兼容端点若拒绝 tool_result 后跟 text,可置 false 回退。 */
      todoAnchorOnToolResult?: boolean;
      /** 是否启用单行会话目标锚(仅经任务锚在消息尾部投递一行;不再有 6 段地图);默认 true,显式 false 可回退旧行为。 */
      goalAnchorEnabled?: boolean;
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
      /** tail 分级折叠比例(方向 2):tail 预算内较旧的该比例折叠进压缩块;undefined/0 = 关闭。 */
      tailFoldRatio?: number;
      /** 预置压缩块快照(方向 3):会话恢复回退场景下注入上次持久化块,压缩时作旧脉络;缺省不注入。 */
      compactedPreset?: string;
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
      /**
       * 重复调用打点:每次工具事件落盘后,若与本次会话中同参数的历史调用重复则回调。
       * 只传数字与短参数摘要(不含工具输出内容);缺省不回调 = 不做检测。
       */
      onToolRepeat?: (hit: ToolRepeatHit) => void;
      /**
       * 轮次档案:一次 send(一个「大任务」)收尾时回调一条完整计数档案
       * (rounds / toolCalls / 重复 / 压缩 / ContextRecall / 缓存命中 token)。
       * 纯旁路:只记数字不记内容,不影响发给 provider 的字节;缺省不回调 = 不打点。
       */
      onTurnSummary?: (s: TurnSummary) => void;
    },
  ) {
    this.todo = this.deps.todo ?? new TodoManager();
    // 实际使用注入的 provider(思考能力由 provider.capabilities 决定)。
    this.effectiveProvider = this.deps.provider;
    // 加载历史时先修复孤儿 tool_use,避免旧会话一发消息就 400
    this.messages.push(...repairToolUseResultPairs(this.deps.initialHistory ?? []));
    // 未注入 contextManager 时自建:用本会话 provider 单发一条"总结前文"请求,
    // 失败时返回兜底摘要,保证压缩不会让主循环崩溃。ContextManager 本体保持纯逻辑。
    const windowTokens =
      this.deps.windowTokensOverride && this.deps.windowTokensOverride > 0
        ? this.deps.windowTokensOverride
        : effectiveContextWindowTokens(this.effectiveProvider.capabilities);
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
      tailFoldRatio: this.deps.tailFoldRatio,
      presetCompactedBlock: this.deps.compactedPreset,
      // 默认开启会话目标锚(仅 1 行,经任务锚在消息尾部投递);显式传 false 可回退。
      goalAnchorEnabled: this.deps.goalAnchorEnabled !== false,
    });
    // 恢复路径种子:目标已移出压缩块(不再随块持久化),会话恢复后到下次压缩之间
    // residentGoal 会为空 → 任务锚短时丢目标行。此处从恢复块的需求轨最新一条真实需求重建
    // (幂等/确定性,只走消息尾部锚,不参与压缩块前缀)。
    // 优先取 apiHistory 里的压缩块,其次回退 preset 快照(ContextManager 内部处理)。
    this.contextManager.seedResidentGoal?.(this.extractCompactedBlock());
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
    this.messages = sanitizeOutbound(this.effectiveProvider.capabilities, compacted);
    this.persistNow();
  }

  private record(ev: SessionEvent): void {
    this.deps.onRecord?.(ev);
    // 重复调用检测:与 jsonl 落盘同一漏斗,保证运行时口径与离线脚本 analyze-duplicate-work.py 一致。
    // 纯旁路:只读事件、只发统计回调,不改动任何发给 provider 的字节(messages/system 前缀稳定)。
    if (ev.kind === "tool") {
      // 轮次档案:工具调用数/失败数/种类数(与 UI 事件同源,口径一致)。
      this.turnStats.recordTool(ev.name, ev.status === "completed");
      if (ev.name === "ContextRecall") this.turnStats.recordContextRecall();
      try {
        const hit = this.repeatTracker.observe(ev.name, ev.input as Record<string, unknown> | undefined, ev.detail, ev.timestamp);
        if (hit) {
          this.turnStats.recordRepeat(hit);
          this.deps.onToolRepeat?.(hit);
        }
      } catch {
        // 统计失败不影响主流程(fail-open,与 hooks / persistNow 同哲学)。
      }
    }
  }

  /** 持久化当前 messages 快照:失败绝不阻断主循环(fail-open,与 hooks 同哲学)。 */
  private persistNow(): void {
    try {
      // 全量快照 = apiHistory + 压缩块快照(经 agentPersist 由宿主拆两处落盘;无宿主时回退 onPersist)。
      if (this.deps.agentPersist) {
        this.deps.agentPersist({
          messages: this.messages,
          compactedBlock: this.extractCompactedBlock(),
        });
      } else {
        this.deps.onPersist?.(this.messages);
      }
    } catch {
      // 持久化失败忽略:不影响 agent 运行
    }
  }

  /** 从当前消息提取最近一条压缩块原文(带 [compacted] 的 user 文本消息);无则 undefined。 */
  private extractCompactedBlock(): string | undefined {
    const messages = this.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "user" || typeof m.content !== "string") continue;
      const content = m.content as string;
      if (content.includes("[compacted]")) return content;
    }
    return undefined;
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
      const result = await this.effectiveProvider.round(
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
        caps: this.effectiveProvider.capabilities,
        messages: [message],
        lastInputTokens: this.contextManager.getLastInputTokens?.() ?? 0,
      });
      const roundStart = Date.now();
      // 摘要任务不需要推理预算,且调用方预算常被钳到 800/200/3500 —— 远小于能力预算(medium=4096)。
      // 直接透传会发出 `budget_tokens >= max_tokens` 的违规组合(严格端点 400,且此处 catch 会静默
      // 降级为兜底文案 → 压缩块变空)。故按「钳后的 maxTokens」重新解析 thinking 参数。
      const summaryMaxTokens = Math.min(prepared.maxTokens, maxTokens);
      const summaryThinking = resolveThinkingParams(this.effectiveProvider.capabilities, summaryMaxTokens);
      const result = await this.effectiveProvider.round(
        [message],
        {
          system:
            rules ??
            `请用不超过 ${maxTokens} tokens 的篇幅总结上述对话,保留关键决策、文件路径和结论,以便后续继续。`,
          tools: [],
          signal: this.abortController?.signal,
          // 调用方预算(explanation 800 / thinking 3500)真正生效,同时不超能力上限
          maxTokens: summaryMaxTokens,
          lastInputTokens: this.contextManager.getLastInputTokens?.() ?? 0,
          ...(summaryThinking.thinkingBudgetTokens !== undefined
            ? { thinkingBudgetTokens: summaryThinking.thinkingBudgetTokens }
            : {}),
          ...(summaryThinking.thinkingDisabled === true ? { thinkingDisabled: true } : {}),
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
   * StrReplace.old_string 在替换前归档原文(文件系统已无副本)。
   */
  private trimConsumedToolUses(): void {
    try {
      const targets = findConsumedToolUses(this.messages);
      if (targets.length === 0) return;
      // 近期窗口:最近 N 条已消费 tool_use 一律不精简(对齐 thinking 的 THINKING_KEEP_RECENT_COUNT)。
      // 「已消费」只说明又过了一轮,被消费的内容往往正是刚支撑完当前任务的工作集,不是垃圾。
      const rankFromLatest = targets.length - 1;
      for (let t = 0; t < targets.length; t++) {
        if (rankFromLatest - t < TOOL_USE_KEEP_RECENT_COUNT) continue;
        const { index, blockIndex } = targets[t];
        const msg = this.messages[index];
        if (msg.role !== "assistant") continue;
        const block = msg.content[blockIndex];
        if (block.type !== "tool_use") continue;
        const plan = planToolUseTrim(block.name, block.input);
        if (plan.action !== "trim" || plan.trimmedInput === undefined) continue;
        let nextInput: unknown = plan.trimmedInput;
        if (block.name === "StrReplace") {
          const archive = buildStrReplaceOldStringArchiveChunk(block.input);
          const seq = archive ? this.archiveCut([archive]) : undefined;
          if (seq !== undefined) nextInput = withOldStringRecallMarker(nextInput, seq);
        }
        block.input = nextInput as typeof block.input;
      }
    } catch {
      // 精简失败不阻塞主循环;下次发送前会重试
    }
  }

  /**
   * tail 内已消费 thinking 原文精简(同步,零 LLM 成本)。
   *
   * T3(缓存前缀):此处**只做长度规则的幂等兜底** —— 超阈值(> THINKING_TAIL_CHARS)
   * 的 thinking 保留尾部结论行 + 截断标记,原文写冷存储并附 [r{seq}] 供 ContextRecall。
   * 但超阈值 thinking 已在 push 进 messages 前「写前定型」(见回合落盘处),故该兜底对
   * 新产生的 thinking 恒为 keep(幂等),不会制造「原始 → 精简」二次字节形态。
   *
   * 原「按条数窗口折叠旧 thinking」(rank 规则)已移除此路径:条数规则要求「预知该块
   * 终将跌出窗口」,只能在块**已发送后**回头改写历史中部消息 → 该消息之后的全部前缀
   * 断裂(实测 C 类断裂主因)。条数增长的自然回收点是压缩:旧 thinking 随 head 一起
   * 离开窗口,并由 compressThinkingSources 归并进 `[thinking]` 脉络块。
   */
  private trimConsumedThinking(): void {
    try {
      const targets = findConsumedThinking(this.messages);
      if (targets.length === 0) return;
      for (const { index, blockIndex } of targets) {
        const msg = this.messages[index];
        if (msg.role !== "assistant") continue;
        const block = msg.content[blockIndex];
        if (block.type !== "thinking") continue;
        const original = block.thinking;
        // rank 恒 0:只走长度规则(幂等兜底),不再按条数窗口折叠(折叠=改写已发送中部)。
        const plan = planThinkingTrim(original, 0);
        if (plan.action === "trim" && plan.trimmed !== undefined) {
          const seq = this.archiveCut([buildThinkingArchiveChunk(original)]);
          block.thinking = seq !== undefined ? withRecallMarker(plan.trimmed, seq) : plan.trimmed;
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
          const seq = this.archiveCut([buildToolResultArchiveChunk(text)]);
          if (plan.action === "summarize") {
            const summary = await this.summarizeMessages(text, 400, TOOL_RESULT_SUMMARIZE_PROMPT);
            const body =
              seq !== undefined
                ? withToolResultRecallMarker(summary, seq)
                : summary;
            block.content = [{ type: "text", text: `${SUMMARIZED_MARKER}\n${body}` }];
          } else if (plan.trimmed !== undefined) {
            const body =
              seq !== undefined
                ? withToolResultRecallMarker(plan.trimmed, seq)
                : plan.trimmed;
            block.content = [{ type: "text", text: `${TRIMMED_MARKER}\n${body}` }];
          }
        }
      }
    } catch {
      // 精简失败不阻塞主循环;下次发送前会重试
    }
  }

  /** 裁剪切点原文入冷存储;返回分配的 seq(无 store / 失败 → undefined)。 */
  private archiveCut(chunks: Array<Omit<ColdChunk, "seq">>): number | undefined {
    const store = this.deps.contextStore;
    if (!store || chunks.length === 0) return undefined;
    try {
      const withSeq = chunks.map((c) => ({ ...c, seq: undefined as unknown as number }));
      const seqs = store.append(this.deps.sessionId ?? "default", withSeq);
      return seqs[0];
    } catch {
      return undefined;
    }
  }

  async send(
    userText: string,
    onEvent: (ev: AgentLoopEvent) => void,
    opts?: { rawText?: string; images?: SdkImagePayload[]; mode?: AgentMode },
  ): Promise<void> {
    const { tools, permissions, workspaceRoot, systemPrompt } = this.deps;
    const provider = this.effectiveProvider;
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
    // 轮次档案:一次 send = 一个「大任务」,从入口开始计时;收尾在 finally 落一条。
    this.turnStats.begin(this.deps.sessionId ?? "default", (opts?.rawText ?? userText).length, Date.now());
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
    let maxTokensContinueCount = 0;

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
            // 处理侧关:即使模型产出了 thinking,也不进入压缩流程(剥离丢弃)
            this.contextManager.setThinkingEnabled?.(
              this.deps.thinkingProcessEnabled !== false &&
                thinkingEnabledForMode(mode),
            );
            const compacted = await this.contextManager.compact(this.messages);
            this.messages = sanitizeOutbound(provider.capabilities, compacted);
            this.persistNow(); // compact 后立刻同步持久化,避免「JSONL 全量、内存已摘要」分叉
            // A5:压缩质量抽查(自动压缩且配置了回调时才触发;手动 compactNow 不掺入)
            if (this.deps.onCompactionQa && this.lastCompaction) {
              void this.runCompactionQa(this.lastCompaction);
            }
            onEvent({ type: "info", text: "已压缩上下文" });
            this.turnStats.recordCompaction();
          } catch {
            // 注入的 ContextManager 摘要失败时不阻断主循环:保持原消息继续
            onEvent({ type: "info", text: "上下文压缩失败,继续原对话" });
          }
        }
        // 交互式追加:busy 期间用户追加的新消息,每轮开始前注入消息尾部。
        // 只 push 不改写既有消息 → 前缀字节稳定;追加作为新的一轮(user_message 事件)
        // 由 chatController 关闭当前 assistant 时间线并新开 user/assistant 框。
        if (this.pendingAppends.length > 0) {
          const appends = this.pendingAppends.splice(0);
          this.turnStats.recordAppend(appends.length);
          for (const text of appends) {
            this.messages.push({ role: "user", content: text });
            this.record({ kind: "user", text, timestamp: Date.now() });
            onEvent({ type: "user_message", text });
          }
        }
        const forward: (ev: ProviderStreamEvent) => void = (ev) => {
          if (ev.type === "text_delta") {
            onEvent({ type: "text_delta", text: ev.text });
          } else onEvent({ type: "thinking_delta", text: ev.text });
        };

        let result;
        let roundStart = 0;
        let roundMaxTokens = 8192;
        let roundParallel: { mode: "read_safe" | "serial"; maxParallelTools: number } = {
          mode: "read_safe",
          maxParallelTools: 8,
        };
        try {
          // tail 内已消费 toolResult / toolUse / thinking 精简:在 prepareRound / 打点之前,让打点反映真实发送
          this.trimConsumedToolUses();
          this.trimConsumedThinking();
          await this.trimConsumedToolResults();
          // 任务锚注入(清单 + 地图 + 模式说明 + 回查提示):并入尾部 user / tool_result 之后。
          // 三类内容互相独立,任一非空即注入(T1 地图已移出压缩块、T2 模式说明已移出 system,
          // 尾部锚是它们唯一的投递通道):
          //  - 清单:仅未完成项(全完成不注入,避免模型反复 TodoWrite);
          //  - 会话目标:压缩块需求轨**最新一条**(= 当前任务),单行投递,保证每轮可见(含工具轮);
          //  - 模式说明:自 T2 起不再挂 system 后缀(system 字节变化会让 tools + 全部 messages 前缀 miss)。
          // 全空不注入,避免无意义尾部膨胀;清单最新状态由 TodoWrite 的 tool_result(尾部)传播——
          // 绝不进 system(todo / mode 等动态内容都会打断前缀)。
          const todoBlock = this.todo.hasPending() ? this.todo.toPromptBlock() : "";
          // 单行会话目标(兜底可选调用:注入式 ContextManager 测试替身可能没有该方法)。
          const goalLine = this.contextManager.getResidentGoal?.() ?? "";
          // 真实未完成待办(done=false)→ 锚的「下一步」段;历史需求不再冒充待办。
          const pendingTodos = this.todo.list().filter((i) => !i.done).map((i) => i.content);
          const requestMessages =
            todoBlock.length > 0 || goalLine.length > 0 || modeSeg.length > 0
              ? injectTodoIntoMessages(this.messages, todoBlock, {
                  anchorOnToolResult: this.deps.todoAnchorOnToolResult !== false,
                  goalLine,
                  pendingTodos,
                  modeNote: modeSeg,
                })
              : this.messages;
          // T2:system 恒等于 systemPrompt 字节(不挂 mode 段)→ 切模式不再让 tools + messages 前缀全断。
          const roundSystem = systemPrompt;
          const prepared = prepareRound({
            caps: provider.capabilities,
            messages: requestMessages,
            lastInputTokens: this.contextManager.getLastInputTokens?.() ?? 0,
            windowTokensOverride: this.deps.windowTokensOverride,
          });
          roundMaxTokens = prepared.maxTokens;
          roundParallel = {
            mode: prepared.toolParallelMode,
            maxParallelTools: prepared.maxParallelTools,
          };
          // 每轮通告核心 + MCP 工具定义(T2:**恒为全量**,不按模式过滤 —— tools JSON 变化会让
          // system 之后的整段前缀 miss)。模式限制改由尾部锚说明 + 执行层 isToolAllowed 硬拒兜底。
          // 传原始 messages + lastInputTokens:Fallback 会按子 client caps 重 prepare;直连 client 入口再 sanitize。
          const lastInputTokens = this.contextManager.getLastInputTokens?.() ?? 0;
          // 发送前打点:记录这一包消息的 token 组成(只记数字不记内容),供历史占比统计
          roundStart = Date.now();
          this.deps.onProviderSend?.(estimateProviderSendTokens(roundSystem, requestMessages));
          result = await provider.round(requestMessages, {
            system: roundSystem,
            tools: tools.allToolDefs(),
            signal,
            maxTokens: prepared.maxTokens,
            lastInputTokens,
            ...(prepared.thinkingBudgetTokens !== undefined
              ? { thinkingBudgetTokens: prepared.thinkingBudgetTokens }
              : {}),
            // 本轮预算装不下思考时明确禁用(否则 client 会用能力默认预算发出违规组合)
            ...(prepared.thinkingDisabled === true ? { thinkingDisabled: true } : {}),
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
          this.turnStats.recordChatRound({
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            ...(result.usage.cacheReadTokens !== undefined ? { cacheReadTokens: result.usage.cacheReadTokens } : {}),
            ...(result.usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: result.usage.cacheWriteTokens } : {}),
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
        // 处理侧关闭(thinkingProcessEnabled=false)时:即使模型侧仍产 thinking(请求带预算),
        // 产出的 thinking 也剥离丢弃——「模型先思考再回答,但流程不处理 thinking」。
        // 剥离点选在 push 前,保证历史/压缩/脉络永不出现 thinking。
        const persistBlocks =
          this.deps.thinkingProcessEnabled === false
            ? assistantBlocks.filter((b) => b.type !== "thinking")
            : assistantBlocks;
        // P3 写前定型:trim 类 tool_use 瞬时参数与超阈值 thinking 在首次进入 messages 前
        // 就定成最终形态(与 P1 tool_result 写前定型同理念),使该块自首次进入前缀起字节恒定;
        // 发送前 trimConsumedToolUses/trimConsumedThinking 只做幂等兜底(已定型块不再二次改写),
        // 根治「消费后中部改写 → 前缀断裂」。工具执行用 toolUses(独立对象),不受定型影响。
        for (const b of persistBlocks) {
          if (b.type === "tool_use") {
            // 锚点档(StrReplace.old_string)不可重建(替换后盘上无副本),写前不定型 ——
            // 原文先进入历史,模型下一轮才能看到真实锚点;待其跌出近期窗口后,
            // 再由 trimConsumedToolUses 精简为预览 + [r{seq}]。
            const plan = planToolUseTrim(b.name, b.input, { skipAnchorFields: true });
            if (plan.action === "trim" && plan.trimmedInput !== undefined) {
              b.input = plan.trimmedInput as Record<string, unknown>;
            }
          } else if (b.type === "thinking") {
            const plan = planThinkingTrim(b.thinking, 0);
            if (plan.action === "trim" && plan.trimmed !== undefined) {
              b.thinking = plan.trimmed;
            }
          }
        }
        // 仅 thinking 且处理侧关闭时 persistBlocks 为空:可走续轮占位,否则勿写 content:[](后续发送触发 API 400)
        const completeToolUseCount = toolUses.length;
        const shouldContinue = needsMaxTokensContinue({
          stopReason: result.stopReason,
          outputTokens: result.usage?.outputTokens,
          maxTokens: roundMaxTokens,
          completeToolUseCount,
        });

        if (persistBlocks.length === 0 && !shouldContinue) {
          terminal = { type: "done" };
          return;
        }

        const assistantContent =
          persistBlocks.length > 0
            ? persistBlocks
            : [{ type: "text" as const, text: kMaxTokensInterruptedAssistantText }];
        this.messages.push({ role: "assistant", content: assistantContent });

        if (completeToolUseCount === 0) {
          if (shouldContinue) {
            if (maxTokensContinueCount >= kMaxTokensContinueLimit) {
              terminal = { type: "error", message: "连续输出超限次数过多" };
              return;
            }
            maxTokensContinueCount += 1;
            this.messages.push({ role: "user", content: kMaxTokensContinueUserText });
            // 不 record / 不 user_message:续写不对 UI 发假用户气泡
            onEvent({ type: "info", text: kMaxTokensContinueInfoText });
            continue;
          }
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
          // P1 写前定型:把 trim 类工具结果在写入 messages 之前就定成最终形态,
          // 使该块自首次进入前缀起字节恒定(tool_use + tool_result 后续轮不再二次变化),
          // 避免「原始 → 精简」两次形态导致的缓存前缀断裂。summarize 类需异步 LLM,
          // 保留原文,由发送前的 trimConsumedToolResults 兜底汇总。
          for (let i = 0; i < toolResultBlocks.length; i++) {
            const block = toolResultBlocks[i];
            if (!block) continue;
            const text = toolResultText(block.content);
            const trimPlan = planToolResultTrim(toolUses[i]?.name ?? "", text);
            if (trimPlan.action === "trim" && trimPlan.trimmed !== undefined) {
              const seq = this.archiveCut([buildToolResultArchiveChunk(text)]);
              const body =
                seq !== undefined
                  ? withToolResultRecallMarker(trimPlan.trimmed, seq)
                  : trimPlan.trimmed;
              block.content = [{ type: "text", text: `${TRIMMED_MARKER}\n${body}` }];
            }
          }
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
      // 轮次档案:一次「大任务」的完整计数在此一次性落盘(纯旁路,失败不影响主流程)。
      // endReason 区分 done/error/aborted/maxRounds —— 触顶与取消是「卡住」的两个主因,必须可分辨。
      try {
        const endReason: TurnEndReason = signal.aborted
          ? "aborted"
          : terminal?.type === "done"
            ? "done"
            : terminal?.type === "error"
              ? /Exceeded max tool rounds/.test(terminal.message)
                ? "maxRounds"
                : "error"
              : "aborted";
        this.deps.onTurnSummary?.(this.turnStats.finish(endReason, Date.now()));
      } catch {
        // fail-open:统计失败绝不影响收尾。
      }
      // 任意终态下 this.messages 都是合法快照(done 保留终态;error/abort 已 rollback 到 preSend),
      // 在此保存即「以最后一次稳定状态为准」。必须放在 if (terminal) 之外,abort 也要落盘。
      this.persistNow();
      // 冷存储异步队列:回合结束冲刷,保证 ContextRecall 可读到本轮裁剪切点原文
      try {
        await this.deps.contextStore?.flush(this.deps.sessionId ?? "default");
      } catch {
        // fail-open
      }
      // Stop:每次运行结束(done/error/取消)时触发,fire-and-forget 不延迟收尾事件
      void fireHook(this.hooks, "Stop", "", {});
    }
  }

  cancel(): void {
    // 停止时丢弃排队追加:用户主动取消,不应在下次发送时自动补发
    this.pendingAppends.length = 0;
    this.abortController?.abort();
  }

  /**
   * 交互式追加:busy 期间调用,把新消息排入队列,下一轮发送前注入消息尾部。
   * 只 push 不改写既有消息 → 符合缓存前缀稳定性(变化只在消息尾部)。
   * 空闲时调用方应直接走 send(),本方法仅排入队列。
   */
  append(text: string): void {
    const trimmed = text.trim();
    if (trimmed) this.pendingAppends.push(trimmed);
  }

  /** 取走尚未注入的追加(send 结束后兜底自动重发用;已停止时队列为空)。 */
  takePendingAppends(): string[] {
    if (this.pendingAppends.length === 0) return [];
    return this.pendingAppends.splice(0);
  }
}
