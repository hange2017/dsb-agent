import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** 本项目约定根目录:.dsb/ 优先;旧 .cxxxp/、.deepseek/、.claude/ 只读回退。 */
export const CONVENTION_DIR = ".dsb";
/** @deprecated 短暂用过的约定根,仅只读回退。 */
export const LEGACY_CXXXP_DIR = ".cxxxp";
/** @deprecated 旧产品约定根,仅只读回退。 */
export const LEGACY_PRODUCT_DIR = ".deepseek";
export const LEGACY_DIR = ".claude";

export const SETTINGS_FILES = ["settings.json", "settings.local.json"];

const ROOT_ORDER = [CONVENTION_DIR, LEGACY_CXXXP_DIR, LEGACY_PRODUCT_DIR, LEGACY_DIR] as const;

/** 项目指令文件候选(顶层 + 约定根内)。 */
export function projectInstructionCandidates(workspaceRoot: string): string[] {
  return [
    path.join(workspaceRoot, "DSB.md"),
    path.join(workspaceRoot, CONVENTION_DIR, "DSB.md"),
    path.join(workspaceRoot, "CXXXP.md"),
    path.join(workspaceRoot, LEGACY_CXXXP_DIR, "CXXXP.md"),
    path.join(workspaceRoot, "DEEPSEEK.md"),
    path.join(workspaceRoot, LEGACY_PRODUCT_DIR, "DEEPSEEK.md"),
    path.join(workspaceRoot, "CLAUDE.md"),
    path.join(workspaceRoot, LEGACY_DIR, "CLAUDE.md"),
  ];
}

/** 生效的约定根顺序见 ROOT_ORDER;都不存在返回 `.dsb/`。 */
export function activeSettingsRoot(workspaceRoot: string): string {
  for (const r of ROOT_ORDER) {
    try {
      if (fs.statSync(path.join(workspaceRoot, r)).isDirectory()) return r;
    } catch {
      // 不存在/不可读,继续下一个
    }
  }
  return CONVENTION_DIR;
}

function dirCandidates(base: string, leaf: "skills" | "rules"): string[] {
  return ROOT_ORDER.map((r) => path.join(base, r, leaf));
}

/** 项目级技能目录候选。 */
export function projectSkillDirCandidates(workspaceRoot: string): string[] {
  return dirCandidates(workspaceRoot, "skills");
}

/** 用户级技能目录候选。 */
export function userSkillDirCandidates(): string[] {
  return dirCandidates(os.homedir(), "skills");
}

/** 项目级规则目录候选。 */
export function projectRulesDirCandidates(workspaceRoot: string): string[] {
  return dirCandidates(workspaceRoot, "rules");
}

/** 用户级规则目录候选。 */
export function userRulesDirCandidates(): string[] {
  return dirCandidates(os.homedir(), "rules");
}

export function firstExistingFile(candidates: string[]): string | undefined {
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // 不存在/不可读,跳过
    }
  }
  return undefined;
}

export function firstExistingDir(candidates: string[]): string | undefined {
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
      // 跳过
    }
  }
  return undefined;
}
