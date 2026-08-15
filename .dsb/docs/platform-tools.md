# 平台感知与工具平台门禁

> 状态:已实现(2026-08-14,设计见 `.dsb/specs/2026-08-14-platform-tools-design.md`,已按 B1 + B3 扩展落地;**Windows 实测全量验证通过**,见第 11 节)
> Canonical: `dsb-agent/.dsb/docs/`(2026-08-15 自 bbb 迁入;以本仓库为准)
> Git: `875174e`
> 目标:让工具集按当前操作系统自适应,修复 Windows 下工具失效问题,并为平台专用工具提供注册门禁机制。

## 1. 背景

用户报告:项目在 Windows 下运行时,部分工具提示无法运行或失效。全量实测(Windows, 2026-08-14)确认两个真实故障:

| 现象 | 根因 |
|---|---|
| **Grep 完全失效** | 每次调用返回 `ERROR: ripgrep (rg) not found`。rg 二进制解析链路在某种运行模式下断链(实测 `node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe` 存在且可运行,但解析未命中),且无 PATH 兜底与降级方案 |
| **Bash 半失效** | 执行层已正确选 `cmd.exe`,但**模型不知道平台**——系统提示词无任何 OS/shell 信息,模型生成 Unix 风格命令(`ls`/`pwd`/`$HOME`)在 cmd 下批量失败 |

其余 14 类核心工具(Read/Write/StrReplace/Delete/Glob/LS/TodoWrite/WebSearch/WebFetch/Agent/Workflow/记忆工具)在 Windows 上行为正常。

## 2. 方案演进

- **B1(基础)**:平台门禁注册机制 + Grep 修复 + Bash 平台感知。已实现。
- **B3(扩展)**:门禁应用到 MCP/插件工具 + 新增 PowerShell 专用工具。已实现。
- **CI 平台矩阵**:三平台(ubuntu/windows/macos)CI 真实平台冒烟。已实现。

## 3. 平台门禁机制

### 3.1 类型层(`src/agent/tools/types.ts`)

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

### 3.2 门禁纯函数(`src/agent/tools/platformGate.ts`)

```ts
export function filterToolDefs(defs: ToolDef[], platform: NodeJS.Platform): ToolDef[];
// 未声明 platforms → 放行;声明了 → 仅当 platform ∈ platforms;空数组 → 全平台
```

### 3.3 注册层(`src/agent/tools/executor.ts`)

- `allToolDefs()` 对 `CORE_TOOLS + MCP 工具 + 插件工具`统一经 `filterToolDefs` 过滤。
- 核心工具均不声明 `platforms`(全平台可用);**平台专用工具只需声明 `platforms: ["win32"]` 即自动按 OS 暴露**。
- `ToolExecutor` 构造函数末尾新增可选 `platform` 参数(默认 `process.platform`,测试可注入);`dispatch` 中**优先读取 `ctx.platform`,其次构造参数,最后 `process.platform`**(`ctx.platform ?? this.platform ?? process.platform`),插件守卫 / PowerShell 守卫共用这一解析,保证「执行时注入平台」与文档一致。

### 3.4 插件工具门禁(B3)

- `src/plugins/types.ts`:`PluginToolSpec` 新增可选 `platforms?: NodeJS.Platform[]`。
- `src/plugins/pluginTools.ts`:`parsePlatforms()` 解析 manifest 工具条目的 `platforms`(非法平台值自动过滤);`buildPluginToolDef` 透传。
- `executor.ts` 插件工具执行入口加平台守卫:直接调用不匹配平台的插件工具返回 `not available on <platform>`。

### 3.5 MCP 服务器门禁(B3)

- `src/mcp/types.ts`:`McpServerConfig` 新增可选 `platforms?: NodeJS.Platform[]`。
- `src/mcp/mcpRegistry.ts`:
  - 构造函数新增可选 `platform` 参数(默认 `process.platform`;`new McpRegistry()` 无参调用保持兼容)。
  - `loadFromMcpJson` 解析 `.mcp.json` 服务器条目的 `platforms`(非法平台过滤)。
  - `listEnabled()` 按平台过滤;**平台不匹配的服务器不连接、不上报工具、不可信任**;`ensureConnected` 同样守卫。

## 4. Grep 修复(Windows 实测失效)

`src/util/ripgrepPath.ts` + `src/agent/tools/executor.ts` + 新文件 `src/agent/tools/grepFallback.ts`:

