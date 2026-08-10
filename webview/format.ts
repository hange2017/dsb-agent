function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatInline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/** GFM 分隔行:| --- | :---: | ---: | */
function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|")) return false;
  let body = t;
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  const cells = body.split("|");
  return cells.length > 0 && cells.every((c) => /^\s*:?-{3,}:?\s*$/.test(c));
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.includes("|", 1);
}

function splitCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

function renderTable(header: string[], rows: string[][]): string {
  let html = '<table class="md-table"><thead><tr>';
  for (const h of header) html += `<th>${formatInline(h)}</th>`;
  html += "</tr></thead><tbody>";
  for (const row of rows) {
    html += "<tr>";
    for (let i = 0; i < header.length; i++) {
      html += `<td>${formatInline(row[i] ?? "")}</td>`;
    }
    html += "</tr>";
  }
  html += "</tbody></table>";
  return html;
}

export function renderMarkdown(text: string): string {
  // 支持 MVP 子集:代码块 / 行内代码 / 加粗 / GFM 表格 / 换行。转义 HTML。
  const lines = escHtml(text).split("\n");
  let inCode = false;
  let out = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      if (inCode) {
        out += "</code></pre>";
        inCode = false;
      } else {
        out += "<pre><code>";
        inCode = true;
      }
      i++;
      continue;
    }
    if (inCode) {
      out += line + "\n";
      i++;
      continue;
    }
    // GFM 表格:表头 + 分隔行 + 0..n 数据行
    if (
      isTableRow(line) &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const header = splitCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]) && !isTableSeparator(lines[i])) {
        rows.push(splitCells(lines[i]));
        i++;
      }
      out += renderTable(header, rows) + "\n";
      continue;
    }
    out += formatInline(line) + "\n";
    i++;
  }
  if (inCode) out += "</code></pre>";
  return linkifyJumpables(out);
}

// ---- 行内跳转标记 ----
// 在渲染后的 HTML 里把行内文件路径 / path:line / http(s) URL 包成可双击跳转的 span。
// 跳过已存在的 HTML 标签与实体,只处理文本片段,避免破坏表格/代码块结构。

const INLINE_JUMP_RE =
  /(?<url>https?:\/\/[^\s<>"'`\u4e00-\u9fff，。；：！？】）、]+)|(?<![\w])(?<path>(?:\.{1,2}[\\/]|[A-Za-z]:[\\/]|[\\/]|[A-Za-z0-9_.@~-]+[\\/])[A-Za-z0-9_.@~-]+(?:[\\/][A-Za-z0-9_.@~-]+)*)(?::(?<line>\d+))?(?![\w])/g;

const HTML_TOKEN_RE = /<\/?[a-z][^>]*>|&(?:amp|lt|gt|quot|#\d+);/g;

/** URL 尾部常见的句子标点(中英文),匹配时剥掉,避免把句号带进链接。 */
const URL_TAIL_RE = /[.,;:!?)\]}"'、。，；：！？】）]+$/;

function jumpSpan(m: RegExpMatchArray): string {
  const g = m.groups;
  if (!g) return m[0];
  if (g.url) {
    let u = g.url;
    const tail = u.match(URL_TAIL_RE);
    if (tail) u = u.slice(0, -tail[0].length);
    if (!u) return m[0];
    return `<span class="jumpable jump-url" data-jump-url="${u}">${u}</span>`;
  }
  const p = g.path;
  const line = g.line;
  if (line) {
    return `<span class="jumpable jump-path" data-jump-path="${p}" data-jump-line="${line}">${p}:${line}</span>`;
  }
  return `<span class="jumpable jump-path" data-jump-path="${p}">${p}</span>`;
}

function linkifyPlain(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(INLINE_JUMP_RE)) {
    out += text.slice(last, m.index);
    out += jumpSpan(m);
    last = (m.index ?? 0) + m[0].length;
  }
  out += text.slice(last);
  return out;
}

/** 遍历已渲染 HTML,跳过标签/实体与 pre/code 代码块,把纯文本段里的路径与 URL 标记为可跳转。 */
export function linkifyJumpables(html: string): string {
  let out = "";
  let last = 0;
  let inCode = 0;
  for (const m of html.matchAll(HTML_TOKEN_RE)) {
    const tag = m[0];
    const seg = html.slice(last, m.index);
    out += inCode > 0 ? seg : linkifyPlain(seg);
    out += tag;
    if (/^<(pre|code)\b/.test(tag)) inCode++;
    else if (/^<\/(pre|code)>/.test(tag) && inCode > 0) inCode--;
    last = (m.index ?? 0) + tag.length;
  }
  const seg = html.slice(last);
  out += inCode > 0 ? seg : linkifyPlain(seg);
  return out;
}
