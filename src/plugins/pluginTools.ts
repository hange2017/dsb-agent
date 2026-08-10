import * as path from "path";
import type { ToolDef } from "../agent/tools/types";
import type { PluginToolSpec } from "./types";

/** 插件/工具 id 段:仅保留安全字符,供合格工具名。 */
export function sanitizePluginId(id: string): string {
  const s = id.replace(/[^A-Za-z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return s || "unnamed";
}

export function pluginToolQualifiedName(pluginName: string, toolName: string): string {
  return `plugin__${sanitizePluginId(pluginName)}__${sanitizePluginId(toolName)}`;
}

export function buildPluginToolDef(spec: PluginToolSpec): ToolDef {
  return {
    name: pluginToolQualifiedName(spec.pluginName, spec.name),
    description: `[plugin:${spec.pluginName}] ${spec.description}`,
    input_schema: spec.inputSchema,
  };
}

/**
 * 将 command 解析为插件目录内的绝对路径。
 * 拒绝绝对路径逃出、`..` 逃逸、空串;成功时返回 resolved 路径(不要求文件已存在——执行时再失败)。
 */
export function resolvePluginCommandPath(pluginDir: string, command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  const root = path.resolve(pluginDir);
  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(root, trimmed);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return resolved;
}

/** 从 manifest 原始 tools 数组解析 PluginToolSpec(单项失败则跳过)。 */
export function parsePluginToolsFromManifest(
  pluginDir: string,
  pluginName: string,
  toolsRaw: unknown,
): PluginToolSpec[] {
  if (!Array.isArray(toolsRaw)) return [];
  const out: PluginToolSpec[] = [];
  for (const item of toolsRaw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const description = typeof o.description === "string" ? o.description.trim() : "";
    const command = typeof o.command === "string" ? o.command : "";
    const schema = o.input_schema;
    if (!name || !description || !command) continue;
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) continue;
    const commandPath = resolvePluginCommandPath(pluginDir, command);
    if (!commandPath) continue;
    out.push({
      pluginName,
      pluginDir: path.resolve(pluginDir),
      name,
      description,
      inputSchema: schema as Record<string, unknown>,
      commandPath,
    });
  }
  return out;
}
