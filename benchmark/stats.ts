/** benchmark 成本统计:收集每次 provider.round 的 usage,汇总为成本摘要。 */
import type { ProviderSendBreakdown } from "../src/stats/providerSendStats";
import type { CompactionRecord } from "../src/stats/compactionEvents";

export interface RoundRecord {
  phase: "chat" | "compact";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  roundMs: number;
  ts: number;
}

export interface CostSummary {
  calls: number;
  chatCalls: number;
  compactCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 按 costPerCallCNY 折算的估算成本(元)。 */
  costCNY: number;
  /** 缓存命中率(cacheRead / (cacheRead + cacheWrite));无缓存数据时 undefined。 */
  cacheHitRate?: number;
  compactions: number;
}

/** 打榜成本跟踪器:挂在 AgentSession 的 onProviderSend / onProviderRound / onCompaction 上。 */
export class CostTracker {
  private rounds: RoundRecord[] = [];
  private breakdowns: ProviderSendBreakdown[] = [];
  private compactions: CompactionRecord[] = [];

  constructor(private readonly costPerCallCNY = 0.005) {}

  readonly onProviderSend = (b: ProviderSendBreakdown): void => {
    this.breakdowns.push(b);
  };

  readonly onProviderRound = (u: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    phase: "chat" | "compact";
    roundMs: number;
  }): void => {
    this.rounds.push({ ...u, ts: Date.now() });
  };

  readonly onCompaction = (ev: CompactionRecord): void => {
    this.compactions.push(ev);
  };

  summary(): CostSummary {
    const chat = this.rounds.filter((r) => r.phase === "chat");
    const compact = this.rounds.filter((r) => r.phase === "compact");
    const inputTokens = this.rounds.reduce((s, r) => s + r.inputTokens, 0);
    const outputTokens = this.rounds.reduce((s, r) => s + r.outputTokens, 0);
    const cacheReadTokens = this.rounds.reduce((s, r) => s + (r.cacheReadTokens ?? 0), 0);
    const cacheWriteTokens = this.rounds.reduce((s, r) => s + (r.cacheWriteTokens ?? 0), 0);
    const calls = this.rounds.length;
    return {
      calls,
      chatCalls: chat.length,
      compactCalls: compact.length,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costCNY: calls * this.costPerCallCNY,
      cacheHitRate:
        cacheReadTokens + cacheWriteTokens > 0 ? cacheReadTokens / (cacheReadTokens + cacheWriteTokens) : undefined,
      compactions: this.compactions.length,
    };
  }

  /** 输出 JSONL 供归档:每次 round 一行。 */
  toJSONL(): string {
    return this.rounds.map((r) => JSON.stringify(r)).join("\n");
  }
}
