import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionService } from "../src/chat/sessionService";
import { SessionStore } from "../src/session/sessionStore";
import { PermissionManager } from "../src/agent/permission";
import { PermissionRules } from "../src/agent/permissionRules";
import type { AgentLoopEvent } from "../src/agent/agentLoop";
import type { ProviderMessage } from "../src/agent/provider/types";
import type { SessionEvent } from "../src/session/sessionTypes";
import type { Configuration } from "../src/settings/configuration";
import type { CreateSessionFn, SessionLike } from "../src/chat/sessionTypes";

let dir: string;
let store: SessionStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dss-"));
  store = new SessionStore(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function makeService(opts?: { sessionIdSeed?: string }) {
  const sessionImpl: SessionLike = {
    send: async (_t: string, _onEvent: (ev: AgentLoopEvent) => void) => {},
    cancel: () => {},
  };
  const createSession: CreateSessionFn = async (o) => {
    captured = { onRecord: o.onRecord, onPersist: o.onPersist, initialHistory: o.initialHistory, sessionId: o.sessionId, permissions: o.permissions, onWorkflowProgress: o.onWorkflowProgress };
    return sessionImpl;
  };
  // onPersist 参数须与 CreateSessionFn 声明一致(ProviderMessage[]),否则逆变赋值报错。
  let captured: { onRecord?: (ev: SessionEvent) => void; onPersist?: (m: ProviderMessage[]) => void; initialHistory?: unknown[]; sessionId?: string; permissions?: PermissionManager; onWorkflowProgress?: (stageId: string, status: "running" | "done" | "error") => void } | undefined;
  const svc = new SessionService({
    apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
    // Configuration 含私有 reader 字段,对象字面量无法结构化匹配,仅测 baseUrl/model 两个方法故强转。
    configuration: { baseUrl: () => "https://x", model: () => "m" } as Configuration,
    getWorkspaceCwd: () => "/tmp",
    sessionStore: store,
    createSession,
    currentModel: () => undefined,
    makePermissions: () => new PermissionManager({ gateway: { request: async () => true }, rules: new PermissionRules() }),
    makeHooks: () => undefined as never,
    onWorkflowProgress: (_stageId, _status) => {},
  });
  return { svc, sessionImpl, captured: () => captured };
}

describe("SessionService", () => {
  it("ensureSession creates once and binds onRecord/onPersist to the session id", async () => {
    const { svc, captured } = makeService();
    const a = await svc.ensureSession("/tmp");
    const b = await svc.ensureSession("/tmp");
    expect(a.sessionId).toBe(b.sessionId); // 复用主会话
    const cap = captured()!;
    expect(cap.sessionId).toBe(a.sessionId);
    expect(cap.initialHistory).toEqual([]);
    cap.onRecord?.({ kind: "user", text: "hi", timestamp: 1 });
    cap.onPersist?.([{ role: "user", content: "hi" }]);
    expect(store.load(a.sessionId).some((e) => e.kind === "user")).toBe(true);
    expect(store.loadApiHistory(a.sessionId)).toEqual([{ role: "user", content: "hi" }]);
  });
  it("loadSession reads api-history first, falls back to eventsToHistory", () => {
    const id = store.create();
    store.append(id, { kind: "user", text: "你好", timestamp: 1 });
    store.append(id, { kind: "assistant", text: "你好!", timestamp: 2 });
    store.saveApiHistory(id, [
      { role: "user", content: "你好" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ]);
    const { svc } = makeService();
    const events = svc.loadSession(id);
    expect(events).toHaveLength(2);
    expect(svc.getSessionId()).toBe(id);
  });
  it("loadSession falls back to text history when no api-history", () => {
    const id = store.create();
    store.append(id, { kind: "user", text: "你好", timestamp: 1 });
    const { svc } = makeService();
    svc.loadSession(id);
    expect(svc.historySnapshot()).toEqual([{ role: "user", content: "你好" }]);
  });
  it("newSession clears state", async () => {
    const { svc } = makeService();
    await svc.ensureSession("/tmp");
    expect(svc.getSessionId()).toBeDefined();
    svc.newSession();
    expect(svc.getSessionId()).toBeUndefined();
    expect(svc.historySnapshot()).toEqual([]);
  });
  it("deleteSession removes the store file and resets if current", async () => {
    const { svc } = makeService();
    const id = store.create();
    svc.loadSession(id);
    svc.deleteSession(id);
    expect(store.list()).toHaveLength(0);
    expect(svc.getSessionId()).toBeUndefined();
  });
  it("createStandalone creates a fresh session without touching main state", async () => {
    const { svc } = makeService();
    await svc.ensureSession("/tmp");
    const mainId = svc.getSessionId();
    const st = await svc.createStandalone("/tmp");
    expect(st.sessionId).not.toBe(mainId);
    expect(svc.getSessionId()).toBe(mainId); // 主会话不变
  });
  it("createStandalone does not forward onWorkflowProgress (no webview target)", async () => {
    const { svc, captured } = makeService();
    await svc.ensureSession("/tmp");
    expect(captured()!.onWorkflowProgress).toBeDefined(); // 对照:主会话转发给 webview 时间线
    await svc.createStandalone("/tmp");
    const cap = captured()!;
    expect(cap.onWorkflowProgress).toBeUndefined();
  });
});
