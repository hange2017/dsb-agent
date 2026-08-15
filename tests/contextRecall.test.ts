import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolExecutor } from "../src/agent/tools/executor";
import { MemoryStore } from "../src/agent/memory/memoryStore";
import { ContextStore } from "../src/context/contextStore";
import { isToolAllowed } from "../src/agent/modePolicy";
import { CONTEXT_RECALL_TOOL_DEF, contextRecallExecute } from "../src/agent/tools/contextRecallTool";
import type { RecallStat } from "../src/agent/tools/contextRecallTool";
import type { StatsStore } from "../src/stats/statsStore";
let tmp: string;
let store: ContextStore;
let exec: ToolExecutor;
let execNoStore: ToolExecutor;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crecall-"));
  store = new ContextStore(path.join(tmp, ".ctx"));
  store.append("s1", [
    { seq: 1, type: "demand", role: "user", summary: "需求摘要", content: "用户需求原文很长很长", ts: 1 },
    { seq: 2, type: "ledger", role: "assistant", summary: "Read: a.ts", content: "Read: a.ts", ts: 2 },
    { seq: 3, type: "conclusion", role: "assistant", summary: "结论摘要", content: "最终结论内容", ts: 3 },
  ]);
  exec = new ToolExecutor(
    new MemoryStore(path.join(tmp, ".mem")),
    undefined,
    undefined,
    undefined,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    store,
  );
  execNoStore = new ToolExecutor(new MemoryStore(path.join(tmp, ".mem")));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("ContextRecall executor", () => {
  it("recalls stored content by seq", async () => {
    const r = await exec.execute("ContextRecall", { seq: 3 }, { workspaceRoot: "/tmp", sessionId: "s1" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("[r3]");
    expect(r.content).toContain("最终结论内容");
  });

  it("returns miss with ok=false for unknown seq", async () => {
    const r = await exec.execute("ContextRecall", { seq: 99 }, { workspaceRoot: "/tmp", sessionId: "s1" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("no stored entry");
  });

  it("lists index without seq, capped and filterable by query", async () => {
    const r = await exec.execute("ContextRecall", {}, { workspaceRoot: "/tmp", sessionId: "s1" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("[r1] (demand/user)");
    expect(r.content).toContain("[r3] (conclusion/assistant)");
    const filtered = await exec.execute("ContextRecall", { query: "Read" }, { workspaceRoot: "/tmp", sessionId: "s1" });
    expect(filtered.content).toContain("[r2]");
    expect(filtered.content).not.toContain("[r1]");
  });

  it("fail-opens when no contextStore injected", async () => {
    const r = await execNoStore.execute("ContextRecall", { seq: 1 }, { workspaceRoot: "/tmp", sessionId: "s1" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("不可用");
  });

  it("invalid seq returns error", async () => {
    const r = await exec.execute("ContextRecall", { seq: "abc" }, { workspaceRoot: "/tmp", sessionId: "s1" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("seq must be a number");
  });

  it("query with no local hit falls back to cross-session search", async () => {
    store.append("s_old", [
      { seq: 1, type: "demand", role: "user", summary: "旧会话需求", content: "旧会话里讨论过基线压缩", ts: 1 },
      { seq: 2, type: "conclusion", role: "assistant", summary: "结论", content: "最终结论", ts: 2 },
    ]);
    const r = await exec.execute(
      "ContextRecall",
      { query: "旧会话" },
      { workspaceRoot: "/tmp", sessionId: "s1" },
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("跨会话检索");
    expect(r.content).toContain("[s_old]");
    expect(r.content).toContain("[r1]");
    expect(r.content).toContain("旧会话需求");
  });

  it("seq lookup stays within current session (no cross-session)", async () => {
    store.append("s_old", [{ seq: 1, type: "demand", role: "user", summary: "x", content: "旧会话内容", ts: 1 }]);
    const r = await exec.execute("ContextRecall", { seq: 1 }, { workspaceRoot: "/tmp", sessionId: "s1" });
    // s1 有 seq=1(需求摘要),不跨会话;若 s1 无 seq=1 则 miss
    expect(r.ok).toBe(true);
    expect(r.content).not.toContain("旧会话内容");
  });
});

describe("ContextRecall wiring", () => {
  it("is part of the advertised tool definitions", () => {
    const names = exec.allToolDefs().map((d) => d.name);
    expect(names).toContain("ContextRecall");
    expect(CONTEXT_RECALL_TOOL_DEF.name).toBe("ContextRecall");
  });

  it("is allowed in plan and ask modes", () => {
    expect(isToolAllowed("plan", "ContextRecall")).toBe(true);
    expect(isToolAllowed("ask", "ContextRecall")).toBe(true);
    expect(isToolAllowed("agent", "ContextRecall")).toBe(true);
  });
});

describe("ContextRecall stats (P0)", () => {
  const stats: string[][] = [];
  const onStat = (s: RecallStat) => stats.push([s.mode, s.seq ? String(s.seq) : "", String(s.results ?? "")]);

  beforeEach(() => {
    stats.length = 0;
  });

  it("reports seq_hit with seq and result count", () => {
    const r = contextRecallExecute(store, "s1", { seq: 3 }, onStat);
    expect(r.ok).toBe(true);
    expect(stats).toEqual([["seq_hit", "3", "1"]]);
  });

  it("reports seq_miss for unknown seq", () => {
    const r = contextRecallExecute(store, "s1", { seq: 99 }, onStat);
    expect(r.ok).toBe(false);
    expect(stats).toEqual([["seq_miss", "99", "0"]]);
  });

  it("reports index_hit with results and no seq", () => {
    const r = contextRecallExecute(store, "s1", {}, onStat);
    expect(r.ok).toBe(true);
    expect(stats[0][0]).toBe("index_hit");
    expect(stats[0][1]).toBe(""); // 无 seq
    expect(Number(stats[0][2])).toBeGreaterThanOrEqual(3);
  });

  it("reports index_empty for no-match query in current session", () => {
    const r = contextRecallExecute(store, "s1", { query: "zzz不存在" }, onStat);
    expect(r.ok).toBe(true);
    expect(stats[0][0]).toBe("index_empty");
    expect(Number(stats[0][2])).toBe(0);
  });

  it("reports cross_session when query falls back to other sessions", () => {
    store.append("s_old", [{ seq: 1, type: "demand", role: "user", summary: "旧会话需求", content: "x", ts: 1 }]);
    const r = contextRecallExecute(store, "s1", { query: "旧会话" }, onStat);
    expect(r.ok).toBe(true);
    expect(stats[0][0]).toBe("cross_session");
    expect(Number(stats[0][2])).toBeGreaterThanOrEqual(1);
  });

  it("executor records context_recall into injected statsStore; unavailable when no store", async () => {
    const rec = vi.fn();
    const fakeStats = { record: rec } as unknown as StatsStore;
    const execStats = new ToolExecutor(
      new MemoryStore(path.join(tmp, ".mem2")),
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      store,
      undefined, // platform(默认 process.platform)
      fakeStats,
    );
    await execStats.execute("ContextRecall", { seq: 3 }, { workspaceRoot: "/tmp", sessionId: "s1" });
    expect(rec).toHaveBeenCalledWith("context_recall", expect.objectContaining({ mode: "seq_hit", seq: 3 }));
    // 无冷存储:fail-open 且记录 unavailable
    const execNoStoreStats = new ToolExecutor(new MemoryStore(path.join(tmp, ".mem3")), undefined, undefined, undefined, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, fakeStats);
    await execNoStoreStats.execute("ContextRecall", { seq: 1 }, { workspaceRoot: "/tmp", sessionId: "s1" });
    expect(rec).toHaveBeenCalledWith("context_recall", { mode: "unavailable" });
  });
});
