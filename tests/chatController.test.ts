import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChatController } from "../src/chat/chatController";
import { loadProjectContext } from "../src/projectContext";
import { SessionStore } from "../src/session/sessionStore";
import { MarketplaceManager } from "../src/plugins/marketplace";
import type { AgentLoopEvent } from "../src/agent/agentLoop";
import type { PermissionManager } from "../src/agent/permission";
import type { ProviderMessage } from "../src/agent/provider/types";
import { MemoryStore } from "../src/agent/memory/memoryStore";
import { MemorySessionUiState, type SessionUiState } from "../src/settings/sessionUiState";

let dir: string;
let store: SessionStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-"));
  store = new SessionStore(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function makeDeps(extra?: { sessionUiState?: SessionUiState; activityStats?: { recordActivity: (d: Date) => void } }) {
  const sessionImpl = {
    send: async (_text: string, onEvent: (ev: AgentLoopEvent) => void) => {
      onEvent({ type: "status", busy: true, info: "等待" });
      onEvent({ type: "text_delta", text: "Hello" });
      onEvent({ type: "tool_call", callId: "t1", name: "Read", status: "running", input: { path: "a.ts" } });
      onEvent({ type: "tool_call", callId: "t1", name: "Read", status: "completed", input: { path: "a.ts" }, detail: "x" });
      onEvent({ type: "done" });
    },
    cancel: () => {},
  };
  const deps = {
    apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
    configuration: { baseUrl: () => "https://api.deepseek.com/anthropic", model: () => "m" },
    getWorkspaceCwd: () => "/tmp",
    sessionStore: store,
    createSession: (_opts: unknown) => sessionImpl,
    memory: new MemoryStore(path.join(dir, "mem")),
    sessionUiState: extra?.sessionUiState,
    activityStats: extra?.activityStats,
  };
  const posted: unknown[] = [];
  const controller = new ChatController(deps as never, (m) => posted.push(m));
  return { controller, posted };
}

function makeControllableDeps(sendImpl: (text: string, onEvent: (ev: AgentLoopEvent) => void) => Promise<void>) {
  const sent: string[] = [];
  const sessionImpl = {
    send: async (text: string, onEvent: (ev: AgentLoopEvent) => void) => {
      sent.push(text);
      await sendImpl(text, onEvent);
    },
    cancel: () => {},
  };
  const deps = {
    apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
    configuration: { baseUrl: () => "https://api.deepseek.com/anthropic", model: () => "m" },
    getWorkspaceCwd: () => "/tmp",
    sessionStore: store,
    createSession: (_opts: unknown) => sessionImpl,
    memory: new MemoryStore(path.join(dir, "mem")),
  };
  const posted: unknown[] = [];
  const controller = new ChatController(deps as never, (m) => posted.push(m));
  return { controller, posted, sent, sessionImpl };
}

function typeOf(m: unknown): string {
  return (m as { type: string }).type;
}

function pngB64(): string {
  return Buffer.from("pngbytes").toString("base64");
}

describe("ChatController", () => {
  it("sends user message and forwards stream events", async () => {
    const { controller, posted } = makeDeps();
    await controller.handle({ type: "ready" });
    await controller.handle({ type: "send", text: "hi" });

    const types = posted.map((m) => (m as { type: string }).type);
    expect(types).toContain("message"); // user 消息
    expect(types).toContain("stream");
    expect(types).toContain("timeline_step");
    expect(types).toContain("status");
    const readStep = posted.find(
      (m) => typeOf(m) === "timeline_step" && (m as { kind: string }).kind === "tool" && (m as { name: string }).name === "Read",
    ) as { displayName: string; headerSecondary?: string };
    expect(readStep.displayName).toBe("Read");
    expect(readStep.headerSecondary ?? "").toMatch(/a\.ts/);
  });

  it("opens text steps with stepId and finals only the last segment", async () => {
    const sendImpl = async (_text: string, onEvent: (ev: AgentLoopEvent) => void) => {
      onEvent({ type: "text_delta", text: "A" });
      onEvent({ type: "tool_call", callId: "t1", name: "Read", status: "running", input: { path: "a.ts" } });
      onEvent({ type: "tool_call", callId: "t1", name: "Read", status: "completed", input: { path: "a.ts" }, detail: "x" });
      onEvent({ type: "text_delta", text: "B" });
      onEvent({ type: "done" });
    };
    const { controller, posted } = makeControllableDeps(sendImpl);
    await controller.handle({ type: "send", text: "hi" });

    const textSteps = posted.filter(
      (m) => typeOf(m) === "timeline_step" && (m as { kind: string }).kind === "text",
    ) as Array<{ stepId: string; status: string; text?: string; final?: boolean }>;
    const streams = posted.filter((m) => typeOf(m) === "stream") as Array<{ stepId?: string; text: string }>;
    expect(streams.length).toBeGreaterThan(0);
    expect(streams.every((s) => typeof s.stepId === "string" && s.stepId.length > 0)).toBe(true);

    const completed = textSteps.filter((s) => s.status === "completed");
    expect(completed.length).toBe(2);
    expect(completed[0].stepId).not.toBe(completed[1].stepId);
    expect(completed[0].text).toBe("A");
    expect(completed[0].final).toBeFalsy();
    expect(completed[1].text).toBe("B");
    expect(completed[1].final).toBe(true);
  });

  it("accumulates thinking deltas into one timeline step and marks completed on done", async () => {
    const sendImpl = async (_text: string, onEvent: (ev: AgentLoopEvent) => void) => {
      onEvent({ type: "thinking_delta", text: "The" });
      onEvent({ type: "thinking_delta", text: " user" });
      onEvent({ type: "text_delta", text: "Hello" });
      onEvent({ type: "done" });
    };
    const { controller, posted } = makeControllableDeps(sendImpl);
    await controller.handle({ type: "send", text: "hi" });

    const steps = posted.filter(
      (m) => typeOf(m) === "timeline_step" && (m as { kind: string }).kind === "thinking",
    ) as Array<{ status: string; text?: string; durationMs?: number }>;

    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps[0].status).toBe("running");
    expect(steps[0].text).toBe("The");
    expect(steps[1].text).toBe("The user");
    const completed = steps.filter((t) => t.status === "completed");
    expect(completed).toHaveLength(1);
    expect(typeof completed[0].durationMs).toBe("number");
  });

  it("posts reset on new session", async () => {
    const { controller, posted } = makeDeps();
    await controller.handle({ type: "ready" });
    await controller.handle({ type: "new" });
    expect(posted).toContainEqual({ type: "reset" });
  });

  it("suggest '/' returns built-in commands for autocomplete", async () => {
    const { controller, posted } = makeDeps();
    await controller.handle({ type: "suggest", trigger: "/", query: "new" });
    const sugg = posted.find((m) => typeOf(m) === "suggestions") as
      | { items: Array<{ kind: string; name: string }> }
      | undefined;
    expect(sugg?.items.some((i) => i.kind === "command" && i.name === "new")).toBe(true);
  });

  it("marketplacePlugins reads a .claude-plugin/marketplace.json marketplace", async () => {
    const mk = fs.mkdtempSync(path.join(os.tmpdir(), "cc-mp-"));
    try {
      fs.mkdirSync(path.join(mk, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(
        path.join(mk, ".claude-plugin", "marketplace.json"),
        JSON.stringify({ name: "sp", plugins: [{ name: "superpowers", description: "d", source: "https://x.git" }] }),
      );
      const mkt = new MarketplaceManager({ cacheDir: path.join(dir, "glob") });
      await mkt.add(mk);
      const deps = {
        apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
        configuration: { baseUrl: () => "https://x", model: () => "m" },
        getWorkspaceCwd: () => "/tmp",
        sessionStore: store,
        marketplace: mkt,
        createSession: () => {
          throw new Error("should not be called");
        },
      };
      const c2 = new ChatController(deps as never, () => {});
      const plugins = c2.marketplacePlugins("sp");
      expect(plugins.some((p) => p.name === "superpowers")).toBe(true);
    } finally {
      fs.rmSync(mk, { recursive: true, force: true });
    }
  });

  it("set_permission_mode applies and persists the mode", async () => {
    const updated: string[] = [];
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://x", model: () => "m", permissionMode: () => "default" as const },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      updatePermissionMode: async (mode: string) => {
        updated.push(mode);
      },
      createSession: () => {
        throw new Error("should not be called");
      },
    };
    const posted: unknown[] = [];
    const c = new ChatController(deps as never, (m) => posted.push(m));
    await c.handle({ type: "set_permission_mode", mode: "bypassPermissions" });
    expect(updated).toEqual(["bypassPermissions"]);
    const toast = posted.find((m) => typeOf(m) === "toast") as { message?: string } | undefined;
    expect(toast?.message).toContain("超级权限");
  });

  it("set_permission_mode acceptEdits posts a matching toast", async () => {
    const { controller, posted } = makeDeps();
    await controller.handle({ type: "set_permission_mode", mode: "acceptEdits" });
    const toast = posted.find((m) => typeOf(m) === "toast") as { message?: string } | undefined;
    expect(toast?.message).toContain("自动接受编辑");
  });

  it("set_permission_mode default posts the strict-mode toast", async () => {
    const { controller, posted } = makeDeps();
    await controller.handle({ type: "set_permission_mode", mode: "default" });
    const toast = posted.find((m) => typeOf(m) === "toast") as { message?: string } | undefined;
    expect(toast?.message).toContain("严格");
  });

  it("pickSuggestion for a file attaches it as a file chip", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sugg-"));
    try {
      fs.writeFileSync(path.join(dir, "notes.md"), "hello notes");
      const deps = {
        apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
        configuration: { baseUrl: () => "https://api.deepseek.com/anthropic", model: () => "m" },
        getWorkspaceCwd: () => dir,
        sessionStore: store,
        memory: new MemoryStore(path.join(dir, "mem")),
        createSession: () => {
          throw new Error("should not be called");
        },
      };
      const posted2: unknown[] = [];
      const c2 = new ChatController(deps as never, (m) => posted2.push(m));
      await c2.handle({
        type: "pickSuggestion",
        item: { kind: "file", relativePath: "notes.md" },
        triggerStart: 0,
        triggerEnd: 9,
        inputText: "@notes.md",
      });
      // 文件 → 单条 suggestionPicked 携带 chip 视图 + 插入 `` `label` ``,webview 直接渲染
      const picked = posted2.find((m) => typeOf(m) === "suggestionPicked") as
        | { inputText: string; insertText?: string; chips?: unknown[] }
        | undefined;
      expect(picked).toBeDefined();
      expect(picked?.inputText).toBe("");
      expect(picked?.insertText).toContain("notes.md");
      expect(picked?.chips?.length).toBe(1);
      expect((picked?.chips?.[0] as { kind?: string })?.kind).toBe("file");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pickSuggestion for a skill inserts skill chip prompt instead of sending", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-skill-"));
    try {
      const skillDir = path.join(root, ".dsb", "skills", "demo-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\ndescription: demo\n---\n# Demo Skill\nDo the thing.\n",
        "utf8",
      );
      let sendCalled = false;
      const deps = {
        apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
        configuration: { baseUrl: () => "https://api.deepseek.com/anthropic", model: () => "m" },
        getWorkspaceCwd: () => root,
        sessionStore: store,
        memory: new MemoryStore(path.join(root, "mem")),
        createSession: () => {
          sendCalled = true;
          throw new Error("should not send on skill pick");
        },
      };
      const posted: unknown[] = [];
      const controller = new ChatController(deps as never, (m) => posted.push(m));
      await controller.handle({
        type: "pickSuggestion",
        item: { kind: "skill", name: "demo-skill", description: "demo" },
        triggerStart: 0,
        triggerEnd: 11,
        inputText: "/demo-skill",
      });
      expect(sendCalled).toBe(false);
      const picked = posted.find((m) => typeOf(m) === "suggestionPicked") as
        | { inputText: string; insertText?: string; chips?: Array<{ kind: string; label: string }> }
        | undefined;
      expect(picked?.insertText).toContain("skill:");
      expect(picked?.chips?.[0]?.kind).toBe("skill");
      expect(posted.some((m) => typeOf(m) === "message" && (m as { role?: string }).role === "user")).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("pickSuggestion '/new' starts a new session (posts reset)", async () => {
    const { controller, posted } = makeDeps();
    await controller.handle({
      type: "pickSuggestion",
      item: { kind: "command", name: "new", detail: "" },
      triggerStart: 0,
      triggerEnd: 4,
      inputText: "/new",
    });
    expect(posted.map((m) => typeOf(m))).toContain("reset");
  });

  it("loads and replays a saved session", async () => {
    const id = store.create();
    store.append(id, { kind: "user", text: "你好", timestamp: 1 });
    store.append(id, { kind: "assistant", text: "你好!", timestamp: 2 });
    const { controller, posted } = makeDeps();
    await controller.handle({ type: "load_session", id });
    const types = posted.map((m) => (m as { type: string }).type);
    expect(types).toContain("reset");
    expect(types.filter((t) => t === "message").length).toBe(2);
  });

  it("init resumes last session without creating a new empty jsonl", async () => {
    const id = store.create();
    store.append(id, { kind: "user", text: "继续这个", timestamp: 1 });
    store.append(id, { kind: "assistant", text: "好的", final: true, timestamp: 2 });
    const ui = new MemorySessionUiState();
    ui.setLastSessionId(id);
    ui.setInterrupted({ sessionId: id, at: Date.now() });
    const before = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length;
    const { controller, posted } = makeDeps({ sessionUiState: ui });
    await controller.handle({ type: "ready" });
    const after = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length;
    expect(after).toBe(before);
    expect(posted.some((m) => typeOf(m) === "toast" && String((m as { message: string }).message).includes("未完成"))).toBe(true);
    expect(posted.some((m) => typeOf(m) === "message" && (m as { role: string }).role === "user")).toBe(true);
  });

  it("init without lastSessionId does not create a session file", async () => {
    const before = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length;
    const { controller } = makeDeps({ sessionUiState: new MemorySessionUiState() });
    await controller.handle({ type: "ready" });
    const after = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length;
    expect(after).toBe(before);
  });

  it("loadSession restores persisted todos", async () => {
    const id = store.create();
    store.append(id, { kind: "user", text: "task", timestamp: 1 });
    store.saveTodos(id, [{ id: "t1", content: "写测试", done: false }]);
    const { controller, posted } = makeDeps();
    await controller.handle({ type: "load_session", id });
    const todosStep = posted.find(
      (m) => typeOf(m) === "timeline_step" && (m as { kind: string }).kind === "todos",
    ) as { items: Array<{ content: string }> };
    expect(todosStep.items.some((i) => i.content === "写测试")).toBe(true);
  });

  it("wraps history replay with history_start/history_end markers", async () => {
    const id = store.create();
    store.append(id, { kind: "user", text: "q1", timestamp: 1 });
    store.append(id, { kind: "assistant", text: "a1", final: true, timestamp: 2 });
    store.append(id, { kind: "user", text: "q2", timestamp: 3 });
    store.append(id, { kind: "assistant", text: "a2", final: true, timestamp: 4 });
    const { controller, posted } = makeDeps();
    await controller.handle({ type: "load_session", id });
    const types = posted.map((m) => typeOf(m));
    const s = types.indexOf("history_start");
    const e = types.lastIndexOf("history_end");
    expect(s).toBeGreaterThan(-1);
    expect(e).toBeGreaterThan(s);
    // 两个标记之间只有重放事件(message / timeline_step),无 reset/status 等
    const between = types.slice(s + 1, e);
    expect(between.length).toBeGreaterThan(0);
    expect(between.every((t) => t === "message" || t === "timeline_step")).toBe(true);
    // 标记成对出现(reset 在新会话重放时也以同样模式包裹)
    expect(types.filter((t) => t === "history_start").length).toBe(1);
    expect(types.filter((t) => t === "history_end").length).toBe(1);
  });

  it("replays interleaved assistant text segments on one timeline", async () => {
    const id = store.create();
    store.append(id, { kind: "user", text: "do", timestamp: 1 });
    store.append(id, { kind: "thinking", text: "plan", durationMs: 10, timestamp: 2 });
    store.append(id, {
      kind: "tool",
      name: "Read",
      status: "completed",
      detail: "x",
      input: { path: "a.ts" },
      timestamp: 3,
    });
    store.append(id, { kind: "assistant", text: "mid", final: false, timestamp: 4 });
    store.append(id, {
      kind: "tool",
      name: "Bash",
      status: "completed",
      detail: "ok",
      input: { command: "echo" },
      timestamp: 5,
    });
    store.append(id, { kind: "assistant", text: "end", final: true, timestamp: 6 });
    const { controller, posted } = makeDeps();
    await controller.handle({ type: "load_session", id });

    const assistantMsgs = posted.filter(
      (m) => typeOf(m) === "message" && (m as { role: string }).role === "assistant",
    );
    expect(assistantMsgs.length).toBe(1);

    const textSteps = posted.filter(
      (m) => typeOf(m) === "timeline_step" && (m as { kind: string }).kind === "text",
    ) as Array<{ text?: string; final?: boolean; stepId: string }>;
    expect(textSteps.map((s) => s.text)).toEqual(["mid", "end"]);
    expect(textSteps[0].final).toBeFalsy();
    expect(textSteps[1].final).toBe(true);

    const kinds = posted
      .filter((m) => typeOf(m) === "timeline_step")
      .map((m) => (m as { kind: string }).kind);
    expect(kinds).toEqual(["thinking", "tool", "text", "tool", "text"]);
  });

  it("records daily activity on send", async () => {
    const recordActivity = vi.fn();
    const { controller } = makeDeps({ activityStats: { recordActivity } });
    await controller.handle({ type: "send", text: "hi" });
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0][0]).toBeInstanceOf(Date);
  });

  it("requestDailySummary does not record daily activity", async () => {
    const recordActivity = vi.fn();
    const { controller } = makeDeps({ activityStats: { recordActivity } });
    await controller.requestDailySummary();
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("reports missing API key", async () => {
    const deps2 = {
      apiKeyStore: { getApiKey: async () => undefined, setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://x", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      createSession: () => {
        throw new Error("should not be called");
      },
    };
    const posted2: unknown[] = [];
    const c2 = new ChatController(deps2 as never, (m) => posted2.push(m));
    await c2.handle({ type: "send", text: "hi" });
    const status = posted2.find((m) => (m as { type: string }).type === "status") as { info?: string };
    expect(status?.info).toContain("API Key");
  });

  it("no-ops a second send while a run is in flight (busy guard)", async () => {
    let sendCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { controller, posted, sent } = makeControllableDeps(async () => { sendCalls++; await gate; });
    const first = controller.handle({ type: "send", text: "first" });
    const second = controller.handle({ type: "send", text: "second" });
    await second;
    release();
    await first;
    expect(sendCalls).toBe(1);
    expect(sent).toEqual(["first"]);
    const userMsgs = posted.filter((m) => typeOf(m) === "message" && (m as { role?: string }).role === "user");
    expect(userMsgs).toHaveLength(1);
  });

  it("expands cited chips into the prompt sent to the session", async () => {
    const { controller, posted, sent } = makeControllableDeps(async () => {});
    await controller.handle({
      type: "attach_images",
      images: [{ mimeType: "image/png", data: pngB64(), fileName: "pic.png" }],
    });
    await controller.handle({
      type: "attach_documents",
      documents: [{ fileName: "notes.txt", mimeType: "text/plain", data: Buffer.from("hello notes").toString("base64") }],
    });
    await controller.handle({ type: "send", text: "summarize `📄 notes.txt` and `image: pic.png`" });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("[Context: document notes.txt]");
    expect(sent[0]).toContain("hello notes");
    expect(sent[0]).toContain("[Image ref: image: pic.png]");
    // 用户消息气泡回显原始文本,不含展开的 prompt block
    const userMsg = posted.find((m) => typeOf(m) === "message" && (m as { role?: string }).role === "user") as { text: string };
    expect(userMsg.text).toBe("summarize `📄 notes.txt` and `image: pic.png`");
  });

  it("posts attach errors as toast without touching busy", async () => {
    const { controller, posted } = makeControllableDeps(async () => {});
    await controller.handle({ type: "attach_images", images: [{ mimeType: "image/bmp", data: "AAA=" }] });
    const toast = posted.find((m) => typeOf(m) === "toast") as { message?: string };
    expect(toast).toBeTruthy();
    expect(toast.message).toContain("不支持的图片格式");
    // 不能发 status busy:false,否则 in-flight run 期间会重新启用 Send
    expect(posted.some((m) => typeOf(m) === "status")).toBe(false);
  });

  it("Critical-2 repro: attach error during a run posts toast, busy untouched, second send still no-ops", async () => {
    let sendCalls = 0;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const startedP = new Promise<void>((r) => { started = r; });
    const { controller, posted } = makeControllableDeps(async () => {
      sendCalls++;
      started();
      await gate;
    });
    const first = controller.handle({ type: "send", text: "first" });
    await startedP; // run 已 in-flight,host busy=true
    // 运行中附加错误 → 只发 toast,不重置 busy
    await controller.handle({ type: "attach_images", images: [{ mimeType: "image/bmp", data: "AAA=" }] });
    const toast = posted.find((m) => typeOf(m) === "toast") as { message?: string };
    expect(toast).toBeTruthy();
    expect(posted.filter((m) => typeOf(m) === "status")).toHaveLength(0);
    // 第二次 send 仍被 host busy 互斥拦下
    await controller.handle({ type: "send", text: "second" });
    release();
    await first;
    expect(sendCalls).toBe(1);
  });

  it("remove_chip frees a slot so a later valid attach is accepted", async () => {
    const { controller, posted } = makeControllableDeps(async () => {});
    const images = Array.from({ length: 5 }, (_, i) => ({ mimeType: "image/png" as const, data: pngB64(), fileName: `p${i}.png` }));
    await controller.handle({ type: "attach_images", images });
    const firstAttach = posted.find((m) => typeOf(m) === "chipsAttached") as { chips: Array<{ id: string }> };
    expect(firstAttach.chips).toHaveLength(5);
    await controller.handle({ type: "remove_chip", id: firstAttach.chips[0].id });
    await controller.handle({ type: "attach_images", images: [{ mimeType: "image/png", data: pngB64(), fileName: "extra.png" }] });
    const attaches = posted.filter((m) => typeOf(m) === "chipsAttached");
    expect(attaches).toHaveLength(2);
  });

  it("new session rejects pending permission asks (no hang)", async () => {
    let permissionsRef: PermissionManager | undefined;
    let checkDecision: string | undefined;
    const sessionImpl = {
      send: async () => {
        const d = await permissionsRef!.check("WebFetch", { url: "https://x" });
        checkDecision = d.decision;
      },
      cancel: () => {},
    };
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://x", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      createSession: (opts: { permissions: PermissionManager }) => {
        permissionsRef = opts.permissions;
        return sessionImpl;
      },
    };
    const posted: unknown[] = [];
    const controller = new ChatController(deps as never, (m) => posted.push(m));
    const sendP = controller.handle({ type: "send", text: "run" });
    await vi.waitFor(() => {
      expect(posted.some((m) => typeOf(m) === "ask_permission")).toBe(true);
    });
    await controller.handle({ type: "new" });
    await sendP;
    expect(checkDecision).toBe("deny");
  });

  it("pending ask resolves after load_session clears it", async () => {
    let permissionsRef: PermissionManager | undefined;
    let checkDecision: string | undefined;
    const sessionImpl = {
      send: async () => {
        const d = await permissionsRef!.check("WebFetch", { url: "https://x" });
        checkDecision = d.decision;
      },
      cancel: () => {},
    };
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://x", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      createSession: (opts: { permissions: PermissionManager }) => {
        permissionsRef = opts.permissions;
        return sessionImpl;
      },
    };
    const posted: unknown[] = [];
    const controller = new ChatController(deps as never, (m) => posted.push(m));
    const id = store.create();
    const sendP = controller.handle({ type: "send", text: "run" });
    await vi.waitFor(() => {
      expect(posted.some((m) => typeOf(m) === "ask_permission")).toBe(true);
    });
    await controller.handle({ type: "load_session", id });
    await sendP;
    expect(checkDecision).toBe("deny");
  });

  it("send survives a malformed plugin cache dir (bad entries skipped, not thrown)", async () => {
    // 插件缓存含非目录条目:plugins/ 下放一个文件(充当 market)、market 下放一个文件(充当 plugin)
    const cacheDir = path.join(dir, "pluginCache");
    fs.mkdirSync(path.join(cacheDir, "plugins", "marketA"), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "plugins", "not-a-dir"), "file where a market should be", "utf8");
    fs.writeFileSync(path.join(cacheDir, "plugins", "marketA", "bad-plugin"), "file where a plugin should be", "utf8");

    const sent: string[] = [];
    const sessionImpl = {
      send: async (text: string, onEvent: (ev: AgentLoopEvent) => void) => {
        sent.push(text);
        onEvent({ type: "status", busy: true, info: "等待" });
        onEvent({ type: "done" });
      },
      cancel: () => {},
    };
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://x", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      createSession: () => sessionImpl,
      pluginCacheDir: cacheDir,
    };
    const posted: unknown[] = [];
    const controller = new ChatController(deps as never, (m) => posted.push(m));
    await controller.handle({ type: "send", text: "hello" });
    expect(sent).toEqual(["hello"]); // 消息成功送出,buildHookRunner 未因坏条目抛错
    expect(posted.some((m) => typeOf(m) === "status")).toBe(true);
  });

  it("real createSession path survives a corrupted plugin cache (ENOTDIR in scanPluginSkills)", async () => {
    // 复现 65f0879 修复遗漏的同类 bug:plugin 层技能扫描(loadProjectContext + skillList→getSkillIndex
    // 两处)面对 plugins/ 根是文件或 market 目录是文件时应 fail-open,不得让会话创建挂起。
    // 变体 A:plugins 根是文件(第一层 readdirSync 即 ENOTDIR)
    const cacheDirA = path.join(dir, "pluginCache3");
    fs.mkdirSync(cacheDirA, { recursive: true });
    fs.writeFileSync(path.join(cacheDirA, "plugins"), "file where plugins root should be", "utf8");
    // 变体 B:plugins 根是目录,market 条目是文件(第二层 readdirSync 即 ENOTDIR)
    const cacheDirB = path.join(dir, "pluginCache4");
    fs.mkdirSync(path.join(cacheDirB, "plugins"), { recursive: true });
    fs.writeFileSync(path.join(cacheDirB, "plugins", "marketB"), "file where a market dir should be", "utf8");

    const sent: string[] = [];
    const sessionImpl = {
      send: async (text: string, onEvent: (ev: AgentLoopEvent) => void) => {
        sent.push(text);
        onEvent({ type: "status", busy: true, info: "等待" });
        onEvent({ type: "done" });
      },
      cancel: () => {},
    };
    let controllerRef: ChatController | undefined;
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://x", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      // 模拟 chatViewProvider 的真实 createSession:先 loadProjectContext(插件层技能扫描),
      // 再取 controller.skillList()(同一份索引、同一条 scanPluginSkills 路径)。
      createSession: async (opts: { workspaceRoot: string }) => {
        expect((await loadProjectContext(opts.workspaceRoot, { pluginCacheDir: cacheDirA })).skills).toEqual([]);
        expect((await loadProjectContext(opts.workspaceRoot, { pluginCacheDir: cacheDirB })).skills).toEqual([]);
        expect(controllerRef?.skillList() ?? []).toEqual([]);
        return sessionImpl;
      },
      pluginCacheDir: cacheDirA,
    };
    const posted: unknown[] = [];
    const controller = new ChatController(deps as never, (m) => posted.push(m));
    controllerRef = controller;
    await controller.handle({ type: "send", text: "hello" });
    expect(sent).toEqual(["hello"]); // 消息成功送出,会话创建未被坏插件缓存阻断
    expect(posted.some((m) => typeOf(m) === "status")).toBe(true);
  });

  it("send survives a plugin cache whose plugins root is a file", async () => {
    // plugins 根是文件而非目录 → pluginContents 返回 [] 而非 throw
    const cacheDir = path.join(dir, "pluginCache2");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "plugins"), "not a directory", "utf8");

    const sessionImpl = {
      send: async (_text: string, onEvent: (ev: AgentLoopEvent) => void) => {
        onEvent({ type: "status", busy: true, info: "等待" });
        onEvent({ type: "done" });
      },
      cancel: () => {},
    };
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://x", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      createSession: () => sessionImpl,
      pluginCacheDir: cacheDir,
    };
    const posted: unknown[] = [];
    const controller = new ChatController(deps as never, (m) => posted.push(m));
    await controller.handle({ type: "send", text: "hello" });
    expect(posted.some((m) => typeOf(m) === "status")).toBe(true);
  });

  it("in-flight run records to its own session file even after a switch (closure binding)", async () => {
    const idA = store.create();
    const idB = store.create();
    let onRecordRef: ((ev: { kind: string; text?: string; timestamp: number }) => void) | undefined;
    let fireEvent!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => { fireEvent = r; });
    const startedP = new Promise<void>((r) => { started = r; });
    const sessionImpl = {
      send: async () => {
        started(); // 会话已创建、send 已进入 in-flight
        await gate; // 挂起:等会话切换发生后再产生事件
        onRecordRef?.({ kind: "user", text: "late", timestamp: Date.now() });
      },
      cancel: () => {},
    };
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://x", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      createSession: (opts: { onRecord?: (ev: { kind: string; text?: string; timestamp: number }) => void }) => {
        onRecordRef = opts.onRecord;
        return sessionImpl;
      },
    };
    const posted: unknown[] = [];
    const controller = new ChatController(deps as never, (m) => posted.push(m));
    await controller.handle({ type: "load_session", id: idA });
    const sendP = controller.handle({ type: "send", text: "run" });
    await startedP; // 等会话创建完成、send 挂起后,再切到 idB
    await controller.handle({ type: "load_session", id: idB });
    fireEvent();
    await sendP;
    // onRecord 闭包绑定的是创建时捕获的 idA,切走后的事件仍写 idA
    expect(store.load(idA).some((e) => e.kind === "user")).toBe(true);
    expect(store.load(idB).some((e) => e.kind === "user")).toBe(false);
  });

  it("maps Workflow stage 'done' to protocol status 'completed' when posting progress", async () => {
    let onProgress: ((s: string, st: "running" | "done" | "error") => void) | undefined;
    const sessionImpl = {
      send: async (_t: string, onEvent: (ev: AgentLoopEvent) => void) => {
        onProgress?.("stage-1", "running");
        onProgress?.("stage-1", "done");
        onEvent({ type: "status", busy: true, info: "等待" });
        onEvent({ type: "text_delta", text: "ran" });
        onEvent({ type: "done" });
      },
      cancel: () => {},
    };
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://x", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      createSession: (opts: { onWorkflowProgress?: (s: string, st: "running" | "done" | "error") => void }) => {
        onProgress = opts.onWorkflowProgress;
        return sessionImpl;
      },
    };
    const posted: unknown[] = [];
    const controller = new ChatController(deps as never, (m) => posted.push(m));
    await controller.handle({ type: "send", text: "run workflow" });
    const workflowTools = posted.filter(
      (m) =>
        typeOf(m) === "timeline_step" &&
        (m as { kind?: string }).kind === "tool" &&
        (m as { name?: string }).name === "Workflow",
    ) as Array<{ status?: string }>;
    // 协议 union 只允许 running|completed|error:done 必须映射为 completed,不能透传
    expect(workflowTools.map((t) => t.status)).toEqual(["running", "completed"]);
  });

  it("runInWorktree rethrows the task error even when cleanup also fails", async () => {
    const worktree = {
      create: async () => ({ path: "/wt", branch: "b" }),
      remove: async () => {
        throw new Error("remove failed");
      },
    };
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://x", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      createSession: () => {
        throw new Error("should not be called");
      },
      worktree,
    };
    const posted: unknown[] = [];
    const controller = new ChatController(deps as never, (m) => posted.push(m));
    await expect(controller.runInWorktree(async () => {
      throw new Error("task failed");
    })).rejects.toThrow("task failed");
    // 清理失败被记录(toast),但不掩盖任务原始错误
    expect(posted.some((m) => typeOf(m) === "toast" && (m as { message?: string }).message?.includes("清理失败"))).toBe(true);
  });

  it("runInWorktree surfaces a remove failure when the task itself succeeds", async () => {
    const worktree = {
      create: async () => ({ path: "/wt", branch: "b" }),
      remove: async () => {
        throw new Error("remove failed");
      },
    };
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://x", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      createSession: () => {
        throw new Error("should not be called");
      },
      worktree,
    };
    const posted: unknown[] = [];
    const controller = new ChatController(deps as never, (m) => posted.push(m));
    await expect(controller.runInWorktree(async () => {})).rejects.toThrow("remove failed");
  });

  it("runInWorktree cleans up and resolves when task and removal both succeed", async () => {
    const removed: string[] = [];
    const worktree = {
      create: async () => ({ path: "/wt", branch: "b" }),
      remove: async (p: string) => {
        removed.push(p);
      },
    };
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://x", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      createSession: () => {
        throw new Error("should not be called");
      },
      worktree,
    };
    const posted: unknown[] = [];
    const controller = new ChatController(deps as never, (m) => posted.push(m));
    await controller.runInWorktree(async () => {});
    expect(removed).toEqual(["/wt"]);
  });

  it("a throwing notifier does not reject the pending-approval flow", async () => {
    let permissionsRef: PermissionManager | undefined;
    let checkDecision: string | undefined;
    const sessionImpl = {
      send: async () => {
        const d = await permissionsRef!.check("WebFetch", { url: "https://x" });
        checkDecision = d.decision;
      },
      cancel: () => {},
    };
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://x", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      createSession: (opts: { permissions: PermissionManager }) => {
        permissionsRef = opts.permissions;
        return sessionImpl;
      },
      notifier: {
        info: () => {},
        warn: () => {
          throw new Error("notification boom");
        },
      },
      isVisible: () => false,
      notificationsEnabled: () => true,
    };
    const posted: unknown[] = [];
    const controller = new ChatController(deps as never, (m) => posted.push(m));
    const sendP = controller.handle({ type: "send", text: "run" });
    await vi.waitFor(() => {
      expect(posted.some((m) => typeOf(m) === "ask_permission")).toBe(true);
    });
    const ask = posted.find((m) => typeOf(m) === "ask_permission") as { askId: string };
    await controller.handle({ type: "permission_response", askId: ask.askId, approved: true });
    await sendP;
    // 面板隐藏 + 通知开启时 warn 抛错必须被吞掉,授权流程仍正常回调到 allow
    expect(checkDecision).toBe("allow");
  });

  it("load_session uses persisted api history as initialHistory on next send", async () => {
    const id = store.create();
    store.append(id, { kind: "user", text: "你好", timestamp: 1 });
    store.append(id, { kind: "assistant", text: "你好!", timestamp: 2 });
    const apiHistory: ProviderMessage[] = [
      { role: "user", content: "你好" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ];
    store.saveApiHistory(id, apiHistory);
    let initialHistory: unknown;
    const sessionImpl = {
      send: async (_t: string, onEvent: (ev: AgentLoopEvent) => void) => {
        onEvent({ type: "status", busy: true, info: "等待" });
        onEvent({ type: "done" });
      },
      cancel: () => {},
    };
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://x", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      createSession: (opts: { initialHistory?: unknown }) => {
        initialHistory = opts.initialHistory;
        return sessionImpl;
      },
    };
    const posted: unknown[] = [];
    const controller = new ChatController(deps as never, (m) => posted.push(m));
    await controller.handle({ type: "load_session", id });
    await controller.handle({ type: "send", text: "继续" });
    expect(initialHistory).toEqual(apiHistory);
  });

  it("load_session falls back to text-only history when no api history exists", async () => {
    const id = store.create();
    store.append(id, { kind: "user", text: "你好", timestamp: 1 });
    store.append(id, { kind: "assistant", text: "你好!", timestamp: 2 });
    let initialHistory: unknown;
    const sessionImpl = {
      send: async (_t: string, onEvent: (ev: AgentLoopEvent) => void) => {
        onEvent({ type: "status", busy: true, info: "等待" });
        onEvent({ type: "done" });
      },
      cancel: () => {},
    };
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://x", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      createSession: (opts: { initialHistory?: unknown }) => {
        initialHistory = opts.initialHistory;
        return sessionImpl;
      },
    };
    const posted: unknown[] = [];
    const controller = new ChatController(deps as never, (m) => posted.push(m));
    await controller.handle({ type: "load_session", id });
    await controller.handle({ type: "send", text: "继续" });
    expect(initialHistory).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: [{ type: "text", text: "你好!" }] },
    ]);
  });

  it("binds onPersist to save api history for the session", async () => {
    const id = store.create();
    let onPersistRef: ((msgs: unknown[]) => void) | undefined;
    const sessionImpl = {
      send: async () => {
        onPersistRef?.([{ role: "user", content: "hi" }]);
      },
      cancel: () => {},
    };
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://x", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      createSession: (opts: { onPersist?: (msgs: unknown[]) => void }) => {
        onPersistRef = opts.onPersist;
        return sessionImpl;
      },
    };
    const posted: unknown[] = [];
    const controller = new ChatController(deps as never, (m) => posted.push(m));
    await controller.handle({ type: "load_session", id });
    await controller.handle({ type: "send", text: "hi" });
    expect(store.loadApiHistory(id)).toEqual([{ role: "user", content: "hi" }]);
  });

  it("injects project permission rules from .dsb/settings.json into the session", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cc-perm-"));
    try {
      fs.mkdirSync(path.join(ws, ".dsb"), { recursive: true });
      fs.writeFileSync(path.join(ws, ".dsb", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm -rf *)"] } }), "utf8");
      let permissionsRef: PermissionManager | undefined;
      const sessionImpl = {
        send: async () => {},
        cancel: () => {},
      };
      const deps = {
        apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
        configuration: { baseUrl: () => "https://x", model: () => "m" },
        getWorkspaceCwd: () => ws,
        sessionStore: store,
        createSession: (opts: { permissions: PermissionManager }) => {
          permissionsRef = opts.permissions;
          return sessionImpl;
        },
      };
      const posted: unknown[] = [];
      const controller = new ChatController(deps as never, (m) => posted.push(m));
      await controller.handle({ type: "send", text: "run" });
      const d = await permissionsRef!.check("Bash", { command: "rm -rf /" });
      expect(d.decision).toBe("deny");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it("reloads project rules after New Session picks up a settings change", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cc-perm2-"));
    try {
      fs.mkdirSync(path.join(ws, ".dsb"), { recursive: true });
      let permissionsRef: PermissionManager | undefined;
      const sessionImpl = {
        send: async () => {},
        cancel: () => {},
      };
      const deps = {
        apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
        configuration: { baseUrl: () => "https://x", model: () => "m" },
        getWorkspaceCwd: () => ws,
        sessionStore: store,
        createSession: (opts: { permissions: PermissionManager }) => {
          permissionsRef = opts.permissions;
          return sessionImpl;
        },
      };
      const posted: unknown[] = [];
      const controller = new ChatController(deps as never, (m) => posted.push(m));
      await controller.handle({ type: "send", text: "first" });
      expect(permissionsRef).toBeDefined();
      // 写入 deny 规则后 New Session 再发
      fs.writeFileSync(path.join(ws, ".dsb", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm -rf *)"] } }), "utf8");
      await controller.handle({ type: "new" });
      await controller.handle({ type: "send", text: "second" });
      const after = await permissionsRef!.check("Bash", { command: "rm -rf /" });
      expect(after.decision).toBe("deny");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it("send passes currentMode as opts.mode to the session", async () => {
    const sentOpts: Array<{ mode?: string }> = [];
    const sessionImpl = {
      send: async (_text: string, onEvent: (ev: AgentLoopEvent) => void, opts?: { mode?: string }) => {
        sentOpts.push(opts ?? {});
        onEvent({ type: "status", busy: true, info: "等待" });
        onEvent({ type: "done" });
      },
      cancel: () => {},
    };
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://x", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      createSession: () => sessionImpl,
    };
    const posted: unknown[] = [];
    const controller = new ChatController(deps as never, (m) => posted.push(m));
    await controller.handle({ type: "set_mode", mode: "plan" });
    await controller.handle({ type: "send", text: "plan this" });
    expect(sentOpts[0]?.mode).toBe("plan");
  });

  it("set_mode posts a mode toast", async () => {
    const { controller, posted } = makeDeps();
    await controller.handle({ type: "set_mode", mode: "ask" });
    const toast = posted.find((m) => typeOf(m) === "toast") as { message?: string } | undefined;
    expect(toast?.message).toContain("Ask");
  });

  it("/ suggestions include a .dsb/commands command", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cmd-"));
    try {
      fs.mkdirSync(path.join(ws, ".dsb", "commands"), { recursive: true });
      fs.writeFileSync(path.join(ws, ".dsb", "commands", "test.md"), "---\ndescription: 跑测试\n---\n运行 npm test。", "utf8");
      const deps = {
        apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
        configuration: { baseUrl: () => "https://x", model: () => "m" },
        getWorkspaceCwd: () => ws,
        sessionStore: store,
        createSession: () => {
          throw new Error("should not be called");
        },
      };
      const posted: unknown[] = [];
      const controller = new ChatController(deps as never, (m) => posted.push(m));
      await controller.handle({ type: "suggest", trigger: "/", query: "test" });
      const sugg = posted.find((m) => typeOf(m) === "suggestions") as { items: Array<{ kind: string; name: string }> } | undefined;
      expect(sugg?.items.some((i) => i.kind === "command" && i.name === "test")).toBe(true);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it("picking a project command sends its body as a prompt", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cmd2-"));
    try {
      fs.mkdirSync(path.join(ws, ".dsb", "commands"), { recursive: true });
      fs.writeFileSync(path.join(ws, ".dsb", "commands", "test.md"), "---\ndescription: 跑测试\n---\n运行 npm test。", "utf8");
      const sent: string[] = [];
      const sessionImpl = {
        send: async (text: string, onEvent: (ev: AgentLoopEvent) => void) => {
          sent.push(text);
          onEvent({ type: "status", busy: true, info: "等待" });
          onEvent({ type: "done" });
        },
        cancel: () => {},
      };
      const deps = {
        apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
        configuration: { baseUrl: () => "https://x", model: () => "m" },
        getWorkspaceCwd: () => ws,
        sessionStore: store,
        createSession: () => sessionImpl,
      };
      const posted: unknown[] = [];
      const controller = new ChatController(deps as never, (m) => posted.push(m));
      await controller.handle({
        type: "pickSuggestion",
        item: { kind: "command", name: "test", detail: "" },
        triggerStart: 0,
        triggerEnd: 5,
        inputText: "/test",
      });
      expect(sent.some((s) => s.includes("npm test"))).toBe(true);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it("/ suggestions include a plugin command from the plugin cache", async () => {
    // 插件缓存结构:plugins/<market>/<plugin>/commands/foo.md;getSlashIndex 经 pluginDirs() → <plugin>/commands
    const cacheDir = path.join(dir, "pluginCmdCache");
    fs.mkdirSync(path.join(cacheDir, "plugins", "marketA", "pluginA", "commands"), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "plugins", "marketA", "pluginA", "commands", "foo.md"), "---\ndescription: 插件命令\n---\n插件 body", "utf8");
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://api.deepseek.com/anthropic", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      pluginCacheDir: cacheDir,
      createSession: () => {
        throw new Error("should not be called");
      },
    };
    const posted: unknown[] = [];
    const controller = new ChatController(deps as never, (m) => posted.push(m));
    await controller.handle({ type: "suggest", trigger: "/", query: "foo" });
    const sugg = posted.find((m) => typeOf(m) === "suggestions") as { items: Array<{ kind: string; name: string }> } | undefined;
    expect(sugg?.items.some((i) => i.kind === "command" && i.name === "foo")).toBe(true);
  });

  it("picking a plugin command sends its body as a prompt", async () => {
    const cacheDir = path.join(dir, "pluginCmdCache2");
    fs.mkdirSync(path.join(cacheDir, "plugins", "marketA", "pluginA", "commands"), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "plugins", "marketA", "pluginA", "commands", "foo.md"), "---\ndescription: 插件命令\n---\n插件 body", "utf8");
    const sent: string[] = [];
    const sessionImpl = {
      send: async (text: string, onEvent: (ev: AgentLoopEvent) => void) => {
        sent.push(text);
        onEvent({ type: "status", busy: true, info: "等待" });
        onEvent({ type: "done" });
      },
      cancel: () => {},
    };
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://api.deepseek.com/anthropic", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      pluginCacheDir: cacheDir,
      createSession: () => sessionImpl,
    };
    const posted: unknown[] = [];
    const controller = new ChatController(deps as never, (m) => posted.push(m));
    await controller.handle({
      type: "pickSuggestion",
      item: { kind: "command", name: "foo", detail: "" },
      triggerStart: 0,
      triggerEnd: 4,
      inputText: "/foo",
    });
    expect(sent.some((s) => s.includes("插件 body"))).toBe(true);
  });

  describe("session tools commands (compact/export/memory)", () => {
    function makeSessionToolsDeps(extra?: Record<string, unknown>) {
      const sessionImpl = {
        send: async () => {},
        cancel: () => {},
        ...(extra?.sessionImpl ?? {}),
      };
      const deps = {
        apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
        configuration: { baseUrl: () => "https://api.deepseek.com/anthropic", model: () => "m" },
        getWorkspaceCwd: () => dir,
        sessionStore: store,
        createSession: () => sessionImpl,
        memory: new MemoryStore(path.join(dir, "mem")),
        ...(extra?.deps ?? {}),
      };
      const posted: unknown[] = [];
      const controller = new ChatController(deps as never, (m) => posted.push(m));
      return { controller, posted, sessionImpl };
    }

    it("/compact compacts the active session and posts success toast", async () => {
      const compactNow = vi.fn(async () => {});
      const { controller, posted } = makeSessionToolsDeps({
        sessionImpl: { compactNow },
      });
      // 先发一条消息触发 ensureSession,让 sessionService 持有活跃会话
      await controller.handle({ type: "send", text: "hi" });
      await controller.handle({
        type: "pickSuggestion",
        item: { kind: "command", name: "compact", detail: "" },
        triggerStart: 0,
        triggerEnd: 8,
        inputText: "/compact",
      });
      expect(compactNow).toHaveBeenCalledTimes(1);
      expect(posted.some((m) => typeOf(m) === "toast" && String((m as { message?: string }).message).includes("已压缩上下文"))).toBe(true);
    });

    it("/compact without an active session posts an error toast", async () => {
      const { controller, posted } = makeSessionToolsDeps();
      await controller.handle({
        type: "pickSuggestion",
        item: { kind: "command", name: "compact", detail: "" },
        triggerStart: 0,
        triggerEnd: 8,
        inputText: "/compact",
      });
      const toasts = posted.filter((m) => typeOf(m) === "toast").map((m) => (m as { message?: string }).message);
      expect(toasts.some((t) => t?.includes("没有可压缩的会话"))).toBe(true);
    });

    it("/compact propagates compaction failure as an error toast", async () => {
      const compactNow = vi.fn(async () => {
        throw new Error("boom");
      });
      const { controller, posted } = makeSessionToolsDeps({ sessionImpl: { compactNow } });
      await controller.handle({ type: "send", text: "hi" });
      await controller.handle({
        type: "pickSuggestion",
        item: { kind: "command", name: "compact", detail: "" },
        triggerStart: 0,
        triggerEnd: 8,
        inputText: "/compact",
      });
      expect(posted.some((m) => typeOf(m) === "toast" && String((m as { message?: string }).message).includes("压缩失败: boom"))).toBe(true);
    });

    it("/export md writes the session history to .dsb/exports and reports the path", async () => {
      const id = store.create();
      store.saveApiHistory(id, [
        { role: "user", content: "你好" },
        { role: "assistant", content: [{ type: "text", text: "你好!" }] },
      ]);
      const { controller, posted } = makeSessionToolsDeps();
      await controller.handle({ type: "load_session", id });
      await controller.handle({
        type: "pickSuggestion",
        item: { kind: "command", name: "export", detail: "" },
        triggerStart: 0,
        triggerEnd: 7,
        inputText: "/export md",
      });
      const target = path.join(dir, ".dsb", "exports", `${id}.md`);
      expect(fs.existsSync(target)).toBe(true);
      const content = fs.readFileSync(target, "utf8");
      expect(content).toContain("你好");
      expect(content).toContain("你好!");
      expect(posted.some((m) => typeOf(m) === "toast" && String((m as { message?: string }).message).includes("已导出"))).toBe(true);
    });

    it("/export with no argument posts usage toast", async () => {
      const { controller, posted } = makeSessionToolsDeps();
      await controller.handle({
        type: "pickSuggestion",
        item: { kind: "command", name: "export", detail: "" },
        triggerStart: 0,
        triggerEnd: 7,
        inputText: "/export",
      });
      expect(posted.some((m) => typeOf(m) === "toast" && String((m as { message?: string }).message).includes("用法:/export"))).toBe(true);
    });

    it("/memory dream without API key posts a failure toast and keeps memory untouched", async () => {
      const { controller, posted } = makeSessionToolsDeps({
        deps: { apiKeyStore: { getApiKey: async () => undefined, setApiKey: async () => {} } },
      });
      await controller.handle({
        type: "pickSuggestion",
        item: { kind: "command", name: "memory", detail: "" },
        triggerStart: 0,
        triggerEnd: 7,
        inputText: "/memory dream",
      });
      expect(posted.some((m) => typeOf(m) === "toast" && String((m as { message?: string }).message).includes("记忆整合失败: 未设置 API Key"))).toBe(true);
    });

    it("/memory with a non-dream argument posts usage toast", async () => {
      const { controller, posted } = makeSessionToolsDeps();
      await controller.handle({
        type: "pickSuggestion",
        item: { kind: "command", name: "memory", detail: "" },
        triggerStart: 0,
        triggerEnd: 7,
        inputText: "/memory list",
      });
      expect(posted.some((m) => typeOf(m) === "toast" && String((m as { message?: string }).message).includes("用法:/memory dream"))).toBe(true);
    });
  });
});

describe("ChatController provider/capability wiring", () => {
  function providerDeps(extra?: {
    supportsVision?: boolean;
    vision?: boolean;
    modes?: string[];
    protocols?: string[];
    fetchOk?: boolean;
    fresh?: boolean;
  }) {
    const providers = [
      {
        id: "p1",
        name: "默认兼容端点",
        baseUrl: "https://api.deepseek.com/anthropic",
        defaultCapabilities: { supportsVision: extra?.supportsVision ?? extra?.vision ?? true, supportsThinking: true },
        modes: (extra?.modes ?? ["agent", "plan", "ask"]) as Array<"agent" | "plan" | "ask">,
        protocol: (extra?.protocols?.[0] ?? "anthropic") as "anthropic" | "openai",
        source: "manual",
        createdAt: 1,
      },
    ];
    const setActive = vi.fn();
    const providerStore = {
      list: () => providers,
      get: (id: string) => providers.find((p) => p.id === id),
      getActive: () => providers[0],
      setActive,
      upsert: () => {},
      remove: () => {},
      getApiKey: async () => "sk-provider",
      setApiKey: async () => {},
    };
    const modelCatalog = {
      resolveModels: () => [{ id: "m1", capabilities: { supportsVision: true, supportsThinking: true }, source: "builtin" }],
      clearCache: () => {},
      fetchModels: async () => {
        if (extra?.fetchOk === false) throw new Error("network down");
        return [{ id: "m1", capabilities: { supportsVision: true, supportsThinking: true }, source: "remote" }];
      },
      hasFreshCache: () => extra?.fresh ?? false,
    };
    const capabilityRegistry = {
      resolve: () => ({ supportsVision: extra?.supportsVision ?? extra?.vision ?? true, supportsThinking: true }),
      buildOverride: () => ({}),
    };
    const sessionImpl = {
      send: async (_text: string, onEvent: (ev: AgentLoopEvent) => void) => {
        onEvent({ type: "status", busy: true, info: "x" });
        onEvent({ type: "done" });
      },
      cancel: () => {},
    };
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://api.deepseek.com/anthropic", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      createSession: (_opts: unknown) => sessionImpl,
      memory: new MemoryStore(path.join(dir, "mem")),
      providerStore,
      modelCatalog,
      capabilityRegistry,
    };
    const posted: unknown[] = [];
    const controller = new ChatController(deps as never, (m) => posted.push(m));
    return { controller, posted, providerStore, setActive };
  }

  it("init includes providers/models/modes/capabilities", async () => {
    const { controller, posted } = providerDeps();
    await controller.handle({ type: "ready" } as never);
    const init = posted.find((m) => typeOf(m) === "init") as {
      providers?: Array<{ id: string; name: string }>;
      models?: unknown[];
      modes?: string[];
      currentCapabilities?: { supportsVision: boolean; supportsThinking: boolean };
    } | undefined;
    expect(init?.providers?.length).toBe(1);
    expect(init?.providers?.[0].name).toBe("默认兼容端点");
    expect(init?.models?.length).toBe(1);
    expect(init?.modes).toEqual(["agent", "plan", "ask"]);
    expect(init?.currentCapabilities).toEqual({ supportsVision: true, supportsThinking: true });
  });

  it("set_provider persists active provider and broadcasts provider_changed", async () => {
    const { controller, posted, setActive } = providerDeps();
    await controller.handle({ type: "set_provider", providerId: "p1" });
    expect(setActive).toHaveBeenCalledWith("p1");
    const changed = posted.find((m) => typeOf(m) === "provider_changed") as {
      providerId?: string;
      providerName?: string;
      models?: unknown[];
      capabilities?: unknown;
    } | undefined;
    expect(changed?.providerId).toBe("p1");
    expect(changed?.providerName).toBe("默认兼容端点");
    expect(changed?.capabilities).toEqual({ supportsVision: true, supportsThinking: true });
  });

  it("rejects attach_images when current model has no vision", async () => {
    const { controller, posted } = providerDeps({ supportsVision: false });
    await controller.handle({
      type: "attach_images",
      images: [{ mimeType: "image/png", data: pngB64(), fileName: "a.png" }],
    });
    const toast = posted.find((m) => typeOf(m) === "toast") as { message?: string } | undefined;
    expect(toast?.message).toContain("不支持图片输入");
  });

  it("accepts attach_images when vision enabled", async () => {
    const { controller, posted } = providerDeps({ supportsVision: true });
    await controller.handle({
      type: "attach_images",
      images: [{ mimeType: "image/png", data: pngB64(), fileName: "a.png" }],
    });
    expect(posted.some((m) => typeOf(m) === "chipsAttached")).toBe(true);
    expect(posted.some((m) => typeOf(m) === "toast" && String((m as { message?: string }).message).includes("不支持图片"))).toBe(false);
  });

  it("init filters out openai-protocol providers", async () => {
    const { controller, posted } = providerDeps({ protocols: ["openai"] });
    await controller.handle({ type: "ready" } as never);
    const init = posted.find((m) => typeOf(m) === "init") as { providers?: Array<{ id: string }> } | undefined;
    expect(init?.providers?.length).toBe(0);
  });

  it("set_provider rejects openai-protocol provider with error toast", async () => {
    const { controller, posted, setActive } = providerDeps({ protocols: ["openai"] });
    await controller.handle({ type: "set_provider", providerId: "p1" });
    expect(setActive).not.toHaveBeenCalled();
    const toast = posted.find((m) => typeOf(m) === "toast") as { message?: string; error?: boolean } | undefined;
    expect(toast?.error).toBe(true);
    expect(toast?.message).toContain("协议");
  });

  it("init broadcasts models_updated remote after successful fetch", async () => {
    const { controller, posted } = providerDeps({ fetchOk: true });
    await controller.handle({ type: "ready" } as never);
    const mu = posted.filter((m) => typeOf(m) === "models_updated") as Array<{ source?: string }>;
    expect(mu.length).toBeGreaterThan(0);
    expect(mu.some((m) => m.source === "remote")).toBe(true);
  });

  it("init broadcasts models_updated builtin + toast on fetch failure", async () => {
    const { controller, posted } = providerDeps({ fetchOk: false });
    await controller.handle({ type: "ready" } as never);
    const mu = posted.filter((m) => typeOf(m) === "models_updated") as Array<{ source?: string }>;
    expect(mu.some((m) => m.source === "builtin")).toBe(true);
    const toast = posted.find((m) => typeOf(m) === "toast") as { message?: string; error?: boolean } | undefined;
    expect(toast?.error).toBe(true);
    expect(toast?.message).toContain("已回退内置预设");
  });

  it("does not broadcast loading when fresh cache exists", async () => {
    const { controller, posted } = providerDeps({ fresh: true });
    await controller.handle({ type: "ready" } as never);
    const mu = posted.filter((m) => typeOf(m) === "models_updated") as Array<{ source?: string }>;
    expect(mu.some((m) => m.source === "loading")).toBe(false);
    expect(mu.some((m) => m.source === "remote")).toBe(true);
  });

  it("onAgentEvent error calls notifier.error with message", async () => {
    const error = vi.fn();
    const sessionImpl = {
      send: async (_text: string, onEvent: (ev: AgentLoopEvent) => void) => {
        onEvent({ type: "error", message: "API error (401)" });
      },
      cancel: () => {},
    };
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://api.deepseek.com/anthropic", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      createSession: (_opts: unknown) => sessionImpl,
      memory: new MemoryStore(path.join(dir, "mem")),
      notifier: { info: vi.fn(), warn: vi.fn(), error },
    };
    const posted: unknown[] = [];
    const controller = new ChatController(deps as never, (m) => posted.push(m));
    await controller.handle({ type: "send", text: "hi" });
    expect(error).toHaveBeenCalledWith("DSBAgent", "API error (401)");
    const status = posted.find((m) => typeOf(m) === "status") as { error?: boolean } | undefined;
    expect(status?.error).toBe(true);
  });

  it("init includes locale and notificationsEnabled", async () => {
    const { controller, posted } = makeDeps();
    await controller.handle({ type: "ready" });
    const init = posted.find((m) => typeOf(m) === "init") as { locale?: string; notificationsEnabled?: boolean } | undefined;
    expect(init?.locale).toBe("zh");
    expect(typeof init?.notificationsEnabled).toBe("boolean");
  });

  it("set_language persists, broadcasts locale_changed, and switches toast language", async () => {
    const updateLanguage = vi.fn(async () => {});
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://api.deepseek.com/anthropic", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      createSession: (_opts: unknown) => ({ send: async () => {}, cancel: () => {} }),
      memory: new MemoryStore(path.join(dir, "mem")),
      updateLanguage,
    };
    const posted: unknown[] = [];
    const c = new ChatController(deps as never, (m) => posted.push(m));
    await c.handle({ type: "set_language", language: "zh" } as never);
    expect(updateLanguage).toHaveBeenCalledWith("zh");
    const changed = posted.find((m) => typeOf(m) === "locale_changed") as { locale?: string } | undefined;
    expect(changed?.locale).toBe("zh");
  });

  it("set_vim_mode and set_notifications persist and toast", async () => {
    const updateVimMode = vi.fn(async () => {});
    const updateNotifications = vi.fn(async () => {});
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://api.deepseek.com/anthropic", model: () => "m" },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      createSession: (_opts: unknown) => ({ send: async () => {}, cancel: () => {} }),
      memory: new MemoryStore(path.join(dir, "mem")),
      updateVimMode,
      updateNotifications,
    };
    const posted: unknown[] = [];
    const c = new ChatController(deps as never, (m) => posted.push(m));
    await c.handle({ type: "set_vim_mode", enabled: true } as never);
    expect(updateVimMode).toHaveBeenCalledWith(true);
    await c.handle({ type: "set_notifications", enabled: false } as never);
    expect(updateNotifications).toHaveBeenCalledWith(false);
    const toasts = posted.filter((m) => typeOf(m) === "toast") as Array<{ message?: string }>;
    expect(toasts.some((t) => t.message?.includes("vim 模式已开启"))).toBe(true);
    expect(toasts.some((t) => t.message?.includes("通知已关闭"))).toBe(true);
  });
});
