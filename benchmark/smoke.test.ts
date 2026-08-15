/**
 * benchmark 冒烟测试:不产生 API 费用,验证 headless 装配链路。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { ScriptedProvider } from "./provider";
import { CostTracker } from "./stats";
import { buildSession } from "./deps";
import { buildProblemPrompt, collectPatch, readInstances } from "./swebench";
import type { SwebenchInstance } from "./swebench";

let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsb-bench-smoke-"));
  execSync('git init -q', { cwd: workDir });
  execSync('git config user.email smoke@test.local && git config user.name smoke', { cwd: workDir });
  fs.writeFileSync(path.join(workDir, "a.txt"), "hello\n");
  execSync('git add -A && git commit -qm init', { cwd: workDir });
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

const inst: SwebenchInstance = {
  instance_id: "test/repo--123",
  repo: "test/repo",
  base_commit: "abc123",
  problem_statement: "Fix the bug in a.txt: 'hello' should be 'world'.",
};

describe("swebench helpers", () => {
  it("buildProblemPrompt wraps the issue", () => {
    const p = buildProblemPrompt(inst);
    expect(p).toContain("BEGIN REQUEST");
    expect(p).toContain("Fix the bug");
    expect(p).toContain("git diff");
  });

  it("readInstances parses single object and array", () => {
    const f = path.join(workDir, "inst.json");
    fs.writeFileSync(f, JSON.stringify(inst));
    expect(readInstances(f)).toHaveLength(1);
    fs.writeFileSync(f, JSON.stringify([inst, inst]));
    expect(readInstances(f)).toHaveLength(2);
  });

  it("collectPatch returns working-tree diff", () => {
    fs.writeFileSync(path.join(workDir, "a.txt"), "world\n");
    const patch = collectPatch(workDir);
    expect(patch).toContain("a.txt");
    expect(patch).toContain("hello");
    expect(patch).toContain("world");
    execSync('git checkout -q -- .', { cwd: workDir });
  });
});

describe("CostTracker", () => {
  it("summarizes rounds and cost", () => {
    const t = new CostTracker(0.005);
    t.onProviderRound({ inputTokens: 100, outputTokens: 50, phase: "chat", roundMs: 10 });
    t.onProviderRound({ inputTokens: 200, outputTokens: 40, phase: "chat", roundMs: 20 });
    t.onProviderRound({ inputTokens: 300, outputTokens: 30, cacheReadTokens: 250, cacheWriteTokens: 50, phase: "chat", roundMs: 30 });
    const s = t.summary();
    expect(s.calls).toBe(3);
    expect(s.inputTokens).toBe(600);
    expect(s.outputTokens).toBe(120);
    expect(s.cacheReadTokens).toBe(250);
    expect(s.costCNY).toBeCloseTo(0.015, 5);
    expect(s.cacheHitRate).toBeCloseTo(250 / 300, 5);
  });
});

describe("headless session with ScriptedProvider", () => {
  it("runs agent loop and writes a file via Bash tool", async () => {
    const provider = new ScriptedProvider([
      () => ({
        blocks: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo world >> a.txt" } }],
        toolUses: [{ id: "t1", name: "Bash", input: { command: "echo world >> a.txt" } }],
        usage: { inputTokens: 100, outputTokens: 20 },
      }),
      () => ({
        blocks: [{ type: "text", text: "Done." }],
        toolUses: [],
        usage: { inputTokens: 150, outputTokens: 30 },
      }),
    ]);
    const tracker = new CostTracker(0.005);
    const session = buildSession({
      provider,
      workspaceRoot: workDir,
      workDir,
      maxRounds: 10,
      tracker,
    });
    let done = false;
    let error: string | undefined;
    await session.send("please fix a.txt", (ev) => {
      if (ev.type === "done") done = true;
      if (ev.type === "error") error = ev.message;
    });
    expect(error).toBeUndefined();
    expect(done).toBe(true);
    expect(tracker.summary().calls).toBe(2);
    // Bash 工具通过 cmd 执行,`echo world >> a.txt` 应追加内容
    const content = fs.readFileSync(path.join(workDir, "a.txt"), "utf8");
    expect(content.replace(/\r\n/g, "\n").trim()).toBe("hello\nworld");
  });
});
