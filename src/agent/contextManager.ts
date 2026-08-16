import type { ProviderMessage, ProviderUserContent } from "./provider/types";
import { estimateMessageTokens, estimateTokens } from "../stats/providerSendStats";
import {
  classifyAssistantText,
  summarizeToolUse,
  extractKeyLines,
  buildCompactedBlock,
  isCompactedBlock,
  parseCompactedBlock,
  mergeCompactedTracks,
  estimateBlockChars,
  collapseTailExplanations,
  truncateParts,
  THINKING_COMPACTION_RULES,
  buildThinkingBlock,
  isThinkingBlock,
  parseThinkingBlock,
  mergeThinkingBlocks,
  estimateThinkingChars,
  trimThinkingBlock,
  assertNoSeqOverlap,
  assertUniqueSeqLines,
  type CompactBlockParts,
  type ThinkingBlockParts,
} from "./contextCompactor";
import { ContextStore, makeSummary, type ColdChunk } from "../context/contextStore";
import type { CompactionRecord, CompactionReason } from "../stats/compactionEvents";

/**
 * 消息是否是"携带 tool_result 的 user 消息"。tool_result 的 tool_use 一定在前一条
 * assistant 消息里;若把这样的消息放在摘要尾部开头,其 tool_use 已被摘要进 head,
 * Anthropic 兼容 API 会因 tool_use_id 无对应 tool_use 而 400。
 */
function isToolResultUserMessage(msg: ProviderMessage): boolean {
  if (msg.role !== "user") return false;
  if (typeof msg.content === "string") return false;
  return msg.content.some((b) => b.type === "tool_result");
}

function isCompactedMessage(msg: ProviderMessage): boolean {
  return msg.role === "user" && typeof msg.content === "string" && isCompactedBlock(msg.content);
}

/** thinking 块消息:独立 user 消息,内容以 [thinking] 标记开头(位于压缩块之后)。 */
function isThinkingMessage(msg: ProviderMessage): boolean {
  return msg.role === "user" && typeof msg.content === "string" && isThinkingBlock(msg.content);
}

/** 旧格式(整段 100:1 摘要)的"前文摘要" user 消息,信息价值高,归入结论轨保留 */
function isLegacySummaryMessage(msg: ProviderMessage): boolean {
  return msg.role === "user" && typeof msg.content === "string" && msg.content.startsWith("[前文摘要]");
}

function toolResultText(content: ProviderUserContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "tool_result")
    .map((b) => {
      if (typeof b.content === "string") return b.content;
      return b.content.map((t) => t.text).join("\n");
    })
    .join("\n");
}

/** 从压缩块行 `- [r{n}] ...` 提取序号;无匹配返回 0。 */
function rSeq(line: string): number {
  const m = line.match(/\[r(\d+)\]/);
  return m ? Number(m[1]) : 0;
}

/** 一条待压缩的 thinking 原文及其配对上下文。 */
interface ThinkingSource {
  seq: number;
  thinking: string;
  context: string[];
}

export interface ContextManagerOptions {
  windowTokens: number;
  triggerRatio: number;
  /** 摘要函数:接收纯文本(仅解释轨),返回摘要文本;rules 可选注入(thinking 压缩规则) */
  summarize: (text: string, opts: { maxTokens: number; rules?: string }) => Promise<string>;
  /** 可选冷存储:传入后压缩过程写入原文,ContextRecall 可回查 */
  contextStore?: ContextStore;
  /** 冷存储按会话隔离;缺省 "default" */
  sessionId?: string;
  /** 解释轨摘要预算 */
  maxCompactTextTokens?: number;
  /** 压缩时保留的尾部消息条数 */
  keepTail?: number;
  /** 压缩块最大字符数;超限时对最旧解释段再摘要、其次截断超长行 */
  maxBlockChars?: number;
  /** 压缩块硬上限:默认 maxBlockChars * 4;超过硬上限才截断超长行 */
  maxBlockCharsHard?: number;
  /** thinking 压缩开关;缺省 true。false 时 thinking 剥离丢弃(等价现状) */
  thinkingEnabled?: boolean;
  /** thinking 块滚动收缩触发阈值(字符);缺省 6000(≈3000 tokens) */
  thinkingMaxChars?: number;
  /** thinking 块滚动收缩目标(字符);缺省 4000(≈2000 tokens) */
  thinkingTrimChars?: number;
  /** 单次压缩 thinking 增量总预算(tokens);缺省 3500 */
  thinkingBudgetTokens?: number;
  /** thinking 压缩发生时的回调(成功或失败均触发,用于成本统计);缺省不回调。 */
  onThinkingCompaction?: () => void;
  /** 历史信息 token 总预算;0/缺省 = 关闭(现状:固定 tail 4 条 + 压缩块 8K 字符自适应)。 */
  historyTokenBudget?: number;
  /** 预算三块比例(压缩块/thinking/tail);缺省 45/20/35;调用方负责归一化。 */
  budgetSplit?: { compacted: number; thinking: number; tail: number };
  /** 触发比例:每块 token ≥ 额定×该比例 → 触发压缩(流水线主触发);缺省 0.75。 */
  triggerPct?: number;
  /** 压缩后目标比例:触发后收缩到额定×该比例(滞回);缺省 0.5,须 < triggerPct。 */
  targetPct?: number;
  /**
   * tail 分级折叠比例(方向 2):tail 预算内保留的近期消息中,较旧的该比例也折叠进压缩块
   * (走 stratify 摘要,追加到各轨末尾——P2 只追加兼容),只保留最近 (1-ratio) 比例原样。
   * 目的:压缩后首轮 tail 全 miss(结构性成本)的 miss 字节从「全量 tail」降到「近期保留 + 折叠增量」。
   * undefined / 0 = 关闭(现状:tail 预算内全部原样保留)。须 < 1。
   */
  tailFoldRatio?: number;
  /** 压缩事件上报(4 个压缩位置 before/after tokens);缺省不回调。 */
  onCompaction?: (ev: CompactionRecord) => void;
  /**
   * 预置压缩块快照(方向 3):会话恢复时 apiHistory 缺失回退(eventsToHistory)场景下,
   * 把上次持久化的压缩块原文注入 → compact() 时 prev 优先取它,输出块 = 快照旧行 + 本次增量,
   * 旧块字节与上次发送一致 → 首轮可命中,避免「块全新生成」的最坏情况(命中率最低 7.6%)。
   * 仅当 head[0] 无实际压缩块时生效;缺省不注入。
   */
  presetCompactedBlock?: string;
}

