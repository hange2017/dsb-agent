import { describe, it, expect } from "vitest";
import { runSubagent, MAX_SUBAGENT_DEPTH, type SubagentFactory } from "../src/agent/subagentRunner";

describe("runSubagent", () => {
  it("runs a subagent and returns its answer", async () => {
    const factory: SubagentFactory = () => ({
      send: async (_t, onEvent) => {
        onEvent({ type: "text_delta", text: "result" });
        return "result";
      },
      cancel: () => {},
    });
    const r = await runSubagent(factory, "task", undefined, 0);
    expect(r.ok).toBe(true);
    expect(r.content).toBe("result");
  });
  it("caps depth (exactly MAX_SUBAGENT_DEPTH is blocked, off-by-one fixed)", async () => {
    const factory: SubagentFactory = () => ({ send: async () => "", cancel: () => {} });
    const r = await runSubagent(factory, "t", undefined, MAX_SUBAGENT_DEPTH);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("depth");
    const r2 = await runSubagent(factory, "t", undefined, MAX_SUBAGENT_DEPTH + 1);
    expect(r2.ok).toBe(false);
  });
  it("turns a nested failure into ok:false when send throws (wrapper detects the error event)", async () => {
    // 模拟 chatViewProvider 包装:send 检测到嵌套会话的 error 事件后 throw,
    // runSubagent 的 catch 必须把它转成 ok:false,而不是把部分文本当成功返回。
    const factory: SubagentFactory = () => ({
      send: async (_t, onEvent) => {
        onEvent({ type: "error", message: "model exploded" });
        throw new Error("model exploded");
      },
      cancel: () => {},
    });
    const r = await runSubagent(factory, "task", undefined, 0);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("model exploded");
  });
  it("cancels the nested session when the parent signal aborts", async () => {
    const ac = new AbortController();
    let cancelled = false;
    let release: (() => void) | undefined;
    const factory: SubagentFactory = () => ({
      send: () =>
        new Promise<string>((resolve) => {
          release = () => resolve("partial");
        }),
      cancel: () => {
        cancelled = true;
        release?.();
      },
    });
    const pending = runSubagent(factory, "task", undefined, 0, ac.signal);
    ac.abort();
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(r.content).toContain("Aborted");
    expect(cancelled).toBe(true);
  });
  it("returns Aborted without spawning a session when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    let factoryCalled = false;
    const factory: SubagentFactory = () => {
      factoryCalled = true;
      return { send: async () => "", cancel: () => {} };
    };
    const r = await runSubagent(factory, "t", undefined, 0, ac.signal);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("Aborted");
    expect(factoryCalled).toBe(false);
  });
});
