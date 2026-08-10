import type { ModelCapabilities } from "./types";

export const kDefaultContextWindowTokens = 256_000;
export const kDefaultMaxOutputTokens = 8192;
export const kDefaultMaxParallelTools = 8;
export const kDefaultToolParallelMode = "read_safe" as const;

const kDefaultCapabilities: ModelCapabilities = {
  supportsVision: false,
  supportsThinking: true,
};

function positiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

function toolParallelMode(v: unknown): "read_safe" | "serial" | undefined {
  return v === "read_safe" || v === "serial" ? v : undefined;
}

/**
 * 把持久化/UI/远程的任意能力形状收成运行时 ModelCapabilities。
 * 兼容旧键 vision/thinking 与新键 supportsVision/supportsThinking。
 */
export function normalizeCapabilities(raw: unknown): ModelCapabilities {
  if (!raw || typeof raw !== "object") {
    return { ...kDefaultCapabilities };
  }
  const o = raw as Record<string, unknown>;
  const supportsVision =
    typeof o.supportsVision === "boolean"
      ? o.supportsVision
      : typeof o.vision === "boolean"
        ? o.vision
        : false;
  const supportsThinking =
    typeof o.supportsThinking === "boolean"
      ? o.supportsThinking
      : typeof o.thinking === "boolean"
        ? o.thinking
        : true;
  const contextWindowTokens = positiveInt(o.contextWindowTokens);
  const maxOutputTokens = positiveInt(o.maxOutputTokens);
  const thinkingBudgetTokens = positiveInt(o.thinkingBudgetTokens);
  const maxParallelTools = positiveInt(o.maxParallelTools);
  const mode = toolParallelMode(o.toolParallelMode);
  const out: ModelCapabilities = { supportsVision, supportsThinking };
  if (contextWindowTokens !== undefined) out.contextWindowTokens = contextWindowTokens;
  if (maxOutputTokens !== undefined) out.maxOutputTokens = maxOutputTokens;
  if (thinkingBudgetTokens !== undefined) out.thinkingBudgetTokens = thinkingBudgetTokens;
  if (maxParallelTools !== undefined) out.maxParallelTools = maxParallelTools;
  if (mode !== undefined) out.toolParallelMode = mode;
  return out;
}

/** 覆盖表:逐模型 normalize;非法项跳过。 */
export function normalizeCapabilityOverrides(
  raw: unknown,
): Record<string, Partial<ModelCapabilities>> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, Partial<ModelCapabilities>> = {};
  for (const [modelId, patch] of Object.entries(raw as Record<string, unknown>)) {
    if (!patch || typeof patch !== "object") continue;
    const o = patch as Record<string, unknown>;
    const next: Partial<ModelCapabilities> = {};
    if (typeof o.supportsVision === "boolean") next.supportsVision = o.supportsVision;
    else if (typeof o.vision === "boolean") next.supportsVision = o.vision;
    if (typeof o.supportsThinking === "boolean") next.supportsThinking = o.supportsThinking;
    else if (typeof o.thinking === "boolean") next.supportsThinking = o.thinking;
    const contextWindowTokens = positiveInt(o.contextWindowTokens);
    const maxOutputTokens = positiveInt(o.maxOutputTokens);
    const thinkingBudgetTokens = positiveInt(o.thinkingBudgetTokens);
    const maxParallelTools = positiveInt(o.maxParallelTools);
    const mode = toolParallelMode(o.toolParallelMode);
    if (contextWindowTokens !== undefined) next.contextWindowTokens = contextWindowTokens;
    if (maxOutputTokens !== undefined) next.maxOutputTokens = maxOutputTokens;
    if (thinkingBudgetTokens !== undefined) next.thinkingBudgetTokens = thinkingBudgetTokens;
    if (maxParallelTools !== undefined) next.maxParallelTools = maxParallelTools;
    if (mode !== undefined) next.toolParallelMode = mode;
    if (Object.keys(next).length > 0) out[modelId] = next;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 写入 settings 时保留已解析字段(含可选数值)。 */
export function toPersistedCapabilities(caps: ModelCapabilities): ModelCapabilities {
  const out: ModelCapabilities = {
    supportsVision: caps.supportsVision,
    supportsThinking: caps.supportsThinking,
  };
  if (caps.contextWindowTokens !== undefined) out.contextWindowTokens = caps.contextWindowTokens;
  if (caps.maxOutputTokens !== undefined) out.maxOutputTokens = caps.maxOutputTokens;
  if (caps.thinkingBudgetTokens !== undefined) out.thinkingBudgetTokens = caps.thinkingBudgetTokens;
  if (caps.maxParallelTools !== undefined) out.maxParallelTools = caps.maxParallelTools;
  if (caps.toolParallelMode !== undefined) out.toolParallelMode = caps.toolParallelMode;
  return out;
}

/** loop/client 用的有效窗长与输出上限。 */
export function effectiveContextWindowTokens(caps: ModelCapabilities): number {
  return caps.contextWindowTokens ?? kDefaultContextWindowTokens;
}

export function effectiveMaxOutputTokens(caps: ModelCapabilities): number {
  return caps.maxOutputTokens ?? kDefaultMaxOutputTokens;
}

/** 正整数 thinking budget;缺省或非法时 undefined。 */
export function effectiveThinkingBudgetTokens(caps: ModelCapabilities): number | undefined {
  return positiveInt(caps.thinkingBudgetTokens);
}

export function effectiveMaxParallelTools(caps: ModelCapabilities): number {
  return positiveInt(caps.maxParallelTools) ?? kDefaultMaxParallelTools;
}

export function effectiveToolParallelMode(caps: ModelCapabilities): "read_safe" | "serial" {
  return caps.toolParallelMode === "serial" ? "serial" : kDefaultToolParallelMode;
}
