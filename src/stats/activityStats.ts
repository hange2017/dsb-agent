import * as fs from "fs";
import * as path from "path";

/**
 * 每日工作统计 + 工作总结提醒。
 *
 * 数据:记录「每天最后一次发送消息的时间」(按本地日期去重覆盖)。
 * 提醒:使用 ≥3 个(过去)工作日后,取最近若干天的平均收工时间,提前 20 分钟
 * (不早于 17:00)提醒用户生成本日工作总结并更新项目文档;当日只提醒一次。
 * 纯 TS 无 vscode 依赖:存储目录与通知回调由装配方注入,便于单测。
 */

export interface ActivityRecord {
  /** 本地日期 YYYY-MM-DD。 */
  date: string;
  /** 当天最后一次发送消息的本地时间 ISO 字符串。 */
  lastSendAt: string;
}

export interface DailySummaryReminderInfo {
  /** 提醒日期 YYYY-MM-DD。 */
  date: string;
  /** 建议提醒时刻(平均收工时间 - 20 分钟,clamp 到 17:00 之后)。 */
  reminderTime: Date;
  /** 平均收工时间,格式 HH:mm。 */
  avgTime: string;
  /** 参与统计的天数。 */
  days: number;
}

export interface DailySummaryReminderDeps {
  stats: ActivityStatsStore;
  now: () => Date;
  /** 到达提醒窗口时回调;返回用户是否选择「生成总结」。 */
  notify: (info: DailySummaryReminderInfo) => Promise<"summarize" | "dismiss">;
}

/** 本地日期 YYYY-MM-DD(按本地时区)。 */
export function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 本地分钟数(0-1439)。 */
function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * 计算今日提醒时刻:
 * - 取最近 maxDays(默认 5)个「有记录且非今天」的天;
 * - 少于 minDays(默认 3)天 → 返回 null(数据不足,不提醒);
 * - 平均收工分钟 - 20 分钟,clamp 到 [17:00, 23:59] 之间。
 */
export function computeDailyReminder(
  records: ActivityRecord[],
  now: Date,
  opts?: { maxDays?: number; minDays?: number },
): DailySummaryReminderInfo | null {
  const maxDays = opts?.maxDays ?? 5;
  const minDays = opts?.minDays ?? 3;
  const today = localDateStr(now);
  const byDate = new Map<string, number>();
  for (const r of records) {
    if (!r.date || r.date >= today) continue; // 今天的数据还在变动,不参与统计
    const d = new Date(r.lastSendAt);
    if (Number.isNaN(d.getTime())) continue;
    byDate.set(r.date, minutesOfDay(d));
  }
  const days = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, maxDays);
  if (days.length < minDays) return null;
  const avg = Math.round(days.reduce((s, [, m]) => s + m, 0) / days.length);
  // 提前 20 分钟;不早于 17:00,不晚于 23:59
  const reminderMin = Math.min(Math.max(avg - 20, 17 * 60), 23 * 60 + 59);
  const reminderTime = new Date(now);
  reminderTime.setHours(Math.floor(reminderMin / 60), reminderMin % 60, 0, 0);
  const avgTime = `${`${Math.floor(avg / 60)}`.padStart(2, "0")}:${`${avg % 60}`.padStart(2, "0")}`;
  return { date: today, reminderTime, avgTime, days: days.length };
}

/** 每日活动统计存储:单文件 `daily.json`,按项目 key 分目录。 */
export class ActivityStatsStore {
  constructor(private readonly dir: string) {}

  private file(): string {
    return path.join(this.dir, "daily.json");
  }

  private load(): { days: ActivityRecord[]; reminded: Record<string, true> } {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), "utf8")) as {
        days?: ActivityRecord[];
        reminded?: Record<string, true>;
      };
      return {
        days: Array.isArray(raw.days) ? raw.days : [],
        reminded: typeof raw.reminded === "object" && raw.reminded !== null ? raw.reminded : {},
      };
    } catch {
      return { days: [], reminded: {} };
    }
  }

  private save(data: { days: ActivityRecord[]; reminded: Record<string, true> }): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file(), JSON.stringify(data, null, 2), "utf8");
  }

  /** 记录一次发送:覆盖当天最后发送时间。 */
  recordActivity(at: Date): void {
    const data = this.load();
    const date = localDateStr(at);
    const next: ActivityRecord[] = data.days.filter((d) => d.date !== date);
    next.push({ date, lastSendAt: at.toISOString() });
    // 只保留最近 90 天,防止文件无限增长
    const cutoff = localDateStr(new Date(at.getTime() - 90 * 24 * 3600 * 1000));
    data.days = next.filter((d) => d.date >= cutoff);
    this.save(data);
  }

  list(): ActivityRecord[] {
    return this.load().days;
  }

  /** 当天是否已提醒过。 */
  wasReminded(date: string): boolean {
    return this.load().reminded[date] === true;
  }

  /** 标记当天已提醒(当日只提醒一次)。 */
  markReminded(date: string): void {
    const data = this.load();
    data.reminded[date] = true;
    this.save(data);
  }
}

/** 每日提醒调度器:周期性 tick,到提醒窗口(提醒时刻起 2 小时内)触发一次并当日去重。 */
export class DailySummaryReminder {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: DailySummaryReminderDeps) {}

  /** 启动周期检查(默认每 60s);立即 tick 一次。 */
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.tick();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  tick(): void {
    const now = this.deps.now();
    const info = computeDailyReminder(this.deps.stats.list(), now);
    if (!info) return;
    if (this.deps.stats.wasReminded(info.date)) return;
    const windowEnd = info.reminderTime.getTime() + 2 * 3600 * 1000;
    if (now.getTime() < info.reminderTime.getTime() || now.getTime() > windowEnd) return;
    // 进入提醒窗口:先标记(异步通知失败也不重复弹),再回调
    this.deps.stats.markReminded(info.date);
    void this.deps.notify(info).catch(() => {});
  }
}
