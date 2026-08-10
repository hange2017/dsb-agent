import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { firstExistingDir, projectRulesDirCandidates, userRulesDirCandidates } from "./convention";

/** 规则条目:来源文件名(如 `.dsb/rules/style.md`)+ 全文内容。 */
export interface RuleEntry {
  /** 展示用相对名:项目级 `.dsb/rules/x.md` / `.claude/rules/x.md`,用户级 `~/.dsb/rules/x.md`。 */
  name: string;
  content: string;
  source: "project" | "user";
}

/**
 * 读取规则目录下所有 *.md 文件(本项目 `.dsb/rules/`,可回退 `.claude/rules/`):
 * - 项目级 `.dsb/rules/`(回退 `.claude/rules/`)在前,用户级 `~/.dsb/rules/`(回退 `~/.claude/rules/`)在后;
 * - 每级只取首个存在的目录(不混读两套根,与 skills 同策略);
 * - 文件按文件名排序,注入顺序稳定;
 * - 不可读/非 .md 一律跳过,绝不 throw(与 skillsScan 同策略)。
 */
export function readRules(workspaceRoot: string): RuleEntry[] {
  const projectDir = firstExistingDir(projectRulesDirCandidates(workspaceRoot));
  const userDir = firstExistingDir(userRulesDirCandidates());
  const project = projectDir ? scanRulesDir(projectDir, path.relative(workspaceRoot, projectDir), "project") : [];
  const user = userDir ? scanRulesDir(userDir, `~/${path.relative(os.homedir(), userDir)}`, "user") : [];
  return [...project, ...user];
}

function scanRulesDir(dir: string, displayBase: string, source: RuleEntry["source"]): RuleEntry[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: RuleEntry[] = [];
  for (const name of entries.sort((a, b) => a.localeCompare(b))) {
    if (!name.endsWith(".md")) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue; // 单个规则文件不可读,跳过
    }
    out.push({ name: `${displayBase}/${name}`, content, source });
  }
  return out;
}
