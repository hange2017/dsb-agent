import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolExecutor } from "../src/agent/tools/executor";
import { MemoryStore } from "../src/agent/memory/memoryStore";
import { ContextStore } from "../src/context/contextStore";
import { isToolAllowed } from "../src/agent/modePolicy";
import { CONTEXT_RECALL_TOOL_DEF } from "../src/agent/tools/contextRecallTool";
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
