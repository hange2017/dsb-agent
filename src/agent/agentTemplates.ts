import * as fs from "fs";
import * as path from "path";

/** 子代理模板(.dsb/agents 项目/用户/插件):Agent 工具 `agent` 参数按名解析,模板 system 作为子代理角色。 */
export interface AgentTemplate {
  name: string;
  description: string;
  /** 允许的工具子集(本期仅元数据;子代理仍用全量工具)。 */
  tools?: string[];
  system: string;
}

export function parseAgentMd(name: string, raw: string): AgentTemplate {
  raw = raw.replace(/\r\n/g, "\n"); // 归一化 CRLF:frontmatter 正则只认 \n,否则整文件退化为 system
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { name, description: "", system: raw.trim() };
  const front = m[1];
  const descMatch = front.match(/^description:\s*(.*)$/m);
  const toolsMatch = front.match(/^tools:\s*(.*)$/m);
  const tools = toolsMatch?.[1]?.split(/[\s,]+/).filter(Boolean) ?? undefined;
  return { name, description: descMatch?.[1]?.trim() ?? "", tools, system: (m[2] ?? "").trim() };
}

/** 扫描目录下的 *.md 代理模板;缺目录/坏文件一律跳过(fail-open)。只读固定子目录,不做 .. 拼接。 */
export function loadAgentDir(dir: string): AgentTemplate[] {
  if (!fs.existsSync(dir)) return [];
  const out: AgentTemplate[] = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        out.push(parseAgentMd(f.slice(0, -3), fs.readFileSync(path.join(dir, f), "utf8")));
      } catch {
        // 单文件损坏跳过
      }
    }
  } catch {
    return out; // 目录不可读/是文件:fail-open
  }
  return out;
}

/** 项目(.dsb/agents,回退 .claude/agents)+ 用户(~/.dsb/agents)+ 插件(.agents/)。 */
export function loadAgentTemplates(workspaceRoot: string, userHome: string, pluginDirs: string[]): AgentTemplate[] {
  const project = loadAgentDir(path.join(workspaceRoot, ".dsb", "agents"));
  const projectLegacy = project.length ? [] : loadAgentDir(path.join(workspaceRoot, ".claude", "agents"));
  const user = loadAgentDir(path.join(userHome, ".dsb", "agents"));
  const userLegacy = user.length ? [] : loadAgentDir(path.join(userHome, ".claude", "agents"));
  const plugin: AgentTemplate[] = [];
  for (const dir of pluginDirs) plugin.push(...loadAgentDir(path.join(dir, ".agents")));
  return [...project, ...projectLegacy, ...user, ...userLegacy, ...plugin];
}
