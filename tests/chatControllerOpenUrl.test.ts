import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("vscode", () => ({
  env: { openExternal: vi.fn().mockResolvedValue(true) },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  window: { showTextDocument: vi.fn(), activeTerminal: undefined, terminals: [] },
  workspace: { openTextDocument: vi.fn() },
  commands: { registerCommand: vi.fn((_id: string, fn: () => void) => ({ dispose: vi.fn() })), executeCommand: vi.fn() },
}));

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChatController } from "../src/chat/chatController";
import { SessionStore } from "../src/session/sessionStore";
import { MemoryStore } from "../src/agent/memory/memoryStore";
import type { AgentLoopEvent } from "../src/agent/agentLoop";

let dir: string;
let store: SessionStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-url-"));
  store = new SessionStore(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function makeController() {
  const sessionImpl = {
    send: async (_text: string, onEvent: (ev: AgentLoopEvent) => void) => {
      onEvent({ type: "status", busy: true, info: "等待" });
      onEvent({ type: "text_delta", text: "Hello" });
      onEvent({ type: "done" });
    },
    cancel: () => {},
  };
  const deps = {
    apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
    configuration: { baseUrl: () => "https://api.example.com/anthropic", model: () => "m" },
    getWorkspaceCwd: () => "/tmp",
    sessionStore: store,
    createSession: (_opts: unknown) => sessionImpl,
    memory: new MemoryStore(path.join(dir, "mem")),
  };
  const posted: unknown[] = [];
  const controller = new ChatController(deps as never, (m) => posted.push(m));
  return { controller, posted };
}

describe("open_url 消息", () => {
  it("合法 URL 通过 env.openExternal 打开且不发 toast", async () => {
    const vscode = await import("vscode");
    vi.clearAllMocks();
    const { controller, posted } = makeController();
    await controller.handle({ type: "open_url", url: "https://example.com/docs" } as never);
    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
    const toasts = posted.filter((m) => (m as { type?: string }).type === "toast");
    expect(toasts).toHaveLength(0);
  });

  it("空白/无效 URL 不发 openExternal", async () => {
    const vscode = await import("vscode");
    vi.clearAllMocks();
    const { controller } = makeController();
    await controller.handle({ type: "open_url", url: "   " } as never);
    await controller.handle({ type: "open_url", url: "javascript:alert(1)" } as never);
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
  });
});
