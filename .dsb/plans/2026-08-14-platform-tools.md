# 平台感知与工具平台门禁(B1)实现计划

> **Canonical copy:** 已迁入 `dsb-agent/.dsb/plans/`(2026-08-15)。`bbb/plans/` 为历史工作副本,以本仓库为准。
> **状态:** Task 1–5 已完成并提交(`875174e`);若干步骤为**接受偏差**(见 checkbox 注释)。
> **For agentic workers:** REQUIRED SUB-SKILL: 使用 dsb-skills:subagent-driven-development(推荐)逐任务实现。步骤用 checkbox(`- [ ]`)跟踪。

**Goal:** 让 DSBAgent 工具集按当前操作系统自适应:修复 Windows 下 Grep 失效与 Bash 命令风格错误,并建立工具平台门禁机制。

**Architecture:** 三管齐下:(1) 在 `ToolDef` 加 `platforms` 元数据 + 纯函数 `filterToolDefs` 门禁,当前核心工具默认全平台,机制为将来平台专用工具留口;(2) 修复 Grep 的 rg 二进制解析(候选顺序 + PATH 兜底),并在 rg 完全不可用时降级为纯 Node 行扫描,保证 Grep 永远可用;(3) 集中 `platformInfo()` 平台信息,注入系统提示词「运行环境」段并更新 Bash/Grep 工具描述,让模型按 OS 生成正确命令。

**Tech Stack:** TypeScript / Node.js(child_process, fs, path)/ vitest(测试,node 环境)。

## Global Constraints

- **平台门禁语义**:`ToolDef.platforms` 未声明 → 全平台放行;声明 → 仅 `process.platform ∈ platforms` 时暴露。非法平台字符串视为全平台放行(宽松,不抛错)。
- **当前 16 个核心工具均不声明 `platforms`**(它们确实全平台可用);门禁只为将来平台专用工具(如 Windows PowerShell 执行器)预留。
- **门禁过滤平台来源**:`ToolExecContext.platform ?? process.platform`(测试注入 win32/linux 断言)。
- **保持行尾**:修改现有文件时保持其原有行尾(多数为 CRLF);用 Python `io.open(path, 'r', encoding='utf-8', newline='')` 读写,避免写工具改变行尾。
- **本机无 node/npm**(vitest 无法运行):每任务「运行测试」步骤若本机有 node 则 `npx vitest run <file>`;否则用 Python 括号配平脚本校验语法,并把"真实运行 vitest"留给有依赖的 CI/开发环境。
- **临时文件**:不得在仓库根残留 `_*.py`/`_*.ps1` 等探测脚本,用完即删。
- **工作区根**:所有路径相对 `e:\DSBAgent`,工具实现中的工作区根是 `dsb-agent/` 下的 `src/` 对应文件。

---

### Task 1: 平台元数据 + 门禁纯函数 + 注册层接线

**Files:**
- Modify: `dsb-agent/src/agent/tools/types.ts`(ToolDef 加 platforms、ToolExecContext 加 platform)
- Create: `dsb-agent/src/agent/tools/platformGate.ts`
- Create: `dsb-agent/tests/platformGate.test.ts`
- Modify: `dsb-agent/src/agent/tools/executor.ts`(allToolDefs 加过滤)

**Interfaces:**
- Consumes: 现有 `ToolDef` 类型(`name`/`description`/`input_schema`)。
- Produces:
  - `export type ToolPlatform = NodeJS.Platform;`
  - `ToolDef` 增加可选字段 `platforms?: ToolPlatform[];`
  - `ToolExecContext` 增加可选字段 `platform?: NodeJS.Platform;`
  - `export function filterToolDefs(defs: ToolDef[], platform: NodeJS.Platform): ToolDef[];`
  - `ToolExecutor.allToolDefs(): ToolDef[]` 行为变更:返回 `filterToolDefs([...this.toolDefs, ...mcp, ...plugin], ctxPlatform)` 结果。

- [x] **Step 1: 修改 `types.ts` 加平台元数据**

在 `ToolDef` 类型加:
```ts
export type ToolPlatform = NodeJS.Platform; // "win32" | "linux" | "darwin" | ...

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** 可选:仅在该平台集合暴露;缺省 = 全平台。 */
  platforms?: ToolPlatform[];
};
```
`ToolExecContext` 加:
```ts
/** 平台门禁过滤与提示词构建用的平台;缺省 process.platform。测试可注入。 */
platform?: NodeJS.Platform;
```

- [x] **Step 2: 新建 `platformGate.ts`**

