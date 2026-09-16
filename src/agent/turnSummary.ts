/**
 * 轮次档案(turn summary)累加器 —— 纯 TS,无 vscode 依赖,便于单测。
 *
 * 动机:一次用户消息(一个「大任务」)在 agentLoop 里会展开成 R 轮 provider.round、
 * N 次工具调用。这些数字散落在会话 jsonl(全量 tool 事件)里,事后统计慢且没有
 * 项目维度聚合;stats 侧的 tool_repeat 只有分子没有分母(算不出重复率)。
 * 本累加器把「一次 send」的全部计数在一次收尾时聚合,经 `turn_summary` 事件落盘,
 * 直接回答:
 *   - 这轮大任务里执行了多少小任务(rounds / toolCalls)?
 *   - 小任务是否在重复(toolRepeat* / redundantTokens / 重复率)?
 *   - 是否卡住(endReason + rounds 是否触顶 + durationMs)?
 *   - 缓存是否异常(cacheHitRate 用权威口径)?
 *
 * 口径对齐(禁止自造):
 * - 缓存命中率 = cacheReadTokens / (cacheReadTokens + inputTokens),
 *   与 `scripts/analyze-cache-prefix.py` 的权威口径一致(见该文件头部注释)。
 * - 重复判定由 `ToolRepeatTracker` 提供,与离线脚本 `analyze-duplicate-work.py` 同口径。
 *
 * 约束:纯旁路,不进入任何发给 provider 的载荷;只记数字,不记内容。
 */

/** 一轮大任务的终态原因。 */
export type TurnEndReason = "done" | "error" | "aborted" | "maxRounds";

/** 一次 send(一个「大任务」)的完整档案。 */
export interface TurnSummary {
  /** 会话 id。 */
  sessionId: string;
  /** 会话内第几次 send(1 基,含此前全部 send)。 */
  turnIndex: number;
  /** 用户原始消息长度(字符数;不记内容)。 */
  userTextLen: number;
  /** 本轮耗时(ms):send 入口 → 收尾。 */
  durationMs: number;
  /** 实际执行的 provider.round 数(小任务轮数)。 */
  rounds: number;
  /** 工具调用总次数(分母)。 */
  toolCalls: number;
  /** 工具调用失败次数(execResult.ok=false / 权限拒绝 / 参数错误)。 */
  toolErrors: number;
  /** 涉及的不同工具种类数。 */
  distinctTools: number;
  /** 重复调用命中次数(与 tool_repeat 同口径)。 */
  toolRepeatCount: number;
  /** 其中「浪费型」重复次数(间隔 < wasteGapMs)。 */
  toolRepeatWasteCount: number;
  /** 重复调用累计冗余 token 估算。 */
  redundantTokens: number;
  /** 压缩发生次数(本轮内 before/after 事件条数)。 */
  compactionCount: number;
  /** ContextRecall 调用次数(信息丢失的直接计分板)。 */
  contextRecallCalls: number;
  /** 交互式追加注入次数。 */
  appends: number;
  /** 本轮 input token(未命中缓存部分;来自 provider 真实 usage)。 */
  inputTokens: number;
  /** 本轮 output token。 */
  outputTokens: number;
  /** 缓存命中读取 token。 */
  cacheReadTokens: number;
  /** 缓存写入 token。 */
  cacheWriteTokens: number;
  /** 交互(非压缩)轮次耗时合计(ms)。 */
  chatMs: number;
  /** 终态原因。 */
  endReason: TurnEndReason;
}

/** 累加器内部可变形态(TurnSummary 去掉派生字段)。 */
type MutableSummary = Omit<TurnSummary, "distinctTools" | "endReason"> & {
  endReason?: TurnEndReason;
  toolNames: Set<string>;
};

/**
 * 单次 send 的计数累加器。
 *
 * 用法:send 入口 `begin(sessionId, userTextLen, turnIndex)`;
 * 过程中调用 recordRound / recordTool / recordRepeat / recordCompaction / recordContextRecall / recordAppend;
 * 收尾(含 abort/error)`finish(endReason)` 得到完整 TurnSummary。
 */
export class TurnSummaryStats {
  private sessionId = "default";
  private turnIndex = 0;
  private userTextLen = 0;
  private startedAt = 0;
  private endedAt = 0;
  private rounds = 0;
  private toolCalls = 0;
  private toolErrors = 0;
  private toolRepeatCount = 0;
  private toolRepeatWasteCount = 0;
  private redundantTokens = 0;
  private compactionCount = 0;
  private contextRecallCalls = 0;
  private appends = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private chatMs = 0;
  private active = false;
  private toolNames = new Set<string>();

  /** 会话累计 send 次数(独立于单轮状态,跨轮保留)。 */
  private totalTurns = 0;

