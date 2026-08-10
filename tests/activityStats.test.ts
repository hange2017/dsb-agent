import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ActivityStatsStore,
  computeDailyReminder,
  DailySummaryReminder,
  localDateStr,
  type ActivityRecord,
} from "../src/stats/activityStats";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function at(h: number, m: number, dayOffset = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d;
}

function rec(dayOffset: number, h: number, m: number): ActivityRecord {
  const d = at(h, m, dayOffset);
  return { date: localDateStr(d), lastSendAt: d.toISOString() };
}

describe("ActivityStatsStore", () => {
  it("records last send per day (overwrite) and prunes old days", () => {
    const s = new ActivityStatsStore(dir);
    s.recordActivity(at(9, 0, -2));
    s.recordActivity(at(10, 30, -2)); // 同一天覆盖
    s.recordActivity(at(18, 0, -1));
    const list = s.list();
    expect(list).toHaveLength(2);
    const d2 = list.find((r) => r.date === localDateStr(at(0, 0, -2)))!;
    expect(new Date(d2.lastSendAt).getHours()).toBe(10);
  });

  it("tracks reminded marks per day", () => {
    const s = new ActivityStatsStore(dir);
    expect(s.wasReminded("2026-08-09")).toBe(false);
    s.markReminded("2026-08-09");
    expect(s.wasReminded("2026-08-09")).toBe(true);
    expect(s.wasReminded("2026-08-10")).toBe(false);
  });
});

describe("computeDailyReminder", () => {
  it("returns null with fewer than 3 recorded days", () => {
    const now = at(22, 0);
    expect(computeDailyReminder([rec(-1, 18, 0), rec(-2, 19, 0)], now)).toBeNull();
  });

  it("averages past workday last-send times and subtracts 20 minutes", () => {
    const now = at(22, 0);
    const info = computeDailyReminder(
      [rec(-1, 19, 0), rec(-2, 20, 0), rec(-3, 21, 0)], // 平均 20:00
      now,
    )!;
    expect(info).not.toBeNull();
    expect(info.days).toBe(3);
    expect(info.avgTime).toBe("20:00");
    expect(info.reminderTime.getHours()).toBe(19);
    expect(info.reminderTime.getMinutes()).toBe(40);
    expect(info.date).toBe(localDateStr(now));
  });

  it("clamps reminder to 17:00 when average is earlier", () => {
    const now = at(22, 0);
    const info = computeDailyReminder(
      [rec(-1, 10, 0), rec(-2, 10, 30), rec(-3, 11, 0)], // 平均 ~10:30 → 10:10,clamp
      now,
    )!;
    expect(info.reminderTime.getHours()).toBe(17);
    expect(info.reminderTime.getMinutes()).toBe(0);
  });

  it("excludes today (still in progress) and uses up to maxDays", () => {
    const now = at(22, 0);
    const records = [
      rec(0, 23, 0), // 今天,不计入
      rec(-1, 18, 0),
      rec(-2, 18, 30),
      rec(-3, 19, 0),
      rec(-4, 17, 30),
      rec(-5, 20, 0),
      rec(-6, 21, 0),
    ];
    const info = computeDailyReminder(records, now, { maxDays: 5 })!;
    expect(info.days).toBe(5);
    // 过去 5 天:18:00,18:30,19:00,17:30,20:00 → 平均 18:36 → 提前 20 → 18:16
    expect(info.avgTime).toBe("18:36");
    expect(info.reminderTime.getHours()).toBe(18);
    expect(info.reminderTime.getMinutes()).toBe(16);
  });
});

describe("DailySummaryReminder", () => {
  it("fires once inside the window and marks reminded", () => {
    const store = new ActivityStatsStore(dir);
    for (let i = 1; i <= 3; i++) store.recordActivity(at(19, 0, -i)); // 平均 19:00 → 提醒 18:40
    const now = at(18, 45); // 窗口内
    const notify = vi.fn().mockResolvedValue("dismiss" as const);
    const r = new DailySummaryReminder({ stats: store, now: () => now, notify });
    r.tick();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].avgTime).toBe("19:00");
    r.tick(); // 当日已标记,不重复
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does not fire before the reminder time", () => {
    const store = new ActivityStatsStore(dir);
    for (let i = 1; i <= 3; i++) store.recordActivity(at(19, 0, -i));
    const notify = vi.fn();
    const r = new DailySummaryReminder({ stats: store, now: () => at(18, 20), notify });
    r.tick();
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not fire with insufficient history", () => {
    const store = new ActivityStatsStore(dir);
    store.recordActivity(at(19, 0, -1));
    const notify = vi.fn();
    const r = new DailySummaryReminder({ stats: store, now: () => at(19, 0), notify });
    r.tick();
    expect(notify).not.toHaveBeenCalled();
  });
});
