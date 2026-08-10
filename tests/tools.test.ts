import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolExecutor } from "../src/agent/tools/executor";
import { truncateToolResult } from "../src/agent/tools/executor";
import { MemoryStore } from "../src/agent/memory/memoryStore";
import { HookRunner } from "../src/hooks/hookRunner";
import type { SubagentFactory } from "../src/agent/subagentRunner";

let tmp: string;
let exec: ToolExecutor;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsa-"));
  fs.writeFileSync(path.join(tmp, "a.txt"), "hello world\nsecond line\n", "utf8");
  exec = new ToolExecutor(new MemoryStore(path.join(tmp, ".mem")));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("ToolExecutor", () => {
  it("Read reads a file", async () => {
    const r = await exec.execute("Read", { path: "a.txt" }, { workspaceRoot: tmp });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("hello world");
  });

  it("Write then StrReplace modifies a file", async () => {
    await exec.execute("Write", { path: "b.txt", contents: "foo bar" }, { workspaceRoot: tmp });
    const r = await exec.execute("StrReplace", { path: "b.txt", old_string: "foo", new_string: "baz" }, { workspaceRoot: tmp });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(tmp, "b.txt"), "utf8")).toBe("baz bar");
  });

  it("Glob finds files", async () => {
    const r = await exec.execute("Glob", { pattern: "*.txt" }, { workspaceRoot: tmp });
    expect(r.ok).toBe(true);
    expect(r.content.split("\n")).toContain("a.txt");
  });

  it("Glob handles **, root-level matches and special chars", async () => {
    fs.mkdirSync(path.join(tmp, "sub"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "sub", "b.txt"), "nested", "utf8");
    fs.writeFileSync(path.join(tmp, "weird+.txt"), "x", "utf8");

    const star = await exec.execute("Glob", { pattern: "*.txt" }, { workspaceRoot: tmp });
    const starFiles = star.content.split("\n");
    expect(starFiles).toContain("a.txt");
    expect(starFiles).not.toContain("sub/b.txt");

    const dstar = await exec.execute("Glob", { pattern: "**/*.txt" }, { workspaceRoot: tmp });
    const dstarFiles = dstar.content.split("\n");
    expect(dstarFiles).toContain("a.txt");
    expect(dstarFiles).toContain("sub/b.txt");

    // `+` 等特殊字符应被字面匹配,不破坏正则
    const special = await exec.execute("Glob", { pattern: "weird+.txt" }, { workspaceRoot: tmp });
    expect(special.content.split("\n")).toContain("weird+.txt");
  });

  it("LS lists entries", async () => {
    const r = await exec.execute("LS", { path: "." }, { workspaceRoot: tmp });
    expect(r.content).toContain("a.txt");
  });

  it("Grep finds a match and reports no matches", async () => {
    const hit = await exec.execute("Grep", { pattern: "hello" }, { workspaceRoot: tmp });
    expect(hit.ok).toBe(true);
    expect(hit.content).toContain("a.txt");
    const miss = await exec.execute("Grep", { pattern: "definitely-not-present" }, { workspaceRoot: tmp });
    expect(miss.ok).toBe(true);
    expect(miss.content).toContain("(no matches)");
  });

  it("Grep uses ctx.ripgrepPath absolute binary when provided", async () => {
    let rgBin: string | undefined;
    try {
      const mod = (await import("@vscode/ripgrep")) as { rgPath?: string };
      rgBin = mod.rgPath;
    } catch {
      rgBin = undefined;
    }
    if (!rgBin || !fs.existsSync(rgBin)) return;
    const hit = await exec.execute(
      "Grep",
      { pattern: "hello" },
      { workspaceRoot: tmp, ripgrepPath: rgBin },
    );
    expect(hit.ok).toBe(true);
    expect(hit.content).toContain("a.txt");
  });

  it("Bash runs a command", async () => {
    const r = await exec.execute("Bash", { command: "echo hi" }, { workspaceRoot: tmp });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("hi");
  });

  it("Bash non-zero exit is completed (ok:true) with output", async () => {
    const r = await exec.execute("Bash", { command: "exit 3" }, { workspaceRoot: tmp });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("exit=3");
  });

  it("Read missing file is completed (ok:true) with message", async () => {
    const r = await exec.execute("Read", { path: "missing.txt" }, { workspaceRoot: tmp });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("missing.txt");
  });

  it("WebFetch non-200 is completed (ok:true)", async () => {
    // 直接调 webFetch 并注入 fake fetch,绕过真实网络;非 200 也视为执行完成(绿)
    const { webFetch } = await import("../src/agent/tools/webTools");
    const r = await webFetch("https://x", async () => ({ ok: false, status: 404, text: async () => "not found" }) as Response);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("404");
  });

  it("StrReplace no-match is completed (ok:true)", async () => {
    const r = await exec.execute("StrReplace", { path: "a.txt", old_string: "not-in-file", new_string: "x" }, { workspaceRoot: tmp });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("No match");
  });

  it("Read EACCES on an unreadable file stays red (ok:false)", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return; // chmod 测试在 root/Windows 不可靠
    const secret = path.join(tmp, "secret.txt");
    fs.writeFileSync(secret, "top secret", "utf8");
    fs.chmodSync(secret, 0o000);
    try {
      const r = await exec.execute("Read", { path: "secret.txt" }, { workspaceRoot: tmp });
      expect(r.ok).toBe(false);
    } finally {
      fs.chmodSync(secret, 0o644);
    }
  });

  it("rejects path escapes", async () => {
    const r = await exec.execute("Read", { path: "../secret.txt" }, { workspaceRoot: tmp });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("escapes");
  });

  it("rejects symlink escapes", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dsa-out-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "top secret", "utf8");
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(tmp, "link.txt"));
      const r = await exec.execute("Read", { path: "link.txt" }, { workspaceRoot: tmp });
      expect(r.ok).toBe(false);
      expect(r.content).toContain("escapes");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("Delete removes a file", async () => {
    await exec.execute("Delete", { path: "a.txt" }, { workspaceRoot: tmp });
    expect(fs.existsSync(path.join(tmp, "a.txt"))).toBe(false);
  });

  it("truncates long results", () => {
    const out = truncateToolResult("x".repeat(200), 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).toContain("...[truncated]...");
  });
});