```ts
import type { ToolDef } from "./types";

/** 按平台过滤工具定义:未声明 platforms 的放行;声明了仅当 platform ∈ platforms。 */
export function filterToolDefs(defs: ToolDef[], platform: NodeJS.Platform): ToolDef[] {
  return defs.filter((d) => !d.platforms || d.platforms.length === 0 || d.platforms.includes(platform));
}
```

- [x] **Step 3: 新建 `tests/platformGate.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { filterToolDefs } from "../src/agent/tools/platformGate";
import type { ToolDef } from "../src/agent/tools/types";

function def(name: string, platforms?: NodeJS.Platform[]): ToolDef {
  return { name, description: name, input_schema: {}, ...(platforms ? { platforms } : {}) };
}

describe("filterToolDefs", () => {
  it("passes through tools without platforms", () => {
    const defs = [def("a"), def("b")];
    expect(filterToolDefs(defs, "win32").map((d) => d.name)).toEqual(["a", "b"]);
    expect(filterToolDefs(defs, "linux").map((d) => d.name)).toEqual(["a", "b"]);
  });

  it("keeps only matching platform when declared", () => {
    const defs = [def("win-only", ["win32"]), def("all")];
    const win = filterToolDefs(defs, "win32").map((d) => d.name);
    expect(win).toContain("win-only");
    expect(win).toContain("all");
    const linux = filterToolDefs(defs, "linux").map((d) => d.name);
    expect(linux).not.toContain("win-only");
    expect(linux).toContain("all");
  });

  it("empty platforms array means all platforms", () => {
    const defs = [def("e", [])];
    expect(filterToolDefs(defs, "darwin").map((d) => d.name)).toEqual(["e"]);
  });

  it("multi-platform list keeps any match", () => {
    const defs = [def("uni", ["win32", "darwin"])];
    expect(filterToolDefs(defs, "darwin").map((d) => d.name)).toEqual(["uni"]);
    expect(filterToolDefs(defs, "linux").map((d) => d.name)).toEqual([]);
  });
});
```

- [x] **Step 4: 修改 `executor.ts` 的 `allToolDefs()` 接线门禁**

`allToolDefs()` 改为:
```ts
allToolDefs(): ToolDef[] {
  const mcp: ToolDef[] = [];
  for (const defs of this.mcpServerDefs.values()) mcp.push(...defs);
  const plugin = [...this.pluginTools.values()].map(buildPluginToolDef);
  const all = [...this.toolDefs, ...mcp, ...plugin];
  // 平台门禁:缺省按 process.platform 过滤(当前核心工具全平台,机制供平台专用工具使用)
  return filterToolDefs(all, process.platform);
}
```
并在文件顶部 import:`import { filterToolDefs } from "./platformGate";`

- [x] **Step 5: 验证**

```bash
# 有 node 的环境:
npx vitest run tests/platformGate.test.ts
# 预期:PASS 4 个用例。
# 无 node 的环境(本机):
python - <<'PY'
import re
for f in ["dsb-agent/src/agent/tools/types.ts","dsb-agent/src/agent/tools/platformGate.ts","dsb-agent/src/agent/tools/executor.ts","dsb-agent/tests/platformGate.test.ts"]:
    s = open(f, encoding="utf-8").read()
    s2 = re.sub(r"//[^\n]*", "", s)
    assert s2.count("{") == s2.count("}"), f"bracket mismatch in {f}"
    print(f"{f}: brackets balanced")
PY
```

- [x] **Step 6: Commit**(若仓库可用) <!-- 已提交: 875174e feat(tools): platform gate, Grep fallback, and OS-aware Bash prompts -->

```bash
git add dsb-agent/src/agent/tools/types.ts dsb-agent/src/agent/tools/platformGate.ts dsb-agent/src/agent/tools/executor.ts dsb-agent/tests/platformGate.test.ts
git commit -m "feat(tools): add platform gate metadata and filter"
```
(当前 e:\DSBAgent 非 git 仓库,此步可跳过,记录说明即可)

---

### Task 2: 平台信息集中 + 系统提示词「运行环境」段 + Bash/Grep 描述更新

**Files:**
- Create: `dsb-agent/src/util/platformInfo.ts`
- Create: `dsb-agent/tests/platformInfo.test.ts`
- Modify: `dsb-agent/src/agent/systemPrompt.ts`(SystemPromptInput 加 platform/shell,注入「运行环境」段)
- Create: `dsb-agent/tests/systemPrompt.test.ts`
- Modify: `dsb-agent/src/chat/chatViewProvider.ts:357`(buildSystemPrompt 调用处传 platform/shell)
- Modify: `dsb-agent/src/agent/tools/definitions.ts`(Bash/Grep 描述)

