import * as fs from "fs";
import * as path from "path";

/**
 * 统计大模块:通用事件日志(JSONL,按天分文件)。
 *
 * 定位:一切「通过统计用户使用方式改进 agent 体验 / 调整 agent 参数」的数据基座。
 * 已有具体统计见 `src/stats/activityStats.ts`(每日最后发送时间 + 工作总结提醒)与
 * `src/agent/compactionStats.ts`(thinking 压缩频率,会话内滑动窗口);
 * 本模块提供可长期积累、可查询的原始事件流,供未来分析/调参使用。
 *
 * 存储布局:`~/.dsb/stats/<projectKey>/events-YYYY-MM-DD.jsonl`(按项目隔离,保留最近 maxAgeDays 天)。
 * 事件只记录元信息(类型/时间/轻量负载),不落用户消息内容,隐私友好。
 */

/** 本地日期 YYYY-MM-DD(与 activityStats 的 localDateStr 保持一致语义)。 */
export function statsLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface StatsEvent {
  /** epoch ms。 */
  t: number;
  /** 事件类型,如 message_sent / tool_completed / compaction / error。 */
  type: string;
  /** 轻量可序列化负载(不含敏感内容)。 */
  data?: Record<string, unknown>;
}

export interface StatsStoreOpts {
  /** 事件文件保留天数;缺省 30。 */
  maxAgeDays?: number;
}

export class StatsStore {
  private readonly maxAgeDays: number;

  constructor(
    private readonly dir: string,
    opts?: StatsStoreOpts,
  ) {
    this.maxAgeDays = opts?.maxAgeDays ?? 30;
  }

  /** 追加一条事件(JSONL append,崩溃安全:单行写入)。 */
  record(type: string, data?: Record<string, unknown>): void {
    const now = new Date();
    const file = this.eventFile(now);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify({ t: now.getTime(), type, data }) + "\n", "utf8");
    } catch {
      // 统计失败不影响主流程(fail-open)
    }
    if (Math.random() < 0.01) this.prune(now); // 抽样清理旧文件,避免每次写都扫目录
  }

  /** 读取事件(倒序=新→旧);可按类型过滤、按起始时间过滤。 */
  list(opts?: { type?: string; since?: number; limit?: number }): StatsEvent[] {
    const out: StatsEvent[] = [];
    let files: string[];
    try {
      files = fs.readdirSync(this.dir).filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
    } catch {
      return [];
    }
    files.sort().reverse(); // 新日期在前
    for (const f of files) {
      let lines: string[];
      try {
        lines = fs.readFileSync(path.join(this.dir, f), "utf8").split("\n").filter(Boolean);
      } catch {
        continue;
      }
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const ev = JSON.parse(lines[i]) as StatsEvent;
          if (opts?.type && ev.type !== opts.type) continue;
          if (opts?.since !== undefined && ev.t < opts.since) continue;
          out.push(ev);
          if (opts?.limit !== undefined && out.length >= opts.limit) return out;
        } catch {
          // 单行损坏跳过
        }
      }
    }
    return out;
  }

  /** 事件计数(按类型);用于快速统计(如近 7 天发送次数)。 */
  count(opts?: { type?: string; since?: number }): number {
    return this.list({ type: opts?.type, since: opts?.since }).length;
  }

  private eventFile(d: Date): string {
    return path.join(this.dir, `events-${statsLocalDate(d)}.jsonl`);
  }

  /** 删除超过 maxAgeDays 天的旧事件文件。 */
  prune(now?: Date): void {
    const ref = now ?? new Date();
    let files: string[];
    try {
      files = fs.readdirSync(this.dir).filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
    } catch {
      return;
    }
    const cutoff = new Date(ref.getTime() - this.maxAgeDays * 24 * 3600 * 1000).getTime();
    for (const f of files) {
      const m = f.match(/^events-(\d{4})-(\d{2})-(\d{2})\.jsonl$/);
      if (!m) continue;
      const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
      if (day < cutoff) {
        try {
          fs.unlinkSync(path.join(this.dir, f));
        } catch {
          // 删除失败忽略
        }
      }
    }
  }
}
