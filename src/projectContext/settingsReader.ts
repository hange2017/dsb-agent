import * as fs from "fs";
import * as path from "path";
import { PermissionRules } from "../agent/permissionRules";
import type { HookEvent, HookRule } from "../hooks/hookRunner";
import { activeSettingsRoot, SETTINGS_FILES } from "./convention";

export interface LoadedSettings {
  permissionRules: PermissionRules;
  env: Record<string, string>;
  model?: string;
  /** `.dsb/settings.json` 的 hooks 字段解析结果(仅命令型;空数组表示未配置)。 */
  hooks: HookRule[];
}

const HOOK_EVENTS: ReadonlySet<string> = new Set(["PreToolUse", "PostToolUse", "Stop", "SessionStart"]);

/**
 * 解析 settings hooks 字段形状:
 *   `{ "hooks": { "PreToolUse": [{ "matcher": "Write", "hooks": [{ "type": "command", "command": "…" }] }] } }`
 * 仅保留 `type === "command"` 的条目;matcher 缺省为 `"*"`(匹配全部)。解析宽容:
 * 非法事件名 / 非数组 / 畸形条目一律跳过,绝不 throw。
 */
export function parseSettingsHooks(hooksField: unknown): HookRule[] {
  if (typeof hooksField !== "object" || hooksField === null || Array.isArray(hooksField)) return [];
  const rules: HookRule[] = [];
  for (const [eventName, entriesRaw] of Object.entries(hooksField as Record<string, unknown>)) {
    if (!HOOK_EVENTS.has(eventName)) continue;
    if (!Array.isArray(entriesRaw)) continue;
    for (const entryRaw of entriesRaw) {
      if (typeof entryRaw !== "object" || entryRaw === null) continue;
      const entry = entryRaw as Record<string, unknown>;
      if (!Array.isArray(entry.hooks)) continue;
      const matcher = typeof entry.matcher === "string" && entry.matcher ? entry.matcher : "*";
      for (const hookRaw of entry.hooks) {
        if (typeof hookRaw !== "object" || hookRaw === null) continue;
        const hook = hookRaw as Record<string, unknown>;
        if (hook.type !== "command") continue;
        if (typeof hook.command !== "string" || !hook.command.trim()) continue;
        rules.push({ event: eventName as HookEvent, matcher, command: hook.command });
      }
    }
  }
  return rules;
}

/**
 * 按 key 深度合并两个设置对象。顶层 env/model 等普通字段由后一个文件覆盖;
 * 只有 permissions 采用数组级合并——settings.local.json 的 allow/deny/ask
 * 追加到 settings.json 的基线之上,避免本地文件静默丢弃基线的 allow/deny 规则。
 */
function mergeSettings(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(src)) {
    if (key === "permissions" && value && typeof value === "object" && !Array.isArray(value)) {
      const srcPermissions = value as Record<string, unknown>;
      const targetPermissions =
        target.permissions && typeof target.permissions === "object" && !Array.isArray(target.permissions)
          ? (target.permissions as Record<string, unknown>)
          : {};
      for (const [pk, pv] of Object.entries(srcPermissions)) {
        const current = targetPermissions[pk];
        if (Array.isArray(current) && Array.isArray(pv)) {
          targetPermissions[pk] = [...current, ...pv];
        } else {
          targetPermissions[pk] = pv;
        }
      }
      target.permissions = targetPermissions;
    } else {
      target[key] = value;
    }
  }
}

export function readProjectSettings(workspaceRoot: string): LoadedSettings {
  // 约定根:.dsb/ 优先,旧 .claude/ 只读回退(不混读两套根)
  const root = activeSettingsRoot(workspaceRoot);
  const merged: Record<string, unknown> = {};
  for (const name of SETTINGS_FILES) {
    const file = path.join(workspaceRoot, root, name);
    if (fs.existsSync(file)) {
      try {
        mergeSettings(merged, JSON.parse(fs.readFileSync(file, "utf8")));
      } catch {
        // 解析失败跳过该文件
      }
    }
  }
  const env = (merged.env ?? {}) as Record<string, unknown>;
  const envStr: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") envStr[k] = v;
  const model = typeof merged.model === "string" ? merged.model : undefined;
  return {
    permissionRules: PermissionRules.parseSettings(merged),
    env: envStr,
    model,
    hooks: parseSettingsHooks(merged.hooks),
  };
}
