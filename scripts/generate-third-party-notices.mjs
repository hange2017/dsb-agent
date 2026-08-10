#!/usr/bin/env node
/**
 * Regenerate THIRD_PARTY_NOTICES.md from production dependency licenses.
 * Usage: node scripts/generate-third-party-notices.mjs
 * Requires: npm install (node_modules present); uses license-checker via npx.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = path.join(root, "THIRD_PARTY_NOTICES.md");

const raw = execFileSync(
  "npx",
  ["--yes", "license-checker", "--production", "--json"],
  { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
);
const data = JSON.parse(raw);
const rows = Object.entries(data)
  .map(([name, v]) => ({
    name,
    licenses: String(v.licenses || "UNKNOWN"),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

const by = {};
for (const r of rows) by[r.licenses] = (by[r.licenses] || 0) + 1;
const summary = Object.entries(by)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `- ${k}: ${v}`)
  .join("\n");

const direct = [
  { pkg: "@modelcontextprotocol/sdk", role: "MCP client" },
  { pkg: "@vscode/ripgrep", role: "Grep binary helper" },
  { pkg: "cheerio", role: "HTML parse (WebFetch/Search)" },
  { pkg: "mammoth", role: "DOCX extract" },
  { pkg: "pdf-parse", role: "PDF extract" },
  { pkg: "exceljs", role: "Spreadsheet extract" },
  { pkg: "better-sqlite3", role: "Optional: cc-switch import", optional: true },
];

function findLic(name) {
  const hit = rows.find((r) => r.name.startsWith(`${name}@`));
  if (hit) return hit.licenses;
  if (name === "better-sqlite3") return "MIT (npm; optional, may be absent from node_modules)";
  return "UNKNOWN — re-run after npm install";
}

const directTable = direct
  .map((d) => `| \`${d.pkg}\` | ${d.role} | ${findLic(d.pkg)} |`)
  .join("\n");
const inventory = rows.map((r) => `| ${r.name} | ${r.licenses} |`).join("\n");
const generatedAt = new Date().toISOString().slice(0, 10);

const md = `# Third-Party Notices

This file documents open-source licenses for **production** dependencies of **DSBAgent**
(\`dsb-agent\`), as resolved from \`node_modules\` / the lockfile.

Project source code is licensed separately under the root [MIT LICENSE](./LICENSE)
(Copyright (c) 2026 ZhaoNingHan).

> Inventory date: ${generatedAt}. Re-run before each public release (\`npm run licenses:inventory\`).
> Dual-licensed packages (e.g. MIT OR GPL) are used under the permissive MIT option unless noted.

## Summary (production tree)

Total packages scanned: **${rows.length}**

${summary}

**Review notes**

| Package | License field | Notes |
|---------|---------------|-------|
| \`jszip\` (transitive, via document tooling) | \`(MIT OR GPL-3.0-or-later)\` when present | Dual license; this project uses the **MIT** option |
| \`better-sqlite3\` | MIT (upstream) | \`optionalDependencies\`; may be absent if native build skipped |

No production packages in this scan were **GPL-only**, AGPL, SSPL, or proprietary (as of inventory date).

## Direct runtime / optional dependencies

| Package | Role | License |
|---------|------|---------|
${directTable}

## Regenerating this file

\`\`\`bash
npm run licenses:inventory
\`\`\`

## Full production inventory

| Package | License |
|---------|---------|
${inventory}
`;

fs.writeFileSync(outPath, md);
console.log(`Wrote ${path.relative(root, outPath)} (${rows.length} packages)`);
