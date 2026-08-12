/**
 * SWE-bench-Live 实例适配:
 * - SwebenchInstance 类型(兼容官方 instances JSON 字段)
 * - buildProblemPrompt:构造标准 SWE-bench request prompt
 * - prepareRepo:clone repo + checkout base_commit
 * - collectPatch:send 结束后从工作区提取 git diff 作为预测 patch
 */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

/** SWE-bench-Live 官方实例字段(宽松解析,只读需要字段)。 */
export interface SwebenchInstance {
  instance_id: string;
  repo: string; // "owner/repo"
  base_commit: string;
  problem_statement: string;
  patch?: string; // 参考答案(评测用;打榜时不给模型)
  test_patch?: string;
  [key: string]: unknown;
}

/** 读取实例 JSON 文件(单个实例对象或数组)。 */
export function readInstances(file: string): SwebenchInstance[] {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  const arr = Array.isArray(raw) ? raw : [raw];
  const out: SwebenchInstance[] = [];
  for (const x of arr) {
    const r = x as Record<string, unknown>;
    if (typeof r.instance_id !== "string" || typeof r.repo !== "string" || typeof r.base_commit !== "string") {
      throw new Error(`Invalid instance (missing instance_id/repo/base_commit): ${file}`);
    }
    out.push({
      instance_id: r.instance_id,
      repo: r.repo,
      base_commit: r.base_commit,
      problem_statement: typeof r.problem_statement === "string" ? r.problem_statement : "",
      patch: typeof r.patch === "string" ? r.patch : undefined,
      test_patch: typeof r.test_patch === "string" ? r.test_patch : undefined,
    });
  }
  return out;
}

/** 标准 SWE-bench request prompt(与官方 agent 接口一致的正文形态)。 */
export function buildProblemPrompt(inst: SwebenchInstance): string {
  return [
    "We are currently solving the following issue within our repository. Here is the issue text:",
    "--- BEGIN REQUEST ---",
    inst.problem_statement,
    "--- END REQUEST ---",
    "",
    "Please inspect the repository, find the root cause, and implement a fix.",
    "Do NOT commit your changes. Leave them in the working tree so we can collect `git diff`.",
    "When you believe the fix is complete, run `git diff` yourself and report it as your final answer.",
  ].join("\n");
}

/**
 * 准备实例工作目录:clone repo(如不存在)+ checkout base_commit。
 * 返回 repo 目录;已存在时跳过 clone(断点续跑友好)。
 */
export function prepareRepo(workDir: string, inst: SwebenchInstance, git = "git"): string {
  const repoDir = path.join(workDir, inst.instance_id);
  const gitDir = path.join(repoDir, ".git");
  if (!fs.existsSync(gitDir)) {
    fs.mkdirSync(workDir, { recursive: true });
    console.log(`[swebench] cloning ${inst.repo} ...`);
    execSync(`"${git}" clone --quiet https://github.com/${inst.repo}.git "${repoDir}"`, { stdio: "inherit" });
  }
  console.log(`[swebench] checkout ${inst.base_commit} ...`);
  execSync(`"${git}" -C "${repoDir}" checkout --quiet ${inst.base_commit}`, { stdio: "inherit" });
  return repoDir;
}

/** 提取预测 patch:优先工作区 diff,其次 HEAD diff(agent 若 commit 过)。 */
export function collectPatch(repoDir: string, git = "git"): string {
  try {
    const diff = execSync(`"${git}" -C "${repoDir}" diff`, { encoding: "utf8" }).trim();
    if (diff.length > 0) return diff;
  } catch {
    // fall through
  }
  try {
    const diffHead = execSync(`"${git}" -C "${repoDir}" diff HEAD`, { encoding: "utf8" }).trim();
    return diffHead;
  } catch {
    return "";
  }
}

/** 检查 git 是否可用。 */
export function ensureGit(git = "git"): void {
  try {
    execSync(`"${git}" --version`, { stdio: "pipe" });
  } catch {
    throw new Error(`git not available (tried: ${git}). SWE-bench-Live runner requires git.`);
  }
}
