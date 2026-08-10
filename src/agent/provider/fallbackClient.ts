import type { ProviderClient, ProviderMessage, ProviderRoundResult, ProviderStreamEvent } from "./types";
import type { ModelCapabilities } from "../../providers/types";
import type { ToolDef } from "../tools/types";
import { prepareRound } from "../capabilityGate";

const FALLBACK_TRIGGER = /429|Rate limit|timeout|timed out|5\d\d|overloaded|overloaded_|ECONNRESET|aborted/i;

export class FallbackClient implements ProviderClient {
  /** 最近一次 round 成功使用的 client;未 round 前为 undefined。 */
  private active: ProviderClient | undefined;

  constructor(
    private readonly deps: {
      primary: ProviderClient;
      fallbacks: Array<{ model: string; make: (model: string) => ProviderClient }>;
    },
  ) {}

  /** 运行时真相:最近一次成功 round 的 client 能力;否则 primary。 */
  get capabilities(): ModelCapabilities {
    return this.active?.capabilities ?? this.deps.primary.capabilities;
  }

  async round(
    messages: ProviderMessage[],
    opts: {
      system: string;
      tools: ToolDef[];
      signal?: AbortSignal;
      maxTokens?: number;
      thinkingBudgetTokens?: number;
      lastInputTokens?: number;
    },
    onEvent: (ev: ProviderStreamEvent) => void,
  ): Promise<ProviderRoundResult> {
    let lastError: unknown;
    // 逐个候选尝试:primary 成功时后续 fallback 根本不构造;fallback 在重试链内惰性
    // 构造(f.make 在 try 内调用),make 抛错同样被捕获、记入 lastError 并继续下一个。
    // 每个 attempt 按该 client 的 capabilities 重跑 prepareRound,避免 primary 出站/预算毒害 fallback。
    const attempt = async (makeClient: () => ProviderClient): Promise<ProviderRoundResult | undefined> => {
      let client: ProviderClient;
      try {
        client = makeClient();
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (!FALLBACK_TRIGGER.test(msg)) throw err; // 配置类错误不 fallback
        return undefined; // 构造失败:记入 lastError,继续下一个 fallback
      }
      try {
        const prepared = prepareRound({
          caps: client.capabilities,
          messages,
          lastInputTokens: opts.lastInputTokens ?? 0,
        });
        const childOpts: {
          system: string;
          tools: ToolDef[];
          signal?: AbortSignal;
          maxTokens: number;
          thinkingBudgetTokens?: number;
        } = {
          system: opts.system,
          tools: opts.tools,
          signal: opts.signal,
          maxTokens: prepared.maxTokens,
        };
        if (prepared.thinkingBudgetTokens !== undefined) {
          childOpts.thinkingBudgetTokens = prepared.thinkingBudgetTokens;
        }
        const result = await client.round(prepared.outbound, childOpts, onEvent);
        this.active = client;
        return result;
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (!FALLBACK_TRIGGER.test(msg)) throw err; // 配置类错误不 fallback
        return undefined; // 可重试错误:继续下一个
      }
    };
    const primary = await attempt(() => this.deps.primary);
    if (primary !== undefined) return primary;
    for (const f of this.deps.fallbacks) {
      const r = await attempt(() => f.make(f.model));
      if (r !== undefined) return r;
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