/** A5:从消息列表内容中提取 `[r{n}]` 序号(保持出现顺序)。 */
function extractSeqsFromMessages(messages: ProviderMessage[]): number[] {
  const out: number[] = [];
  for (const msg of messages) {
    const content = msg.content;
    if (typeof content !== "string") continue;
    const re = /\[r(\d+)\]/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(content)) !== null) {
      out.push(Number(mm[1]));
    }
  }
  return out;
}

/** A7:压缩流程 LLM 调用用途标签。 */
export type SummarizeTag = "resummarize" | "oversize" | "explanation" | "thinking";

export class ContextManager {
  private lastInput = 0;
  private lastOutput = 0;
  /** 块行/冷存储共用的单调 seq;增量压缩时继续推进,避免新旧块 [r{n}] 碰撞。 */
  private nextSeq = 1;
  /** thinking 压缩开关(可热更新;plan/ask 模式关闭)。 */
  private thinkingEnabled: boolean;
  /** thinking 压缩发生时的回调(成功或失败均触发,用于成本统计);缺省不回调。 */
  onThinkingCompaction?: () => void;

  constructor(private readonly opts: ContextManagerOptions) {
    this.thinkingEnabled = opts.thinkingEnabled ?? true;
    this.onThinkingCompaction = opts.onThinkingCompaction;
  }

  /** 当前压缩流程开始时间(epoch ms);每次 compact 入口重置,emitCompaction 用其计算耗时。 */
  private compactStartedAt = 0;
  /** 本次压缩流程的 LLM 调用次数(summarize 包装器累加;压缩自身成本统计)。 */
  private flowLLMCalls = 0;
  /** 本次压缩流程 LLM 调用总耗时(ms)。 */
  private flowLLMMs = 0;
  /** 本次压缩流程 LLM 调用输入 token 总量(压缩自身消耗)。 */
  private flowSelfInputTokens = 0;
  /** 本次压缩流程 LLM 调用输出 token 总量。 */
  private flowSelfOutputTokens = 0;
  /** A7:按 LLM 用途细分的流程累计(4 类)。 */
  private flowLLMDetail: Record<SummarizeTag, { calls: number; ms: number; inTokens: number; outTokens: number }> = {
    resummarize: { calls: 0, ms: 0, inTokens: 0, outTokens: 0 },
    oversize: { calls: 0, ms: 0, inTokens: 0, outTokens: 0 },
    explanation: { calls: 0, ms: 0, inTokens: 0, outTokens: 0 },
    thinking: { calls: 0, ms: 0, inTokens: 0, outTokens: 0 },
  };

  /** A7:位置耗时打点——上一次 emit 时刻;首个 emit 以 compact 入口为起点。 */
  private lastEmitAt = 0;
  /** A7:上一次 emit 时各 tag 的 calls 快照,用于判定该位置是否调用了 LLM。 */
  private lastLLMDetailCalls: Record<SummarizeTag, number> = {
    resummarize: 0,
    oversize: 0,
    explanation: 0,
    thinking: 0,
  };


  /** 热更新上下文窗;后续 ratio / needsCompaction 使用新窗重算。 */
  setWindowTokens(n: number): void {
    this.opts.windowTokens = n;
  }

  /** 热更新 thinking 压缩开关(plan/ask 模式关闭);影响后续 compact。 */
  setThinkingEnabled(enabled: boolean): void {
    this.thinkingEnabled = enabled;
  }

  track(usage?: { inputTokens?: number; outputTokens?: number }): number {
    if (usage) {
      this.lastInput = usage.inputTokens ?? 0;
      this.lastOutput = usage.outputTokens ?? 0;
    }
    return this.ratio;
  }

  get ratio(): number {
    return this.windowTokens <= 0 ? 0 : Math.min(1, this.lastInput / this.windowTokens);
  }

  /** 上一轮记录的 input tokens;供 CapabilityGate 动态预算。 */
  getLastInputTokens(): number {
    return this.lastInput;
  }

  private get windowTokens(): number {
    return this.opts.windowTokens;
  }

  needsCompaction(messages?: ProviderMessage[]): boolean {
    // 安全阀 1(窗口兜底):整个上下文占用 ≥ 窗口×triggerRatio 仍触发压缩。
    if (this.ratio >= this.opts.triggerRatio) return true;
    // 流水线主触发(tail 自驱动):tail token ≥ tail额定×triggerPct。
    if (messages) {
      const budget = this.budgetInfo();
      if (budget && budget.tailTokens > 0) {
        const tailToken = this.tailMessages(messages).reduce((acc, m) => acc + estimateMessageTokens(m), 0);
        if (tailToken >= Math.floor(budget.tailTokens * this.triggerPct)) return true;
      }
    }
    return false;
  }

