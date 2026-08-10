import { describe, it, expect } from "vitest";
import { isToolAllowed, modeSystemSegment, modeToastText, thinkingEnabledForMode } from "../src/agent/modePolicy";

describe("modePolicy", () => {
  it("agent allows everything including MCP tools", () => {
    expect(isToolAllowed("agent", "Write")).toBe(true);
    expect(isToolAllowed("agent", "mcp__server__tool")).toBe(true);
  });
  it("plan allows read-only core tools", () => {
    for (const t of ["Read", "Glob", "Grep", "LS", "WebSearch", "WebFetch", "MemoryRead", "TodoWrite"]) {
      expect(isToolAllowed("plan", t)).toBe(true);
    }
  });
  it("plan blocks write/bash/subagent/workflow/MCP tools", () => {
    for (const t of ["Write", "StrReplace", "Delete", "Bash", "Agent", "Workflow", "MemoryWrite", "mcp__srv__tool"]) {
      expect(isToolAllowed("plan", t)).toBe(false);
    }
  });
  it("ask is a narrower read-only subset", () => {
    expect(isToolAllowed("ask", "Read")).toBe(true);
    expect(isToolAllowed("ask", "Grep")).toBe(true);
    expect(isToolAllowed("ask", "WebSearch")).toBe(false);
    expect(isToolAllowed("ask", "TodoWrite")).toBe(false);
    expect(isToolAllowed("ask", "Write")).toBe(false);
  });
  it("system segments differ per mode; agent is empty", () => {
    expect(modeSystemSegment("agent")).toBe("");
    expect(modeSystemSegment("plan")).toContain("Plan 模式");
    expect(modeSystemSegment("ask")).toContain("Ask 模式");
  });
  it("toast text differs per mode", () => {
    expect(modeToastText("plan")).toContain("只读");
    expect(modeToastText("ask")).toContain("问答");
    expect(modeToastText("agent")).toContain("全量");
  });
  it("thinking compaction is enabled only in agent mode", () => {
    expect(thinkingEnabledForMode("agent")).toBe(true);
    expect(thinkingEnabledForMode("plan")).toBe(false);
    expect(thinkingEnabledForMode("ask")).toBe(false);
  });
});
