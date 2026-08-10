import * as fs from "fs";
import * as path from "path";

export function resolveWorkspacePath(root: string, rel: string): string {
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes workspace: ${rel}`);
  }
  if (fs.existsSync(resolved)) {
    const real = fs.realpathSync(resolved);
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new Error(`Path escapes workspace via symlink: ${rel}`);
    }
  }
  return resolved;
}

function escapeRegExpChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** 跨目录匹配;若紧跟 /,让该 / 可选,使 **/*.txt 也匹配根级文件
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

export function readWorkspaceFile(root: string, rel: string, opts?: { offset?: number; limit?: number }): string {
  const full = resolveWorkspacePath(root, rel);
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    throw new Error(`File not found: ${rel}`);
  }
  const all = fs.readFileSync(full, "utf8");
  const lines = all.split("\n");
  const start = Math.max(0, (opts?.offset ?? 1) - 1);
  const end = opts?.limit !== undefined ? start + opts.limit : lines.length;
  return lines.slice(start, Math.min(end, lines.length)).join("\n");
}

export function writeWorkspaceFile(root: string, rel: string, contents: string): void {
  const full = resolveWorkspacePath(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents, "utf8");
}

export function strReplaceWorkspaceFile(root: string, rel: string, oldString: string, newString: string, replaceAll: boolean): { replacements: number } {
  const full = resolveWorkspacePath(root, rel);
  const text = fs.readFileSync(full, "utf8");
  if (oldString === "") throw new Error("old_string must be non-empty");
  if (!text.includes(oldString)) throw new Error(`old_string not found in ${rel}`);
  const updated = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString);
  fs.writeFileSync(full, updated, "utf8");
  return { replacements: replaceAll ? text.split(oldString).length - 1 : 1 };
}

export function deleteWorkspaceFile(root: string, rel: string): void {
  const full = resolveWorkspacePath(root, rel);
  if (fs.existsSync(full)) fs.rmSync(full, { recursive: true });
}

export function globWorkspace(root: string, pattern: string, subdir?: string): string {
  const base = subdir ? resolveWorkspacePath(root, subdir) : root;
  if (!fs.existsSync(base)) return "";
  const found: string[] = [];
  const matcher = globToRegex(pattern);
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.relative(base, path.join(dir, entry.name));
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
      } else if (matcher.test(rel)) {
        found.push(rel);
      }
    }
  };
  walk(base);
  found.sort();
  return found.join("\n");
}

/** `@` 建议的文件枚举:递归列相对路径,跳过常见重型/生成目录,按 query 包含过滤,上限 max。 */
export function suggestWorkspaceFiles(root: string, query: string, max = 40): string[] {
  const skipDirs = new Set(["node_modules", ".git", ".vscode", ".idea", "dist", "out", ".dsb"]);
  const q = query.trim().toLowerCase();
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (found.length >= max) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= max) return;
      const rel = path.relative(root, path.join(dir, e.name)).replace(/\\/g, "/");
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        walk(path.join(dir, e.name));
      } else if (!q || rel.toLowerCase().includes(q)) {
        found.push(rel);
      }
    }
  };
  walk(root);
  return found;
}

export function listWorkspaceDir(root: string, rel: string): string {
  const full = resolveWorkspacePath(root, rel);
  if (!fs.existsSync(full)) throw new Error(`Directory not found: ${rel}`);
  return fs
    .readdirSync(full, { withFileTypes: true })
    .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
    .join("\n");
}
