import { describe, it, expect } from "vitest";
import {
  ProjectScope,
  normalizeRemoteUrl,
  projectKeyFromRemote,
  workspaceSlug,
} from "../src/agent/projectScope";

describe("normalizeRemoteUrl", () => {
  it("strips protocol, trailing .git, user info, and case", () => {
    expect(normalizeRemoteUrl("https://github.com/user/repo.git")).toBe("github.com/user/repo");
    expect(normalizeRemoteUrl("git@github.com:user/repo.git")).toBe("github.com/user/repo");
    expect(normalizeRemoteUrl("ssh://git@github.com/user/repo")).toBe("github.com/user/repo");
    expect(normalizeRemoteUrl("git://github.com/user/repo/")).toBe("github.com/user/repo/");
    expect(normalizeRemoteUrl("HTTPS://GitHub.com/User/Repo.git")).toBe("github.com/user/repo");
    expect(normalizeRemoteUrl("https://toke@github.com/org/proj")).toBe("github.com/org/proj");
  });

  it("normalizes scp-like colon to slash so https/ssh forms share one key", () => {
    expect(projectKeyFromRemote("git@github.com:user/repo.git")).toBe(
      projectKeyFromRemote("https://github.com/user/repo.git"),
    );
  });
});

describe("ProjectScope", () => {
  it("resolves projectKey from git remote and caches per root", async () => {
    let calls = 0;
    const scope = new ProjectScope(async () => {
      calls++;
      return "https://github.com/user/repo.git";
    });
    const k1 = await scope.resolve("/ws/a");
    const k2 = await scope.resolve("/ws/a");
    expect(k1).toBe(projectKeyFromRemote("https://github.com/user/repo.git"));
    expect(k2).toBe(k1);
    expect(calls).toBe(1); // 缓存:同 root 只 exec 一次
  });

  it("falls back to path slug when git fails (fail-open)", async () => {
    const scope = new ProjectScope(async () => {
      throw new Error("not a git repository");
    });
    expect(await scope.resolve("/home/hange/Proj X")).toBe(workspaceSlug("/home/hange/Proj X"));
  });

  it("falls back to path slug when origin remote is empty", async () => {
    const scope = new ProjectScope(async () => "");
    expect(await scope.resolve("/home/hange/no-remote")).toBe("home-hange-no-remote");
  });

  it("same remote across different worktree roots yields the same key", async () => {
    const scope = new ProjectScope(async () => "git@github.com:user/repo.git");
    const k1 = await scope.resolve("/ws/main");
    const k2 = await scope.resolve("/ws/.dsb/worktrees/task-x");
    expect(k1).toBe(k2);
  });
});
