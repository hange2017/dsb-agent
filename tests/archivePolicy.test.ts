import { describe, it, expect } from "vitest";
import { sessionToChunks } from "../src/agent/archivePolicy";
import type { ProviderMessage } from "../src/agent/provider/types";

function mk(): ProviderMessage[] {
  return [
    { role: "user", content: "需求:A" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "思考过程 alpha" },
        { type: "tool_use", id: "tu1", name: "Read", input: { path: "a.ts" } },
        { type: "text", text: "结论一" },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu1",
          content: [{ type: "text", text: "文件内容 X" }],
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "先分析原因:这是第一段比较长的解释文本,用于说明实现细节,包含足够多字符超过短文本阈值,需要写很长很长才能超过八百字符的短文本判定,所以这一段要多写一些细节描述,比如步骤拆分、异常处理、边界情况与兼容性考虑,把整个推理过程展开说明,确保长度足够,同时避免出现关键词导致被误判,还可以再补充一些背景信息,比如为什么选择当前的实现方式,以及历史遗留问题的处理思路,让第一段内容更加完整丰富,达到超过八百字符的长度要求,再展开一点关于设计权衡的叙述,把每个选项的利弊都描述清楚,方便后续检索与理解。\n\n继续补充第二段解释,涉及多个技术点的权衡与取舍说明,包括性能开销、可维护性、可测试性等方面的对比分析,以及在不同规模数据下的表现差异,这一段同样需要写得足够长以超过短文本阈值,但又不带关键词,保持纯粹的解释风格,详细展开各种设计选项的优劣,比如同步与异步的选择、缓存策略的取舍、错误处理粒度的把握,以及如何平衡实现复杂度与运行效率,把每一个技术决策的前因后果都交代清楚,让整段解释既有深度又有广度,再补充一些实现层面的注意事项,例如并发访问的同步问题、错误恢复策略、日志与监控的接入方式,以及未来可能的扩展方向,让整段内容充实完整。\n\n先分析原因:这是第一段比较长的解释文本,用于说明实现细节,包含足够多字符超过短文本阈值,需要写很长很长才能超过八百字符的短文本判定,所以这一段要多写一些细节描述,比如步骤拆分、异常处理、边界情况与兼容性考虑,把整个推理过程展开说明,确保长度足够,同时避免出现关键词导致被误判,还可以再补充一些背景信息,比如为什么选择当前的实现方式,以及历史遗留问题的处理思路,让第一段内容更加完整丰富,达到超过八百字符的长度要求,再展开一点关于设计权衡的叙述,把每个选项的利弊都描述清楚,方便后续检索与理解。\n\n继续补充第二段解释,涉及多个技术点的权衡与取舍说明,包括性能开销、可维护性、可测试性等方面的对比分析,以及在不同规模数据下的表现差异,这一段同样需要写得足够长以超过短文本阈值,但又不带关键词,保持纯粹的解释风格,详细展开各种设计选项的优劣,比如同步与异步的选择、缓存策略的取舍、错误处理粒度的把握,以及如何平衡实现复杂度与运行效率,把每一个技术决策的前因后果都交代清楚,让整段解释既有深度又有广度,再补充一些实现层面的注意事项,例如并发访问的同步问题、错误恢复策略、日志与监控的接入方式,以及未来可能的扩展方向,让整段内容充实完整。" }] },
    { role: "user", content: "[前文摘要]\n[compacted]\n- [r1] 老压缩块" },
  ];
}

describe("sessionToChunks", () => {
  it("maps full history to cold-storage chunks (skipping compacted)", () => {
    const chunks = sessionToChunks(mk());
    const types = chunks.map((c) => c.type);
    expect(types).toContain("demand");
    expect(types).toContain("thinking");
    expect(types).toContain("ledger"); // tool_use + tool_result
    expect(types).toContain("conclusion");
    expect(types).toContain("explanation");
    // 压缩块不归档
    expect(chunks.some((c) => c.content.includes("[compacted]"))).toBe(false);
  });

  it("each chunk has summary + content + role", () => {
    for (const c of sessionToChunks(mk())) {
      expect(typeof c.summary).toBe("string");
      expect(c.summary.length).toBeGreaterThan(0);
      expect(typeof c.content).toBe("string");
      expect(c.content.length).toBeGreaterThan(0);
      expect(["user", "assistant", "tool"]).toContain(c.role);
    }
  });

  it("empty message lists produce no chunks", () => {
    expect(sessionToChunks([])).toEqual([]);
    expect(sessionToChunks([{ role: "user", content: "   " }])).toEqual([]);
  });

  it("tool_result role is tool with key lines summary", () => {
    const chunks = sessionToChunks(mk());
    const toolChunks = chunks.filter((c) => c.role === "tool" && c.content.startsWith("文件内容"));
    expect(toolChunks.length).toBe(1);
    expect(toolChunks[0].type).toBe("ledger");
  });
});
