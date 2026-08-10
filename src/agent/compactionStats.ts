/**
 * thinking 压缩成本监控。
 *
 * 目标:量化 compactionTriggerRatio 的实际触发频率 —— 「最近 N 次对话中,发生了几次
 * thinking 压缩」。频率过高意味着每次对话都在为压缩付一次额外 LLM 调用成本,
 * 应调高 dsbAgent.compaction.triggerRatio(缺省 0.75)降低触发;频率很低则阈值可下调,
 * 换取更多上下文保留。
 *
 * 纯 TS 无 vscode 依赖,便于单测。每个 AgentSession 持有一个实例(子代理不统计)。
 */
export const COMPACTION_STATS_WINDOW = 100;

export interface CompactionStatsSnapshot {
  /** 窗口内发生的 thinking 压缩次数。 */
  windowCompactions: number;
  /** 窗口内对话数(≤ COMPACTION_STATS_WINDOW;会话初期未满窗口)。 */
  windowConversations: number;
  /** 统计窗口大小。 */
  windowSize: number;
  /** 会话累计对话数。 */
  totalConversations: number;
  /** 会话累计 thinking 压缩次数。 */
  totalCompactions: number;
  /** 最近窗口内每次对话的压缩次数(旧→新;长度 = windowConversations)。供 UI 画趋势图。 */
  windowSeries: number[];
}

export class CompactionStats {
  /** 每个元素 = 一次对话内发生的 thinking 压缩次数;长度 ≤ COMPACTION_STATS_WINDOW。 */
  private window: number[] = [];
  private totalConversations = 0;
  private totalCompactions = 0;

  /** 会话累计对话数。 */
  get conversationCount(): number {
    return this.totalConversations;
  }

  /** 会话累计 thinking 压缩次数。 */
  get compactionCount(): number {
    return this.totalCompactions;
  }

  /** 一次对话开始(send 入口)。此后发生的压缩事件归入本条窗口记录。 */
  beginConversation(): void {
    this.window.push(0);
    if (this.window.length > COMPACTION_STATS_WINDOW) this.window.shift();
    this.totalConversations++;
  }

  /**
   * 一次 thinking 压缩发生(成功或失败都产生 LLM 成本,均计入)。
   * 归入最近一次对话;窗口为空(压缩发生在首次对话前,实际不可能)时只计累计值。
   */
  recordThinkingCompaction(): void {
    this.totalCompactions++;
    if (this.window.length > 0) this.window[this.window.length - 1]++;
  }

  get windowCompactions(): number {
    return this.window.reduce((a, b) => a + b, 0);
  }

  get windowConversations(): number {
    return this.window.length;
  }

  snapshot(): CompactionStatsSnapshot {
    return {
      windowCompactions: this.windowCompactions,
      windowConversations: this.windowConversations,
      windowSize: COMPACTION_STATS_WINDOW,
      totalConversations: this.totalConversations,
      totalCompactions: this.totalCompactions,
      windowSeries: [...this.window],
    };
  }
}
