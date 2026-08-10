import { describe, it, expect, vi } from "vitest";
import { AgentSession } from "../src/agent/agentLoop";
import { PermissionManager } from "../src/agent/permission";
import { PermissionRules } from "../src/agent/permissionRules";
import type { ProviderClient, ProviderMessage } from "../src/agent/provider/types";
import type { ToolExecutor } from "../src/agent/tools/executor";
import type { ContextManager } from "../src/agent/contextManager";

// 与 agentLoop.test.ts 同款注入风格:只 mock contextManager,不触发真实 LLM 调用。
function makeSession(opts: {
  contextManager?: unknown;
  initialHistory?: ProviderMessage[];
  onPersist?: (messages: ProviderMessage[]) => void;
}): AgentSession {
  return new AgentSession({
    provider: {
      capabilities: { supportsVision: true, supportsThinking: true },
      round: async () => {
        throw new Error("provider.round 不应在 compactNow 测试中被调用");
      },
    } as unknown as ProviderClient,
    tools: {
      allToolDefs: () => [],
      async execute() {
        return { ok: true, content: "" };
      },
    } as unknown as ToolExecutor,
    permissions: new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
    workspaceRoot: "/tmp",
    systemPrompt: "s",
    contextManager: opts.contextManager as ContextManager | undefined,
    initialHistory: opts.initialHistory,
    onPersist: opts.onPersist,
  });
}

describe("AgentSession.compactNow", () => {
  it("calls contextManager.compact with current messages and persists the result", async () => {
    const initialHistory: ProviderMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: [{ type: "text", text: "b" }] },
      { role: "user", content: "c" },
    ];
    const compacted: ProviderMessage[] = [{ role: "user", content: "[前文摘要]\nsum" }];
    const compact = vi.fn(async (msgs: ProviderMessage[]) => {
      expect(msgs).toEqual(initialHistory);
      return compacted;
    });
    let persisted: ProviderMessage[] | undefined;
    const session = makeSession({
      initialHistory,
      contextManager: { compact } as unknown as ContextManager,
      onPersist: (m) => {
        persisted = m;
      },
    });

    await session.compactNow();

    // compact 拿到的是当前全量消息,持久化落盘的是压缩后的结果
    expect(compact).toHaveBeenCalledTimes(1);
    expect(persisted).toEqual(compacted);
  });

  it("forces compaction regardless of the needsCompaction threshold", async () => {
    // 手动压缩不检查阈值:needsCompaction 即使返回 false 也照常 compact
    const compact = vi.fn(async (msgs: ProviderMessage[]) => msgs);
    const cm = {
      needsCompaction: () => false,
      compact,
    } as unknown as ContextManager;
    const session = makeSession({ contextManager: cm });

    await session.compactNow();

    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("propagates compaction errors (fail-fast so the command layer can toast)", async () => {
    const cm = {
      compact: async () => {
        throw new Error("summarize boom");
      },
    } as unknown as ContextManager;
    const session = makeSession({
      contextManager: cm,
      initialHistory: [{ role: "user", content: "x" }],
    });

    // 与 send() 内自动压缩的 fail-open 不同,compactNow 必须把错误抛给调用方
    await expect(session.compactNow()).rejects.toThrow("summarize boom");
  });

  it("persistNow is invoked even when compaction returns messages unchanged", async () => {
    const initialHistory: ProviderMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: [{ type: "text", text: "b" }] },
    ];
    const compact = vi.fn(async (msgs: ProviderMessage[]) => msgs); // 历史太短时原样返回
    let persistCalls = 0;
    let persisted: ProviderMessage[] | undefined;
    const session = makeSession({
      initialHistory,
      contextManager: { compact } as unknown as ContextManager,
      onPersist: (m) => {
        persistCalls++;
        persisted = m;
      },
    });

    await session.compactNow();

    expect(persistCalls).toBe(1);
    expect(persisted).toEqual(initialHistory);
  });
});
