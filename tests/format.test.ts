import { describe, it, expect } from "vitest";
import { renderMarkdown, linkifyJumpables } from "../webview/format";

describe("renderMarkdown", () => {
  it("renders inline code", () => {
    expect(renderMarkdown("run `npm test`")).toContain("<code>npm test</code>");
  });
  it("renders code blocks", () => {
    const out = renderMarkdown("```js\nconst x=1;\n```");
    expect(out).toContain("<pre><code>");
    expect(out).toContain("const x=1;");
  });
  it("escapes html", () => {
    expect(renderMarkdown("<script>")).not.toContain("<script>");
  });
  it("renders GFM pipe tables as HTML table", () => {
    const md = [
      "| Gap | § | 状态 |",
      "|-----|---|------|",
      "| MCP enabled | §4.2 | ⚠️ |",
      "| Project rules | §4.4 | ❌ |",
    ].join("\n");
    const out = renderMarkdown(md);
    expect(out).toContain("<table");
    expect(out).toContain("MCP enabled");
    expect(out).not.toMatch(/^\|/m);
  });
  it("keeps surrounding text around a table", () => {
    const md = "前言\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n后记";
    const out = renderMarkdown(md);
    expect(out).toContain("前言");
    expect(out).toContain("<table");
    expect(out).toContain("后记");
  });
  it("does not treat non-table pipes as a table", () => {
    const out = renderMarkdown("use `|` as delimiter");
    expect(out).not.toContain("<table");
    expect(out).toContain("|");
  });
});

describe("linkifyJumpables", () => {
  it("marks inline file path as jumpable", () => {
    const out = linkifyJumpables("看看 src/agent/agentLoop.ts 里的实现");
    expect(out).toContain('class="jumpable jump-path"');
    expect(out).toContain('data-jump-path="src/agent/agentLoop.ts"');
  });

  it("marks path:line and keeps the line number", () => {
    const out = linkifyJumpables("问题在 src/chat/chatController.ts:383");
    expect(out).toContain('data-jump-path="src/chat/chatController.ts"');
    expect(out).toContain('data-jump-line="383"');
    expect(out).toContain(">src/chat/chatController.ts:383</span>");
  });

  it("marks http(s) url and strips trailing punctuation", () => {
    const out = linkifyJumpables("文档见 https://example.com/guide,请查阅。");
    expect(out).toContain('class="jumpable jump-url"');
    expect(out).toContain('data-jump-url="https://example.com/guide"');
    expect(out).not.toContain('data-jump-url="https://example.com/guide,"');
  });

  it("preserves existing tags while linkifying their text", () => {
    const out = linkifyJumpables("<strong>src/a.ts</strong>");
    expect(out).toBe(
      '<strong><span class="jumpable jump-path" data-jump-path="src/a.ts">src/a.ts</span></strong>'
    );
  });

  it("skips code blocks: path inside pre/code is untouched", () => {
    const out = linkifyJumpables("<pre><code>src/a.ts:1\n</code></pre>");
    expect(out).toBe("<pre><code>src/a.ts:1\n</code></pre>");
  });

  it("does not mark plain words or version-like tokens", () => {
    expect(linkifyJumpables("hello world 1.2.3")).not.toContain("jumpable");
    expect(linkifyJumpables("npm test")).not.toContain("jumpable");
  });

  it("keeps amp entities unparsed", () => {
    const out = linkifyJumpables("a &amp; b src/x.ts");
    expect(out).toContain("&amp;");
    expect(out).toContain('data-jump-path="src/x.ts"');
  });

  it("linkifies paths inside table cells", () => {
    const out = linkifyJumpables("<td>src/main.ts</td>");
    expect(out).toContain('data-jump-path="src/main.ts"');
    expect(out).toContain("</td>");
  });

  it("linkifies paths/urls inside inline code (agent 表格/列表常见 `` `path` `` 风格)", () => {
    // formatInline 之后路径在 <code> 内:inline code 不算代码块,必须可跳转
    const out = linkifyJumpables(
      "<code>src/agent/contextManager.ts</code> <code>src/agent/agentLoop.ts:139</code> <code>https://example.com/x</code>"
    );
    expect(out).toContain('data-jump-path="src/agent/contextManager.ts"');
    expect(out).toContain('data-jump-path="src/agent/agentLoop.ts"');
    expect(out).toContain('data-jump-line="139"');
    expect(out).toContain('data-jump-url="https://example.com/x"');
  });

  it("skips paths inside inline code inside a code block", () => {
    const out = linkifyJumpables("<pre><code>see `src/a.ts` here\n</code></pre>");
    expect(out).not.toContain("jumpable");
  });

  it("renderMarkdown marks inline-code paths in markdown tables", () => {
    const md = "| 文件 | 职责 |\n|---|---|\n| `src/agent/contextManager.ts` | 主控 |";
    const out = renderMarkdown(md);
    expect(out).toContain('data-jump-path="src/agent/contextManager.ts"');
  });
});