  /** 开始一轮。turnIndex 由内部自增(会话内 1 基)。 */
  begin(sessionId: string, userTextLen: number, startedAt: number): void {
    this.sessionId = sessionId;
    this.turnIndex = ++this.totalTurns;
    this.userTextLen = userTextLen;
    this.startedAt = startedAt;
    this.endedAt = startedAt;
    this.rounds = 0;
    this.toolCalls = 0;
    this.toolErrors = 0;
    this.toolRepeatCount = 0;
    this.toolRepeatWasteCount = 0;
    this.redundantTokens = 0;
    this.compactionCount = 0;
    this.contextRecallCalls = 0;
    this.appends = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheReadTokens = 0;
    this.cacheWriteTokens = 0;
    this.chatMs = 0;
    this.toolNames = new Set<string>();
    this.active = true;
  }

  /** 是否处于一轮进行中(未 finish)。 */
  isActive(): boolean {
    return this.active;
  }

  /** 一次 provider.round(互动轮)完成。 */
  recordChatRound(usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    roundMs: number;
  }): void {
    this.rounds += 1;
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.cacheReadTokens += usage.cacheReadTokens ?? 0;
    this.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    this.chatMs += usage.roundMs;
  }

  /** 一次工具调用结束(ok=false 计入失败)。 */
  recordTool(name: string, ok: boolean): void {
    this.toolCalls += 1;
    this.toolNames.add(name);
    if (!ok) this.toolErrors += 1;
  }

  /** 一次重复调用命中(来自 toolRepeat 回调)。 */
  recordRepeat(hit: { isWaste: boolean; redundantTokens: number }): void {
    this.toolRepeatCount += 1;
    if (hit.isWaste) this.toolRepeatWasteCount += 1;
    this.redundantTokens += hit.redundantTokens;
  }

  /** 一次压缩发生。 */
  recordCompaction(): void {
    this.compactionCount += 1;
  }

  /** 一次 ContextRecall 调用。 */
  recordContextRecall(): void {
    this.contextRecallCalls += 1;
  }

  /** 一次交互式追加注入。 */
  recordAppend(n = 1): void {
    this.appends += n;
  }

  /** 收尾,产出完整档案。重复调用幂等:endedAt 与 endReason 均以首次为准。 */
  finish(endReason: TurnEndReason, endedAt: number): TurnSummary {
    if (this.active) {
      this.endedAt = endedAt;
      this.lastEndReason = endReason;
      this.active = false;
    }
    const m: MutableSummary = {
      sessionId: this.sessionId,
      turnIndex: this.turnIndex,
      userTextLen: this.userTextLen,
      durationMs: Math.max(0, this.endedAt - this.startedAt),
      rounds: this.rounds,
      toolCalls: this.toolCalls,
      toolErrors: this.toolErrors,
      toolRepeatCount: this.toolRepeatCount,
      toolRepeatWasteCount: this.toolRepeatWasteCount,
      redundantTokens: this.redundantTokens,
      compactionCount: this.compactionCount,
      contextRecallCalls: this.contextRecallCalls,
      appends: this.appends,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      chatMs: this.chatMs,
      endReason: this.lastEndReason,
      toolNames: this.toolNames,
    };
    return toSummary(m);
  }

  /** finish 记录的终态(首次为准)。 */
  private lastEndReason: TurnEndReason | undefined;

  /** 会话累计对话数(供上层对齐 CompactionStats.conversationCount)。 */
  get turnCount(): number {
    return this.totalTurns;
  }
}

/** 派生字段计算:distinctTools;把内部 Set 转纯数据。 */
function toSummary(m: MutableSummary): TurnSummary {
  return {
    sessionId: m.sessionId,
    turnIndex: m.turnIndex,
    userTextLen: m.userTextLen,
    durationMs: m.durationMs,
    rounds: m.rounds,
    toolCalls: m.toolCalls,
    toolErrors: m.toolErrors,
    distinctTools: m.toolNames.size,
    toolRepeatCount: m.toolRepeatCount,
    toolRepeatWasteCount: m.toolRepeatWasteCount,
    redundantTokens: m.redundantTokens,
    compactionCount: m.compactionCount,
    contextRecallCalls: m.contextRecallCalls,
    appends: m.appends,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    cacheReadTokens: m.cacheReadTokens,
    cacheWriteTokens: m.cacheWriteTokens,
    chatMs: m.chatMs,
    endReason: m.endReason ?? "done",
  };
}

/**
 * 缓存命中率(权威口径,与 analyze-cache-prefix.py 一致):
 * `cacheReadTokens / (cacheReadTokens + inputTokens)`。
 * 分母为 0(无 usage)时返回 undefined,避免用 0% 误导。
 */
export function cacheHitRate(s: Pick<TurnSummary, "cacheReadTokens" | "inputTokens">): number | undefined {
  const denom = s.cacheReadTokens + s.inputTokens;
  if (denom <= 0) return undefined;
  return s.cacheReadTokens / denom;
}

/**
 * 重复率(小任务重复程度的直接指标):
 * `toolRepeatWasteCount / toolCalls`;无工具调用时返回 undefined。
 * 用「浪费型」重复作分子(排除"改完再看"这类合理复查),更贴近真实浪费。
 */
export function repeatWasteRate(s: Pick<TurnSummary, "toolRepeatWasteCount" | "toolCalls">): number | undefined {
  if (s.toolCalls <= 0) return undefined;
  return s.toolRepeatWasteCount / s.toolCalls;
}
