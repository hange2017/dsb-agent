import type { StatsEvent } from "./statsStore";

/**
 * 统计聚合纯函数(不依赖 vscode,只依赖 ts 类型)。
 *
 * 定位:对 `~/.dsb/stats/<projectKey>/events-YYYY-MM-DD.jsonl` 里的原始事件流做内存聚合,
 * 供面板/CLI 展示与分析。全部为纯函数:输入 StatsEvent[] 数组、输出结构化聚合结果。
 *
 * 事件口径:
 * - provider_round:data = { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, phase?, roundMs? },
 *   顶层 t = epoch ms。phase 缺省或 "chat" 视为普通聊天轮。
 * - compaction:data = { position, beforeTokens?, afterTokens?, startedAt?, durationMs? }。
 * - compaction_qa:data = { seq, answerable, qaInputTokens?, qaOutputTokens? }。
 * - error:顶层 type === "error"(本模块只关心是否出现,不读取负载)。
 */

// ---------------------------------------------------------------------------
// 共享小工具
// ---------------------------------------------------------------------------

function dataOf(ev: StatsEvent): Record<string, unknown> {
  return ev.data ?? {};
}

/** 取 data 中数值字段;非有限数字视为缺省(fallback)。 */
function num(data: Record<string, unknown>, key: string, fallback = 0): number {
  const v = data[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** 是否聊天轮 provider_round(phase 缺省或 "chat")。 */
function isChatRound(ev: StatsEvent): boolean {
  if (ev.type !== "provider_round") return false;
  const phase = dataOf(ev).phase;
  return phase === undefined || phase === "chat";
}

function median(values: number[], fallback = 0): number {
  if (values.length === 0) return fallback;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 升序数组中小于 t 的最大元素(严格小于)。 */
function lastLess(sortedAsc: number[], t: number): number | undefined {
  let out: number | undefined;
  for (const v of sortedAsc) {
    if (v < t) out = v;
    else break;
  }
  return out;
}

/** 本地小时键:"YYYY-MM-DDTHH:00"(用 new Date(t) 的本地时区字段拼接)。 */
function hourKey(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  const h = `${d.getHours()}`.padStart(2, "0");
  return `${y}-${m}-${day}T${h}:00`;
}

// ---------------------------------------------------------------------------
// 1. 压缩后缓存命中率"雪崩"分析
// ---------------------------------------------------------------------------

/** 一个聊天轮的缓存命中点。 */
export interface MissRatePoint {
  t: number;
  /** 未命中 token = inputTokens - cacheReadTokens(负数按 0)。 */
  missTokens: number;
  /** 输入总 token(>0 才计点)。 */
  inputTokens: number;
  /** 未命中率 = missTokens / inputTokens。 */
  missRate: number;
}

/** 一次压缩后的命中率雪崩。 */
export interface CompactAvalanche {
  /** 压缩开始时间(epoch ms;data.startedAt 缺省时用事件 t)。 */
  startedAt: number;
  /** 压缩前基线:最近 5 个聊天轮的 missRate 中位数。 */
  beforeMissRate: number;
  /** 压缩后第 1 个聊天轮的 missRate(无后续轮时为基线)。 */
  firstMissRate: number;
  /** 额外未命中 token:压缩后每轮 (missRate-基线)×inputTokens 的正值累加。 */
  extraMissTokens: number;
  /** 恢复轮数:达到连续 3 轮 missRate<=基线所需的轮数;到末尾未恢复为 999。 */
  recoveryRounds: number;
}

/** 压缩雪崩聚合结果。 */
export interface AvalancheAnalysis {
  compactions: CompactAvalanche[];
  totalExtraMissTokens: number;
  /** 已恢复压缩的平均恢复轮数(未恢复的 999 不计入平均)。 */
  avgRecoveryRounds: number;
}

export function analyzeCacheAfterCompact(events: StatsEvent[]): AvalancheAnalysis {
  const sorted = [...events].sort((a, b) => a.t - b.t);

  // 收集所有聊天轮命中点(按 t 升序)。
  const points: MissRatePoint[] = [];
  for (const ev of sorted) {
    if (!isChatRound(ev)) continue;
    const d = dataOf(ev);
    const input = num(d, "inputTokens");
    if (input <= 0) continue;
    const miss = Math.max(0, input - num(d, "cacheReadTokens"));
    points.push({ t: ev.t, missTokens: miss, inputTokens: input, missRate: miss / input });
  }

  const compactions: CompactAvalanche[] = [];
  for (const ev of sorted) {
    if (ev.type !== "compaction") continue;
    const d = dataOf(ev);
    const startedAt = num(d, "startedAt", ev.t);

    // 基线 = 压缩前最近 5 个 chat 轮的 missRate 中位数(points 已按 t 升序)。
    const before = points.filter((p) => p.t < ev.t).slice(-5).map((p) => p.missRate);
    const beforeMissRate = median(before);
    const after = points.filter((p) => p.t >= ev.t);

    let firstMissRate = beforeMissRate;
    let extraMissTokens = 0;
    let recoveryRounds = 999;
    let consecutiveLow = 0;
    for (let i = 0; i < after.length; i++) {
      const p = after[i];
      if (i === 0) firstMissRate = p.missRate;
      const excess = (p.missRate - beforeMissRate) * p.inputTokens;
      if (excess > 0) extraMissTokens += excess;
      consecutiveLow = p.missRate <= beforeMissRate ? consecutiveLow + 1 : 0;
      if (consecutiveLow >= 3) {
        recoveryRounds = i + 1;
        break;
      }
    }
    compactions.push({ startedAt, beforeMissRate, firstMissRate, extraMissTokens, recoveryRounds });
  }

  const totalExtraMissTokens = compactions.reduce((s, c) => s + c.extraMissTokens, 0);
  const recovered = compactions.filter((c) => c.recoveryRounds < 999);
  const avgRecoveryRounds = recovered.length
    ? recovered.reduce((s, c) => s + c.recoveryRounds, 0) / recovered.length
    : 0;

  return { compactions, totalExtraMissTokens, avgRecoveryRounds };
}

// ---------------------------------------------------------------------------
// 2. 按本地小时的成本汇总
// ---------------------------------------------------------------------------

export interface HourlyCost {
  /** 本地小时键 "YYYY-MM-DDTHH:00"。 */
  hour: string;
  /** 聊天轮 provider_round 次数。 */
  rounds: number;
  /** compaction 事件次数。 */
  compactions: number;
  /** 缓存命中输入 token。 */
  inputHit: number;
  /** 缓存未命中输入 token(= inputTokens - cacheReadTokens)。 */
  inputMiss: number;
  /** 输出 token。 */
  output: number;
  costHit: number;
  costMiss: number;
  costOutput: number;
  /** costTotal = costHit + costMiss + costOutput。 */
  costTotal: number;
  /** compaction_qa 的 qa 输入 token。 */
  qaInput: number;
  /** compaction_qa 的 qa 输出 token。 */
  qaOutput: number;
  /** qa 成本(qaInput 按 miss 单价、qaOutput 按输出单价)。 */
  qaCost: number;
  /** realCost = costTotal - qaCost(剔除压缩自审成本后的真实成本)。 */
  realCost: number;
}

/** 每百万 token 单价(美元)。 */
export interface CostPrices {
  hitPerM: number;
  missPerM: number;
  outputPerM: number;
}

const DEFAULT_PRICES: CostPrices = { hitPerM: 0.02, missPerM: 1, outputPerM: 2 };

export function hourlyCostSummary(events: StatsEvent[], prices?: Partial<CostPrices>): HourlyCost[] {
  const p: CostPrices = { ...DEFAULT_PRICES, ...prices };
  const sorted = [...events].sort((a, b) => a.t - b.t);

  const map = new Map<string, HourlyCost>();
  const rowFor = (hour: string): HourlyCost => {
    let row = map.get(hour);
    if (!row) {
      row = {
        hour,
        rounds: 0,
        compactions: 0,
        inputHit: 0,
        inputMiss: 0,
        output: 0,
        costHit: 0,
        costMiss: 0,
        costOutput: 0,
        costTotal: 0,
        qaInput: 0,
        qaOutput: 0,
        qaCost: 0,
        realCost: 0,
      };
      map.set(hour, row);
    }
    return row;
  };

  for (const ev of sorted) {
    const row = rowFor(hourKey(new Date(ev.t)));
    if (ev.type === "provider_round" && isChatRound(ev)) {
      const d = dataOf(ev);
      const input = num(d, "inputTokens");
      const hit = Math.max(0, num(d, "cacheReadTokens"));
      const miss = Math.max(0, input - hit);
      row.rounds += 1;
      row.inputHit += hit;
      row.inputMiss += miss;
      row.output += Math.max(0, num(d, "outputTokens"));
    } else if (ev.type === "compaction") {
      row.compactions += 1;
    } else if (ev.type === "compaction_qa") {
      const d = dataOf(ev);
      row.qaInput += Math.max(0, num(d, "qaInputTokens"));
      row.qaOutput += Math.max(0, num(d, "qaOutputTokens"));
    }
  }

  for (const row of map.values()) {
    row.costHit = (row.inputHit / 1e6) * p.hitPerM;
    row.costMiss = (row.inputMiss / 1e6) * p.missPerM;
    row.costOutput = (row.output / 1e6) * p.outputPerM;
    row.costTotal = row.costHit + row.costMiss + row.costOutput;
    row.qaCost = (row.qaInput / 1e6) * p.missPerM + (row.qaOutput / 1e6) * p.outputPerM;
    row.realCost = row.costTotal - row.qaCost;
  }

  // 按首次出现顺序排列。
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// 3. 会话轮次聚合(错误/压缩/窗口分组)
// ---------------------------------------------------------------------------

export interface RoundResult {
  /** 聊天轮序号(按 t 升序从 0 递增)。 */
  roundIndex: number;
  /** 该轮到下一轮之间没有 error 事件为 true。 */
  ok: boolean;
  /** 距上一个 compaction 事件的轮数;压缩前为 -1。 */
  roundsSinceCompaction: number;
  /** 该轮 data 里的窗口字段值(缺省 0)。 */
  windowTokens: number;
}

export interface WindowAgg {
  /** 窗口 token 分组键。 */
  windowTokens: number;
  /** 组内 compaction 事件数(简化:全时段 compaction 总数分到轮数最多的组)。 */
  compressCount: number;
  /** 组内轮数。 */
  roundsAnalyzed: number;
  /** ok 轮数 / 组内轮数。 */
  successRate: number;
}

export interface RoundAggResult {
  rounds: RoundResult[];
  agg: WindowAgg[];
}

export function sessionRoundAgg(events: StatsEvent[], opts?: { windowField?: string }): RoundAggResult {
  const windowField = opts?.windowField ?? "windowTokens";
  const sorted = [...events].sort((a, b) => a.t - b.t);

  const chatRounds = sorted.filter(isChatRound);
  const errorTimes = sorted.filter((ev) => ev.type === "error").map((ev) => ev.t);
  const compactionTimes = sorted.filter((ev) => ev.type === "compaction").map((ev) => ev.t);

  const rounds: RoundResult[] = [];
  for (let i = 0; i < chatRounds.length; i++) {
    const ev = chatRounds[i];
    const nextT = i + 1 < chatRounds.length ? chatRounds[i + 1].t : Infinity;
    const hasError = errorTimes.some((et) => et >= ev.t && et < nextT);

    // roundsSinceCompaction:最近的压缩(严格早于本轮)之后的轮数;-1 = 压缩前。
    const lastComp = lastLess(compactionTimes, ev.t);
    let roundsSinceCompaction = -1;
    if (lastComp !== undefined) {
      roundsSinceCompaction = chatRounds.filter((r) => r.t > lastComp && r.t <= ev.t).length;
    }

    rounds.push({
      roundIndex: i,
      ok: !hasError,
      roundsSinceCompaction,
      windowTokens: num(dataOf(ev), windowField),
    });
  }

  // 按 windowTokens 分组(0 归 "0" 组)。
  const groups = new Map<number, { windowTokens: number; rounds: number; ok: number }>();
  for (const r of rounds) {
    const g = groups.get(r.windowTokens);
    if (g) {
      g.rounds += 1;
      if (r.ok) g.ok += 1;
    } else {
      groups.set(r.windowTokens, { windowTokens: r.windowTokens, rounds: 1, ok: r.ok ? 1 : 0 });
    }
  }

  // 简化:全时段 compaction 总数分到轮数最多的组。
  let maxGroup: { windowTokens: number; rounds: number; ok: number } | undefined;
  for (const g of groups.values()) {
    if (!maxGroup || g.rounds > maxGroup.rounds) maxGroup = g;
  }
  const totalCompactions = compactionTimes.length;

  const agg: WindowAgg[] = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, g]) => ({
      windowTokens: key,
      compressCount: maxGroup && maxGroup.windowTokens === key ? totalCompactions : 0,
      roundsAnalyzed: g.rounds,
      successRate: g.rounds > 0 ? g.ok / g.rounds : 0,
    }));

  return { rounds, agg };
}