  /** 消息数组中的 tail:跳过头部压缩块 / thinking 块后剩余的连续原样消息。 */
  private tailMessages(messages: ProviderMessage[]): ProviderMessage[] {
    let start = 0;
    if (messages.length > 0 && isCompactedMessage(messages[0])) start = 1;
    if (start < messages.length && isThinkingMessage(messages[start])) start++;
    return messages.slice(start);
  }

  private get triggerPct(): number {
    const v = this.opts.triggerPct ?? 0.75;
    return v > 0 && v <= 1 ? v : 0.75;
  }

  private get targetPct(): number {
    const v = this.opts.targetPct ?? 0.5;
    return v > 0 && v < 1 && v < this.triggerPct ? v : 0.5;
  }

  private get sessionId(): string {
    return this.opts.sessionId ?? "default";
  }

  async compact(history: ProviderMessage[]): Promise<ProviderMessage[]> {
    const startedAt = Date.now();
    this.compactStartedAt = startedAt;
    // 重置本次压缩流程的 LLM 调用统计(summarize 包装器会累加)
    this.flowLLMCalls = 0;
    this.flowLLMMs = 0;
    this.flowLLMDetail = {
      resummarize: { calls: 0, ms: 0, inTokens: 0, outTokens: 0 },
      oversize: { calls: 0, ms: 0, inTokens: 0, outTokens: 0 },
      explanation: { calls: 0, ms: 0, inTokens: 0, outTokens: 0 },
      thinking: { calls: 0, ms: 0, inTokens: 0, outTokens: 0 },
    };
    this.flowSelfInputTokens = 0;
    this.flowSelfOutputTokens = 0;
    this.lastEmitAt = startedAt;
    this.lastLLMDetailCalls = { resummarize: 0, oversize: 0, explanation: 0, thinking: 0 };
    const budget = this.budgetInfo();
    if (!budget && history.length <= 4) return history;
    // 触发原因:窗口兜底(安全阀)优先,其次 tail 自驱动;手动调用为 manual。
    const reason = this.compactionReason(history);
    const budgetSnapshot = budget
      ? {
          total: this.opts.historyTokenBudget ?? 0,
          compacted: budget.compactedTokens,
          thinking: budget.thinkingTokens,
          tail: budget.tailTokens,
        }
      : undefined;
    // 朴素边界保留最近 keepTail 条;预算开启时按 tail 预算累加估算 token 确定条数。
    // 但若该边界把尾部第一跳设为孤儿 tool_result
    // (其 tool_use 在 head 里被摘要掉,API 会 400),就向前扫描到不拆散
    // tool_use/tool_result 对的干净起点。
    const keepTail = budget
      ? this.tailKeepCount(history, Math.max(1, Math.floor(budget.tailTokens * this.targetPct)))
      : (this.opts.keepTail ?? 4);
    let cut = history.length - keepTail;
    while (cut > 0 && isToolResultUserMessage(history[cut])) {
      cut--;
    }
    // —— 方向 2:tail 分级折叠 ——
    // tail 预算内保留的近期消息中,较旧的 tailFoldRatio 比例也折叠进压缩块
    // (并入 head → stratify 摘要追加到各轨末尾,遵循 P2 只追加规则),
    // 只保留最近 (1-tailFoldRatio) 比例原样 → 压缩后首轮 tail miss 从全量降到
    // 「近期保留 + 折叠增量」。折叠边界不拆 tool_use/tool_result 对。
    if (
      budget &&
      this.opts.tailFoldRatio !== undefined &&
      this.opts.tailFoldRatio > 0 &&
      this.opts.tailFoldRatio < 1 &&
      cut > 0
    ) {
      const tailBudget = Math.max(1, Math.floor(budget.tailTokens * this.targetPct));
      const recentTokens = Math.max(1, Math.floor(tailBudget * (1 - this.opts.tailFoldRatio)));
      const keepRecent = this.tailKeepCount(history, recentTokens);
      let foldEnd = history.length - keepRecent;
      // 保留段首条若是 tool_result,其 tool_use 已在折叠段 → 前移 foldEnd 把它也折叠,
      // 避免压缩后 tool_result 无配对 tool_use(API 400)。
      while (foldEnd > cut && isToolResultUserMessage(history[foldEnd])) {
        foldEnd--;
      }
      if (foldEnd > cut) {
        cut = foldEnd; // 折叠段 [原 cut, foldEnd) 并入 head
      }
    }
    // 预算模式:全部消息都在 tail 预算内 → 无需压缩,原样返回
    if (budget && cut === 0) {
      return history;
    }
    const head = history.slice(0, cut);
    const tail = history.slice(cut);

    // 增量检测:head[0] 是既有压缩块 → 旧块原样保留,只处理新增段;
    // head[1] 可能是既有 thinking 块(独立消息)→ 解析旧脉络,增量合并。
    // 从旧块行推断已用最大序号,让新段 seq 继续推进(旧块可能是外部构造/上次压缩产物,
    // 实例计数器无法自行感知其占用)。
    // head[0] 是既有压缩块 → 用实际块(freshStart=1,块本身不参与增量);
    // 否则若注入 preset 快照(会话重建回退场景)→ 用快照作旧脉络(freshStart=0,全部消息
    // 视为新增,输出块 = 快照旧行 + 本次增量 → 旧块字节与上次发送一致,首轮可命中)。
    const hasBlock = isCompactedMessage(head[0]);
    const prev = hasBlock
      ? parseCompactedBlock((head[0] as { role: "user"; content: string }).content)
      : this.opts.presetCompactedBlock
        ? parseCompactedBlock(this.opts.presetCompactedBlock)
        : null;
    let prevThinking: ThinkingBlockParts = { correct: [], wrong: [], neutral: [] };
    let freshStart = hasBlock ? 1 : 0;
    if (freshStart < head.length && isThinkingMessage(head[freshStart])) {
      prevThinking = parseThinkingBlock((head[freshStart] as { role: "user"; content: string }).content);
      freshStart++;
    }
    if (prev) {
      const prevLines = [
        ...prev.demands,
        ...prev.conclusions,
        ...prev.explanations,
        ...prev.ledger,
        ...prevThinking.correct,
        ...prevThinking.wrong,
        ...prevThinking.neutral,
      ];
      const maxUsed = Math.max(...prevLines.map(rSeq), 0);
      if (maxUsed + 1 > this.nextSeq) this.nextSeq = maxUsed + 1;
    }
    const fresh = head.slice(freshStart);

    const collectThinking = this.thinkingEnabled;
    const { parts, thinkingSources } = await this.stratify(fresh, collectThinking);

    // 增量合并前置断言:新段 seq 必须与旧块 seq 无重叠(重叠 → 序号推进 bug,合并会造成
    // 模型看到两条同 [r{n}] 的不同内容)。断言失败由 agentLoop 的 compact fail-open 兜底。
    if (prev) {
      const prevTrackLines = [...prev.demands, ...prev.conclusions, ...prev.explanations, ...prev.ledger];
      const freshTrackLines = [...parts.demands, ...parts.conclusions, ...parts.explanations, ...parts.ledger];
      assertNoSeqOverlap(prevTrackLines, freshTrackLines, "轨道增量合并");
    }
    const merged = prev ? mergeCompactedTracks(prev, parts) : parts;
    const fitted = budget
      ? await this.ensureBlockFits(merged, Math.max(1, Math.floor(budget.compactedTokens * this.targetPct)))
      : await this.ensureBlockFits(merged);
    // 压缩块收缩上报:实际发生收缩(after < before)才记录
    const beforeBlockTokens = estimateTokens(buildCompactedBlock(merged));
    const afterBlockTokens = estimateTokens(buildCompactedBlock(fitted));
    if (afterBlockTokens < beforeBlockTokens) {
      this.emitCompaction({
        position: "block",
        reason,
        beforeTokens: beforeBlockTokens,
        afterTokens: afterBlockTokens,
        budget: budgetSnapshot,
      });
    }
    const block = buildCompactedBlock(fitted);

    // thinking 独立管道:enabled 时压缩新增 thinking(失败兜底占位行),与旧脉络合并后滚动收缩。
    let newThinking: ThinkingBlockParts = { correct: [], wrong: [], neutral: [] };
    if (collectThinking && thinkingSources.length > 0) {
      // 无论成功/失败,thinking 压缩都产生一次 LLM 调用成本,先上报再执行(fail-open)
      this.onThinkingCompaction?.();
      try {
        newThinking = await this.compressThinkingSources(thinkingSources);
      } catch {
        // thinking 摘要失败不影响常规压缩(fail-open):占位行,冷存储原文仍已写入
        newThinking = {
          correct: [],
          wrong: [],
          neutral: thinkingSources.map((s) => `- [r${s.seq}] 推理:(原文已省略)`),
        };
      }
      // 脉络行回写冷存储 summary(压缩成功后;失败时写占位行,只影响脉络不丢原文)
      this.backfillThinkingSummaries(thinkingSources, newThinking);
      // thinking 压缩上报:无论成功/失败都产生压缩成本,记录原文 → 脉络的 token 变化
      const beforeThinkingTokens = thinkingSources.reduce((acc, s) => acc + estimateTokens(s.thinking), 0);
      const afterThinkingTokens = estimateTokens(buildThinkingBlock(newThinking));
      this.emitCompaction({
        position: "thinking",
        reason,
        beforeTokens: beforeThinkingTokens,
        afterTokens: afterThinkingTokens,
        budget: budgetSnapshot,
      });
    }
    // thinking 增量合并断言:新旧 thinking 脉络行 seq 不得重叠
    assertNoSeqOverlap(
      [...prevThinking.correct, ...prevThinking.wrong, ...prevThinking.neutral],
      [...newThinking.correct, ...newThinking.wrong, ...newThinking.neutral],
      "thinking 增量合并",
    );
    const mergedThinking = collectThinking
      ? mergeThinkingBlocks(prevThinking, newThinking)
      : { correct: [], wrong: [], neutral: [] };
    const fittedThinking = budget
      ? this.ensureThinkingFits(mergedThinking, Math.max(1, Math.floor(budget.thinkingTokens * this.targetPct)))
      : this.ensureThinkingFits(mergedThinking);
    // thinking 块滚动收缩上报:实际发生收缩才记录
    const beforeThinkingBlockTokens = estimateTokens(buildThinkingBlock(mergedThinking));
    const afterThinkingBlockTokens = estimateTokens(buildThinkingBlock(fittedThinking));
    if (afterThinkingBlockTokens < beforeThinkingBlockTokens) {
      this.emitCompaction({
        position: "thinking_block",
        reason,
        beforeTokens: beforeThinkingBlockTokens,
        afterTokens: afterThinkingBlockTokens,
        budget: budgetSnapshot,
      });
    }
    const thinkingMsg: ProviderMessage[] =
      fittedThinking.correct.length + fittedThinking.wrong.length + fittedThinking.neutral.length > 0
        ? [{ role: "user", content: buildThinkingBlock(fittedThinking) }]
        : [];

    // tail 压缩上报:head 原文(head tokens) → 压缩块 + thinking 块(压缩后 tokens);
    // head 为空(全孤儿 tool_result 等极端情况)视为无实际压缩,不上报。
    if (head.length > 0) {
      const beforeTailTokens = head.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
      const afterTailTokens =
        estimateTokens(block) + thinkingMsg.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
      this.emitCompaction({
        position: "tail",
        reason,
        beforeTokens: beforeTailTokens,
        afterTokens: afterTailTokens,
        budget: budgetSnapshot,
        headCount: head.length,
        tailCount: tail.length,
        // A5:被压缩掉的原始消息 [r{n}] 序号(供 QA 抽查;最多前 8 个)
        compactedSeqs: extractSeqsFromMessages(head).slice(0, 8),
      });
    }

    return [{ role: "user", content: block }, ...thinkingMsg, ...tail];
  }

