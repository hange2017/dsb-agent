import type { ModelCapabilities, ModelInfo } from "./types";
import { normalizeCapabilities } from "./capabilities";
import { kExactProfiles, matchProfile } from "./profiles";
import { mapRemoteModelCapabilities } from "./remoteCapabilities";

/** ModelCatalog 依赖的供应商最小结构(与 ProviderDef 结构兼容)。 */
export interface CatalogProvider {
  id: string;
  baseUrl: string;
  modelListUrl?: string;
  pinnedModels?: string[];
  defaultCapabilities: ModelCapabilities;
  capabilityOverrides?: Record<string, Partial<ModelCapabilities>>;
  modes: string[];
}

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟

/** 内置模型能力表(exact profiles 派生;远程拉取失败/未返回能力信息时兜底 id 列表)。 */
export const kBuiltinCapabilities: Record<string, Partial<ModelCapabilities>> = {
  ...kExactProfiles,
};

type CacheEntry = { at: number; models: ModelInfo[] };

/**
 * 去掉粘贴 Base URL 时常见的不可见字符(BOM / 零宽空格等),避免 /anthropic 后缀匹配失败。
 */
export function sanitizeProviderUrl(url: string): string {
  return url
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "")
    .trim()
    .replace(/\/+$/, "");
}

/**
 * 构造模型列表探测 URL。
 * Anthropic 兼容聊天端点常以 `/anthropic` 结尾,但 OpenAI 风格的 `/models`
 * 在 API 根路径(如 https://api.deepseek.com/models)。对 /anthropic 基址优先探测 API 根,
 * 再回退到基址下的 /v1/models 与 /models。
 */
export function modelListUrlCandidates(baseUrl: string, modelListUrl?: string): string[] {
  if (modelListUrl?.trim()) {
    return [sanitizeProviderUrl(modelListUrl)];
  }
  const base = sanitizeProviderUrl(baseUrl);
  const attempts: string[] = [];
  const anthropicSuffix = /\/anthropic$/i;
  if (anthropicSuffix.test(base)) {
    const root = sanitizeProviderUrl(base.replace(anthropicSuffix, ""));
    if (root.length > 0) {
      attempts.push(`${root}/models`, `${root}/v1/models`);
    }
  }
  attempts.push(`${base}/v1/models`, `${base}/models`);
  return [...new Set(attempts)];
}

/**
 * 无远程缓存时的内置模型候选:按 baseUrl 主机名猜测厂商,避免 DeepSeek 端点混入 Claude 等无关 id。
 * 无法识别时仅返回空(仍可由 pinnedModels 补齐)。
 */
export function fallbackBuiltinModelIds(
  baseUrl: string,
  builtin: Record<string, unknown> = kBuiltinCapabilities,
): string[] {
  const ids = Object.keys(builtin);
  const url = baseUrl.toLowerCase();
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    host = url;
  }
  if (host.includes("deepseek") || url.includes("deepseek")) {
    return ids.filter((id) => id.startsWith("deepseek-"));
  }
  if (host.includes("anthropic") || url.includes("anthropic.com")) {
    return ids.filter((id) => id.startsWith("claude-"));
  }
  return [];
}

