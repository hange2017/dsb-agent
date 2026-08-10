import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../webview/format";

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
    expect(out).toContain("<th>");
    expect(out).toContain("Gap");
    expect(out).toContain("<td>");
    expect(out).toContain("MCP enabled");
    expect(out).toContain("Project rules");
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
