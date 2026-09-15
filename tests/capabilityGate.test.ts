import { describe, it, expect } from "vitest";
import {
  prepareRound,
  resolveThinkingParams,
  dynamicMaxTokens,
  sanitizeOutbound,
  repairToolUseResultPairs,
} from "../src/agent/capabilityGate";
import type { ProviderMessage } from "../src/agent/provider/types";

describe("dynamicMaxTokens", () => {
  it("equals cap when plenty of room", () => {
    expect(
      dynamicMaxTokens({ windowTokens: 100_000, lastInputTokens: 1_000, maxOutputTokens: 8192 }),
    ).toBe(8192);
  });

  it("shrinks when remaining is small", () => {
    // window 10000, last 9000, reserve min(1024,100)=100 → remaining-reserve=900
    expect(
      dynamicMaxTokens({ windowTokens: 10_000, lastInputTokens: 9_000, maxOutputTokens: 8192 }),
    ).toBe(900);
  });

  it("never goes below 1", () => {
    expect(
      dynamicMaxTokens({ windowTokens: 100, lastInputTokens: 200, maxOutputTokens: 8192 }),
    ).toBe(1);
  });
});

describe("prepareRound", () => {
  it("strips thinking when unsupported and exposes parallel defaults", () => {
    const messages: ProviderMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "x" },
          { type: "text", text: "hi" },
        ],
      },
    ];
    const out = prepareRound({
      caps: { supportsVision: false, supportsThinking: false, maxOutputTokens: 4096 },
      messages,
    });
    expect(out.outbound[0]).toEqual({ role: "assistant", content: [{ type: "text", text: "hi" }] });
    expect(out.maxTokens).toBe(4096);
    expect(out.maxParallelTools).toBe(8);
    expect(out.toolParallelMode).toBe("read_safe");
  });

  it("respects parallel caps; 预算装不进 maxTokens 时禁用而非发违规组合", () => {
    const out = prepareRound({
      caps: {
        supportsVision: true,
        supportsThinking: true,
        thinkingBudgetTokens: 2048,
        maxParallelTools: 2,
        toolParallelMode: "serial",
        contextWindowTokens: 50_000,
        maxOutputTokens: 8192,
      },
      messages: [{ role: "user", content: "a" }],
      lastInputTokens: 49_000,
    });
    // 窗口吃紧(maxTokens≈500),预算 2048 装不下且低于 1024 下限 → 禁用 thinking,
    // 而不是发出 `budget_tokens >= max_tokens` 的违规组合(严格端点 400)。
    expect(out.thinkingDisabled).toBe(true);
    expect(out.thinkingBudgetTokens).toBeUndefined();
    expect(out.maxParallelTools).toBe(2);
    expect(out.toolParallelMode).toBe("serial");
    expect(out.maxTokens).toBeLessThan(8192);
  });

  it("level 预算超出本轮输出上限时收敛,为正文留住额度", () => {
    const out = prepareRound({
      caps: { supportsVision: true, supportsThinking: true, thinkingLevel: "high" },
      messages: [{ role: "user", content: "a" }],
      lastInputTokens: 100,
    });
    // high=16384 + 预留 1024 > maxTokens 8192 → 收敛为 8192-1024=7168(< maxTokens,且 >= 1024 下限)。
    expect(out.maxTokens).toBe(8192);
    expect(out.thinkingBudgetTokens).toBe(7168);
    expect(out.thinkingDisabled).toBeUndefined();
  });

  it("explicit thinkingBudgetTokens wins over thinkingLevel", () => {
    const out = prepareRound({
      caps: { supportsVision: true, supportsThinking: true, thinkingBudgetTokens: 2048, thinkingLevel: "low" },
      messages: [{ role: "user", content: "a" }],
      lastInputTokens: 100,
    });
    expect(out.thinkingBudgetTokens).toBe(2048);
  });
});

