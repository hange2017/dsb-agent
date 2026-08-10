import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GitWorktree, createGitWorktree } from "../src/agent/worktree";

/** 建一个带 origin 的真实仓库:有 origin/main 但 origin/HEAD 未设置(常见场景)。 */
function makeRepoWithOrigin(): { root: string; repo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-real-"));
  const repo = path.join(root, "repo");
  const bare = path.join(root, "origin.git");
  fs.mkdirSync(repo, { recursive: true });
  const run = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "f.txt"), "x");
  run(["add", "."]);
  run(["commit", "-m", "init"]);
  execFileSync("git", ["init", "--bare", bare], { cwd: repo, stdio: "ignore" });
  run(["remote", "add", "origin", bare]);
  run(["push", "-u", "origin", "main"]);
  run(["fetch", "origin"]);
  return { root, repo };
}

describe("GitWorktree", () => {
  it("creates a worktree", async () => {
    const exec = vi.fn(async (args: string[]) => `ran ${args.join(" ")}`);
    const wt = new GitWorktree({ exec, getDefaultBranch: async () => "main" });
    const r = await wt.create("/proj", "task");
    expect(r.branch).toContain("task-");
    expect(r.path).toContain(".dsb/worktrees");
    expect(exec).toHaveBeenCalledWith(expect.arrayContaining(["worktree", "add"]), expect.anything());
  });
  it("removes a worktree inside the repo (cwd threaded through)", async () => {
    const exec = vi.fn(async () => "");
    const wt = new GitWorktree({ exec, getDefaultBranch: async () => "main" });
    await wt.remove("/wt", { cwd: "/proj" });
    // remove 必须带仓库 cwd:扩展宿主 cwd 在仓库外时 `git worktree remove` 会找不到仓库
    expect(exec).toHaveBeenCalledWith(["worktree", "remove", "--force", "/wt"], { cwd: "/proj" });
  });
  it("deletes the matching dsb-task-* branch after removing the worktree", async () => {
    const exec = vi.fn(async () => "");
    const wt = new GitWorktree({ exec, getDefaultBranch: async () => "main" });
    await wt.remove("/proj/.dsb/worktrees/dsb-task-abc", { cwd: "/proj" });
    expect(exec).toHaveBeenCalledWith(
      ["worktree", "remove", "--force", "/proj/.dsb/worktrees/dsb-task-abc"],
      { cwd: "/proj" },
    );
    expect(exec).toHaveBeenCalledWith(["branch", "-D", "dsb-task-abc"], { cwd: "/proj" });
  });
  it("skips branch deletion for paths outside the dsb-task-* convention", async () => {
    const exec = vi.fn(async () => "");
    const wt = new GitWorktree({ exec, getDefaultBranch: async () => "main" });
    await wt.remove("/wt", { cwd: "/proj" });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).not.toHaveBeenCalledWith(expect.arrayContaining(["branch"]), expect.anything());
  });
  it("ignores branch deletion failures (best-effort)", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce("") // worktree remove 成功
      .mockRejectedValueOnce(new Error("no such branch")); // branch -D 失败
    const wt = new GitWorktree({ exec, getDefaultBranch: async () => "main" });
    await expect(wt.remove("/proj/.dsb/worktrees/dsb-task-abc", { cwd: "/proj" })).resolves.toBeUndefined();
  });
});

describe("createGitWorktree (real git)", () => {
  it("falls back to the current local branch when origin exists but origin/HEAD is unset", async () => {
    // 复现:有 origin、有 origin/main,但 origin/HEAD 从未设置(很多仓库如此)。
    // 旧 getDefaultBranch 在此处回退 "master",`worktree add ... origin/master` 失败;
    // 修复后回退到当前本地分支 main,`origin/main` 可解析。
    const { root, repo } = makeRepoWithOrigin();
    try {
      // 前置断言:origin/HEAD 确实未设置(否则本测试场景不成立)
      expect(() => execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: repo, stdio: "ignore" })).toThrow();

      const wt = createGitWorktree(() => repo);
      const created = await wt.create(repo);
      expect(created.branch).toContain("dsb-task-");
      // remove 带上仓库 cwd 后,即使测试进程 cwd 不是本仓库也能正确清理工作树
      await wt.remove(created.path, { cwd: repo });
      expect(fs.existsSync(created.path)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("removes the dsb-task-* branch together with the worktree (no residue)", async () => {
    const { root, repo } = makeRepoWithOrigin();
    try {
      const wt = createGitWorktree(() => repo);
      const created = await wt.create(repo);
      expect(execFileSync("git", ["branch", "--list", "dsb-task-*"], { cwd: repo, encoding: "utf8" }).trim()).toContain(created.branch);
      await wt.remove(created.path, { cwd: repo });
      expect(fs.existsSync(created.path)).toBe(false);
      // 回归防护:工作树清理后分支也必须被删除,仓库不留垃圾分支
      expect(execFileSync("git", ["branch", "--list", "dsb-task-*"], { cwd: repo, encoding: "utf8" }).trim()).toBe("");
      // 主分支未被污染
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim()).toBe("");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
