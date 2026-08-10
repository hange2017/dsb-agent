import { execFile } from "child_process";
import * as path from "path";

/** create 的默认分支名前缀;remove 按此前缀识别并清理对应分支,防误删其他分支。 */
const BRANCH_PREFIX = "dsb-task-";

/**
 * git 工作树 API(引擎层,无 vscode 依赖):后台任务在隔离工作树中运行,
 * 完成后清理工作树,主分支不被污染。依赖注入 exec/getDefaultBranch 以便测试。
 */
export interface WorktreeApi {
  create(base: string, name?: string): Promise<{ path: string; branch: string }>;
  /** remove 也必须在仓库目录内执行(cwd=仓库根),否则扩展宿主 cwd 在仓库外时
   * `git worktree remove` 会报 "not a git repository" 且工作树残留注册。 */
  remove(path: string, opts?: { cwd?: string }): Promise<void>;
}

export class GitWorktree implements WorktreeApi {
  constructor(
    private readonly deps: {
      exec: (args: string[], opts?: { cwd?: string }) => Promise<string>;
      getDefaultBranch: () => Promise<string>;
    },
  ) {}

  async create(base: string, name = "dsb-task"): Promise<{ path: string; branch: string }> {
    const branch = `${name}-${Date.now().toString(36)}`;
    const wtPath = `${base}/.dsb/worktrees/${branch}`;
    const main = await this.deps.getDefaultBranch();
    await this.deps.exec(["worktree", "add", "-b", branch, "--track", wtPath, `origin/${main}`], { cwd: base });
    return { path: wtPath, branch };
  }

  async remove(wtPath: string, opts?: { cwd?: string }): Promise<void> {
    await this.deps.exec(["worktree", "remove", "--force", wtPath], opts);
    // best-effort 清理分支:`git worktree remove` 不删分支,create 生成的
    // wtPath = base/.dsb/worktrees/<branch>,basename 即分支名。仅按约定前缀
    // 删除,防误删其他分支;删分支失败忽略(分支残留是可容忍的资源泄漏,
    // 工作树清理失败才会导致注册残留,那才需要抛错)。
    const branch = path.basename(wtPath);
    if (branch.startsWith(BRANCH_PREFIX)) {
      try {
        await this.deps.exec(["branch", "-D", branch], opts);
      } catch {
        // ignore
      }
    }
  }
}

/** 生产 git exec:promisified `git <args>`(execFile,无新依赖);失败把 stderr 带进错误消息。 */
export function createGitExec(): (args: string[], opts?: { cwd?: string }) => Promise<string> {
  return (args, opts) =>
    new Promise<string>((resolve, reject) => {
      execFile("git", args, { cwd: opts?.cwd }, (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || "").trim() || String(err.message ?? err)));
        else resolve(stdout);
      });
    });
}

/**
 * 生产装配:用真实 execFile 后端构造 GitWorktree。
 * getDefaultBranch 依次解析:
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` 得到 origin 默认分支(origin/main → main);
 *   2. 失败(无 origin/HEAD)回退到仓库当前本地分支(`git branch --show-current`)——很多仓库
 *      有 origin 但从不建 origin/HEAD,旧代码一律回退 `master` 在默认分支是 main 时会让
 *      `git worktree add ... origin/master` 报"pathspec 不匹配"这类令人困惑的错误;
 *   3. 仍失败(非 git 仓库 / detached HEAD)才回退 `master`。
 * getBase 在命令时解析当前工作区,供 git 命令定位仓库根。
 */
export function createGitWorktree(getBase: () => string): WorktreeApi {
  const exec = createGitExec();
  return new GitWorktree({
    exec,
    getDefaultBranch: async () => {
      try {
        const out = await exec(["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: getBase() });
        const m = out.match(/refs\/remotes\/origin\/(.+)/);
        if (m) return m[1].trim();
      } catch {
        // 无 origin/HEAD,落入本地分支解析
      }
      try {
        const local = (await exec(["branch", "--show-current"], { cwd: getBase() })).trim();
        if (local) return local;
      } catch {
        // 非 git 仓库 / detached HEAD,落入 master
      }
      return "master";
    },
  });
}