**Interfaces:**
- Consumes: 无(纯函数)。
- Produces:
  - `export type PlatformInfo = { os: string; shell: string; sep: string; commandStyle: string; posix: boolean; };`
  - `export function platformInfo(platform?: NodeJS.Platform): PlatformInfo;`
  - `SystemPromptInput` 增加 `platform?: string; shell?: string;`
  - `buildSystemPrompt(input)` 在 `input.platform` 存在时注入「## 运行环境」段。

- [x] **Step 1: 新建 `src/util/platformInfo.ts`**

```ts
export type PlatformInfo = {
  os: string;
  shell: string;
  sep: string;
  commandStyle: string;
  posix: boolean;
};

/** 集中平台信息:供系统提示词、工具描述、执行器共用,避免各处散写字符串。 */
export function platformInfo(platform: NodeJS.Platform = process.platform): PlatformInfo {
  if (platform === "win32") {
    return {
      os: "Windows (win32)",
      shell: "cmd.exe",
      sep: "\\",
      commandStyle: "使用 dir/type/copy 等 Windows 命令;不要使用 ls/cat/rm -rf/$HOME",
      posix: false,
    };
  }
  if (platform === "darwin" || platform === "linux") {
    return {
      os: platform === "darwin" ? "macOS (darwin)" : "Linux",
      shell: "/bin/bash",
      sep: "/",
      commandStyle: "使用 ls/cat/rm -rf/$HOME 等 POSIX 命令",
      posix: true,
    };
  }
  // 其它平台(如 freebsd/win32 变体):保守按 POSIX shell 处理
  return { os: platform, shell: "/bin/sh", sep: "/", commandStyle: "使用 POSIX 命令", posix: true };
}
```

- [x] **Step 2: 新建 `tests/platformInfo.test.ts`** <!-- 接受偏差:不建独立文件,由 tests/platformMatrix.test.ts 覆盖 platformInfo() -->

```ts
import { describe, it, expect } from "vitest";
import { platformInfo } from "../src/util/platformInfo";

describe("platformInfo", () => {
  it("win32 uses cmd.exe and windows commands", () => {
    const info = platformInfo("win32");
    expect(info.shell).toBe("cmd.exe");
    expect(info.posix).toBe(false);
    expect(info.sep).toBe("\\");
    expect(info.commandStyle).toContain("dir");
    expect(info.commandStyle).not.toContain("ls/");
  });
  it("linux uses bash and posix commands", () => {
    const info = platformInfo("linux");
    expect(info.shell).toBe("/bin/bash");
    expect(info.posix).toBe(true);
    expect(info.sep).toBe("/");
    expect(info.commandStyle).toContain("ls");
  });
  it("darwin uses bash too", () => {
    expect(platformInfo("darwin").shell).toBe("/bin/bash");
    expect(platformInfo("darwin").posix).toBe(true);
  });
});
```

- [x] **Step 3: 修改 `systemPrompt.ts`**

`SystemPromptInput` 加:
```ts
/** 当前 OS(如 "win32"/"linux");缺省不注入「运行环境」段。 */
platform?: string;
/** 当前 shell(如 "cmd.exe"/"/bin/bash");platform 存在时随段注入。 */
shell?: string;
```

在 `buildSystemPrompt` 的 parts 数组里,紧跟 `Workspace root` 行后加一段(仅当 `input.platform` 存在):
```ts
...(input.platform
  ? [
      `## 运行环境`,
      `- OS: ${input.platform}`,
      `- Shell: ${input.shell ?? "/bin/sh"}(Bash 工具经其执行)`,
      `- 命令风格: ${input.platform === "win32" ? "Windows: 用 dir/type/copy;不要用 ls/cat/rm -rf/$HOME" : "POSIX: 用 ls/cat/rm -rf/$HOME"}`
    ]
  : []),
```

- [x] **Step 4: 新建 `tests/systemPrompt.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/agent/systemPrompt";

