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
  return out;
}