1. **候选顺序修正**:当前平台 `@vscode/ripgrep-${platform}-${arch}` 候选提前(dist/bin 之后、其它平台目录之前);win32 对应 `rg.exe`。
2. **PATH 兜底**:`findRgOnPath()` 在现有候选全部失败后探测 `process.env.PATH` 上的 `rg`(win32 为 `rg.exe`),命中即用(用户系统级安装)。
3. **纯 Node 降级**(`grepFallback.ts`):rg 完全不可用时启用——**Grep 永远可用(慢但可用)**。按 `pattern`(大小写不敏感子串/RegExp)、`glob`、`path` 做行级扫描,输出与 rg 相同格式 `file:line: text`,跳过重型目录(node_modules/.git 等)。`case_insensitive` 支持;字面量语义转义。
4. **报错保留**:仅当降级也失败(如目录无权限)才报错,附「尝试 `npm i -D @vscode/ripgrep` 或运行 `npm run build` 生成 dist/bin」提示。

## 5. Bash 平台感知

### 5.1 系统提示词「运行环境」段(`src/agent/systemPrompt.ts`)

`SystemPromptInput` 新增 `platform?: string`;构建时按 `platformInfo()` 生成一段:

```
## 运行环境
- OS: Windows (win32)
- Shell: cmd.exe(Bash 工具经其执行)
- 路径分隔符: \
- 命令风格: 用 dir/type/copy;不要用 ls/cat/rm -rf/$HOME
```

Linux/macOS 分支:bash + POSIX 命令风格(`ls`/`cat`/`rm -rf`/`$HOME` 可用)。未知平台省略该段。调用方 `src/chat/chatViewProvider.ts:357` 传入 `platform: process.platform`。

### 5.2 平台信息集中(`src/util/platformInfo.ts`)

```ts
export function platformInfo(platform?: NodeJS.Platform): {
  os: string; shell: string; sep: string; commandStyle: string; posix: boolean;
};
```

供 systemPrompt / definitions / executor 共用,避免各文件散写平台字符串。

### 5.3 Bash 工具描述动态化

- `definitions.ts` 通用描述:「以工作区为 cwd 执行 shell 命令。Windows 经 cmd.exe,Linux/macOS 经 /bin/bash;请按当前 OS 选择命令风格。」
- `executor.ts` 的 `bashToolDescription(platform)` 按平台生成更精确的描述;`allToolDefs()` 用当前平台描述覆盖通用版。

## 6. PowerShell 专用工具(B3)

| 项 | 值 |
|---|---|
| 名称 | `PowerShell` |
| 平台 | `platforms: ["win32"]`(仅 Windows 暴露) |
| 描述 | 在 Windows 上以工作区为 cwd 执行 PowerShell 脚本,适合文件/进程/系统管理等 cmd 不擅长的场景 |
| 执行 | `spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { cwd, windowsHide: true })` |
| 输出 | 与 Bash 相同 `ToolExecResult` 形状(exit/stdout/stderr) |
| 非 Windows 调用 | 返回 `not available on <platform>` |

Linux/macOS 上该工具不对外通告;未来新增平台专用工具(如 Linux apt 查询工具)照此模式声明 `platforms: ["linux"]`。

## 7. CI 平台矩阵

`.github/workflows/ci.yml` 的 `test` job 覆盖三平台:

```
strategy:
  matrix:
    os: [ubuntu-latest, windows-latest, macos-latest]
```

流水线:checkout → Setup Node 20 → `npm ci` → 拉取多平台 `@vscode/ripgrep-*` 二进制 → **Platform info**(打印 `process.platform`/`arch`/node 版本/内置 rg 包存在性,便于从 CI 日志核对平台分支)→ `tsc --noEmit` → `vitest run` → esbuild compile → vsce package → 上传 vsix artifact。

新增 `tests/platformMatrix.test.ts`(**真实平台冒烟**,不注入平台),在三个 runner 上验证:

