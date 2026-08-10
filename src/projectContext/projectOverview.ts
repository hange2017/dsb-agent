import * as fs from "fs";
import * as path from "path";

/**
 * 项目整体框架 / 模块功能文档。
 *
 * 首次进入项目(无 `.dsb`)时,除脚手架外自动生成 `.dsb/docs/project-overview.md`:
 * 扫描技术栈、入口、目录结构、源码模块骨架,给 agent 提供「项目框架信息」;
 * 各模块的具体职责由用户在后续会话中逐步补充(文档顶部有说明)。
 * 幂等:项目已有框架类文档(自身生成物 / docs 下 architecture/overview 等)则跳过。
 */

const kOverviewRel = path.join(".dsb", "docs", "project-overview.md");
const kSkipDirs = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "coverage", ".dsb",
  ".venv", "venv", ".next", ".cache", "out", "target", ".turbo", ".yarn", "vendor",
]);
/** 常见源码根:扫描其顶层子目录作为模块骨架。 */
const kSourceDirs = new Set([
  "src", "lib", "packages", "apps", "services", "server", "client", "web", "app",
  "backend", "frontend", "core", "engine", "components", "api", "modules",
]);
/** 视为「已有框架文档」的文件名特征。 */
const kFrameworkDocRe = /(architecture|framework|overview|structure|module|架构|框架|模块|结构|总览)/i;

export type EnsureProjectOverviewResult =
  | { wrote: true }
  | { wrote: false; skipped: "exists" | "has-docs" | "error" };

/** 项目是否已有「整体框架 / 模块功能」类文档(自身生成物或 docs 下架构文档,递归 2 层)。 */
export function hasProjectFrameworkDocs(workspaceRoot: string): boolean {
  if (fs.existsSync(path.join(workspaceRoot, kOverviewRel))) return true;
  for (const base of [path.join(workspaceRoot, ".dsb", "docs"), path.join(workspaceRoot, "docs")]) {
    if (scanFrameworkDocs(base, 2)) return true;
  }
  return false;
}

function scanFrameworkDocs(base: string, depth: number): boolean {
  if (depth < 0) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".md") && kFrameworkDocRe.test(e.name)) return true;
    if (e.isDirectory() && scanFrameworkDocs(path.join(base, e.name), depth - 1)) return true;
  }
  return false;
}

/** 项目无框架文档时补充生成;已存在/已有文档则跳过(幂等)。失败 fail-open。 */
export function ensureProjectOverview(workspaceRoot: string): EnsureProjectOverviewResult {
  if (fs.existsSync(path.join(workspaceRoot, kOverviewRel))) return { wrote: false, skipped: "exists" };
  if (hasProjectFrameworkDocs(workspaceRoot)) return { wrote: false, skipped: "has-docs" };
  try {
    fs.mkdirSync(path.join(workspaceRoot, ".dsb", "docs"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, kOverviewRel), buildProjectOverview(workspaceRoot), "utf8");
    return { wrote: true };
  } catch {
    return { wrote: false, skipped: "error" };
  }
}