describe("Memory tools (executor routes)", () => {
  it("writes, reads, lists, deletes via the executor", async () => {
    const w = await exec.execute("MemoryWrite", { name: "user-pref", description: "d", body: "hello body" }, { workspaceRoot: tmp });
    expect(w.ok).toBe(true);
    expect(w.content).toContain("user-pref");
    const r = await exec.execute("MemoryRead", { name: "user-pref" }, { workspaceRoot: tmp });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("hello body");
    const l = await exec.execute("MemoryList", {}, { workspaceRoot: tmp });
    expect(l.ok).toBe(true);
    expect(l.content).toContain("user-pref");
    const d = await exec.execute("MemoryDelete", { name: "user-pref" }, { workspaceRoot: tmp });
    expect(d.ok).toBe(true);
    const l2 = await exec.execute("MemoryList", {}, { workspaceRoot: tmp });
    expect(l2.content).toContain("(no memories)");
  });

  it("MemoryRead of a missing memory reports not found", async () => {
    const r = await exec.execute("MemoryRead", { name: "nope" }, { workspaceRoot: tmp });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("not found");
  });

  it("registers the memory tool defs in CORE_TOOLS", () => {
    const names = exec.toolDefs.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["MemoryWrite", "MemoryRead", "MemoryList", "MemoryDelete"]));
  });
});