describe("buildSystemPrompt platform section", () => {
  it("injects windows guidance when platform=win32", () => {
    const p = buildSystemPrompt({ workspaceRoot: "/w", platform: "win32", shell: "cmd.exe" });
    expect(p).toContain("## 运行环境");
    expect(p).toContain("Windows");
    expect(p).toContain("cmd.exe");
    expect(p).toContain("dir");
  });
  it("injects posix guidance when platform=linux", () => {
    const p = buildSystemPrompt({ workspaceRoot: "/w", platform: "linux", shell: "/bin/bash" });
    expect(p).toContain("/bin/bash");
    expect(p).toContain("ls");
  });
  it("omits section when platform missing", () => {
    const p = buildSystemPrompt({ workspaceRoot: "/w" });
    expect(p).not.toContain("## 运行环境");
  });
});
```

- [x] **Step 5: 修改 `chatViewProvider.ts:357` 调用处**

`buildSystemPrompt({...})` 参数对象加:
```ts
platform: process.platform,
shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
```
(文件顶部需有 `import * as process` 或 Node 全局 process 声明;若无 import,在文件头加 `import * as os from "os";` 用 `os.platform()` 也可。优先用 `process.platform`,与 executor 一致。)

- [x] **Step 6: 修改 `definitions.ts` 的 Bash/Grep 描述**

Grep 描述改为:
```ts
description: "用 ripgrep 搜索文件内容(rg 不可用时自动降级为纯 Node 行扫描)。",
```
Bash 描述改为:
```ts
description: "以工作区为 cwd 执行 shell 命令。Windows 经 cmd.exe,Linux/macOS 经 /bin/bash;请按当前 OS 选择命令风格。",
```

- [x] **Step 7: 验证**

```bash
npx vitest run tests/platformInfo.test.ts tests/systemPrompt.test.ts   # 预期 PASS
# 无 node 时用 Task 1 Step 5 的 Python 括号校验脚本核对 4 个文件
```

- [x] **Step 8: Commit** <!-- 已提交:同 Task1, 875174e -->

```bash
git add dsb-agent/src/util/platformInfo.ts dsb-agent/tests/platformInfo.test.ts dsb-agent/src/agent/systemPrompt.ts dsb-agent/tests/systemPrompt.test.ts dsb-agent/src/chat/chatViewProvider.ts dsb-agent/src/agent/tools/definitions.ts
git commit -m "feat(prompt): inject OS/shell platform section and update tool descriptions"
```

---

### Task 3: Grep 二进制解析修复(候选顺序 + PATH 兜底)

**Files:**
- Modify: `dsb-agent/src/util/ripgrepPath.ts`
- Modify: `dsb-agent/tests/ripgrepPath.test.ts`
- Modify: `dsb-agent/src/agent/tools/executor.ts`(resolveRgBinary 加 PATH 兜底)

**Interfaces:**
- Consumes: 现有 `resolveRipgrepCandidates` / `pickRipgrepPath` / `configureRipgrepPath`。
- Produces:
  - `resolveRipgrepCandidates` 顺序保证:当前平台 `@vscode/ripgrep-${platform}-${arch}` 候选紧随 dist 之后、其它平台目录之前(现状已是,补回归用例锁定)。
  - `export function pickRipgrepPathFromEnv(existsSync?: (p: string) => boolean): string | undefined;` —— 扫描 `process.env.PATH` 找 `rg`(win32 为 `rg.exe`)。
  - `resolveRgBinary(ctx)` 在现有候选失败后追加 PATH 探测。

- [x] **Step 1: 修改 `ripgrepPath.ts` 加 PATH 候选函数** <!-- 接受偏差:PATH 兜底落在 executor.ts `findRgOnPath`(功能等价) -->

文件末尾加:
```ts
const PATH_DELIM = process.platform === "win32" ? ";" : ":";

