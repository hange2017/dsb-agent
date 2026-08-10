import type { ModelCapabilities } from "./types";

const kWindow128k = 128_000;
const kWindow256k = 256_000;
const kOut8k = 8192;

/**
 * Exact model-id capability profiles (migrated from former kBuiltinCapabilities).
 * Exact match always wins over prefix rules.
 * deepseek-v4 系列窗口按 spec(2026-08-09 §7)取 256K:用户模型 1M,256K 是成本/频率平衡点。
 */
export const kExactProfiles: Record<string, Partial<ModelCapabilities>> = {
  "deepseek-v4-flash": {
    supportsVision: true,
    supportsThinking: true,
    contextWindowTokens: kWindow256k,
    maxOutputTokens: kOut8k,
  },
  "deepseek-v4-pro": {
    supportsVision: false,
    supportsThinking: true,
    contextWindowTokens: kWindow256k,
    maxOutputTokens: kOut8k,
  },
  "deepseek-chat": {
    supportsVision: false,
    supportsThinking: false,
    contextWindowTokens: kWindow128k,
    maxOutputTokens: kOut8k,
  },
  "deepseek-reasoner": {
    supportsVision: false,
    supportsThinking: true,
    contextWindowTokens: kWindow128k,
    maxOutputTokens: kOut8k,
  },
  "claude-sonnet-4-5": {
    supportsVision: true,
    supportsThinking: true,
    contextWindowTokens: 200_000,
    maxOutputTokens: kOut8k,
  },
  "claude-opus-4-1": {
    supportsVision: true,
    supportsThinking: true,
    contextWindowTokens: 200_000,
    maxOutputTokens: kOut8k,
  },
  "claude-haiku-4-5": {
    supportsVision: true,
    supportsThinking: true,
    contextWindowTokens: 200_000,
    maxOutputTokens: kOut8k,
  },
};

/**
 * Prefix capability profiles for unknown remote ids.
 * Matching order: longest prefix first; ties keep first-defined order below.
 */
export const kPrefixProfiles: ReadonlyArray<{
  prefix: string;
  caps: Partial<ModelCapabilities>;
}> = [
  {
    prefix: "deepseek-v4-",
    caps: { supportsThinking: true, contextWindowTokens: kWindow256k, maxOutputTokens: kOut8k },
  },
  {
    prefix: "claude-",
    caps: {
      supportsVision: true,
      supportsThinking: true,
      contextWindowTokens: 200_000,
      maxOutputTokens: kOut8k,
    },
  },
];

/**
 * Resolve capability hints from exact id or prefix profile.
 * Exact match wins; otherwise longest matching prefix (then first-defined).
 * Unknown ids return {}.
 */
export function matchProfile(modelId: string): Partial<ModelCapabilities> {
  const exact = kExactProfiles[modelId];
  if (exact) {
    return { ...exact };
  }

  const sorted = [...kPrefixProfiles].sort((a, b) => {
    const lenDiff = b.prefix.length - a.prefix.length;
    if (lenDiff !== 0) return lenDiff;
    return kPrefixProfiles.indexOf(a) - kPrefixProfiles.indexOf(b);
  });

  for (const rule of sorted) {
    if (modelId.startsWith(rule.prefix)) {
      return { ...rule.caps };
    }
  }
  return {};
}
