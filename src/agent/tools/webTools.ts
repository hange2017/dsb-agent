import { load } from "cheerio";
import type { ToolExecResult } from "./types";

export type WebHit = { title: string; url: string; snippet: string };
export type WebSearchImpl = (q: string) => Promise<WebHit[]>;

const DEFAULT_SEARCH_TIMEOUT_MS = 12_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function webSearchResult(query: string, hits: WebHit[]): string {
  if (hits.length === 0) return "(no results)";
  return hits
    .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`)
    .join("\n");
}

export async function webSearch(query: string, searchImpl: WebSearchImpl): Promise<ToolExecResult> {
  try {
    const hits = await searchImpl(query);
    return { ok: true, content: webSearchResult(query, hits) };
  } catch (err) {
    return { ok: false, content: `ERROR: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function webFetch(url: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<ToolExecResult> {
  try {
    const res = await fetchImpl(url, { headers: { "User-Agent": "dsb-agent" } });
    // 产品约定:HTTP 非 200 也是「抓取执行了并返回了状态码」→ 完成态;网络异常/解析失败才算失败
    if (!res.ok) return { ok: true, content: `HTTP ${res.status}` };
    const html = await res.text();
    const $ = load(html);
    $("script, style, nav, footer, header").remove();
    const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 20_000);
    return { ok: true, content: text || "(empty page)" };
  } catch (err) {
    return { ok: false, content: `ERROR: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** DuckDuckGo 的 HTML 结果链接是 `//duckduckgo.com/l/?uddg=<url>` 重定向,取出真实目标 URL。 */
export function decodeRedirectUrl(href: string): string {
  if (!href.includes("uddg=")) return href;
  try {
    const u = new URL(href, "https://duckduckgo.com");
    return u.searchParams.get("uddg") ?? href;
  } catch {
    return href;
  }
}

/** 解析 DuckDuckGo HTML 结果页(供测试注入 fixture)。 */
export function parseDuckDuckGoHtml(html: string): WebHit[] {
  const $ = load(html);
  const hits: WebHit[] = [];
  $("div.result").each((_, el) => {
    if (hits.length >= 5) return false;
    const $el = $(el);
    const a = $el.find("a.result__a").first();
    const title = a.text().trim();
    const href = a.attr("href") ?? "";
    if (!title || !href) return;
    const snippet = $el.find("a.result__snippet").first().text().trim();
    hits.push({ title, url: decodeRedirectUrl(href), snippet });
  });
  return hits;
}

/** 解析 Bing / cn.bing HTML 结果页(供测试注入 fixture)。 */
export function parseBingHtml(html: string): WebHit[] {
  const $ = load(html);
  const hits: WebHit[] = [];
  $("li.b_algo").each((_, el) => {
    if (hits.length >= 5) return false;
    const $el = $(el);
    const a = $el.find("h2 a").first();
    const title = a.text().trim();
    const href = a.attr("href") ?? "";
    if (!title || !href) return;
    const snippet = $el
      .find(".b_caption p, .b_lineclamp2, .b_lineclamp3, .b_algoSlug")
      .first()
      .text()
      .trim();
    hits.push({ title, url: href, snippet });
  });
  return hits;
}

async function fetchHtml(
  url: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": DEFAULT_USER_AGENT },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * DuckDuckGo HTML 搜索。网络/解析失败抛错(不再静默变空结果)。
 */
export async function duckDuckGoSearch(
  query: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<WebHit[]> {
  const html = await fetchHtml(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    fetchImpl,
  });
  return parseDuckDuckGoHtml(html);
}

/**
 * Bing HTML 搜索(含 cn.bing 重定向)。国内网络通常可达,作 DDG 回退。
 */
export async function bingSearch(
  query: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<WebHit[]> {
  const html = await fetchHtml(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
    fetchImpl,
  });
  return parseBingHtml(html);
}

/**
 * 默认搜索:先 DDG,失败或零结果再 Bing。全部失败则抛错(由 webSearch 转为 ERROR,避免假「无结果」)。
 */
export async function defaultWebSearch(
  query: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<WebHit[]> {
  const errors: string[] = [];

  try {
    const hits = await duckDuckGoSearch(query, fetchImpl);
    if (hits.length > 0) return hits;
  } catch (err) {
    errors.push(`duckduckgo: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const hits = await bingSearch(query, fetchImpl);
    if (hits.length > 0) return hits;
  } catch (err) {
    errors.push(`bing: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (errors.length > 0) {
    throw new Error(`web search failed (${errors.join("; ")})`);
  }
  return [];
}
