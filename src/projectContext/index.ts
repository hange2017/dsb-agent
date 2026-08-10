import { readProjectInstruction } from "./projectInstruction";
import { readProjectSettings } from "./settingsReader";
import { readRules, type RuleEntry } from "./rulesReader";
import { scanSkills, scanVscodeExtensionSkills, scanPluginSkills } from "./skillsScan";
import { readProjectOverview } from "./projectOverview";
import type { PermissionRules } from "../agent/permissionRules";
import type { SkillInfo } from "./skillsScan";

export interface ProjectContext {
  projectInstruction: string;
  permissionRules: PermissionRules;
  skills: SkillInfo[];
  /** 规则目录(.dsb/rules/ 等)注入 system prompt 的自然语言行为约束。 */
  rules: RuleEntry[];
  /** 项目框架文档(.dsb/docs/project-overview.md)全文;首次进入项目自动生成,无则空串。 */
  projectOverview: string;
  workspaceRoot: string;
}

export interface ProjectContextOpts {
  /** VSCode 扩展列表(chatViewProvider 传 vscode.extensions.all),扫描 extension 层技能。 */
  extensions?: ReadonlyArray<{ extensionPath: string }>;
  /** 插件缓存目录(globalStorageUri.fsPath),扫描 plugin 层技能。 */
  pluginCacheDir?: string;
}

export async function loadProjectContext(
  workspaceRoot: string,
  opts?: ProjectContextOpts,
): Promise<ProjectContext> {
  const settings = readProjectSettings(workspaceRoot);
  const skills = [
    ...scanSkills(workspaceRoot),
    ...(opts?.extensions ? scanVscodeExtensionSkills(opts.extensions) : []),
    ...(opts?.pluginCacheDir ? scanPluginSkills(opts.pluginCacheDir) : []),
  ];
  return {
    projectInstruction: readProjectInstruction(workspaceRoot),
    permissionRules: settings.permissionRules,
    skills,
    rules: readRules(workspaceRoot),
    projectOverview: readProjectOverview(workspaceRoot),
    workspaceRoot,
  };
}