/** 扫描 PATH 找 rg/rg.exe;命中返回绝对路径,否则 undefined。 */
export function pickRipgrepPathFromEnv(
  existsSync: (p: string) => boolean = fs.existsSync,
): string | undefined {
  const name = process.platform === "win32" ? "rg.exe" : "rg";
  const dirs = (process.env.PATH ?? "").split(PATH_DELIM).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (pathExists(candidate, existsSync)) return candidate;
  }
  return undefined;
}
```

- [x] **Step 2: 扩展 `tests/ripgrepPath.test.ts`** <!-- 接受偏差:PATH 场景由 tests/platformMatrix.test.ts 覆盖,未扩 ripgrepPath 单测 -->

在 `describe("pickRipgrepPath")` 后加:
```ts
describe("pickRipgrepPathFromEnv", () => {
  const origPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = origPath;
  });
  it("finds rg.exe on PATH (win32 style)", () => {
    const bin = path.join(os.tmpdir(), "rgenv-" + Date.now());
    fs.mkdirSync(bin, { recursive: true });
    const rg = path.join(bin, process.platform === "win32" ? "rg.exe" : "rg");
    fs.writeFileSync(rg, "");
    process.env.PATH = bin + path.delimiter + (origPath ?? "");
    const found = pickRipgrepPathFromEnv();
    expect(found).toBe(rg);
    fs.rmSync(bin, { recursive: true, force: true });
  });
  it("returns undefined when not on PATH", () => {
    process.env.PATH = path.join(os.tmpdir(), "definitely-empty-" + Date.now());
    expect(pickRipgrepPathFromEnv()).toBeUndefined();
  });
});
```
(需 import:`pickRipgrepPathFromEnv` 加入顶部 import 列表。)

- [x] **Step 3: 修改 `executor.ts` 的 `resolveRgBinary`**

在 `getConfiguredRipgrepPath()` 分支后、distDir 分支前插入 PATH 兜底:
```ts
const fromEnv = pickRipgrepPathFromEnv();
if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
```
顶部 import 加 `pickRipgrepPathFromEnv`(与 `pickRipgrepPath` 同一来源)。

- [x] **Step 4: 验证**

```bash
npx vitest run tests/ripgrepPath.test.ts   # 预期 PASS(含新增 2 用例)
# 无 node 时用 Python 括号校验
```

- [x] **Step 5: Commit** <!-- 已提交: 875174e -->

```bash
git add dsb-agent/src/util/ripgrepPath.ts dsb-agent/tests/ripgrepPath.test.ts dsb-agent/src/agent/tools/executor.ts
git commit -m "fix(grep): resolve rg from PATH as fallback"
```

---

### Task 4: Grep 纯 Node 降级(grepFallback)

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

- [x] **Step 1: 新建 `src/agent/tools/grepFallback.ts`**

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

- [x] **Step 2: 新建 `tests/grepFallback.test.ts`**

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

- [x] **Step 3: 修改 `executor.ts` 的 `runGrep` 降级**

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

- [x] **Step 4: 验证**

```bash
npx vitest run tests/grepFallback.test.ts   # 预期 PASS 6 用例
# 手工验证(有 node 的机器):npm run compile 后启动扩展,在无 rg 的目录调用 Grep 应返回纯 Node 结果而非 ERROR。
```

- [x] **Step 5: Commit** <!-- 已提交: 875174e -->

```bash
git add dsb-agent/src/agent/tools/grepFallback.ts dsb-agent/tests/grepFallback.test.ts dsb-agent/src/agent/tools/executor.ts
git commit -m "feat(grep): pure-node fallback when rg unavailable"
```

---

### Task 5: CHANGELOG + 综合验证

**Files:**
- Modify: `dsb-agent/CHANGELOG.md`
- 验证:全部测试文件、括号校验、临时文件清理

- [x] **Step 1: CHANGELOG 记录**

在 `## [Unreleased]` 下追加(若无 Unreleased 段则新建):
```md
### 平台适配
- Grep:rg 二进制解析增加 PATH 兜底;rg 不可用时自动降级为纯 Node 行扫描,Windows 下不再报「rg not found」。
- Bash/系统提示词:注入「运行环境」段(OS/shell/命令风格),模型按 Windows 用 dir/type、POSIX 用 ls/cat。
- 工具门禁:ToolDef 支持 platforms 元数据 + filterToolDefs 按平台过滤,为平台专用工具预留机制(当前核心工具全平台)。
```

- [x] **Step 2: 综合验证**

```bash
# 有 node:
npx vitest run                                    # 全量回归,预期全 PASS
npx tsc --noEmit                                  # 类型检查(若项目配置支持)
# 无 node(本机):用 Python 对 6 个改动文件做括号配平 + 检查无 TODO/TBD 残留
```

- [x] **Step 3: 清理与确认** <!-- 已完成:_src.txt 已删除 -->

```bash
dir /b _*.py _*.ps1 _*.txt 2>nul                 # 应无残留临时文件
```
最终确认交付物清单与 spec §6 一致。

- [x] **Step 4: Commit** <!-- 已提交: 875174e -->

```bash
git add dsb-agent/CHANGELOG.md
git commit -m "docs: record platform adaptation in changelog"
```

---

## Self-Review 记录(计划作者填写)

- **Spec 覆盖率**:§3.1 类型+门禁 → Task 1;§3.2 Grep 修复 → Task 3(候选/PATH)+ Task 4(降级);§3.3 平台感知 → Task 2;§3.5 错误处理 → Task 3/4 分支;§4 测试 → 各任务内嵌;§6 交付物 → Task 1/2/3/4 逐项对应。
- **占位符扫描**:所有代码步骤含完整代码与断言,无 TBD/TODO/「类似上一步」。
- **类型一致性**:`filterToolDefs(defs, platform)`、`platformInfo(platform?)`、`pickRipgrepPathFromEnv()`、`grepFallback(root, opts)` 在定义与消费处签名一致;`ToolExecContext.platform` 可选、缺省 process.platform 与 Global Constraints 一致。
