import * as fs from "fs";
import * as path from "path";

/**
 * 纯 Node 降级 Grep:当 ripgrep 二进制不可用时启用(慢但永远可用)。
 * 输出与 rg --line-number --no-heading --color=never 相同格式:file:line: text。
 * 只用于兜底;正常环境仍优先走 ripgrep。
 */

export type GrepFallbackOptions = {
  /** 工作区根目录(所有路径基于它解析)。 */
  root: string;
  /** 搜索起点(相对路径,缺省 ".")。 */
  path?: string;
  /** glob 过滤(如 "*.ts")。 */
  glob?: string;
  /** 大小写不敏感。 */
  caseInsensitive?: boolean;
  /** 跳过目录(始终包含 node_modules/.git)。 */
  skipDirs?: Set<string>;
  /** 最大输出行数,超出截断(避免失控大输出)。 */
  maxMatches?: number;
};

export type GrepFallbackResult = { ok: boolean; content: string };

/** 默认跳过目录:重型/生成目录,避免降级搜索拖垮性能。 */
const DEFAULT_SKIP = new Set(["node_modules", ".git", ".vscode", ".idea", "dist", "out", ".dsb", ".venv", "venv", "__pycache__"]);

function escapeRegExpChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** glob → RegExp:仅支持 * ** ? 与字面量(与 workspaceFs.globToRegex 语义一致)。 */
function globToRegex(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
        if (pattern[i + 1] === "/") {
          out += "/?";
          i++;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegExpChar(ch);
    }
  }
  return new RegExp("^" + out + "$");
}

/** 把 rg pattern 编译为正则:合法正则按正则;非法(纯字面量)按转义字面量。 */
function compilePattern(pattern: string, caseInsensitive: boolean): RegExp {
  try {
    return new RegExp(pattern, caseInsensitive ? "i" : undefined);
  } catch {
    return new RegExp(escapeRegExpChar(pattern), caseInsensitive ? "i" : undefined);
  }
}

/**
 * 降级行级搜索:递归遍历目录,对文本文件做逐行匹配。
 * 输出格式与 rg 一致:`相对路径:行号: 内容`(相对路径统一用 / 分隔)。
 */
export function grepFallback(pattern: string, opts: GrepFallbackOptions): GrepFallbackResult {
  const { root, path: subPath, glob, caseInsensitive, maxMatches = 2000 } = opts;
  const skipDirs = opts.skipDirs ?? DEFAULT_SKIP;
  const base = subPath ? path.resolve(root, subPath) : root;
  if (!fs.existsSync(base)) {
    return { ok: false, content: `Directory not found: ${subPath ?? "."}` };
  }
  const re = compilePattern(pattern, caseInsensitive ?? false);
  const globRe = glob ? globToRegex(glob) : undefined;
  const out: string[] = [];

  const walk = (dir: string): void => {
    if (out.length >= maxMatches) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 无权限目录跳过
    }
    for (const e of entries) {
      if (out.length >= maxMatches) return;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        walk(full);
      } else if (e.isFile()) {
        if (globRe && !globRe.test(rel)) continue;
        if (isBinary(full)) continue;
        try {
          const lines = fs.readFileSync(full, "utf8").split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              out.push(`${rel}:${i + 1}: ${lines[i]}`);
              if (out.length >= maxMatches) return;
            }
          }
        } catch {
          // 读取失败(编码/权限)跳过该文件
        }
      }
    }
  };
  walk(base);
  if (out.length === 0) return { ok: true, content: "(no matches)" };
  return { ok: true, content: out.join("\n") };
}

/** 简单二进制嗅探:含 NUL 字节视为二进制。 */
function isBinary(file: string): boolean {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return n > 0 && buf.subarray(0, n).includes(0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return true; // 打不开按二进制跳过,避免降级卡死
  }
}
