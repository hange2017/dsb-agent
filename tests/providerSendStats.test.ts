import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  estimateImageTokens,
  estimateMessageTokens,
  estimateProviderSendTokens,
} from "../src/stats/providerSendStats";
import type { ProviderMessage } from "../src/agent/provider/types";

describe("estimateTokens", () => {
  it("estimates CJK at ~1 token per char", () => {
    expect(estimateTokens("你好世界")).toBe(4);
  });
  it("estimates latin at ~1 token per 4 chars", () => {
    expect(estimateTokens("abcdefgh")).toBe(2);
  });
  it("estimates mixed content", () => {
    const t = estimateTokens("你好 hello 世界");
    // 4 个 CJK + 6 个非 CJK(含空格)/4 = 4 + 2 = 6
    expect(t).toBe(6);
  });
  it("returns 0 for empty and at least 1 for non-empty", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
  });
});

describe("estimateImageTokens", () => {
  it("estimates by decoded byte size", () => {
    // base64 4 字符 = 3 字节
    expect(estimateImageTokens("AAAA")).toBe(1); // 3 字节 → 1 token(≤1024)
    expect(estimateImageTokens("A".repeat(1024))).toBe(1); // 768 字节 → 1
    expect(estimateImageTokens("A".repeat(1400))).toBe(2); // 1050 字节 → 2
  });
});

describe("estimateProviderSendTokens", () => {
  const compactedBlock =
    "[compacted]\n## 需求\n- [r1] 用户需求\n## 结论\n- [r2] 结论文本\n## 说明\n- [r3] 解释摘要\n## 工具履历\n- [r4] ⤷ Read src/foo.ts";
  const thinkingBlock = "[thinking]\n## 正确\n- [r1] 推理正确\n## 错误\n- [r2] 推理错误";

  function buildMessages(): ProviderMessage[] {
    return [
      { role: "user", content: compactedBlock },
      { role: "user", content: thinkingBlock },
      // tail 1:历史用户文本
      { role: "user", content: "帮我看看这个文件" },
      // tail 2:assistant 回复含 text + thinking 原文 + tool_use
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "我要先读文件再回答" },
          { type: "text", text: "我先读一下文件" },
          { type: "tool_use", id: "t1", name: "Read", input: { file: "src/foo.ts" } },
        ],
      },
      // tail 3:tool_result(blocks 形状)
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "文件内容" }] },
        ],
      },
      // tail 4:assistant 最终文本
      { role: "assistant", content: [{ type: "text", text: "结论是文件没问题" }] },
      // 当前轮:最后一条 user 文本
      { role: "user", content: "好的，谢谢" },
    ];
  }

  it("classifies every block kind", () => {
    const b = estimateProviderSendTokens("system prompt 你好", buildMessages());
    expect(b.hasCompactedBlock).toBe(true);
    expect(b.compactedBlockTokens).toBeGreaterThan(0);
    expect(b.thinkingBlockTokens).toBeGreaterThan(0);
    expect(b.userTextTokens).toBeGreaterThan(0);
    expect(b.toolResultTokens).toBeGreaterThan(0);
    expect(b.assistantTextTokens).toBeGreaterThan(0);
    expect(b.toolUseTokens).toBeGreaterThan(0);
    expect(b.assistantThinkingTokens).toBeGreaterThan(0);
    expect(b.systemTokens).toBeGreaterThan(0);
    // tail = 除压缩块与 thinking 块外的全部(5 条消息)
    expect(b.tailMessageCount).toBe(5);
    expect(b.tailTokens).toBe(
      b.messagesTokens - b.compactedBlockTokens - b.thinkingBlockTokens,
    );
    expect(b.currentRoundTokens).toBe(estimateTokens("好的，谢谢"));
    expect(b.totalTokens).toBe(b.systemTokens + b.messagesTokens);
  });

  it("sum of parts equals messages total", () => {
    const b = estimateProviderSendTokens("sys", buildMessages());
    const parts =
      b.compactedBlockTokens +
      b.thinkingBlockTokens +
      b.userTextTokens +
      b.toolResultTokens +
      b.assistantTextTokens +
      b.toolUseTokens +
      b.assistantThinkingTokens +
      b.imageTokens;
    expect(parts).toBe(b.messagesTokens);
  });

  it("handles no compacted/thinking blocks (plain history)", () => {
    const b = estimateProviderSendTokens("sys", [
      { role: "user", content: "历史问题" },
      { role: "assistant", content: [{ type: "text", text: "历史回答" }] },
    ]);
    expect(b.hasCompactedBlock).toBe(false);
    expect(b.compactedBlockTokens).toBe(0);
    expect(b.thinkingBlockTokens).toBe(0);
    expect(b.tailTokens).toBe(b.messagesTokens);
    expect(b.tailMessageCount).toBe(2);
  });

  it("counts image blocks separately", () => {
    const b = estimateProviderSendTokens("sys", [
      {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(1400) } },
        ],
      },
    ]);
    expect(b.imageTokens).toBe(2); // 1050 字节 → 2
    expect(b.userTextTokens).toBe(estimateTokens("看图"));
    // 当前轮 = text + image
    expect(b.currentRoundTokens).toBe(estimateTokens("看图") + 2);
    expect(estimateImageTokens("A".repeat(4 * 2048))).toBe(6); // 6144 字节 → 6
  });

  it("recognizes compacted/thinking by first non-empty line", () => {
    // 压缩块/thinking 块可能带前导空行,isCompactedBlock 按行匹配
    const b = estimateProviderSendTokens("", [
      { role: "user", content: "\n[compacted]\n## 需求\n- [r1] x" },
      { role: "user", content: "普通" },
    ]);
    expect(b.compactedBlockTokens).toBeGreaterThan(0);
    expect(b.userTextTokens).toBe(estimateTokens("普通"));
    expect(b.tailMessageCount).toBe(1);
  });
});

