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
  workspace: {
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    getConfiguration: () => ({ get: () => "", update: async () => {} }),
  },
}));

import { MemoryStore } from "../src/agent/memory/memoryStore";
import { MemoryManager } from "../src/agent/memory/memoryManager";
import { createMemoryPanel, handleMessage } from "../src/settings/memoryPanel";
import type { MemoryPanelMessage, MemoryPanelServices, VscodeWebviewPanelLike } from "../src/settings/memoryPanel";

function makePanel(dir: string) {
  const root = new MemoryStore(path.join(dir, "mem"));
  const mgr = new MemoryManager(root.scoped("proj-key"), root, "proj-key");
  const services: MemoryPanelServices = {
    getLocale: () => "zh",
    list: () => ({ projectKey: mgr.key(), ...mgr.list() }),
    write: (scope, input) => mgr.write(scope, input),
    delete: (scope, name) => mgr.delete(scope, name),
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
    title: "记忆管理",
    onDidDispose: () => {},
    extensionUri: { fsPath: dir } as never,
  };
  return { panel: panel as unknown as VscodeWebviewPanelLike, services, sent, mgr };
}

describe("memoryPanel handleMessage", () => {
  it("ready 下发 state(含 projectKey 与分组条目)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsb-mp-"));
    try {
      const { panel, services, sent } = makePanel(dir);
      await handleMessage({ type: "ready" }, panel, services);
      const state = sent[0] as { type: "state"; projectKey: string; project: unknown[]; global: unknown[]; locale: string };
      expect(state.type).toBe("state");
      expect(state.projectKey).toBe("proj-key");
      expect(state.project).toEqual([]);
      expect(state.global).toEqual([]);
      expect(state.locale).toBe("zh");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("memory_write 写入并按 scope 路由,随后下发新 state + toast", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsb-mp-"));
    try {
      const { panel, services, sent, mgr } = makePanel(dir);
      await handleMessage(
        { type: "memory_write", scope: "global", name: "g-note", description: "g", body: "body" },
        panel,
        services,
      );
      expect(mgr.list().global.map((e) => e.name)).toEqual(["g-note"]);
      const state = sent.find((m) => (m as { type?: string }).type === "state") as { global: Array<{ name: string }> };
      expect(state.global[0].name).toBe("g-note");
      const toast = sent.find((m) => (m as { type?: string }).type === "toast") as { message: string };
      expect(toast.message).toContain("g-note");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("memory_delete 只删指定 scope,并 toast", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsb-mp-"));
    try {
      const { panel, services, sent, mgr } = makePanel(dir);
      await handleMessage({ type: "memory_write", scope: "project", name: "dup", description: "p", body: "p" }, panel, services);
      await handleMessage({ type: "memory_write", scope: "global", name: "dup", description: "g", body: "g" }, panel, services);
      await handleMessage({ type: "memory_delete", scope: "project", name: "dup" }, panel, services);
      expect(mgr.list().project).toEqual([]);
      expect(mgr.list().global.map((e) => e.name)).toEqual(["dup"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("write 校验失败时 toast error,不落盘", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsb-mp-"));
    try {
      const { panel, services, sent, mgr } = makePanel(dir);
      await handleMessage({ type: "memory_write", scope: "project", name: " ", description: "d", body: "b" }, panel, services);
      const toast = sent[sent.length - 1] as { message: string; error?: boolean };
      expect(toast.error).toBe(true);
      expect(toast.message).toContain("name");
      expect(mgr.list().project).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("createMemoryPanel 装配:设置 html 并注册消息监听", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsb-mp-"));
    try {
      const { panel, services } = makePanel(dir);
      let registered: ((m: MemoryPanelMessage) => void) | undefined;
      const panel2 = {
        ...panel,
        webview: {
          ...panel.webview,
          onDidReceiveMessage: (cb: (m: MemoryPanelMessage) => void) => {
            registered = cb;
          },
        },
      };
      createMemoryPanel(panel2 as unknown as VscodeWebviewPanelLike, services);
      expect(panel2.webview.html.length).toBeGreaterThan(0);
      expect(registered).toBeTypeOf("function");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