  /**
   * 压缩块收缩(自适应上限):默认目标是 maxChars;内容特别多时自动放宽,
   * 避免截断损失。
   *  - 先对最旧解释段再摘要(低预算),正常压进 maxChars 内;
   *  - 再摘要后仍超限但未超硬上限 hardMax → 自动扩容:直接返回,不截断
   *    (宁可块大一点,也不丢需求/结论原文细节);
   *  - 超过硬上限 → 才截断超长行兜底(尽力而为)。
   * 预算模式(budgetTokens 传入):目标与硬上限都是 budgetTokens(token 口径),
   * 取消 4× 扩容;三段式收缩(再摘要 → 截断超长行 → 按 seq 最旧截断轨道行)。
   */
  private async ensureBlockFits(parts: CompactBlockParts, budgetTokens?: number): Promise<CompactBlockParts> {
    if (budgetTokens !== undefined) {
      return this.ensureBlockFitsTokens(parts, budgetTokens);
    }
    const maxChars = this.opts.maxBlockChars ?? 8000;
    const hardMax = this.opts.maxBlockCharsHard ?? maxChars * 4;
    if (estimateBlockChars(parts) <= maxChars) {
      return parts;
    }
    let current = parts;
    // 阶段 1:解释轨「尾部(该次新增)一半」再摘要 —— 只动块尾,旧稳定行不重写,前缀字节稳定。
    if (current.explanations.length > 0) {
      const { keep, tailText, tailSeq } = collapseTailExplanations(current.explanations);
      if (tailText && tailSeq > 0) {
        const budget = Math.max(100, Math.floor((this.opts.maxCompactTextTokens ?? 800) / 4));
        const summary = await this.trackedSummarize(tailText, { maxTokens: budget }, "resummarize");
        const line = `- [r${tailSeq}] 再摘要:${summary.replace(/\s+/g, " ").trim()}`;
        current = { ...current, explanations: [...keep, line] };
        if (estimateBlockChars(current) <= maxChars) {
          return current;
        }
      }
    }
    // 自适应扩容:远超默认上限但未超硬上限 → 放宽上限,避免截断损失
    const afterResummarize = estimateBlockChars(current);
    if (afterResummarize <= hardMax) {
      return current;
    }
    // 兜底:超硬上限才截断超长行
    const truncated = truncateParts(current, 240);
    if (estimateBlockChars(truncated) <= hardMax) {
      return truncated;
    }
    return truncated;
  }