/** 读取项目框架文档全文(不存在返回空串)。 */
export function readProjectOverview(workspaceRoot: string): string {
  try {
    return fs.readFileSync(path.join(workspaceRoot, kOverviewRel), "utf8");
  } catch {
    return "";
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDir(root: string): fs.Dirent[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readJson(p: string): Record<string, unknown> | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function readTextFirstLines(p: string, max: number): string {
  try {
    return fs.readFileSync(p, "utf8").split("\n").slice(0, max).join("\n").trim();
  } catch {
    return "";
  }
}

function packageList(deps: unknown, max = 40): string[] {
  if (typeof deps !== "object" || deps === null) return [];
  return Object.keys(deps as Record<string, unknown>).slice(0, max);
}

/** 生成项目框架文档(纯启发式:只列事实,不推断模块职责)。 */
export function buildProjectOverview(workspaceRoot: string): string {
  const lines: string[] = [];
  lines.push("# 项目框架与模块总览", "");
  lines.push(
    "> 本文件由 DSBAgent 首次进入项目时自动生成(可手动编辑)。它描述项目的整体框架与模块骨架," +
      "供后续会话直接参考;各模块的**具体职责**可在工作中逐步补充(标题下按模块追加说明)。",
  );

  // ---- 项目简介 ----
  const readme = firstReadme(workspaceRoot);
  const intro = readTextFirstLines(readme, 8);
  if (intro) {
    lines.push("## 项目简介", "", intro, "");
  }

  // ---- 技术栈 ----
  const pkg = readJson(path.join(workspaceRoot, "package.json"));
  if (pkg) {
    lines.push("## 技术栈", "");
    if (typeof pkg.name === "string" && pkg.name) lines.push(`- 包名: \`${pkg.name}\``);
    if (typeof pkg.version === "string" && pkg.version) lines.push(`- 版本: \`${pkg.version}\``);
    if (typeof pkg.engines === "object" && pkg.engines) {
      lines.push(`- 引擎: \`${JSON.stringify(pkg.engines)}\``);
    }
    const runtimeDeps = packageList(pkg.dependencies);
    if (runtimeDeps.length) lines.push(`- 运行时依赖: \`${runtimeDeps.join("`, `")}\``);
    const devDeps = packageList(pkg.devDependencies);
    if (devDeps.length) lines.push(`- 开发依赖: \`${devDeps.join("`, `")}\``);
    lines.push("");
  }
  if (fs.existsSync(path.join(workspaceRoot, "pyproject.toml"))) lines.push("## 技术栈\n- Python 项目(pyproject.toml)\n");
  if (fs.existsSync(path.join(workspaceRoot, "go.mod"))) lines.push("## 技术栈\n- Go 项目(go.mod)\n");
  if (fs.existsSync(path.join(workspaceRoot, "Cargo.toml"))) lines.push("## 技术栈\n- Rust 项目(Cargo.toml)\n");

  // ---- 入口与构建 ----
  const entryLines: string[] = [];
  if (pkg && typeof pkg.main === "string") entryLines.push(`- package.json main: \`${pkg.main}\``);
  if (pkg && typeof pkg.bin === "string") entryLines.push(`- bin: \`${pkg.bin}\``);
  for (const f of ["src/index.ts", "src/main.ts", "src/index.js", "src/main.js", "index.ts", "index.js", "main.ts", "main.py", "manage.py", "app.py", "main.go"]) {
    if (fs.existsSync(path.join(workspaceRoot, f))) entryLines.push(`- 入口文件: \`${f}\``);
  }
  if (entryLines.length) {
    lines.push("## 入口与构建", "", ...entryLines, "");
  }

  // ---- 目录结构(1 层) ----
  lines.push("## 目录结构", "", "```text", formatTree(workspaceRoot), "```", "");

  // ---- 源码模块骨架 ----
  lines.push("## 源码模块", "");
  lines.push("> 模块职责待补充:工作时在对应标题下追加说明,保持这份文档最新。", "");
  for (const srcDir of kSourceDirs) {
    const abs = path.join(workspaceRoot, srcDir);
    if (!isDir(abs)) continue;
    lines.push(`### ${srcDir}/`);
    const subs = listDir(abs)
      .filter((e) => e.isDirectory() && !kSkipDirs.has(e.name))
      .map((e) => e.name)
      .sort();
    const files = listDir(abs).filter((e) => e.isFile()).map((e) => e.name).sort();
    if (subs.length) lines.push(`- 子模块: \`${subs.join("`, `")}\``);
    if (files.length) lines.push(`- 顶层文件: \`${files.join("`, `")}\``);
    if (!subs.length && !files.length) lines.push("- (空目录)");
    lines.push("");
  }

  // ---- 现有文档索引 ----
  lines.push("## 文档索引", "");
  const docFiles = collectDocs(workspaceRoot);
  if (docFiles.length) {
    for (const d of docFiles) lines.push(`- \`${d}\``);
  } else {
    lines.push("_暂无其它文档(README 除外)_");
  }
  lines.push("", "---", "> 维护提示:首次生成后,agent 会在工作时参考本文件;模块职责补充请保持 ≤ 3 层标题、一模块一段。");

  return lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

function firstReadme(workspaceRoot: string): string {
  for (const name of ["README.md", "readme.md", "README", "README.rst"]) {
    const p = path.join(workspaceRoot, name);
    if (fs.existsSync(p)) return p;
  }
  return "";
}

function formatTree(workspaceRoot: string): string {
  const out: string[] = ["./"];
  for (const e of listDir(workspaceRoot).sort((a, b) => a.name.localeCompare(b.name))) {
    if (kSkipDirs.has(e.name) || e.name.startsWith(".")) continue;
    if (e.isDirectory()) {
      out.push(`├── ${e.name}/`);
      const subs = listDir(path.join(workspaceRoot, e.name))
        .filter((s) => s.isDirectory() && !kSkipDirs.has(s.name) && !s.name.startsWith("."))
        .map((s) => s.name)
        .sort();
      for (let i = 0; i < Math.min(subs.length, 12); i++) {
        const last = i === Math.min(subs.length, 12) - 1;
        out.push(`${last ? "│   └──" : "│   ├──"} ${subs[i]}/`);
      }
      if (subs.length > 12) out.push(`│   └── …(${subs.length - 12} more)`);
    } else {
      out.push(`├── ${e.name}`);
    }
  }
  return out.join("\n");
}

function collectDocs(workspaceRoot: string): string[] {
  const found: string[] = [];
  for (const base of ["docs", ".dsb/docs"]) {
    const abs = path.join(workspaceRoot, base);
    if (!isDir(abs)) continue;
    for (const e of listDir(abs)) {
      if (e.isFile() && e.name.endsWith(".md")) found.push(`${base}/${e.name}`);
    }
  }
  found.sort();
  return found;
}
