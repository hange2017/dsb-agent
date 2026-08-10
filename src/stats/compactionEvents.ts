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
  /** 压缩前 token(估算口径同 providerSendStats.estimateTokens)。 */
  beforeTokens: number;
  /** 压缩后 token。 */
  afterTokens: number;
  /** 会话 id。 */
  sessionId: string;
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
}
