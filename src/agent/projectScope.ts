import { createHash } from "crypto";

/** 最小 git 调用接口(便于单测注入假实现)。 */
export interface GitLike {
  (args: string[], opts?: { cwd?: string }): Promise<string>;
}

/** 真实实现:调用系统 git。 */
export const realGit: GitLike = async (args, opts) => {
  const cp = await import("child_process");
  const { promisify } = await import("util");
  const exec = promisify(cp.execFile);
  const { stdout } = await exec("git", args, {
    cwd: opts?.cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
};

/** 归一化 remote URL:去掉协议/用户信息/尾部 .git/大小写,scp-like 冒号转斜杠。 */
export function normalizeRemoteUrl(url: string): string {
  let u = url.trim();
  u = u.replace(/\.git$/i, "");
  u = u.replace(/^(https?|ssh|git):\/\//i, "");
  u = u.replace(/^git@/i, "");
  u = u.replace(/^[^@/]+@/, ""); // user@host → host
  u = u.replace(":", "/"); // git@host:path → host/path
  return u.toLowerCase();
}

/** 由 remote URL 生成稳定的短 projectKey(sha1 前 12 位)。 */
export function projectKeyFromRemote(url: string): string {
  const norm = normalizeRemoteUrl(url);
  return createHash("sha1").update(norm).digest("hex").slice(0, 12);
}

/** 无 git 时的回退:工作区路径 slug。 */
export function workspaceSlug(root: string): string {
  return root
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * 项目作用域解析器:同一 git 仓库(含不同 worktree 目录)归一到同一个 projectKey。
 * 通过 vscode workspace 根目录 + git remote origin 计算,带缓存、fail-open。
 */
export class ProjectScope {
  private cache = new Map<string, string>();
  private readonly workspaceRoots: () => readonly string[];

  constructor(
    private readonly exec: GitLike = realGit,
    workspaceRoots?: () => readonly string[],
  ) {
    this.workspaceRoots = workspaceRoots ?? (() => []);
  }

  async resolve(root: string): Promise<string> {
    const cached = this.cache.get(root);
    if (cached) return cached;
    const key = await this.compute(root);
    this.cache.set(root, key);
    return key;
  }

  /** 返回当前工作区的 projectKey(多根时取第一个可解析的)。 */
  async current(): Promise<string> {
    for (const root of this.workspaceRoots()) {
      try {
        return await this.resolve(root);
      } catch {
        // 继续尝试下一个根
      }
    }
    const first = this.workspaceRoots()[0];
    return first ? workspaceSlug(first) : "default";
  }

  private async compute(root: string): Promise<string> {
    try {
      const url = (await this.exec(["remote", "get-url", "origin"], { cwd: root })).trim();
      if (url) return projectKeyFromRemote(url);
    } catch {
      // fail-open:无法读取 git 信息时回退路径 slug
    }
    return workspaceSlug(root);
  }
}