  /**
   * 触发原因判定:窗口兜底(安全阀)优先;其次 tail 自驱动(tail ≥ 额定×triggerPct);
   * 其余为手动调用。needsCompaction 内部是 OR 逻辑,此处独立复判以区分原因。
   */
  private compactionReason(messages: ProviderMessage[]): CompactionReason {
    if (this.ratio >= this.opts.triggerRatio) return "window_ratio";
    const budget = this.budgetInfo();
    if (budget && budget.tailTokens > 0) {
      const tailToken = this.tailMessages(messages).reduce((acc, m) => acc + estimateMessageTokens(m), 0);
      if (tailToken >= Math.floor(budget.tailTokens * this.triggerPct)) return "tail_self_driven";
    }
    return "manual";
  }

  /** 压缩事件上报(sessionId 自动填充;缺省不回调)。 */
  /** summarize 包装器:记录本次压缩流程 LLM 调用次数/耗时/自身 token(压缩自身成本统计)。
   *  压缩自身成本是当前统计盲区,此包装器补齐;不记内容,只记数字。 */
    /** summarize 包装器:记录本次压缩流程 LLM 调用次数/耗时/自身 token(压缩自身成本统计)。
     *  压缩自身成本是当前统计盲区,此包装器补齐;不记内容,只记数字。 */
  private async trackedSummarize(
    text: string,
    opts: { maxTokens: number; rules?: string },
    tag: SummarizeTag = "explanation",
  ): Promise<string> {
    const t0 = Date.now();
    try {
      const out = await this.opts.summarize(text, opts);
      this.flowLLMCalls += 1;
      this.flowLLMMs += Date.now() - t0;
      this.flowSelfInputTokens += estimateTokens(text);
      this.flowSelfOutputTokens += estimateTokens(out);
      // A7:按用途细分累计
      const d = this.flowLLMDetail[tag];
      d.calls += 1;
      d.ms += Date.now() - t0;
      d.inTokens += estimateTokens(text);
      d.outTokens += estimateTokens(out);
      return out;
    } catch (err) {
      // 失败也计一次调用(耗时已发生),保证 llmCalls 与真实调用数一致
      this.flowLLMCalls += 1;
      this.flowLLMMs += Date.now() - t0;
      const d = this.flowLLMDetail[tag];
      d.calls += 1;
      d.ms += Date.now() - t0;
      throw err;
    }
  }