describe("ToolExecutor Workflow", () => {
  it("propagates the parent abort to running AND queued stages (no hang, mapped to stage error)", async () => {
    // 阶段子会话:send 只在 abort 时 resolve(模拟嵌套 AgentSession 被 cancel 后返回)。
    // 修复前 Workflow 分支不接线信号,父 Stop 后 a/b 会一直挂着直到超时;修复后 abort
    // 经 runSubagent → session.cancel 让运行中阶段快速收敛,队列阶段(此处 c)立即 Aborted。
    const made: AbortController[] = [];
    const factory: SubagentFactory = () => {
      const ac = new AbortController();
      made.push(ac);
      return {
        send: () =>
          new Promise<string>((resolve) => {
            ac.signal.addEventListener("abort", () => resolve("interrupted"), { once: true });
          }),
        cancel: () => ac.abort(),
      };
    };
    const exec = new ToolExecutor(new MemoryStore(path.join(tmp, ".mem")), undefined, undefined, factory, 0);
    const ac = new AbortController();
    const runP = exec.execute(
      "Workflow",
      {
        goal: "g",
        stages: [
          { id: "a", prompt: "A", dependsOn: [] },
          { id: "b", prompt: "B", dependsOn: [] },
          { id: "c", prompt: "C", dependsOn: ["a", "b"] },
        ],
      },
      { workspaceRoot: tmp, signal: ac.signal },
    );
    await vi.waitFor(() => expect(made.length).toBe(2)); // a、b 已并行启动
    ac.abort();
    const r = await runP; // 不应挂起:所有阶段(含队列中的 c)都因取消快速收敛
    expect(r.ok).toBe(true);
    // 取消的阶段以 "ERROR: Aborted" 阶段结果文本呈现,而非从工具执行抛出
    expect(r.content).toContain("ERROR: Aborted");
    // 队列阶段 c 未再构造子会话(信号已中止,runSubagent 直接返回)
    expect(made.length).toBe(2);
  });

  it("returns immediately when the signal is already aborted before the workflow starts", async () => {
    const made: AbortController[] = [];
    const factory: SubagentFactory = () => {
      const ac = new AbortController();
      made.push(ac);
      return { send: async () => "x", cancel: () => ac.abort() };
    };
    const exec = new ToolExecutor(new MemoryStore(path.join(tmp, ".mem")), undefined, undefined, factory, 0);
    const ac = new AbortController();
    ac.abort();
    const r = await exec.execute(
      "Workflow",
      { goal: "g", stages: [{ id: "a", prompt: "A", dependsOn: [] }] },
      { workspaceRoot: tmp, signal: ac.signal },
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("ERROR: Aborted");
    expect(made.length).toBe(0); // 未启动任何子会话
  });
});

describe("Agent tool (agent param)", () => {
  // 复用 Workflow 测试的构造约定:第 4 位是 subagentFactory,getAgentTemplate 追加在构造参数末位。
  function agentExec(factory: SubagentFactory, getAgentTemplate?: (name: string) => { system: string } | undefined): ToolExecutor {
    return new ToolExecutor(
      new MemoryStore(path.join(tmp, ".mem")),
      undefined,
      undefined,
      factory,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      getAgentTemplate,
    );
  }

  it("resolves the agent param to the template system and passes it to the subagent", async () => {
    const received: string[] = [];
    const factory: SubagentFactory = (opts) => {
      received.push(opts.systemPrompt);
      return { send: async () => "done", cancel: () => {} };
    };
    const exec = agentExec(factory, (name) => (name === "reviewer" ? { system: "你是审查者。" } : undefined));
    const r = await exec.execute("Agent", { task: "x", agent: "reviewer" }, { workspaceRoot: tmp });
    expect(r.ok).toBe(true);
    expect(received[0]).toContain("你是审查者。");
  });

  it("falls back to the inline system param when no agent is given", async () => {
    const received: string[] = [];
    const factory: SubagentFactory = (opts) => {
      received.push(opts.systemPrompt);
      return { send: async () => "done", cancel: () => {} };
    };
    const exec = agentExec(factory, () => undefined);
    const r = await exec.execute("Agent", { task: "x", system: "内联角色。" }, { workspaceRoot: tmp });
    expect(r.ok).toBe(true);
    expect(received[0]).toContain("内联角色。");
  });

  it("reports an unknown agent as an error and does not spawn a subagent", async () => {
    let spawned = false;
    const factory: SubagentFactory = () => {
      spawned = true;
      return { send: async () => "done", cancel: () => {} };
    };
    const exec = agentExec(factory, (name) => (name === "reviewer" ? { system: "你是审查者。" } : undefined));
    const r = await exec.execute("Agent", { task: "x", agent: "nope" }, { workspaceRoot: tmp });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("Unknown agent: nope");
    expect(spawned).toBe(false);
  });
});

describe("ToolExecutor hooks", () => {
  function hookExec(rules: Array<{ event: "PreToolUse" | "PostToolUse"; matcher: string; command: string }>, calls: string[]): ToolExecutor {
    const hooks = new HookRunner(rules, {
      run: async (c) => {
        calls.push(c);
        return "";
      },
    });
    return new ToolExecutor(new MemoryStore(path.join(tmp, ".mem")), undefined, undefined, undefined, 0, undefined, undefined, hooks);
  }

  it("fires PreToolUse before and PostToolUse after a successful matching tool", async () => {
    const calls: string[] = [];
    const h = hookExec(
      [
        { event: "PreToolUse", matcher: "Write", command: "pre" },
        { event: "PostToolUse", matcher: "Write", command: "post" },
      ],
      calls,
    );
    const r = await h.execute("Write", { path: "c.txt", contents: "x" }, { workspaceRoot: tmp });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["pre", "post"]);
  });

  it("skips hooks for non-matching tools", async () => {
    const calls: string[] = [];
    const h = hookExec(
      [
        { event: "PreToolUse", matcher: "Write", command: "pre" },
        { event: "PostToolUse", matcher: "Write", command: "post" },
      ],
      calls,
    );
    await h.execute("Read", { path: "a.txt" }, { workspaceRoot: tmp });
    expect(calls).toEqual([]);
  });

  it("does not fire PostToolUse when the tool fails", async () => {
    const calls: string[] = [];
    const hooks = new HookRunner(
      [
        { event: "PreToolUse", matcher: "Read", command: "pre" },
        { event: "PostToolUse", matcher: "Read", command: "post" },
      ],
      { run: async (c) => { calls.push(c); return ""; } },
    );
    const h = new ToolExecutor(new MemoryStore(path.join(tmp, ".mem")), undefined, undefined, undefined, 0, undefined, undefined, hooks);
    // 用路径逃逸作为「真正失败」的样例:Read 缺失文件已改判 ok:true(执行完成态),只有安全拒绝仍是 ok:false
    const r = await h.execute("Read", { path: "../secret.txt" }, { workspaceRoot: tmp });
    expect(r.ok).toBe(false);
    expect(calls).toEqual(["pre"]);
  });

  it("a failing hook does not break the tool (fail-open)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const hooks = new HookRunner([{ event: "PreToolUse", matcher: "*", command: "boom" }], {
        run: async () => { throw new Error("hook exploded"); },
      });
      const h = new ToolExecutor(new MemoryStore(path.join(tmp, ".mem")), undefined, undefined, undefined, 0, undefined, undefined, hooks);
      const r = await h.execute("Read", { path: "a.txt" }, { workspaceRoot: tmp });
      expect(r.ok).toBe(true);
      expect(r.content).toContain("hello world");
    } finally {
      warn.mockRestore();
    }
  });
});