describe("resolveThinkingParams(协议自洽规则)", () => {
  const base = { supportsVision: true, supportsThinking: true } as const;

  it("能力不支持思考 → 禁用", () => {
    expect(resolveThinkingParams({ supportsVision: true, supportsThinking: false }, 8192)).toEqual({
      thinkingDisabled: true,
    });
  });

  it("调用方显式禁用优先于能力支持", () => {
    expect(
      resolveThinkingParams({ ...base, thinkingBudgetTokens: 2048 }, 8192, { thinkingDisabled: true }),
    ).toEqual({ thinkingDisabled: true });
  });

  it("未配置任何预算 → 不注入 thinking 参数", () => {
    expect(resolveThinkingParams(base, 8192)).toEqual({});
  });

  it("预算装得下 → 原样启用", () => {
    expect(resolveThinkingParams({ ...base, thinkingBudgetTokens: 4096 }, 8192)).toEqual({
      thinkingBudgetTokens: 4096,
    });
  });

  it("预算装不下但收敛后仍 >=1024 → 收敛,正文保留 1024 额度", () => {
    expect(resolveThinkingParams({ ...base, thinkingLevel: "high" }, 8192)).toEqual({
      thinkingBudgetTokens: 7168,
    });
    // 上限刚过下限:3500-1024=2476,仍给正文留 1024
    expect(resolveThinkingParams({ ...base, thinkingLevel: "medium" }, 3500)).toEqual({
      thinkingBudgetTokens: 2476,
    });
  });

  it("压缩摘要小额度(maxTokens=800/200,medium=4096)→ 禁用,杜绝空转付费与 400", () => {
    for (const maxTokens of [800, 200]) {
      expect(resolveThinkingParams({ ...base, thinkingLevel: "medium" }, maxTokens)).toEqual({
        thinkingDisabled: true,
      });
    }
  });

  it("越 explanation 上限的 3500 档 → 收敛到 2476(不再让思考吃光额度,也不再违规)", () => {
    // 旧行为:透传 4096 → `budget>=max_tokens` 违规,且思考吃掉几乎全部输出额度。
    expect(resolveThinkingParams({ ...base, thinkingLevel: "medium" }, 3500)).toEqual({
      thinkingBudgetTokens: 2476,
    });
  });

  it("中强度预算在充裕输出上限下仍启用(不误伤正常轮次)", () => {
    expect(resolveThinkingParams({ ...base, thinkingLevel: "medium" }, 8192)).toEqual({
      thinkingBudgetTokens: 4096,
    });
  });
});

describe("sanitizeOutbound", () => {
  it("strips historical images when vision unsupported", () => {
    const messages: ProviderMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
          { type: "text", text: "see" },
        ],
      },
    ];
    expect(sanitizeOutbound({ supportsVision: false, supportsThinking: true }, messages)).toEqual([
      { role: "user", content: "see" },
    ]);
  });

  it("repairs orphan tool_use before send (API 400: tool_use without tool_result immediately after)", () => {
    const messages: ProviderMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_00_orphan", name: "Read", input: { path: "a.ts" } }],
      },
      { role: "user", content: "继续" }, // 紧随其后的是普通文本,不是 tool_result
    ];
    const out = sanitizeOutbound({ supportsVision: true, supportsThinking: true }, messages);
    expect(out).toHaveLength(4);
    expect(out[2]).toMatchObject({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_00_orphan",
        },
      ],
    });
    expect(out[3]).toEqual({ role: "user", content: "继续" });
  });

  // 网关 400: messages.N: all messages must have non-empty content
  // 场景:thinking 全剥后空 assistant、或历史落盘 content:[]
  it("drops empty-content messages before send (API 400: non-empty content)", () => {
    const messages: ProviderMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "only think" }],
      },
      { role: "assistant", content: [] },
      { role: "user", content: "" },
      { role: "user", content: "继续" },
    ];
    const out = sanitizeOutbound({ supportsVision: true, supportsThinking: false }, messages);
    expect(out).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "继续" },
    ]);
  });
});

describe("repairToolUseResultPairs", () => {
  it("leaves valid tool_use/tool_result pairs unchanged", () => {
    const messages: ProviderMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: {} },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a" }] },
          { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "b" }] },
        ],
      },
    ];
    expect(repairToolUseResultPairs(messages)).toEqual(messages);
  });

  it("appends synthetic tool_result when history ends on orphan tool_use", () => {
    const messages: ProviderMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t9", name: "Read", input: { path: "z" } }],
      },
    ];
    const out = repairToolUseResultPairs(messages);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t9" }],
    });
  });

  it("fills missing tool_result ids into the following tool_result user message", () => {
    const messages: ProviderMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: {} },
          { type: "tool_use", id: "t2", name: "Read", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "only t1" }] }],
      },
    ];
    const out = repairToolUseResultPairs(messages);
    expect(out).toHaveLength(2);
    const results = (out[1].content as Array<{ type: string; tool_use_id: string }>).filter(
      (b) => b.type === "tool_result",
    );
    expect(results.map((r) => r.tool_use_id).sort()).toEqual(["t1", "t2"]);
  });

  it("splits mixed tool_result+text user so tool_use is followed by pure tool_result only", () => {
    // injectTodo 曾把清单 text 前置进 tool_result 消息 → DeepSeek 报 400
    const messages: ProviderMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_00_Brz", name: "Bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "## 任务清单\n- [ ] a" },
          { type: "tool_result", tool_use_id: "call_00_Brz", content: [{ type: "text", text: "ok" }] },
        ],
      },
    ];
    const out = repairToolUseResultPairs(messages);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_00_Brz", content: [{ type: "text", text: "ok" }] }],
    });
    expect(out[2]).toEqual({
      role: "user",
      content: "## 任务清单\n- [ ] a",
    });
  });
});
