# Task 4 Brief

(来源: .dsb/plans/2026-08-14-platform-tools.md,由控制器提取)

Grep 纯 Node 降级(grepFallback)

**Files:**
- Create: `dsb-agent/src/agent/tools/grepFallback.ts`
- Create: `dsb-agent/tests/grepFallback.test.ts`
- Modify: `dsb-agent/src/agent/tools/executor.ts`(runGrep 在 rg 不可用时降级)

**Interfaces:**
- Consumes: `resolveWorkspacePath`(workspaceFs)、`ToolExecResult`(types)。
- Produces:
  - `export type GrepFallbackOptions = { pattern: string; path?: string; glob?: string; case_insensitive?: boolean; }`
  - `export function grepFallback(root: string, opts: GrepFallbackOptions): ToolExecResult`
  - 输出格式与 rg 一致:`<相对路径>:<行号>: <行文本>`(每行一个),按路径排序;无匹配返回 `(no matches)`。
  - 大小写不敏感:`case_insensitive` 时 pattern 按字面、`toLowerCase()` 对比;否则区分大小写。pattern 视为**字面子串**(rg `--` 语义),不做正则。
  - `glob` 支持 `*`/`**`/`?`,复用 workspaceFs 的 glob 语义(新实现,不依赖 rg)。

- [ ] **Step 1: 新建 `src/agent/tools/grepFallback.ts`**

```ts
import * as fs from "fs";
import * as path from "path";
import type { ToolExecResult } from "./types";
import { resolveWorkspacePath } from "./workspaceFs";

export type GrepFallbackOptions = {
  pattern: string;
  path?: string;
  glob?: string;
  case_insensitive?: boolean;
};

function escapeRegExpChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
        if (pattern[i + 1] === "/") { out += "/?"; i++; }
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

const SKIP_DIRS = new Set(["node_modules", ".git", ".vscode", ".idea", "dist", "out"]);

export function grepFallback(root: string, opts: GrepFallbackOptions): ToolExecResult {
  const base = opts.path ? resolveWorkspacePath(root, opts.path) : root;
  if (!fs.existsSync(base)) return { ok: true, content: `Directory not found: ${opts.path ?? "."}` };
  const needle = opts.pattern;
  const lowerNeedle = needle.toLowerCase();
  const ci = opts.case_insensitive === true;
  const globRe = opts.glob ? globToRegex(opts.glob) : undefined;
  const found: string[] = [];

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(base, full).split(path.sep).join("/");
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full);
        continue;
      }
      if (globRe && !globRe.test(rel)) continue;
      try {
        const lines = fs.readFileSync(full, "utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const hit = ci ? line.toLowerCase().includes(lowerNeedle) : line.includes(needle);
          if (hit) found.push(`${rel}:${i + 1}: ${line}`);
        }
      } catch {
        // 跳过无法读取的文件(权限/二进制)
      }
    }
  };
  walk(base);
  found.sort();
  return { ok: true, content: found.length > 0 ? found.join("\n") : "(no matches)" };
}
```

- [ ] **Step 2: 新建 `tests/grepFallback.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { grepFallback } from "../src/agent/tools/grepFallback";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grepfb-"));
  fs.mkdirSync(path.join(tmp, "sub"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "a.txt"), "hello world\nsecond line\nHello Again\n", "utf8");
  fs.writeFileSync(path.join(tmp, "sub", "b.txt"), "nested hello\n", "utf8");
  fs.writeFileSync(path.join(tmp, "no.txt"), "nothing here\n", "utf8");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("grepFallback", () => {
  it("finds literal substring with file:line: text format", () => {
    const r = grepFallback(tmp, { pattern: "hello" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("a.txt:1: hello world");
    expect(r.content).not.toContain("no.txt");
  });
  it("case_insensitive matches both cases", () => {
    const r = grepFallback(tmp, { pattern: "hello", case_insensitive: true });
    expect(r.content).toContain("a.txt:3: Hello Again");
  });
  it("case sensitive does not match different case", () => {
    const r = grepFallback(tmp, { pattern: "hello" });
    expect(r.content).not.toContain("Hello Again");
  });
  it("glob filters files", () => {
    const r = grepFallback(tmp, { pattern: "hello", glob: "sub/*.txt" });
    expect(r.content).toContain("sub/b.txt:1: nested hello");
    expect(r.content).not.toContain("a.txt");
  });
  it("path restricts search dir", () => {
    const r = grepFallback(tmp, { pattern: "hello", path: "sub" });
    expect(r.content).toContain("sub/b.txt");
    expect(r.content).not.toContain("a.txt");
  });
  it("returns (no matches) when nothing found", () => {
    const r = grepFallback(tmp, { pattern: "zzz" });
    expect(r.content).toBe("(no matches)");
  });
});
```

- [ ] **Step 3: 修改 `executor.ts` 的 `runGrep` 降级**

`runGrep` 中 `if (!rgBinary)` 分支改为:
```ts
const rgBinary = await resolveRgBinary(ctx);
if (!rgBinary) {
  // rg 完全不可用(未安装 @vscode/ripgrep 且 PATH 无 rg):降级为纯 Node 行扫描,保证 Grep 永远可用
  return grepFallback(ctx.workspaceRoot, {
    pattern,
    path: typeof input.path === "string" && input.path ? input.path : undefined,
    glob: typeof input.glob === "string" && input.glob ? input.glob : undefined,
    case_insensitive: input.case_insensitive === true,
  });
}
```
顶部 import 加 `import { grepFallback } from "./grepFallback";`

- [ ] **Step 4: 验证**

```bash
npx vitest run tests/grepFallback.test.ts   # 预期 PASS 6 用例
# 手工验证(有 node 的机器):npm run compile 后启动扩展,在无 rg 的目录调用 Grep 应返回纯 Node 结果而非 ERROR。
```

- [ ] **Step 5: Commit**

```bash
git add dsb-agent/src/agent/tools/grepFallback.ts dsb-agent/tests/grepFallback.test.ts dsb-agent/src/agent/tools/executor.ts
git commit -m "feat(grep): pure-node fallback when rg unavailable"
```

---