export class ModelCatalog {
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(deps: { fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  builtinModels(): Record<string, Partial<ModelCapabilities>> {
    return { ...kBuiltinCapabilities };
  }

  /** 缓存存在且未过期返回 true(供 controller 决定是否跳过 loading 状态)。 */
  hasFreshCache(providerId: string): boolean {
    const cached = this.cache.get(providerId);
    return Boolean(cached && Date.now() - cached.at < CACHE_TTL_MS);
  }

  /** 探测模型列表:先 {modelListUrl|baseUrl}/v1/models,再 /models; /anthropic 基址再试 API 根。 */
  async fetchModels(
    provider: CatalogProvider,
    opts?: { apiKey?: string; force?: boolean },
  ): Promise<ModelInfo[]> {
    const cached = this.cache.get(provider.id);
    if (!opts?.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.models.map((m) => ({ ...m, capabilities: { ...m.capabilities } }));
    }

    const attempts = modelListUrlCandidates(provider.baseUrl, provider.modelListUrl);

    const headers: Record<string, string> = { accept: "application/json" };
    const apiKey = opts?.apiKey?.trim();
    if (apiKey) {
      headers["x-api-key"] = apiKey;
      headers.Authorization = `Bearer ${apiKey}`;
    }

    let models: ModelInfo[] | undefined;
    const failures: string[] = [];
    for (const url of attempts) {
      try {
        const res = await this.fetchImpl(url, { headers });
        if (!res.ok) {
          failures.push(`GET ${url} -> ${res.status}`);
          // 401/403:密钥问题,继续打其它路径通常无意义
          if (res.status === 401 || res.status === 403) {
            throw new Error(
              `模型列表认证失败(${res.status})。请先在供应商设置中配置有效 API Key。尝试: ${url}`,
            );
          }
          continue;
        }
        const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
        const items = (data.data ?? []).filter(
          (m): m is Record<string, unknown> & { id: string } =>
            Boolean(m) && typeof m === "object" && typeof m.id === "string" && m.id.length > 0,
        );
        if (items.length === 0) {
          failures.push(`GET ${url}: empty model list`);
          continue;
        }
        const builtin = this.builtinModels();
        models = items.map((item) => {
          let remote: Partial<ModelCapabilities> = {};
          try {
            remote = mapRemoteModelCapabilities(item);
          } catch {
            // fail-open: mapping errors must not fail the whole fetch
            remote = {};
          }
          return {
            id: item.id,
            capabilities: resolveCapabilities(provider, item.id, builtin, {
              remote,
              profile: matchProfile(item.id),
            }),
            source: "remote" as const,
          };
        });
        break;
      } catch (err) {
        if (err instanceof Error && /认证失败|API Key/.test(err.message)) {
          throw err;
        }
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }

    if (!models) {
      throw new Error(
        failures.length
          ? `模型列表拉取失败:\n${failures.join("\n")}`
          : "模型列表拉取失败:无可用探测 URL",
      );
    }

    this.cache.set(provider.id, { at: Date.now(), models });
    return models.map((m) => ({ ...m, capabilities: { ...m.capabilities } }));
  }

  /**
   * 合并当前供应商可用的模型列表:
   * - 有远程缓存:pinned + 远程缓存(builtin 仅作为能力来源)。
   * - 无缓存:pinned + 按 baseUrl 猜测的厂商内置 id(避免 DeepSeek 端点混入 Claude 等)。
   */
  resolveModels(provider: CatalogProvider): ModelInfo[] {
    const cached = this.cache.get(provider.id);
    const builtin = this.builtinModels();

    const merged = new Map<string, ModelInfo>();
    const addResolved = (id: string, source: ModelInfo["source"], remote?: Partial<ModelCapabilities>) => {
      if (merged.has(id)) return;
      merged.set(id, {
        id,
        capabilities: resolveCapabilities(provider, id, builtin, {
          ...(remote ? { remote } : {}),
          profile: matchProfile(id),
        }),
        source,
      });
    };

    if (cached) {
      // 保留 fetch 时已合并 remote 提示的 capabilities,避免 resolve 时丢掉探测结果
      for (const id of provider.pinnedModels ?? []) {
        const fromCache = cached.models.find((m) => m.id === id);
        if (fromCache) {
          merged.set(id, { id, capabilities: { ...fromCache.capabilities }, source: "pinned" });
        } else {
          addResolved(id, "pinned");
        }
      }
      for (const m of cached.models) {
        if (!merged.has(m.id)) {
          merged.set(m.id, { id: m.id, capabilities: { ...m.capabilities }, source: "remote" });
        }
      }
    } else {
      for (const id of provider.pinnedModels ?? []) addResolved(id, "pinned");
      for (const id of fallbackBuiltinModelIds(provider.baseUrl, builtin)) addResolved(id, "builtin");
    }

    return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  clearCache(providerId: string): void {
    this.cache.delete(providerId);
  }
}

/** 能力解析优先级:override > remote > profile > 内置表 > 供应商默认。 */
export type ResolveCapabilitiesOpts = {
  /** Phase 3:远程列表/探测得到的能力提示。 */
  remote?: Partial<ModelCapabilities>;
  /** Phase 2:profile 匹配结果;未传时回退 builtin[modelId]。 */
  profile?: Partial<ModelCapabilities>;
};

export function resolveCapabilities(
  provider: Pick<CatalogProvider, "defaultCapabilities" | "capabilityOverrides">,
  modelId: string,
  builtin: Record<string, Partial<ModelCapabilities>> = kBuiltinCapabilities,
  opts?: ResolveCapabilitiesOpts,
): ModelCapabilities {
  const override = provider.capabilityOverrides?.[modelId] ?? {};
  const remote = opts?.remote ?? {};
  const fromProfile = opts?.profile ?? builtin[modelId] ?? {};
  const defaults = normalizeCapabilities(provider.defaultCapabilities);
  const out: ModelCapabilities = {
    supportsVision:
      override.supportsVision ?? remote.supportsVision ?? fromProfile.supportsVision ?? defaults.supportsVision,
    supportsThinking:
      override.supportsThinking ??
      remote.supportsThinking ??
      fromProfile.supportsThinking ??
      defaults.supportsThinking,
  };
  const contextWindowTokens =
    override.contextWindowTokens ??
    remote.contextWindowTokens ??
    fromProfile.contextWindowTokens ??
    defaults.contextWindowTokens;
  const maxOutputTokens =
    override.maxOutputTokens ?? remote.maxOutputTokens ?? fromProfile.maxOutputTokens ?? defaults.maxOutputTokens;
  const thinkingBudgetTokens =
    override.thinkingBudgetTokens ??
    remote.thinkingBudgetTokens ??
    fromProfile.thinkingBudgetTokens ??
    defaults.thinkingBudgetTokens;
  const maxParallelTools =
    override.maxParallelTools ?? remote.maxParallelTools ?? fromProfile.maxParallelTools ?? defaults.maxParallelTools;
  const toolParallelMode =
    override.toolParallelMode ?? remote.toolParallelMode ?? fromProfile.toolParallelMode ?? defaults.toolParallelMode;
  if (contextWindowTokens !== undefined) out.contextWindowTokens = contextWindowTokens;
  if (maxOutputTokens !== undefined) out.maxOutputTokens = maxOutputTokens;
  if (thinkingBudgetTokens !== undefined) out.thinkingBudgetTokens = thinkingBudgetTokens;
  const thinkingLevel =
    override.thinkingLevel ?? remote.thinkingLevel ?? fromProfile.thinkingLevel ?? defaults.thinkingLevel;
  if (thinkingLevel !== undefined) out.thinkingLevel = thinkingLevel;
  if (maxParallelTools !== undefined) out.maxParallelTools = maxParallelTools;
  if (toolParallelMode !== undefined) out.toolParallelMode = toolParallelMode;
  return out;
}
