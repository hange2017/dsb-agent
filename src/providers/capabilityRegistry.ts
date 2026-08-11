import type { ModelCapabilities } from "./types";
import { resolveCapabilities } from "./modelCatalog";
import { matchProfile } from "./profiles";
import { normalizeCapabilities, normalizeCapabilityOverrides, type ThinkingLevel } from "./capabilities";

/** CapabilityRegistry 依赖的供应商最小结构。 */
export interface CapabilityProvider {
  id: string;
  defaultCapabilities: ModelCapabilities;
  capabilityOverrides?: Record<string, Partial<ModelCapabilities>>;
}

/**
 * per-model 能力解析与覆盖。
 * 解析优先级:override > remote > profile > 内置能力表 > 供应商默认 > 全局兜底(globalThinkingLevel)。
 */
export class CapabilityRegistry {
  /** 全局思考强度兜底:仅对无任何模型级 level/预算制定的模型生效(优先级最低)。 */
  private globalThinkingLevel?: ThinkingLevel;

  /** 设置全局思考强度兜底(来自 Agent 设置面板 / dsbAgent.thinking.level 配置)。 */
  setGlobalThinkingLevel(level: ThinkingLevel | undefined): void {
    this.globalThinkingLevel = level;
  }

  resolve(provider: CapabilityProvider, modelId: string): ModelCapabilities {
    const caps = resolveCapabilities(
      {
        defaultCapabilities: normalizeCapabilities(provider.defaultCapabilities),
        capabilityOverrides: normalizeCapabilityOverrides(provider.capabilityOverrides),
      },
      modelId,
      undefined,
      { profile: matchProfile(modelId) },
    );
    if (
      this.globalThinkingLevel !== undefined &&
      caps.thinkingLevel === undefined &&
      caps.thinkingBudgetTokens === undefined
    ) {
      return { ...caps, thinkingLevel: this.globalThinkingLevel };
    }
    return caps;
  }

  /** 记录某模型的能力覆盖(实际写 settings 由接线层完成,这里返回补丁供调用方 upsert)。 */
  buildOverride(
    provider: CapabilityProvider,
    modelId: string,
    patch: Partial<ModelCapabilities>,
  ): Record<string, Partial<ModelCapabilities>> {
    const existing = normalizeCapabilityOverrides(provider.capabilityOverrides) ?? {};
    return {
      ...existing,
      [modelId]: { ...(existing[modelId] ?? {}), ...patch },
    };
  }
}