| 用例 | win32 期望 | linux/darwin 期望 |
|---|---|---|
| `platformInfo` 报告真实 OS/shell/分隔符 | shell 含 `cmd`、sep=`\` | shell 含 `bash`、sep=`/` |
| `allToolDefs` 平台工具暴露 | 含 PowerShell | 不含 PowerShell |
| Bash 描述匹配真实 shell | 含 `cmd.exe` | 含 `/bin/bash` |
| Bash 真实执行 `echo platform-ok` | ok | ok |
| Grep 搜索 `alpha`(rg 或降级) | ok | ok |
| Grep 大小写不敏感搜索 | ok | ok |

这把「每个平台都能跑」从口头约定变成 CI 硬性检查。

## 8. 测试覆盖清单

| 测试文件 | 内容 |
|---|---|
| `tests/platformGate.test.ts` | filterToolDefs 门禁(全平台/单平台/空数组/多平台) |
| `tests/ripgrepPath.test.ts`(扩展) | rg 候选顺序、win32 rg.exe、PATH 兜底 |
| `tests/systemPrompt.test.ts` | 运行环境段 win32/linux/未知平台 |
| `tests/grepFallback.test.ts` | 降级搜索 7 用例 |
| `tests/pluginTools.test.ts`(新增) | manifest platforms 解析/非法过滤/透传/门禁 |
| `tests/mcpRegistry.test.ts`(新增) | .mcp.json platforms 解析、listEnabled 平台过滤 |
| `tests/tools.test.ts`(扩展 B3 分组) | PowerShell win32 暴露/linux 隐藏、win32 实机执行、非 win32 拒绝 |
| `tests/platformMatrix.test.ts`(新增) | 真实平台冒烟 6 用例(见第 7 节) |

> 以上测试已在 Windows 实测**全量通过**(106 文件 / 1038 用例,见第 11 节);symlink 用例在无权限平台自动 `skip`。

## 9. 使用指南:如何新增平台专用工具

1. 在 `definitions.ts` 定义工具,声明 `platforms: ["win32"]`(或 linux/darwin/多平台)。
2. 在 `executor.ts` 的 dispatch 增加对应 case;若需平台守卫,用 dispatch 开头统一解析的 `const platform = ctx.platform ?? this.platform ?? process.platform` 判断。
3. 平台不匹配时返回 `{ ok: false, content: "... not available on <platform>" }`。
4. 可选:在 `tests/platformMatrix.test.ts` 加一条真实平台断言,确保 CI 三平台覆盖。

## 10. 真实验证与修复(Windows, 2026-08-14)

实现完成后发现本机 `E:\DSBAgent\.tools\node-v20.19.0-win-x64` 存在便携 Node(此前误判「无 node/npm 无法跑测试」),首次在 Windows 跑通完整验证链,并修复验证过程中暴露的 6 处问题:

| # | 问题 | 修复 |
|---|---|---|
| 1 | `tests/tools.test.ts` 的 `platExec()` 构造传 15 个参数,但构造函数只有 14 个,`platform` 落在多余的第 15 位被忽略 → 门禁用例「假通过」(注入 linux 仍暴露 PowerShell) | 修正为 14 参数,平台门禁真实生效 |
| 2 | `executor.ts` PowerShell dispatch 缺平台守卫(门禁隐藏了工具,但直接 `execute("PowerShell")` 在注入非 win32 时仍会执行) | 加守卫:非 win32 返回 `PowerShell is not available on <platform>` |
| 3 | `benchmark/smoke.test.ts` 断言不兼容 Windows:cmd 下 `echo world >> a.txt` 输出 CRLF,期望 `hello\nworld` 失败 | 断言改为 EOL 规范化比较(`replace(/\r\n/g,"\n")`),Windows/Linux 均通过 |
| 4 | `tests/grepFallback.test.ts`「无效正则」用例用 `a+b`(合法正则,断言逻辑不成立) | 改用真正的无效正则 `(text`,验证字面量匹配语义 |
| 5 | symlink 测试在 Windows 无权限(创建符号链接需管理员/开发者模式)报 EPERM | 加平台能力探测 `symlinkSupported`,无权限时 `skipIf` 优雅跳过(CI Linux 正常执行) |
| 6 | `ToolExecContext.platform` 声明但 executor 从未读取(仅构造参数生效),与文档「测试可注入」不符 | dispatch 统一 `const platform = ctx.platform ?? this.platform ?? process.platform`,ctx.platform 真正生效(优先级:执行上下文 > 构造注入 > process.platform) |

验证结果:

| 项 | 结果 |
|---|---|
| `vitest run` 全量 | ✅ **106 文件 / 1038 用例通过 + 1 跳过(symlink 权限),0 失败** |
| `tsc --noEmit` | ✅ 无类型错误 |
| `esbuild compile` | ✅ 打包成功,生成 `dist/bin/win32-x64-rg.exe`(ripgrep 15.0.0 可运行)→ **Grep 不再报 not found** |
| `dist/bin/win32-x64-rg.exe --version` | ✅ ripgrep 15.0.0(系统 PATH 无 rg,走 dist/bin 修复链路) |

## 11. 相关文件

```
src/agent/tools/types.ts          ToolDef.platforms / ToolExecContext.platform
src/agent/tools/platformGate.ts   filterToolDefs 门禁纯函数
src/agent/tools/grepFallback.ts   纯 Node 降级 Grep
src/util/platformInfo.ts          平台信息集中
src/util/ripgrepPath.ts           rg 候选顺序 + PATH 兜底
src/agent/tools/executor.ts       allToolDefs 门禁 / Grep 降级 / Bash 描述 / runPowerShell / 插件守卫
src/agent/systemPrompt.ts         运行环境段
src/chat/chatViewProvider.ts      buildSystemPrompt 传 platform
src/agent/tools/definitions.ts    Bash/PowerShell 工具定义
src/plugins/types.ts              PluginToolSpec.platforms
src/plugins/pluginTools.ts        platforms 解析/透传
src/mcp/types.ts                  McpServerConfig.platforms
src/mcp/mcpRegistry.ts            平台解析 + listEnabled/ensureConnected 守卫
tests/platformMatrix.test.ts      真实平台冒烟(CI 三平台)
.github/workflows/ci.yml          CI 三平台矩阵 + Platform info 步骤
```
