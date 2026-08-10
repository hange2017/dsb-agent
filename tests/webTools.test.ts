import { describe, it, expect, vi } from "vitest";
import {
  webSearch,
  webFetch,
  webSearchResult,
  parseBingHtml,
  parseDuckDuckGoHtml,
  decodeRedirectUrl,
  defaultWebSearch,
  bingSearch,
} from "../src/agent/tools/webTools";

describe("webTools", () => {
  it("formats search hits", () => {
    const out = webSearchResult("dsb api", [{ title: "T", url: "https://x", snippet: "sn" }]);
    expect(out).toContain("T");
    expect(out).toContain("https://x");
  });

  it("webSearch returns ok with mocked impl", async () => {
    const r = await webSearch("q", async () => [{ title: "A", url: "https://a", snippet: "s" }]);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("A");
  });

  it("webSearch surfaces provider failures as ERROR not (no results)", async () => {
    const r = await webSearch("q", async () => {
      throw new Error("web search failed (duckduckgo: timeout; bing: timeout)");
    });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("ERROR:");
    expect(r.content).not.toBe("(no results)");
  });

  it("webFetch extracts text via mocked fetch", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      text: async () => "<html><body><p>Hello <b>world</b></p><script>x</script></body></html>",
    })) as unknown as typeof fetch;
    const r = await webFetch("https://example.com", fetchImpl);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("Hello world");
  });

  it("webFetch treats non-200 as completed (ok:true)", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    const r = await webFetch("https://example.com", fetchImpl);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("404");
  });

  it("decodeRedirectUrl extracts uddg target", () => {
    expect(
      decodeRedirectUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpath"),
    ).toBe("https://example.com/path");
  });

  it("parseDuckDuckGoHtml reads result__a blocks", () => {
    const html = `
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example">Title A</a>
        <a class="result__snippet">Snippet A</a>
      </div>`;
    const hits = parseDuckDuckGoHtml(html);
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("Title A");
    expect(hits[0].url).toBe("https://a.example");
    expect(hits[0].snippet).toBe("Snippet A");
  });

  it("parseBingHtml reads li.b_algo blocks", () => {
    const html = `
      <ol id="b_results">
        <li class="b_algo">
          <h2><a href="https://bing.example/page">Bing Title</a></h2>
          <div class="b_caption"><p>Bing snippet text</p></div>
        </li>
      </ol>`;
    const hits = parseBingHtml(html);
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("Bing Title");
    expect(hits[0].url).toBe("https://bing.example/page");
    expect(hits[0].snippet).toBe("Bing snippet text");
  });

  it("defaultWebSearch falls back to Bing when DuckDuckGo fetch fails", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("duckduckgo")) {
        throw new Error("ConnectTimeoutError");
      }
      return {
        ok: true,
        text: async () => `
          <li class="b_algo">
            <h2><a href="https://fallback.example">Fallback Hit</a></h2>
            <div class="b_caption"><p>ok</p></div>
          </li>`,
      };
    }) as unknown as typeof fetch;

    const hits = await defaultWebSearch("hello", fetchImpl);
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("Fallback Hit");
  });

  it("bingSearch parses live-shaped mock response", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      text: async () => `
        <li class="b_algo">
          <h2><a href="https://x.example">X</a></h2>
          <div class="b_caption"><p>s</p></div>
        </li>`,
    })) as unknown as typeof fetch;
    const hits = await bingSearch("q", fetchImpl);
    expect(hits[0].url).toBe("https://x.example");
  });
});
