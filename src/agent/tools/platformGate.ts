import type { ToolDef } from "./types";

/** 按平台过滤工具定义:未声明 platforms 的放行;声明了仅当 platform ∈ platforms。 */
export function filterToolDefs(defs: ToolDef[], platform: NodeJS.Platform): ToolDef[] {
  return defs.filter((d) => !d.platforms || d.platforms.length === 0 || d.platforms.includes(platform));
}
