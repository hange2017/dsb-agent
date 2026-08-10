import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("vscode", () => ({
  Uri: {
    joinPath: (...parts: unknown[]) => ({
      fsPath: parts.map(String).join("/"),
      toString: () => parts.map(String).join("/"),
    }),
    file: (p: string) => ({ fsPath: p, toString: () => p }),
  },
}));

import { ContextStore } from "../src/context/contextStore";
import {
  createContextPanel,
  contextPanelServicesFromStore,
  handleMessage,
  type ContextPanelMessage,
  type ContextPanelServices,
  type VscodeWebviewPanelLike,
} from "../src/settings/contextPanel";

function makePanel(dir: string, extra?: (store: ContextStore) => Partial<ContextPanelServices>) {
  const store = new ContextStore(path.join(dir, "context"));
  store.append("s1", [
    { seq: 1, type: "demand", role: "user", summary: "需求摘要", content: "用户需求原文", ts: 1 },
    { seq: 2, type: "ledger", role: "assistant", summary: "Read: a.ts", content: "Read: a.ts", ts: 2 },
  ]);
  store.append("s2", [
    { seq: 1, type: "conclusion", role: "assistant", summary: "结论摘要", content: "结论内容", ts: 3 },
  ]);
  const services: ContextPanelServices = {
    ...contextPanelServicesFromStore(store, () => "zh"),
    ...(extra?.(store) ?? {}),
  };
  const sent: unknown[] = [];
  const panel = {
    webview: {
      html: "",
      onDidReceiveMessage: () => {},
      postMessage: (m: unknown) => {
        sent.push(m);
        return Promise.resolve(true);
      },
    },
    title: "冷存储浏览",
    onDidDispose: () => {},
    extensionUri: { fsPath: dir } as never,
  };
  return { panel: panel as unknown as VscodeWebviewPanelLike, services, sent, store };
}

describe("contextPanel handleMessage", () => {
  it("ready 下发 state(会话列表含统计)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsb-cp-"));
    try {
      const { panel, services, sent } = makePanel(dir);
      await handleMessage({ type: "ready" }, panel, services);
      const state = sent[0] as {
        type: "state";
        sessions: Array<{ id: string; chunkCount: number; compacted: number; pruned: number }>;
        locale: string;
      };
      expect(state.type).toBe("state");
      expect(state.locale).toBe("zh");
      expect(state.sessions.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
      const s1 = state.sessions.find((s) => s.id === "s1")!;
      expect(s1.chunkCount).toBe(2);
      expect(s1.compacted).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("browse 返回该会话块视图", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsb-cp-"));
    try {
      const { panel, services, sent } = makePanel(dir);
      await handleMessage({ type: "browse", sessionId: "s1" }, panel, services);
      const msg = sent[sent.length - 1] as {
        type: "browse";
        sessionId: string;
        entries: Array<{ seq: number; type: string; content: string }>;
      };
      expect(msg.type).toBe("browse");
      expect(msg.sessionId).toBe("s1");
      expect(msg.entries).toHaveLength(2);
      expect(msg.entries[0].content).toBe("用户需求原文");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clear 清空会话并 toast", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsb-cp-"));
    try {
      const { panel, services, sent, store } = makePanel(dir);
      await handleMessage({ type: "clear", sessionId: "s1" }, panel, services);
      expect(store.load("s1")).toEqual([]);
      expect(store.load("s2")).toHaveLength(1);
      const toast = sent.find((m) => (m as { type?: string }).type === "toast") as { message: string };
      expect(toast.message).toContain("s1");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("delete 删除会话文件并 toast", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsb-cp-"));
    try {
      const { panel, services, sent, store } = makePanel(dir);
      await handleMessage({ type: "delete", sessionId: "s2" }, panel, services);
      expect(store.listSessions()).toEqual(["s1"]);
      const toast = sent.find((m) => (m as { type?: string }).type === "toast") as { message: string };
      expect(toast.message).toContain("s2");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merge_all 合并去重全部会话到 __all__ 并删除源会话", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsb-cp-"));
    try {
      const { panel, services, sent, store } = makePanel(dir);
      await handleMessage({ type: "merge_all" }, panel, services);
      expect(store.listSessions()).toEqual(["__all__"]);
      const all = store.load("__all__");
      expect(all).toHaveLength(3);
      const toast = sent.find((m) => (m as { type?: string }).type === "toast") as { message: string };
      expect(toast.message).toContain("3");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("createContextPanel 装配:设置 html 并注册消息监听", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsb-cp-"));
    try {
      const { panel, services } = makePanel(dir);
      let registered: ((m: ContextPanelMessage) => void) | undefined;
      const panel2 = {
        ...panel,
        webview: {
          ...panel.webview,
          onDidReceiveMessage: (cb: (m: ContextPanelMessage) => void) => {
            registered = cb;
          },
        },
      };
      createContextPanel(panel2 as unknown as VscodeWebviewPanelLike, services);
      expect(panel2.webview.html.length).toBeGreaterThan(0);
      expect(registered).toBeTypeOf("function");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
