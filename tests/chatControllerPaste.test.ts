import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("vscode", () => ({
  window: { activeTerminal: undefined, terminals: [], showTextDocument: vi.fn() },
  commands: {
    registerCommand: vi.fn((_id: string, fn: () => void) => ({ dispose: vi.fn() })),
    executeCommand: vi.fn(),
  },
  workspace: { getWorkspaceFolder: vi.fn(), openTextDocument: vi.fn() },
  env: { clipboard: { readText: vi.fn() } },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChatController } from "../src/chat/chatController";
import { ContextCapture } from "../src/context/contextCapture";
import { SessionStore } from "../src/session/sessionStore";
import { MemoryStore } from "../src/agent/memory/memoryStore";

let dir: string;
let store: SessionStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-paste-"));
  store = new SessionStore(dir);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function typeOf(m: unknown): string {
  return (m as { type: string }).type;
}

function makePasteDeps(contextCapture: ContextCapture, autoChipsOnPaste = true) {
  const posted: unknown[] = [];
  const controller = new ChatController(
    {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://x", model: () => "m", autoChipsOnPaste: () => autoChipsOnPaste },
      getWorkspaceCwd: () => "/tmp",
      sessionStore: store,
      createSession: () => {
        throw new Error("should not be called");
      },
      memory: new MemoryStore(path.join(dir, "mem")),
      contextCapture,
      autoChipsOnPaste: () => autoChipsOnPaste,
    } as never,
    (m) => posted.push(m),
  );
  return { controller, posted, contextCapture };
}

describe("ChatController paste and chip sync", () => {
  it("paste multiLine editor promotes to chipsAttached with wrapRef only", async () => {
    const { controller, posted, contextCapture } = makePasteDeps(new ContextCapture());
    const chip = {
      kind: "editor" as const,
      id: "editor-2",
      relativePath: "src/foo.ts",
      absolutePath: "/proj/src/foo.ts",
      startLine: 1,
      endLine: 3,
      text: "line1\nline2\nline3",
    };
    contextCapture.setLastEditorForTest(chip, "multiLine");

    await controller.handle({ type: "paste", text: "line1\nline2\nline3" });

    const attached = posted.filter((m) => typeOf(m) === "chipsAttached") as Array<{
      chips: Array<{ id: string; label: string }>;
      insertTexts: string[];
    }>;
    expect(attached).toHaveLength(1);
    expect(attached[0].chips[0]).toMatchObject({ id: "editor-2", label: "src/foo.ts (1-3)" });
    expect(attached[0].insertTexts).toEqual(["`src/foo.ts (1-3)`"]);
    expect(posted.some((m) => typeOf(m) === "pasteHandled")).toBe(false);
  });

  it("paste partialLine editor falls back to pasteHandled", async () => {
    const { controller, posted, contextCapture } = makePasteDeps(new ContextCapture());
    const chip = {
      kind: "editor" as const,
      id: "editor-partial",
      relativePath: "src/foo.ts",
      absolutePath: "/proj/src/foo.ts",
      startLine: 3,
      endLine: 3,
      text: "x = 1",
    };
    contextCapture.setLastEditorForTest(chip, "partialLine");

    await controller.handle({ type: "paste", text: "x = 1" });

    expect(posted.filter((m) => typeOf(m) === "chipsAttached")).toHaveLength(0);
    expect(posted).toContainEqual({ type: "pasteHandled", consumed: false, text: "x = 1" });
  });

  it("addPendingChips posts chipsAttached with insertTexts", () => {
    const { controller, posted } = makePasteDeps(new ContextCapture());
    controller.addPendingChips([
      {
        kind: "file",
        id: "chip-1",
        relativePath: "a.ts",
        absolutePath: "/a.ts",
        text: "x",
      },
    ]);

    const attached = posted.find((m) => typeOf(m) === "chipsAttached") as {
      chips: Array<{ id: string; kind: string; label: string }>;
      insertTexts: string[];
    };
    expect(attached.chips).toEqual([{ id: "chip-1", kind: "file", label: "a.ts" }]);
    expect(attached.insertTexts).toEqual(["`a.ts`"]);
  });

  it("remove_chip posts chipRemoved with label", async () => {
    const { controller, posted } = makePasteDeps(new ContextCapture());
    controller.addPendingChips([
      {
        kind: "file",
        id: "chip-1",
        relativePath: "a.ts",
        absolutePath: "/a.ts",
        text: "x",
      },
    ]);
    posted.length = 0;

    await controller.handle({ type: "remove_chip", id: "chip-1" });

    expect(posted).toContainEqual({ type: "chipRemoved", id: "chip-1", label: "a.ts" });
  });
});
