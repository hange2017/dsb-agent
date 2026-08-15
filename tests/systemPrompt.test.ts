import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/agent/systemPrompt";

describe("buildSystemPrompt platform segment", () => {
  it("injects Windows run-env with cmd shell guidance", () => {
    const p = buildSystemPrompt({ workspaceRoot: "/w", platform: "win32" });
    expect(p).toContain("## 运行环境");
    expect(p).toContain("Windows (win32)");
    expect(p).toContain("cmd.exe");
    expect(p).toContain("dir");
  });

  it("injects POSIX run-env on linux", () => {
    const p = buildSystemPrompt({ workspaceRoot: "/w", platform: "linux" });
    expect(p).toContain("## 运行环境");
    expect(p).toContain("/bin/bash");
    expect(p).toContain("ls");
  });

  it("omits run-env for unknown platform", () => {
    const p = buildSystemPrompt({ workspaceRoot: "/w", platform: "freebsd" as NodeJS.Platform });
    expect(p).not.toContain("## 运行环境");
  });

  it("still includes workspace root and core instructions", () => {
    const p = buildSystemPrompt({ workspaceRoot: "/w", platform: "win32" });
    expect(p).toContain("Workspace root: /w");
    expect(p).toContain("StrReplace");
  });
});
