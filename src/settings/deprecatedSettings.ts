/**
 * 已废弃配置键的登记表 + 清理决策(纯逻辑,不依赖 `vscode`,便于单测)。
 *
 * 背景:配置键从 `package.json` 的 `contributes.configuration` 移除后,用户 `settings.json`
 * 里的残留值不会被 VS Code 自动删除 —— 它只会被标记为 "Unknown Configuration Setting"。
 * 用户读到自己设的 `"dsbAgent.thinking.enabled": false` 会以为「思考已关」,实际该键已无人读取,
 * 属于**认知误导**(影响所有调优判断)。故激活时按本表主动清理残留。
 *
 * 只清理**用户确实设过值**的作用域;`defaultValue` 不落盘、无需处理。
 */

/** 一个已废弃的配置键及其替代物/废弃原因。 */
export interface DeprecatedSetting {
  /** 完整配置键(如 `dsbAgent.thinking.enabled`)。 */
  key: string;
  /** 语义替代者(写入日志,便于用户迁移)。 */
  replacedBy: string;
  /** 废弃原因(写入日志)。 */
  reason: string;
}

/**
 * 废弃键登记表。新增项务必同时确认 `package.json` 已不再声明该键
 * (否则会误删活键 —— 见本文件末尾自愈约束)。
 */
export const DEPRECATED_SETTINGS: readonly DeprecatedSetting[] = [
  {
    key: "dsbAgent.thinking.enabled",
    replacedBy: "dsbAgent.compaction.thinking + 供应商/模型级 supportsThinking",
    reason: "总闸语义与 supportsThinking 重叠且歧义,已于设置收敛时移除",
  },
  {
    key: "dsbAgent.thinking.level",
    replacedBy: "供应商/模型级 thinkingLevel",
    reason: "全局兜底强度与模型级强度歧义,已于设置收敛时移除",
  },
];

/** 配置作用域(与 VS Code ConfigurationTarget 一一对应,仅这三处会落盘用户值)。 */
export type ConfigScope = "global" | "workspace" | "workspaceFolder";

export const CONFIG_SCOPES: readonly ConfigScope[] = ["global", "workspace", "workspaceFolder"];

/**
 * `vscode.WorkspaceConfiguration.inspect()` 的子集。
 * 语言级覆盖(globalLanguageValue 等)刻意不处理:它们极少由本扩展写入。
 */
export interface SettingInspect {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/** 一处「用户设过值的废弃键」。 */
export interface DeprecatedHit {
  key: string;
  scope: ConfigScope;
  value: unknown;
}

/** 各逻辑作用域 → inspect 结果字段名。 */
const SCOPE_VALUE: Record<ConfigScope, keyof SettingInspect> = {
  global: "globalValue",
  workspace: "workspaceValue",
  workspaceFolder: "workspaceFolderValue",
};

/** 某作用域上用户设过的值(未设过返回 undefined)。 */
export function scopeValue(inspect: SettingInspect | undefined, scope: ConfigScope): unknown {
  return inspect ? inspect[SCOPE_VALUE[scope]] : undefined;
}

/**
 * 提取「用户设过值」的作用域。
 * `undefined` = 该作用域未设过值 → 不产生清理动作(避免无意义写盘触发 settings 变更事件)。
 */
export function findDeprecatedValues(
  key: string,
  inspect: SettingInspect | undefined,
): DeprecatedHit[] {
  if (!inspect) return [];
  const hits: DeprecatedHit[] = [];
  for (const scope of CONFIG_SCOPES) {
    const value = scopeValue(inspect, scope);
    if (value !== undefined) hits.push({ key, scope, value });
  }
  return hits;
}

/**
 * 对登记表逐键判定清理动作(不做 IO,便于测试)。
 * @param inspectOf 取某键 inspect 结果的函数(生产环境注入 `vscode.workspace.getConfiguration().inspect`)。
 */
export function planDeprecatedCleanup(
  inspectOf: (key: string) => SettingInspect | undefined,
): DeprecatedHit[] {
  const plan: DeprecatedHit[] = [];
  for (const dep of DEPRECATED_SETTINGS) {
    plan.push(...findDeprecatedValues(dep.key, inspectOf(dep.key)));
  }
  return plan;
}

/** 把清理计划整理为可读日志行(每键每作用域一条)。 */
export function describeCleanup(plan: readonly DeprecatedHit[]): string[] {
  return plan.map((h) => {
    const dep = DEPRECATED_SETTINGS.find((d) => d.key === h.key);
    const value = JSON.stringify(h.value);
    return `[deprecated-settings] 清理 ${h.key}=${value}(${h.scope});替代:${dep?.replacedBy ?? "见文档"}`;
  });
}
