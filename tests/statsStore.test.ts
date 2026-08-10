import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StatsStore, statsLocalDate, type StatsEvent } from "../src/stats/statsStore";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "statsstore-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("StatsStore", () => {
  it("appends JSONL events per day and lists them newest-first", () => {
    const s = new StatsStore(dir);
    s.record("message_sent", { textLen: 10 });
    s.record("tool_completed", { name: "Read" });
    const events = s.list();
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("tool_completed"); // 新→旧
    expect(events[1].type).toBe("message_sent");
    const file = path.join(dir, `events-${statsLocalDate(new Date())}.jsonl`);
    expect(fs.existsSync(file)).toBe(true);
    // JSONL:每行一个 JSON
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe("message_sent");
  });

  it("filters by type and since", () => {
    const s = new StatsStore(dir);
    const past = Date.now() - 60_000;
    s.record("a");
    s.record("b");
    expect(s.list({ type: "a" })).toHaveLength(1);
    expect(s.list({ since: past }).length).toBeGreaterThanOrEqual(2);
    expect(s.list({ type: "a", since: Date.now() + 1000 })).toHaveLength(0);
  });

  it("counts by type", () => {
    const s = new StatsStore(dir);
    s.record("a");
    s.record("a");
    s.record("b");
    expect(s.count({ type: "a" })).toBe(2);
    expect(s.count()).toBe(3);
  });

  it("prunes event files older than maxAgeDays", () => {
    const s = new StatsStore(dir, { maxAgeDays: 2 });
    // 构造一个 3 天前的文件
    const old = new Date();
    old.setDate(old.getDate() - 3);
    const oldFile = path.join(dir, `events-${statsLocalDate(old)}.jsonl`);
    fs.writeFileSync(oldFile, JSON.stringify({ t: old.getTime(), type: "old" } satisfies StatsEvent) + "\n", "utf8");
    const freshFile = path.join(dir, `events-${statsLocalDate(new Date())}.jsonl`);
    fs.writeFileSync(freshFile, "", "utf8");
    s.prune();
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
  });

  it("survives corrupted single lines", () => {
    const s = new StatsStore(dir);
    s.record("good");
    const file = path.join(dir, `events-${statsLocalDate(new Date())}.jsonl`);
    fs.appendFileSync(file, "not-json\n", "utf8");
    const events = s.list();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("good");
  });
});
