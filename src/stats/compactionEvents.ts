/**
 * 压缩事件统计类型。
 *
 * 需求:记录每次压缩的「位置 × 触发原因 × 压缩前后 token」,
 * 用于后续分析每个压缩位置的压缩频率与压缩规模
 * (tail 压缩 / 压缩块收缩 / thinking 压缩 / thinking 块滚动收缩)。
 * 只记数字与位置,不记内容。
 */

/** 压缩位置。 */
export type CompactionPosition = "tail" | "block" | "thinking" | "thinking_block";

/** 触发原因。 */
export type CompactionReason = "window_ratio" | "tail_self_driven" | "manual";

/** 一次压缩事件。 */
export interface CompactionRecord {
  /** 压缩位置。 */
  position: CompactionPosition;
  /** 触发原因。 */
  reason: CompactionReason;
  /** 压缩流程开始时间(epoch ms):contextManager.compact 入口。 */
  startedAt: number;
  /** 压缩耗时(ms):一次 compact 流程从开始到完成(含 LLM 摘要调用)。 */
  durationMs: number;
  /** 压缩前 token(估算口径同 providerSendStats.estimateTokens)。 */
  beforeTokens: number;
  /** 压缩后 token。 */
  afterTokens: number;
  /** 会话 id。 */
  sessionId: string;
  /** 本次压缩流程 LLM 调用次数(所有 summarize 调用;当前盲区,现补齐)。 */
  llmCalls: number;
  /** 本次压缩流程 LLM 调用总耗时(ms;串行实现为累计,并行改造后须改为取 max)。 */
  llmMs: number;
  /** 纯本地算法耗时(ms)= durationMs - llmMs;负数按 0(并行后需重算口径)。 */
  algoMs: number;
  /** 压缩自身消耗的输入 token(所有 summarize 的 prompt 估算之和)。 */
  selfInputTokens: number;
  /** 压缩自身产生的输出 token(所有 summarize 返回值估算之和)。 */
  selfOutputTokens: number;
  /** 预算快照(总 + 三块额定),便于后续分析规模与频率;未开启预算时缺省。 */
  budget?: {
    total: number;
    compacted: number;
    thinking: number;
    tail: number;
  };
  /** tail 位置:被压入压缩块的旧消息条数(head)。 */
  headCount?: number;
  /** tail 位置:压缩后保留的最近消息条数。 */
  tailCount?: number;

  /** A7:按 LLM 用途细分的压缩流程统计(4 类);detailLevel=full 时记录。 */
  llmDetail?: {
    resummarize: { calls: number; ms: number; inTokens: number; outTokens: number };
    oversize: { calls: number; ms: number; inTokens: number; outTokens: number };
    explanation: { calls: number; ms: number; inTokens: number; outTokens: number };
    thinking: { calls: number; ms: number; inTokens: number; outTokens: number };
  };
  /** A7:该位置压缩自身耗时(ms;位置开始 → 结束,含算法与 LLM)。 */
  posMs?: number;
  /** A7:该位置压缩是否调用了 LLM。 */
  usedLLM?: boolean;
  /** A5:该次压缩被压掉的原始消息 [r{n}] 序号(QA 抽查用,最多前 8 个)。 */
  compactedSeqs?: number[];
}
