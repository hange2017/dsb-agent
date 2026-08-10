import * as fs from "fs";
import * as path from "path";
import { firstExistingDir, projectSkillDirCandidates, userSkillDirCandidates } from "./convention";

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  source: "project" | "user" | "extension" | "plugin";
}

/** 解析 SKILL.md frontmatter 的 description 字段(单行 / 引号包裹 / 多行块)。 */
export function parseSkillDescription(raw: string): string {
  const lines = raw.split("\n");
  const idx = lines.findIndex((l) => /^description:\s*/.test(l));
  if (idx < 0) return "";
  const first = lines[idx].replace(/^description:\s*/, "").trim();
  const stripQuotes = (s: string): string => s.replace(/^["']|["']$/g, "").trim();
  if (first && !["|", ">", "|-", ">-"].includes(first)) {
    return stripQuotes(first);
  }
  // 折叠/字面块或引号延续:收集后续缩进行
  const collected: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s{2,}(.*)$/);
    if (!m) break;
    collected.push(m[1].trim());
  }
  return stripQuotes(collected.join(" "));
}

export function scanSkillDir(dir: string, source: SkillInfo["source"]): SkillInfo[] {
  if (!fs.existsSync(dir)) return [];
  const out: SkillInfo[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    const raw = fs.readFileSync(skillFile, "utf8");
    out.push({ name: entry.name, description: parseSkillDescription(raw), path: path.join(dir, entry.name), source });
  }
  return out;
}

export function scanSkills(workspaceRoot: string): SkillInfo[] {
  // 约定根:.dsb/skills 优先,旧 .claude/skills 回退;只取首个存在的目录,不混读两套根
  const projectDir = firstExistingDir(projectSkillDirCandidates(workspaceRoot));
  const userDir = firstExistingDir(userSkillDirCandidates());
  const project = projectDir ? scanSkillDir(projectDir, "project") : [];
  const user = userDir ? scanSkillDir(userDir, "user") : [];
  return [...project, ...user];
}

/** VSCode 扩展层:扫描每个扩展的 skills/.claude/skills/.claude-plugin/skills 三个候选目录。 */
export function scanVscodeExtensionSkills(extensions: ReadonlyArray<{ extensionPath: string }>): SkillInfo[] {
  const out: SkillInfo[] = [];
  for (const ext of extensions) {
    for (const sub of ["skills", ".claude/skills", ".claude-plugin/skills"]) {
      out.push(...scanSkillDir(path.join(ext.extensionPath, sub), "extension"));
    }
  }
  return out;
}

/**
 * 插件层:扫描插件缓存目录 `plugins/<market>/<plugin>/skills`。
 * 与 pluginContents() 同策略(fail-open):plugins 根或任意条目是文件(ENOTDIR)/不可读时
 * 一律跳过、绝不 throw——否则坏缓存条目会让每次会话创建的 loadProjectContext / skillList 抛错,
 * 进而变成未处理 rejection 导致 webview 卡在"等待模型…"。
 */
export function scanPluginSkills(pluginCacheDir: string): SkillInfo[] {
  const out: SkillInfo[] = [];
  const pluginsDir = path.join(pluginCacheDir, "plugins");
  let markets: string[];
  try {
    if (!fs.statSync(pluginsDir).isDirectory()) return out;
    markets = fs.readdirSync(pluginsDir);
  } catch {
    return out; // 插件缓存目录缺失/不可读/是文件,不阻断技能装配
  }
  for (const market of markets) {
    const marketDir = path.join(pluginsDir, market);
    let plugins: string[];
    try {
      if (!fs.statSync(marketDir).isDirectory()) continue; // 非目录条目跳过
      plugins = fs.readdirSync(marketDir);
    } catch {
      continue; // 单个市场目录不可读,跳过
    }
    for (const plugin of plugins) {
      const pluginDir = path.join(marketDir, plugin);
      try {
        if (!fs.statSync(pluginDir).isDirectory()) continue; // 非目录插件跳过
        // 技能名带 `<plugin>:` 前缀:`/su` 可命中 superpowers:* 全部技能,
        // `/an` 命中 anthropics 官方目录插件,等等;也避免多市场同名技能冲突。
        for (const s of scanSkillDir(path.join(pluginDir, "skills"), "plugin")) {
          out.push({ ...s, name: `${plugin}:${s.name}` });
        }
      } catch {
        // 单个插件扫描失败不阻断整体
      }
    }
  }
  return out;
}
