/** 斜杠命令(.dsb/commands 项目/用户/插件):读 frontmatter description + body,触发时 body 作 prompt 发送。 */
import * as fs from "fs";
import * as path from "path";

export interface SlashCommand {
  name: string;
  description: string;
  body: string;
  source: "project" | "user" | "plugin";
}

/** 解析命令 .md:frontmatter(---\nkey: value\n---)取 description,正文为 body。无 frontmatter 时 description 为空。 */
export function parseCommandMd(name: string, raw: string, source: SlashCommand["source"]): SlashCommand {
  raw = raw.replace(/\r\n/g, "\n"); // 归一化 CRLF:frontmatter 正则只认 \n,否则整文件退化为 body
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { name, description: "", body: raw.trim(), source };
  const front = m[1];
  const descMatch = front.match(/^description:\s*(.*)$/m);
  return { name, description: descMatch?.[1]?.trim() ?? "", body: (m[2] ?? "").trim(), source };
}

/** 扫描目录下的 *.md 命令;缺目录/坏文件一律跳过(fail-open)。只读固定子目录,不做 .. 拼接。 */
export function loadCommandDir(dir: string, source: SlashCommand["source"]): SlashCommand[] {
  if (!fs.existsSync(dir)) return [];
  const out: SlashCommand[] = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const name = f.slice(0, -3);
        out.push(parseCommandMd(name, fs.readFileSync(path.join(dir, f), "utf8"), source));
      } catch {
        // 单文件损坏跳过
      }
    }
  } catch {
    return out; // 目录不可读/是文件:fail-open
  }
  return out;
}

export class SlashCommandIndex {
  private readonly commands = new Map<string, SlashCommand>();

  add(cmd: SlashCommand): void {
    this.commands.set(cmd.name, cmd);
  }

  listForPrompt(): Array<{ name: string; description: string }> {
    return [...this.commands.values()].map((c) => ({ name: c.name, description: c.description }));
  }

  invokeCommand(name: string): { ok: true; content: string } | { ok: false; content: string } {
    const cmd = this.commands.get(name);
    if (!cmd) return { ok: false, content: `未知命令: ${name}` };
    return { ok: true, content: cmd.body };
  }
}
