import { describe, it, expect } from "vitest";
import { buildSessionProgressMemory } from "../src/session/sessionProgress";
import type { SessionEvent } from "../src/session/sessionTypes";

describe("buildSessionProgressMemory", () => {
  it("contains user text and open todo", () => {
    const events: SessionEvent[] = [
      { kind: "user", text: "帮我重构 sessionStore", timestamp: 1 },
      { kind: "assistant", text: "好的", final: true, timestamp: 2 },
    ];
    const todos = [
      { id: "1", content: "写测试", done: false },
      { id: "2", content: "提交", done: true },
    ];
    const entry = buildSessionProgressMemory({
      workspaceRoot: "/home/proj/dsbAgent",
      sessionId: "s_abc",
      events,
      todos,
    });
    expect(entry.name).toBe("session-progress-home-proj-dsbagent");
    expect(entry.description).toContain("1");
    expect(entry.description).toMatch(/待办/);
    expect(entry.body).toContain("帮我重构 sessionStore");
    expect(entry.body).toContain("写测试");
    expect(entry.body).toContain("s_abc");
    expect(entry.body.length).toBeLessThanOrEqual(4000);
    expect(typeof entry.updatedAt).toBe("number");
  });

  it("caps recent tools at 3 with truncated lines", () => {
    const tool = (name: string, command: string, ts: number): SessionEvent => ({
      kind: "tool",
      name,
      status: "completed",
      input: { command },
      detail: "",
      timestamp: ts,
    });
    const events: SessionEvent[] = [
      { kind: "user", text: "开始", timestamp: 1 },
      tool("Bash", "echo " + "x".repeat(500), 2),
      tool("Read", "read a", 3),
      tool("Bash", "npm test", 4),
      tool("Grep", "grep foo", 5),
      tool("Write", "write b", 6),
    ];
    const entry = buildSessionProgressMemory({
      workspaceRoot: "/tmp/p",
      sessionId: "s1",
      events,
      todos: [],
    });
    const body = entry.body;
    // 只保留最近 3 条工具(Write/Grep/Bash npm test),最早的 Bash echo 被挤出
    expect(body).toContain("Write: write b");
    expect(body).toContain("Grep: grep foo");
    expect(body).toContain("Bash: npm test");
    expect(body).not.toContain("Read: read a");
    expect(body).not.toContain("echo");
    // 每行不超过 100 字符 + 省略号
    for (const line of body.split("\n")) {
      if (line.startsWith("- ")) {
        expect(line.length).toBeLessThanOrEqual(105);
      }
    }
  });
});
