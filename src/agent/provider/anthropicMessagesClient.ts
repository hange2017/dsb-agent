import type { ToolDef } from "../tools/types";
import type { ModelCapabilities } from "../../providers/types";
import type {
  ProviderBlock,
  ProviderClient,
  ProviderMessage,
  ProviderRoundResult,
  ProviderStopReason,
  ProviderStreamEvent,
} from "./types";
import { sanitizeOutbound } from "../capabilityGate";
import { normalizeStopReason } from "../maxTokensContinue";

type SseEvent = { event: string; data: Record<string, unknown> };

function positiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

/**
 * 规范化 Anthropic 兼容 baseUrl:
 * - 去尾斜杠
 * - 若用户误填了 `/v1` 或 `/v1/messages`,剥掉以免拼出 `/v1/v1/messages`(典型 404)
 */
export function normalizeAnthropicBaseUrl(baseUrl: string): string {
  let base = baseUrl
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "")
    .trim()
    .replace(/\/+$/, "");
  base = base.replace(/\/v1\/messages$/i, "");
  base = base.replace(/\/v1$/i, "");
  return base.replace(/\/+$/, "");
}

function reasoningTextFrom(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isReasoningContentBlock(cb: { type: string; reasoning_content?: unknown }): boolean {
  return cb.type === "reasoning_content" || reasoningTextFrom(cb.reasoning_content) !== undefined;
}

function reasoningDeltaText(delta: { type: string; thinking?: string; reasoning_content?: string }): string | undefined {
  if (delta.type === "thinking_delta") return delta.thinking;
  if (delta.type === "reasoning_content_delta" || delta.type === "reasoning_content") {
    return delta.reasoning_content;
  }
  return reasoningTextFrom(delta.reasoning_content);
}

async function* parseSSEStream(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let currentData = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (currentData) {
        try {
          yield { event: currentEvent, data: JSON.parse(currentData) };
        } catch {
          // ignore final partial
        }
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice("event: ".length).trim();
      } else if (line.startsWith("data: ")) {
        currentData = line.slice("data: ".length);
      } else if (line === "") {
        if (currentData) {
          try {
            yield { event: currentEvent, data: JSON.parse(currentData) };
          } catch {
            // skip unparseable
          }
        }
        currentEvent = "";
        currentData = "";
      }
    }
  }
}

