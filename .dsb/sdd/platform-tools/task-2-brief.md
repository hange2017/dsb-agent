# Task 2 Brief

(来源: .dsb/plans/2026-08-14-platform-tools.md,由控制器提取)

平台信息集中 + 系统提示词「运行环境」段 + Bash/Grep 描述更新

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

- [ ] **Step 1: 新建 `src/util/platformInfo.ts`**

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

- [ ] **Step 2: 新建 `tests/platformInfo.test.ts`**

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

- [ ] **Step 3: 修改 `systemPrompt.ts`**

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

- [ ] **Step 4: 新建 `tests/systemPrompt.test.ts`**

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

- [ ] **Step 5: 修改 `chatViewProvider.ts:357` 调用处**

`buildSystemPrompt({...})` 参数对象加:
```ts
platform: process.platform,
shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
```
(文件顶部需有 `import * as process` 或 Node 全局 process 声明;若无 import,在文件头加 `import * as os from "os";` 用 `os.platform()` 也可。优先用 `process.platform`,与 executor 一致。)

- [ ] **Step 6: 修改 `definitions.ts` 的 Bash/Grep 描述**

Grep 描述改为:
```ts
description: "用 ripgrep 搜索文件内容(rg 不可用时自动降级为纯 Node 行扫描)。",
```
Bash 描述改为:
```ts
description: "以工作区为 cwd 执行 shell 命令。Windows 经 cmd.exe,Linux/macOS 经 /bin/bash;请按当前 OS 选择命令(Windows: dir/type;POSIX: ls/cat)。",
```

- [ ] **Step 7: 验证**

```bash
npx vitest run tests/platformInfo.test.ts tests/systemPrompt.test.ts   # 预期 PASS
# 无 node 时用 Task 1 Step 5 的 Python 括号校验脚本核对 4 个文件
```

- [ ] **Step 8: Commit**

```bash
git add dsb-agent/src/util/platformInfo.ts dsb-agent/tests/platformInfo.test.ts dsb-agent/src/agent/systemPrompt.ts dsb-agent/tests/systemPrompt.test.ts dsb-agent/src/chat/chatViewProvider.ts dsb-agent/src/agent/tools/definitions.ts
git commit -m "feat(prompt): inject OS/shell platform section and update tool descriptions"
```

---