  private emitCompaction(
    ev: Omit<
      CompactionRecord,
      | "sessionId"
      | "startedAt"
      | "durationMs"
      | "llmCalls"
      | "llmMs"
      | "algoMs"
      | "selfInputTokens"
      | "selfOutputTokens"
      | "llmDetail"
      | "posMs"
      | "usedLLM"
    >,
  ): void {
    const nowMs = Date.now();
    const durationMs = nowMs - this.compactStartedAt;
    // A7:该位置耗时 = 自上一次 emit(或流程开始)以来的增量段,4 个位置加总 ≈ durationMs
    const posMs = nowMs - this.lastEmitAt;
    const tags: SummarizeTag[] = ["resummarize", "oversize", "explanation", "thinking"];
    const usedLLM = tags.some((t) => this.flowLLMDetail[t].calls - this.lastLLMDetailCalls[t] > 0);
    this.lastEmitAt = nowMs;
    for (const t of tags) this.lastLLMDetailCalls[t] = this.flowLLMDetail[t].calls;
    this.opts.onCompaction?.({
      ...ev,
      sessionId: this.sessionId,
      startedAt: this.compactStartedAt,
      durationMs,
      // 压缩流程内 LLM 调用统计(压缩自身成本;无调用时为 0/缺省)
      llmCalls: this.flowLLMCalls,
      llmMs: this.flowLLMMs,
      algoMs: Math.max(0, durationMs - this.flowLLMMs),
      selfInputTokens: this.flowSelfInputTokens,
      selfOutputTokens: this.flowSelfOutputTokens,
      // A7:按用途细分的 LLM 统计(4 类;calls=0 的类保留 0 值便于分析)
      llmDetail: {
        resummarize: { ...this.flowLLMDetail.resummarize },
        oversize: { ...this.flowLLMDetail.oversize },
        explanation: { ...this.flowLLMDetail.explanation },
        thinking: { ...this.flowLLMDetail.thinking },
      },
      posMs,
      usedLLM,
    });
  }

  /** 预算信息:总预算 × 三块比例;预算关闭(≤0)或比例非法时返回 null。 */
  private budgetInfo(): { tailTokens: number; compactedTokens: number; thinkingTokens: number } | null {
    const total = this.opts.historyTokenBudget ?? 0;
    if (total <= 0) return null;
    const split = this.opts.budgetSplit ?? { compacted: 0.45, thinking: 0.2, tail: 0.35 };
    const s = split.compacted + split.thinking + split.tail;
    if (!(s > 0)) return null;
    // thinking 独立压缩关闭时,把 thinking 份额按比例并入 compacted/tail 两段(两段归一化)。
    // 默认 {0.45,0.2,0.35} → compacted 0.5625 / tail 0.4375;自定义 split 按实际值等比缩放。
    const thinkingOn = this.thinkingEnabled;
    if (!thinkingOn) {
      const twoSum = split.compacted + split.tail;
      if (!(twoSum > 0)) return null;
      return {
        tailTokens: Math.max(1, Math.floor((total * split.tail) / twoSum)),
        compactedTokens: Math.max(1, Math.floor((total * split.compacted) / twoSum)),
        thinkingTokens: 0,
      };
    }
    return {
      tailTokens: Math.max(1, Math.floor((total * split.tail) / s)),
      compactedTokens: Math.max(1, Math.floor((total * split.compacted) / s)),
      thinkingTokens: Math.max(1, Math.floor((total * split.thinking) / s)),
    };
  }