describe("estimateMessageTokens", () => {
  it("estimates single user text message", () => {
    expect(estimateMessageTokens({ role: "user", content: "你好世界" })).toBe(4);
  });
  it("estimates user blocks (text + tool_result + image)", () => {
    const msg: ProviderMessage = {
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "文件内容" }] },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(1400) } },
      ],
    };
    expect(estimateMessageTokens(msg)).toBe(estimateTokens("看图") + 4 + 2);
  });
  it("estimates assistant blocks (text + thinking + tool_use)", () => {
    const msg: ProviderMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "推理中" },
        { type: "text", text: "正文" },
        { type: "tool_use", id: "t1", name: "Read", input: { file: "a.ts" } },
      ],
    };
    const expected = estimateTokens("推理中") + estimateTokens("正文") + estimateTokens(JSON.stringify({ file: "a.ts" }));
    expect(estimateMessageTokens(msg)).toBe(expected);
  });
  it("whole-package tokens equal sum of per-message tokens", () => {
    const messages: ProviderMessage[] = [
      { role: "user", content: "第一个问题" },
      { role: "assistant", content: [{ type: "text", text: "第一个回答" }] },
      { role: "user", content: "第二个问题" },
    ];
    const b = estimateProviderSendTokens("", messages);
    const sum = messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
    expect(b.messagesTokens).toBe(sum);
  });
});

describe("messageBreakdown per-part detail", () => {
  it("records index/role/kind/tokens for every message and block", () => {
    const messages: ProviderMessage[] = [
      { role: "user", content: "[compacted]\n## 需求\n- [r1] x" },
      { role: "user", content: "普通问题" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "推理中" },
          { type: "text", text: "正文" },
          { type: "tool_use", id: "t1", name: "Read", input: { file: "a.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "文件内容很长" }] },
        ],
      },
    ];
    const b = estimateProviderSendTokens("", messages);
    // compacted(1) + user_text(1) + assistant 3 块 + tool_result(1) = 6 parts
    expect(b.messageBreakdown).toHaveLength(6);
    expect(b.messageBreakdown[0]).toEqual({
      index: 0,
      role: "user",
      kind: "compacted",
      tokens: b.compactedBlockTokens,
    });
    expect(b.messageBreakdown[1]).toEqual({ index: 1, role: "user", kind: "user_text", tokens: estimateTokens("普通问题") });
    const assistantParts = b.messageBreakdown.slice(2, 5);
    expect(assistantParts.map((p) => p.kind)).toEqual(["assistant_thinking", "text", "tool_use"]);
    expect(assistantParts.every((p) => p.index === 2 && p.role === "assistant")).toBe(true);
    expect(b.messageBreakdown[5]).toEqual({ index: 3, role: "user", kind: "tool_result", tokens: b.toolResultTokens });
  });

  it("sum of breakdown tokens equals messagesTokens", () => {
    const messages: ProviderMessage[] = [
      { role: "user", content: "第一个问题" },
      { role: "assistant", content: [{ type: "text", text: "第一个回答" }] },
      { role: "user", content: "第二个问题" },
      {
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(1400) } }],
      },
    ];
    const b = estimateProviderSendTokens("", messages);
    const sum = b.messageBreakdown.reduce((acc, p) => acc + p.tokens, 0);
    expect(sum).toBe(b.messagesTokens);
    expect(b.messageBreakdown).toHaveLength(4);
    expect(b.messageBreakdown[3].kind).toBe("image");
    expect(b.messageBreakdown[3].tokens).toBe(2);
  });

  it("recognizes thinking_block as its own kind", () => {
    const b = estimateProviderSendTokens("", [
      { role: "user", content: "[thinking]\n## 正确\n- [r1] 推理" },
      { role: "user", content: "继续" },
    ]);
    expect(b.messageBreakdown.map((p) => p.kind)).toEqual(["thinking_block", "user_text"]);
    expect(b.messageBreakdown[0].tokens).toBe(b.thinkingBlockTokens);
  });
});
