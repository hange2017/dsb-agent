import { describe, it, expect } from "vitest";
// vim.ts 依赖 DOM,仅测试纯逻辑:用 happy-dom 环境或抽离纯函数。
// 此处验证结构:导出存在且 handleKey 返回布尔。
import { VimInput } from "../webview/vim";

class FakeTextArea {
  value = "line1\nline2\nline3";
  selectionStart = 0;
  selectionEnd = 0;
  title = "";
  setSelectionRange(s: number, e: number): void { this.selectionStart = s; this.selectionEnd = e; }
  dispatchEvent(): void {}
}

describe("VimInput", () => {
  it("enters insert mode on i", () => {
    const el = new FakeTextArea() as unknown as HTMLTextAreaElement;
    const vim = new VimInput(el, { enabled: () => true });
    expect(vim.handleKey({ key: "i", preventDefault: () => {} } as KeyboardEvent)).toBe(true);
    expect(vim.mode).toBe("insert");
  });
  it("dd deletes current line", () => {
    const el = new FakeTextArea() as unknown as HTMLTextAreaElement;
    el.selectionStart = 8; // line2
    const vim = new VimInput(el, { enabled: () => true });
    vim.handleKey({ key: "d", preventDefault: () => {} } as KeyboardEvent);
    vim.handleKey({ key: "d", preventDefault: () => {} } as KeyboardEvent);
    expect(el.value).toBe("line1\nline3");
  });
  it("G moves caret to start of last line", () => {
    const el = new FakeTextArea() as unknown as HTMLTextAreaElement;
    el.selectionStart = 0;
    const vim = new VimInput(el, { enabled: () => true });
    vim.handleKey({ key: "G", preventDefault: () => {} } as KeyboardEvent);
    expect(el.selectionStart).toBe(12); // start of line3
  });
  it("gg moves caret to start of first line", () => {
    const el = new FakeTextArea() as unknown as HTMLTextAreaElement;
    el.selectionStart = 8; // line2
    const vim = new VimInput(el, { enabled: () => true });
    vim.handleKey({ key: "g", preventDefault: () => {} } as KeyboardEvent);
    vim.handleKey({ key: "g", preventDefault: () => {} } as KeyboardEvent);
    expect(el.selectionStart).toBe(0); // start of line1
  });
  it("disabled returns false", () => {
    const el = new FakeTextArea() as unknown as HTMLTextAreaElement;
    const vim = new VimInput(el, { enabled: () => false });
    expect(vim.handleKey({ key: "i", preventDefault: () => {} } as KeyboardEvent)).toBe(false);
  });
});