export class AnthropicMessagesClient implements ProviderClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  readonly capabilities: ModelCapabilities;

  constructor(deps: {
    apiKey: string;
    baseUrl: string;
    model: string;
    capabilities?: ModelCapabilities;
    fetchImpl?: typeof fetch;
  }) {
    this.apiKey = deps.apiKey;
    this.baseUrl = normalizeAnthropicBaseUrl(deps.baseUrl);
    this.model = deps.model;
    this.capabilities = deps.capabilities ?? { supportsVision: true, supportsThinking: true };
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async round(
    messages: ProviderMessage[],
    opts: {
      system: string;
      tools: ToolDef[];
      signal?: AbortSignal;
      maxTokens?: number;
      thinkingBudgetTokens?: number;
      /** 功能级 thinking 关闭:true 时等价于 capabilities.supportsThinking=false。 */
      thinkingDisabled?: boolean;
    },
    onEvent: (ev: ProviderStreamEvent) => void,
  ): Promise<ProviderRoundResult> {
    const maxTokens = opts.maxTokens ?? this.capabilities.maxOutputTokens ?? 8192;
    const outbound = sanitizeOutbound(this.capabilities, messages);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: maxTokens,
      stream: true,
      system: opts.system,
      tools: opts.tools,
      messages: outbound,
    };
    // 能力开关:模型不支持思考或调用方显式禁用时,显式关闭 thinking(避免 API 默认开启产生额外开销/不可渲染块)
    if (this.capabilities.supportsThinking === false || opts.thinkingDisabled === true) {
      body["thinking"] = { type: "disabled" };
    } else {
      const budget = positiveInt(opts.thinkingBudgetTokens ?? this.capabilities.thinkingBudgetTokens);
      if (budget !== undefined) {
        body["thinking"] = { type: "enabled", budget_tokens: budget };
      }
    }

    let response: Response;
    const requestUrl = `${this.baseUrl}/v1/messages`;
    try {
      response = await this.fetchImpl(requestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err) {
      throw new Error(`Network error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
      let errText = "";
      try {
        errText = await response.text();
      } catch {
        // ignore
      }
      const detail = errText.slice(0, 500);
      if (response.status === 401) throw new Error("Invalid API key.");
      if (response.status === 429) throw new Error("Rate limited. Please retry later.");
      const urlHint = response.status === 404 ? ` [${requestUrl}]` : "";
      throw new Error(`API error (${response.status}): ${detail}${urlHint}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty response body");

    const blocks: ProviderBlock[] = [];
    const toolUses: ProviderRoundResult["toolUses"] = [];
    const toolInputRaw: Record<number, string> = {};
    let usage: ProviderRoundResult["usage"];
    let stopReason: ProviderStopReason | undefined;

    for await (const ev of parseSSEStream(reader)) {
      const data = ev.data;
      switch (ev.event) {
        case "content_block_start": {
          const block = data as {
            index: number;
            content_block: {
              type: string;
              text?: string;
              thinking?: string;
              reasoning_content?: string;
              id?: string;
              name?: string;
              input?: unknown;
            };
          };
          const cb = block.content_block;
          if (cb.type === "text") blocks[block.index] = { type: "text", text: cb.text ?? "" };
          else if (cb.type === "thinking") blocks[block.index] = { type: "thinking", thinking: cb.thinking ?? "" };
          else if (isReasoningContentBlock(cb)) {
            blocks[block.index] = { type: "thinking", thinking: cb.reasoning_content ?? "" };
          } else if (cb.type === "tool_use") {
            blocks[block.index] = { type: "tool_use", id: cb.id ?? "", name: cb.name ?? "", input: (cb.input as Record<string, unknown>) ?? {} };
          }
          break;
        }
        case "content_block_delta": {
          const d = data as {
            index: number;
            delta: { type: string; text?: string; thinking?: string; reasoning_content?: string; partial_json?: string };
          };
          const existing = blocks[d.index];
          if (existing?.type === "text" && d.delta.type === "text_delta") {
            existing.text += d.delta.text ?? "";
            onEvent({ type: "text_delta", text: d.delta.text ?? "" });
          } else if (existing?.type === "thinking") {
            const chunk = reasoningDeltaText(d.delta);
            if (chunk !== undefined) {
              existing.thinking += chunk;
              onEvent({ type: "thinking_delta", text: chunk });
            }
          } else if (existing?.type === "tool_use" && d.delta.type === "input_json_delta") {
            const partial = d.delta.partial_json ?? "";
            toolInputRaw[d.index] = (toolInputRaw[d.index] ?? "") + partial;
          } else {
            const chunk = reasoningDeltaText(d.delta);
            if (chunk !== undefined) {
              blocks[d.index] = { type: "thinking", thinking: chunk };
              onEvent({ type: "thinking_delta", text: chunk });
            }
          }
          break;
        }
        case "content_block_stop": {
          const index = (data as { index: number }).index;
          const b = blocks[index];
          if (b?.type === "tool_use") {
            const raw = toolInputRaw[index];
            let input = b.input;
            if (raw) {
              try {
                const parsed = JSON.parse(raw) as unknown;
                if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                  input = parsed as Record<string, unknown>;
                } else {
                  // 非对象 JSON → 半截/非法,不入 toolUses(策略 A)
                  break;
                }
              } catch {
                // JSON 未闭合 → 半截,不入 toolUses
                break;
              }
            }
            // 必须写回 block:agentLoop 用 blocks 落盘;只更新 toolUses 会导致历史里 tool_use.input 恒为 {}
            b.input = input;
            toolUses.push({ id: b.id, name: b.name, input });
          }
          break;
        }
        case "message_delta": {
          const md = data as {
            delta?: { stop_reason?: string | null };
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              // Anthropic 风格:缓存命中/新建
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
              // DeepSeek 风格:缓存命中/未命中
              prompt_cache_hit_tokens?: number;
              prompt_cache_miss_tokens?: number;
            };
          };
          if (md.delta?.stop_reason != null && md.delta.stop_reason !== "") {
            stopReason = normalizeStopReason(md.delta.stop_reason);
          }
          if (md.usage) {
            const u = md.usage;
            usage = {
              inputTokens: u.input_tokens ?? 0,
              outputTokens: u.output_tokens ?? 0,
              cacheReadTokens:
                (u.cache_read_input_tokens ?? 0) > 0
                  ? (u.cache_read_input_tokens ?? 0)
                  : (u.prompt_cache_hit_tokens ?? 0) > 0
                    ? (u.prompt_cache_hit_tokens ?? 0)
                    : undefined,
              cacheWriteTokens:
                (u.cache_creation_input_tokens ?? 0) > 0
                  ? (u.cache_creation_input_tokens ?? 0)
                  : (u.prompt_cache_miss_tokens ?? 0) > 0
                    ? (u.prompt_cache_miss_tokens ?? 0)
                    : undefined,
            };
          }
          break;
        }
        default:
          break;
      }
    }

    // 按 index 写入会产生稀疏数组;压实后再返回,避免 JSON 出现 null 块。
    // 半截 tool_use(无 content_block_stop 或 JSON 解析失败)不进 toolUses,并从 blocks 剔除(策略 A 写前丢弃)。
    const completedIds = new Set(toolUses.map((t) => t.id));
    const denseBlocks = blocks
      .filter((b): b is ProviderBlock => b != null)
      .filter((b) => b.type !== "tool_use" || completedIds.has(b.id));

    return {
      blocks: denseBlocks,
      toolUses,
      usage,
      ...(stopReason !== undefined ? { stopReason } : {}),
    };
  }
}
