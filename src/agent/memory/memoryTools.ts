import type { MemoryEntry } from "./memoryStore";

/**
 * 记忆作用域参数(所有记忆工具可选):
 * - auto(默认):写/删 → 项目记忆;读 → 项目优先,未命中回退全局;列表 → 合并项目 + 全局。
 * - project:只操作当前项目记忆。
 * - global:操作全局记忆(跨项目共享,兼容旧版 ~/.dsb/memory/*.json)。
 */
const SCOPE_ARG = {
  type: "string",
  enum: ["auto", "project", "global"],
  description: "记忆作用域:auto(默认)/ project / global(跨项目共享)",
};

export const MEMORY_TOOL_DEFS = [
  {
    name: "MemoryWrite",
    description: "写入/更新一条跨会话记忆。name 用简短 kebab-case,body 记录对用户有价值的事实。默认写入当前项目(scope=auto/project);scope=global 写入全局共享记忆。写入时若发现与既有记忆高度相似会返回候选提示,请核对是否应合并/覆盖而非新增重复条目;pinned=true 时该记忆在索引中置顶且不受 limit 截断(用于关键项目约定)。",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        body: { type: "string" },
        scope: SCOPE_ARG,
        pinned: { type: "boolean", description: "常驻标记:true 置顶且不受索引 limit 截断(关键项目约定用);缺省继承既有值(新条目默认 false)" },
      },
      required: ["name", "description", "body"],
    },
  },
  {
    name: "MemoryRead",
    description: "读取一条记忆的完整内容。scope=auto(默认)先查当前项目,未命中回退全局。",
    input_schema: { type: "object", properties: { name: { type: "string" }, scope: SCOPE_ARG }, required: ["name"] },
  },
  {
    name: "MemoryList",
    description: "列出记忆的 name + description。scope=auto(默认)合并列出当前项目 + 全局记忆。",
    input_schema: { type: "object", properties: { scope: SCOPE_ARG } },
  },
  {
    name: "MemoryDelete",
    description: "删除一条记忆。scope=auto(默认)/project 只删当前项目记忆;删除全局记忆需显式 scope=global。",
    input_schema: { type: "object", properties: { name: { type: "string" }, scope: SCOPE_ARG }, required: ["name"] },
  },
];

export type MemoryScope = "auto" | "project" | "global";

/** 归一化 scope 参数:非法值一律回退 auto。 */
export function normalizeMemoryScope(raw: unknown): MemoryScope {
  const v = typeof raw === "string" ? raw.toLowerCase() : "auto";
  return v === "global" || v === "project" || v === "auto" ? v : "auto";
}
