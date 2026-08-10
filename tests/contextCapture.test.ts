import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => ({
  window: { activeTerminal: undefined },
  commands: {
    registerCommand: vi.fn((_id: string, fn: () => void) => ({ dispose: vi.fn() })),
    executeCommand: vi.fn(),
  },
  workspace: { getWorkspaceFolder: vi.fn() },
  env: { clipboard: { readText: vi.fn() } },
}));

import { ContextCapture } from "../src/context/contextCapture";

describe("ContextCapture.consumePasteAsChips", () => {
  it("returns chip when paste matches last terminal capture", () => {
    const c = new ContextCapture();
    c.captureTerminalSelection("error: boom");
    const chips = c.consumePasteAsChips("error: boom");
    expect(chips).toHaveLength(1);
    expect(chips[0]?.kind).toBe("terminal");
  });

  it("returns empty when paste is unrelated", () => {
    const c = new ContextCapture();
    c.captureTerminalSelection("error: boom");
    expect(c.consumePasteAsChips("hello")).toEqual([]);
  });

  it("does not promote chip when paste is substring of last capture", () => {
    const c = new ContextCapture();
    const largeCapture =
      "function handleError(err: Error) {\n  console.error('error: boom', err);\n}";
    c.captureTerminalSelection(largeCapture);
    expect(c.consumePasteAsChips("error: boom")).toEqual([]);
    expect(c.getLastCopy()?.text).toBe(largeCapture);
  });

  it("does not promote editor chip when pasteMode is partialLine even when text matches", () => {
    const c = new ContextCapture();
    const chip = {
      kind: "editor" as const,
      id: "test-id",
      relativePath: "src/foo.ts",
      absolutePath: "/proj/src/foo.ts",
      startLine: 3,
      endLine: 3,
      text: "x = 1",
    };
    c.setLastEditorForTest(chip, "partialLine");
    expect(c.consumePasteAsChips("x = 1")).toEqual([]);
    expect(c.getLastCopy()).toBeUndefined();
  });

  it("promotes editor chip when pasteMode is fullLine and text matches", () => {
    const c = new ContextCapture();
    const chip = {
      kind: "editor" as const,
      id: "test-id",
      relativePath: "src/foo.ts",
      absolutePath: "/proj/src/foo.ts",
      startLine: 3,
      endLine: 3,
      text: "  const x = 1;",
    };
    c.setLastEditorForTest(chip, "fullLine");
    const chips = c.consumePasteAsChips("  const x = 1;");
    expect(chips).toHaveLength(1);
    expect(chips[0]?.kind).toBe("editor");
    expect(c.getLastCopy()).toBeUndefined();
  });
});
