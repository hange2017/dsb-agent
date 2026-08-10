/**
 * 端到端冒烟:fixture 会话历史 → ContextManager.compact(分轨+冷存储)→ ContextRecall 回查。
 * 仅验收阶段使用,验证后删除。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ContextManager } from "../src/agent/contextManager";
import { ContextStore } from "../src/context/contextStore";
import { isCompactedBlock, parseCompactedBlock } from "../src/agent/contextCompactor";
import { contextRecallExecute } from "../src/agent/tools/contextRecallTool";
import type { ProviderMessage } from "../src/agent/provider/types";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("冒烟:压缩 → 冷存储 → 回查", () => {
  it("端到端", async () => {
    const store = new ContextStore(path.join(tmp, "context"), { maxChunks: 80 });
    const cm = new ContextManager({
      windowTokens: 1000,
      triggerRatio: 0.7,
      contextStore: store,
      sessionId: "s_smoke",
      summarize: async (text) => `[解释摘要] ${text.slice(0, 24)}…`,
    });

    const history: ProviderMessage[] = [
      { role: "user", content: "修复 sessionStore 的隔离问题" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "已定位问题\n\n" + "根因分析:项目隔离时会话目录混用。".repeat(60) + "\n\n建议按 projectKey 分目录" },
          { type: "tool_use", id: "t1", name: "Read", input: { path: "src/session/sessionStore.ts" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents\nline2\nline3" }] },
      { role: "user", content: "继续" },
      { role: "user", content: "tail0" },
      { role: "user", content: "tail1" },
      { role: "user", content: "tail2" },
      { role: "user", content: "tail3" },
    ];

    const out = await cm.compact(history);
    const head = out[0];
    expect(head.role).toBe("user");
    const block = head.content as string;
    expect(isCompactedBlock(block)).toBe(true);
    // 四轨齐全
    expect(block).toContain("## 需求");
    expect(block).toContain("## 结论");
    expect(block).toContain("## 说明");
    expect(block).toContain("## 工具履历");
    expect(block).toContain("- [r1] 修复 sessionStore 的隔离问题");
    expect(block).toContain("- [r2] 已定位问题");
    expect(block).toContain("[解释摘要]");
    expect(block).toContain("- [r2] Read: src/session/sessionStore.ts");
    expect(block).toContain("- [r3] ⤷ file contents | line2 | line3");
    // tail 保留 4 条
    expect(out).toHaveLength(5);
    expect(JSON.stringify(out.slice(1))).toContain("tail0");
    // 冷存储文件存在且可按 seq 回查
    const coldFile = path.join(tmp, "context", "s_smoke.context.json");
    expect(fs.existsSync(coldFile)).toBe(true);
    const chunks = store.load("s_smoke");
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    // ContextRecall 命中需求原文
    const hit = contextRecallExecute(store, "s_smoke", { seq: 1 });
    expect(hit.ok).toBe(true);
    expect(hit.content).toContain("修复 sessionStore 的隔离问题");
    // ContextRecall 索引模式
    const idx = contextRecallExecute(store, "s_smoke", {});
    expect(idx.ok).toBe(true);
    expect(idx.content).toContain("[r1] (demand/user)");
    expect(idx.content).toContain("[r2] (ledger/assistant)");
    // 解析块再合并(增量路径原料)
    const parsed = parseCompactedBlock(block);
    expect(parsed.demands[0]).toContain("[r1]");
    expect(parsed.ledger.some((l) => l.includes("Read: src/session/sessionStore.ts"))).toBe(true);
    // 增量压缩:旧块 + 新段,旧行保留、新段进轨(seq 继续推进,不碰撞)
    const more: ProviderMessage[] = [
      { role: "user", content: block },
      { role: "user", content: "新需求:跑全量测试" },
      { role: "user", content: "中间" },
      { role: "user", content: "tailA" },
      { role: "user", content: "tailB" },
      { role: "user", content: "tailC" },
    ];
    const out2 = await cm.compact(more);
    const block2 = out2[0].content as string;
    expect(block2).toContain("- [r1] 修复 sessionStore 的隔离问题");
    expect(block2).toContain("- [r5] 新需求:跑全量测试");
    expect(isCompactedBlock(block2)).toBe(true);
  });
});
