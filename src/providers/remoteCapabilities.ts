import type { ModelCapabilities } from "./types";

/**
 * 从远程 /models 列表条目中提取已知能力字段。
 * Fail-open:仅在确信为 boolean 时写入;无法识别则返回空 partial。
 */
export function mapRemoteModelCapabilities(raw: Record<string, unknown>): Partial<ModelCapabilities> {
  const out: Partial<ModelCapabilities> = {};

  const vision = pickBoolean(
    raw.supports_vision,
    raw.supportsVision,
    raw.vision,
    nestedCap(raw, "vision"),
  );
  if (vision !== undefined) out.supportsVision = vision;

  const thinking = pickBoolean(
    raw.supports_thinking,
    raw.supportsThinking,
    raw.thinking,
    nestedCap(raw, "thinking"),
    nestedCap(raw, "reasoning"),
  );
  if (thinking !== undefined) out.supportsThinking = thinking;

  return out;
}

/** 按参数顺序取第一个 boolean;非 boolean 跳过。 */
function pickBoolean(...candidates: unknown[]): boolean | undefined {
  for (const c of candidates) {
    if (typeof c === "boolean") return c;
  }
  return undefined;
}

function nestedCap(raw: Record<string, unknown>, key: string): unknown {
  const caps = raw.capabilities;
  if (!caps || typeof caps !== "object") return undefined;
  return (caps as Record<string, unknown>)[key];
}
