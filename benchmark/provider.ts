/**
 * benchmark provider 装配:
 * - buildProvider:真实 AnthropicMessagesClient(环境变量 DSB_API_KEY / DSB_BASE_URL / DSB_MODEL)
 * - ScriptedProvider:冒烟测试用假 provider(不产生 API 费用),可脚本化多轮回复
 */
import { AnthropicMessagesClient } from "../src/agent/provider/anthropicMessagesClient";
import type {
  ProviderClient,
  ProviderMessage,
  ProviderRoundResult,
  ProviderStreamEvent,
} from "../src/agent/provider/types";
import type { ToolDef } from "../src/agent/tools/types";
import type { ModelCapabilities } from "../src/providers/types";

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model: string;
}

/** 从环境变量装配真实 provider。 */
export function buildProvider(cfg: ProviderConfig): ProviderClient {
  if (!cfg.apiKey) {
    throw new Error(
      "DSB_API_KEY is required for real provider mode. Set env DSB_API_KEY (and optionally DSB_BASE_URL, DSB_MODEL), or use --fake for smoke test.",
    );
  }
  return new AnthropicMessagesClient({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl ?? "https://api.deepseek.com",
    model: cfg.model,
  });
}

/**
 * 冒烟测试/离线模式用假 provider:
 * 按脚本逐步返回结果;脚本耗尽后重复最后一步。
 * capabilities 保守:无 vision、无 thinking、窗口 128K。
 */
export class ScriptedProvider implements ProviderClient {
  readonly capabilities: ModelCapabilities = {
    supportsVision: false,
    supportsThinking: false,
    contextWindowTokens: 128_000,
    maxOutputTokens: 4096,
  };
  private roundIndex = 0;

  constructor(
    private readonly script: Array<(round: number, messages: ProviderMessage[]) => ProviderRoundResult>,
  ) {}

  async round(
    messages: ProviderMessage[],
    _opts: {
      system: string;
      tools: ToolDef[];
      signal?: AbortSignal;
      maxTokens?: number;
      thinkingBudgetTokens?: number;
      thinkingDisabled?: boolean;
      lastInputTokens?: number;
    },
    onEvent: (ev: ProviderStreamEvent) => void,
  ): Promise<ProviderRoundResult> {
    const step = this.script[Math.min(this.roundIndex, this.script.length - 1)];
    const roundNo = this.roundIndex;
    this.roundIndex++;
    const result = step(roundNo, messages);
    // 模拟流式文本输出,让事件通道与真实模式一致
    for (const b of result.blocks) {
      if (b.type === "text") onEvent({ type: "text_delta", text: b.text });
    }
    return result;
  }
}
