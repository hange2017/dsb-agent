import { describe, it, expect } from "vitest";
import { classifyEditorPasteMode } from "../src/context/editorPasteMode";

describe("classifyEditorPasteMode", () => {
  it("multiLine when start !== end", () => {
    expect(
      classifyEditorPasteMode({
        startLine: 1,
        endLine: 2,
        selectedText: "a\nb",
        fullLineText: "a",
      }),
    ).toBe("multiLine");
  });

  it("fullLine when single line equals full line (trimEnd)", () => {
    expect(
      classifyEditorPasteMode({
        startLine: 3,
        endLine: 3,
        selectedText: "  const x = 1;\n",
        fullLineText: "  const x = 1;",
      }),
    ).toBe("fullLine");
  });

  it("partialLine when selection is not the whole line", () => {
    expect(
      classifyEditorPasteMode({
        startLine: 3,
        endLine: 3,
        selectedText: "x = 1",
        fullLineText: "  const x = 1;",
      }),
    ).toBe("partialLine");
  });
});