  /**
   * tail 预算累加:从消息尾部向前累加估算 token,在预算内尽量多留最近消息;
   * 当前轮(最后一条)必留(keep 至少 1)。
   */
  private tailKeepCount(history: ProviderMessage[], tailTokens: number): number {
    let keep = 0;
    let acc = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const t = estimateMessageTokens(history[i]);
      if (keep > 0 && acc + t > tailTokens) break;
      acc += t;
      keep++;
    }
    return Math.max(1, keep);
  }

  /** 压缩块 token 估算(与 providerSendStats 同口径)。 */
  private blockTokens(parts: CompactBlockParts): number {
    return estimateTokens(buildCompactedBlock(parts));
  }

  /**
   * 预算模式压缩块收缩:目标与硬上限都是 budgetTokens(token 口径),无 4× 扩容。
   * 三段式:① 尾部解释段再摘要 → ② 截断超长行 → ③ 按 seq 尾部截断轨道行(只删尾部,稳定段前缀字节不变)。
   */
  private async ensureBlockFitsTokens(parts: CompactBlockParts, budgetTokens: number): Promise<CompactBlockParts> {
    if (this.blockTokens(parts) <= budgetTokens) return parts;
    let current = parts;
    // 阶段 1:解释轨「尾部(该次新增)一半」再摘要 —— 只动块尾,旧稳定行不重写,前缀字节稳定。
    if (current.explanations.length > 0) {
      const { keep, tailText, tailSeq } = collapseTailExplanations(current.explanations);
      if (tailText && tailSeq > 0) {
        const budget = Math.max(100, Math.floor((this.opts.maxCompactTextTokens ?? 800) / 4));
        const summary = await this.trackedSummarize(tailText, { maxTokens: budget }, "resummarize");
        const line = `- [r${tailSeq}] 再摘要:${summary.replace(/\s+/g, " ").trim()}`;
        current = { ...current, explanations: [...keep, line] };
        if (this.blockTokens(current) <= budgetTokens) return current;
      }
    }
    // 阶段 2:截断超长行
    const truncated = truncateParts(current, 240);
    if (this.blockTokens(truncated) <= budgetTokens) return truncated;
    // 阶段 3:按 seq 尾部(最新)截断轨道行(保留旧稳定段,先删尾部行)
    return this.trimTracksToBudget(truncated, budgetTokens);
  }

  /** 按 seq 最新(尾部)优先删除轨道行,直到压缩块 token ≤ 预算。只删尾部,稳定段前缀字节不变。 */
  private trimTracksToBudget(parts: CompactBlockParts, budgetTokens: number): CompactBlockParts {
    let current = parts;
    let guard = 0;
    while (this.blockTokens(current) > budgetTokens && guard < 1000) {
      guard++;
      const all: Array<{ track: keyof CompactBlockParts; line: string; seq: number }> = [];
      for (const track of ["demands", "conclusions", "explanations", "ledger"] as const) {
        for (const line of current[track]) all.push({ track, line, seq: rSeq(line) });
      }
      if (all.length === 0) break;
      all.sort((a, b) => b.seq - a.seq); // 删尾部:优先删最新 seq,稳定段(旧行)字节不变
      const victim = all[0];
      current = {
        ...current,
        [victim.track]: current[victim.track].filter((l) => l !== victim.line),
      };
    }
    return current;
  }

  /**
   * 对一段消息做分轨处理:
   *  - user 文本(需求)→ demands 轨
   *  - assistant 文本 → classifyAssistantText:结论段原样、解释段过 summarize
   *  - tool_use / tool_result → ledger 轨
   *  - thinking 块(assistant 的 thinking 块)→ 剥离,不进入任何轨;
   *    当 collectThinking 时收集原文(配上下文)供独立 thinking 块压缩,并写冷存储
   * 行标 `[r{n}]`,`n` 为实例级单调 seq(与冷存储 seq 对应)。
   */
  private async stratify(
    messages: ProviderMessage[],
    collectThinking: boolean,
  ): Promise<{ parts: CompactBlockParts; thinkingSources: ThinkingSource[] }> {
    const demands: string[] = [];
    const conclusions: string[] = [];
    const explanations: string[] = [];
    const ledger: string[] = [];
    const chunks: ColdChunk[] = [];
    const maxTokens = this.opts.maxCompactTextTokens ?? 800;

    const explanationTexts: Array<{ seq: number; text: string }> = [];
    const thinkingSources: ThinkingSource[] = [];
    // view:与 messages 等长的轻量视图,供 thinking 配对上下文(同消息 text / 该轮
    // tool_result 摘要 / 后续 1~2 轮 assistant text)。
    const view: Array<{
      seq: number;
      role: "user" | "assistant";
      text: string;
      thinking?: string;
      toolResult?: string;
    }> = [];

    const pushChunk = (chunk: Omit<ColdChunk, "seq" | "ts">, seq: number): void => {
      chunks.push({ ...chunk, seq, ts: Date.now() });
    };

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const seq = this.nextSeq++;
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          const text = msg.content.trim();
          view.push({ seq, role: "user", text });
          if (!text) continue;
          if (isLegacySummaryMessage(msg) && !isCompactedMessage(msg)) {
            conclusions.push(`- [r${seq}] ${text}`);
            pushChunk({ type: "conclusion", role: "user", summary: makeSummary("conclusion", text), content: text }, seq);
            continue;
          }
          demands.push(`- [r${seq}] ${text}`);
          pushChunk({ type: "demand", role: "user", summary: makeSummary("demand", text), content: text }, seq);
          continue;
        }
        // tool_result 消息
        const resultText = toolResultText(msg.content).trim();
        if (!resultText) continue;
        const keyLines = extractKeyLines(resultText, true);
        const oneLine = keyLines.replace(/\n/g, " | ");
        view.push({ seq, role: "user", text: "", toolResult: oneLine });
        ledger.push(`- [r${seq}] ⤷ ${oneLine}`);
        pushChunk({ type: "ledger", role: "tool", summary: makeSummary("ledger", oneLine), content: keyLines }, seq);
        continue;
      }
      // assistant
      const textParts = msg.content.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text);
      const toolUses = msg.content.filter((b) => b.type === "tool_use");
      const thinkingBlocks = msg.content.filter((b) => b.type === "thinking").map((b) => (b as { type: "thinking"; thinking: string }).thinking);
      const text = textParts.join("\n").trim();
      const thinking = thinkingBlocks.join("\n\n").trim();
      view.push({ seq, role: "assistant", text, thinking: thinking || undefined });
      if (text) {
        const { conclusion, explanation } = classifyAssistantText(text, toolUses.length > 0);
        for (const para of conclusion) {
          conclusions.push(`- [r${seq}] ${para}`);
          pushChunk({ type: "conclusion", role: "assistant", summary: makeSummary("conclusion", para), content: para }, seq);
        }
        for (const para of explanation) {
          explanationTexts.push({ seq, text: para });
        }
      }
      if (thinking && collectThinking) {
        // thinking 原文写冷存储(脉络行生成前先用原文首行做 summary;回查取 content 原文)
        pushChunk({ type: "thinking", role: "assistant", summary: makeSummary("thinking", thinking), content: thinking }, seq);
      }
      for (const tu of toolUses) {
        const line = summarizeToolUse(tu.name, tu.input);
        ledger.push(`- [r${seq}] ${line}`);
        pushChunk({ type: "ledger", role: "assistant", summary: makeSummary("ledger", line), content: line }, seq);
      }
    }

    // 解释轨:低压缩比,整段过 summarize(仅新增文本)
    if (explanationTexts.length > 0) {
      const joined = explanationTexts.map((e) => `[r${e.seq}] ${e.text}`).join("\n\n");
      const summary = await this.trackedSummarize(joined, { maxTokens }, "explanation");
      explanations.push(`- [r${explanationTexts[0].seq}] ${summary}`);
      pushChunk(
        {
          type: "explanation",
          role: "assistant",
          summary: makeSummary("explanation", summary),
          content: summary,
        },
        explanationTexts[0].seq,
      );
    }

    // thinking 配对上下文:每条 thinking 附同消息 text + 该轮 tool_result 摘要
    // + 后续 1~2 轮 assistant text(判断正确/错误/中性需要看到"后果")。
    if (collectThinking) {
      for (let i = 0; i < view.length; i++) {
        const v = view[i];
        if (!v.thinking) continue;
        const context: string[] = [];
        context.push(v.text ? `同消息文本:${v.text}` : "(无同消息文本)");
        let j = i + 1;
        while (j < view.length && !view[j].toolResult) {
          j++;
        }
        if (j < view.length) {
          context.push(`工具结果:${view[j].toolResult}`);
        }
        let k = j < view.length ? j + 1 : i + 1;
        let count = 0;
        while (k < view.length && count < 2) {
          if (view[k].role === "assistant" && view[k].text) {
            context.push(`后续结论:${view[k].text}`);
            count++;
          }
          k++;
        }
        thinkingSources.push({ seq: v.seq, thinking: v.thinking, context });
      }
    }

    // 冷存储回填(无 store 时退化,不写)
    if (this.opts.contextStore) {
      try {
        this.opts.contextStore.append(this.sessionId, chunks);
        this.opts.contextStore.prune(this.sessionId);
      } catch {
        // 冷存储失败不影响压缩本身(fail-open)
      }
    }

    return { parts: { demands, conclusions, explanations, ledger }, thinkingSources };
  }

  /**
   * thinking 压缩:一次 LLM 调用,批量处理 fresh 中全部 thinking(含配对上下文),
   * 注入 THINKING_COMPACTION_RULES;解析为分组行。未覆盖的 source 补占位行。
   * 调用方负责 try-catch 兜底(失败 → 全量占位)。
   */
  private async compressThinkingSources(sources: ThinkingSource[]): Promise<ThinkingBlockParts> {
    const budget = this.opts.thinkingBudgetTokens ?? 3500;
    const prompt = sources
      .map((s) => `[r${s.seq}] 推理原文:\n${s.thinking}\n配对上下文:\n${s.context.join("\n")}`)
      .join("\n\n---\n\n");
    const raw = await this.trackedSummarize(prompt, { maxTokens: budget, rules: THINKING_COMPACTION_RULES }, "thinking");
    const parts = parseThinkingBlock(raw);
    // 宽容识别:模型可能不带 `[thinking]` 标记,行前缀可能是 `- [r{n}]` 或直接 `[r{n}]`;
    // 按 `[r{seq}]` 子串匹配,避免有效脉络行被误判 missing 而补占位。
    const hasLine = (seq: number): boolean =>
      [...parts.correct, ...parts.wrong, ...parts.neutral].some((l) => new RegExp(`\\[r${seq}\\]`).test(l));
    const missing = sources.filter((s) => !hasLine(s.seq));
    if (missing.length > 0) {
      parts.neutral.push(...missing.map((s) => `- [r${s.seq}] 推理:(原文已省略)`));
    }
    return parts;
  }

  /** 找 parts 中 `- [r{seq}]` 开头的脉络行(正确/错误/中性任一);无则 undefined。 */
  private thinkingLineFor(parts: ThinkingBlockParts, seq: number): string | undefined {
    for (const group of ["correct", "wrong", "neutral"] as const) {
      const hit = parts[group].find((l) => l.startsWith(`- [r${seq}]`));
      if (hit) return hit;
    }
    return undefined;
  }

  /**
   * 压缩成功后把脉络行回写为冷存储 thinking chunk 的 summary
   * (原文 content 不变;ContextRecall 列表即可命中推理脉络)。无 store 时跳过,fail-open。
   */
  private backfillThinkingSummaries(sources: ThinkingSource[], parts: ThinkingBlockParts): void {
    if (!this.opts.contextStore) return;
    try {
      const updates = sources
        .map((s) => ({ seq: s.seq, summary: this.thinkingLineFor(parts, s.seq) ?? "" }))
        .filter((u) => u.summary !== "");
      if (updates.length > 0) {
        this.opts.contextStore.updateSummaries(this.sessionId, updates);
      }
    } catch {
      // 回写失败不影响主流程(fail-open)
    }
  }

  /**
   * thinking 块滚动收缩(与常规块收缩完全独立):
   * 超过触发阈值(默认 6000 字符 ≈ 3000 tokens)→ 丢弃最旧行至 ≤ 收缩目标
   * (默认 4000 字符 ≈ 2000 tokens),不重压、不额外 LLM 调用。
   * 预算模式(budgetTokens 传入):token 口径判断,丢最旧行至 ≤ 预算。
   */
  private ensureThinkingFits(parts: ThinkingBlockParts, budgetTokens?: number): ThinkingBlockParts {
    if (budgetTokens !== undefined) {
      if (estimateTokens(buildThinkingBlock(parts)) <= budgetTokens) return parts;
      return this.trimThinkingToTokens(parts, budgetTokens);
    }
    const maxChars = this.opts.thinkingMaxChars ?? 6000;
    const trimChars = this.opts.thinkingTrimChars ?? 4000;
    if (estimateThinkingChars(parts) <= maxChars) {
      return parts;
    }
    return trimThinkingBlock(parts, trimChars);
  }

  /** thinking 预算收缩:按 seq 丢最旧脉络行直到 token ≤ 预算;至少保留最新一行。 */
  private trimThinkingToTokens(parts: ThinkingBlockParts, budgetTokens: number): ThinkingBlockParts {
    const groups = ["correct", "wrong", "neutral"] as const;
    const entries: Array<{ group: (typeof groups)[number]; line: string; seq: number }> = [];
    for (const group of groups) {
      for (const line of parts[group]) entries.push({ group, line, seq: rSeq(line) });
    }
    if (entries.length === 0) return parts;
    entries.sort((a, b) => a.seq - b.seq);
    let current: ThinkingBlockParts = { ...parts };
    let guard = 0;
    while (
      estimateTokens(buildThinkingBlock(current)) > budgetTokens &&
      entries.length > 1 &&
      guard < 1000
    ) {
      guard++;
      const victim = entries.shift()!;
      current = {
        ...current,
        [victim.group]: current[victim.group].filter((l) => l !== victim.line),
      };
    }
    return current;
  }
}
