# 平台感知与工具平台门禁(B1)设计说明

> 状态:已实现(2026-08-14;B1 批准落地 → B3 扩展 → CI 平台矩阵,分阶段完成)
> Canonical: `dsb-agent/.dsb/specs/`(2026-08-15 自 bbb 迁入;以本仓库为准)
> 关联:修复 Windows 下工具提示失效/无法运行的问题
> 实现记录:`.dsb/docs/platform-tools.md`;本文件为设计基线,第 7 节记录实现状态与偏差
> Git: `875174e`

## 1. 背景与实测证据

用户报告:项目在 Windows 下运行时,一些工具提示无法运行或失效,建议按操作系统分组工具集,运行自动检测当前 OS 并调用不同工具集。经全量实测(Windows, e:\DSBAgent, 2026-08-14),16 类核心工具表现如下:

| 工具 | 结果 | 证据 |
|---|---|---|
| Read / Write / StrReplace / Delete | ✅ 正常 | 文件读写/替换/删除 OK(含中文 UTF-8) |
| Glob / LS | ✅ 正常 | 递归 glob、列目录 OK |
| **Grep** | ❌ **完全失效** | 每次调用返回 `ERROR: ripgrep (rg) not found` |
| **Bash** | ⚠️ **半失效** | cmd.exe 正确;但 `ls`/`pwd`/`$HOME` 等 Unix 命令报"不是内部或外部命令" |
| TodoWrite | ✅ 正常 | list/add OK |
| WebSearch / WebFetch | ✅ 正常 | 网络请求 OK |
| Agent / Workflow | ✅ 正常 | 子代理、多阶段 OK |
| MemoryWrite/Read/List/Delete | ✅ 正常 | 记忆全链路 OK |
| ContextRecall | ⚠️ 不可用 | "未启用冷存储"(会话配置原因,fail-open 设计,非平台 bug) |

**关键事实**:
- 本机 `node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe` 存在且可运行(ripgrep 15.0.0),但 Grep 仍报 not found → 是**解析/注入链路在某种运行模式下断链**,不是二进制缺失。
- `executor.ts` 的 `runShell` 已按 `process.platform` 选 `cmd.exe` vs `/bin/bash`(执行层正确),但**模型不知道平台**:系统提示词无任何 OS/shell 信息,模型生成 Unix 风格命令在 cmd 下批量失败。
- `ripgrepPath.ts` 已按 win32/linux/darwin 生成候选,但候选顺序/兜底不足,且无 PATH 探测与降级。

## 2. 目标与范围(B1)

- 让工具集按当前操作系统自适应:对**真正存在平台差异**的环节做平台分支。
- 建立"平台门禁"注册机制(`platforms` 元数据),为将来平台专用工具留口子,但**不**为全平台工具硬造变体(排除 B2)。
- 修复 Grep 在 Windows 的失效(二进制解析 + PATH 兜底 + 纯 Node 降级,保证永远可用)。
- 让模型感知平台:Bash 工具按 OS 生成正确命令风格。
- 测试覆盖门禁过滤、ripgrep 候选、提示词平台分支、降级 Grep。

**设计时不在范围**(后续部分已落地,见第 7 节):B2(全平台变体,仍不做)、B3(新增 PowerShell 等平台专用工具,已实现)、平台矩阵 CI 改造(已实现)、ContextRecall 冷存储启用(仍不做,非平台问题)。

## 3. 设计

### 3.1 平台元数据 + 门禁机制

**类型层**(`src/agent/tools/types.ts`):
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

**门禁纯函数**(新文件 `src/agent/tools/platformGate.ts`):
```ts
export function filterToolDefs(defs: ToolDef[], platform: NodeJS.Platform): ToolDef[];
// 未声明 platforms → 放行;声明了 → 仅当 platform ∈ platforms
```

**注册层**(`executor.ts`):
- `allToolDefs()` 对 `CORE_TOOLS + MCP 工具 + 插件工具`统一经 `filterToolDefs` 过滤后再返回。
- 当前 16 个核心工具**均不声明** `platforms`(全平台可用);机制就位供未来新增平台专用工具使用。
- `ToolExecutor` 构造函数末位新增可选 `platform` 参数(默认 `process.platform`,测试可注入),门禁过滤与提示词构建用 `this.platform ?? process.platform`。
- 插件工具(MCP/plugin):设计上留位;实际已按 B3 落地——`PluginToolSpec.platforms` 与 `McpServerConfig.platforms` 均已实现并接入门禁(见第 7 节)。

### 3.2 Grep 二进制解析修复

`src/util/ripgrepPath.ts` + `src/agent/tools/executor.ts`:

1. **候选顺序修正**:`resolveRipgrepCandidates` 把当前平台 `@vscode/ripgrep-${platform}-${arch}` 的候选**提前**到 dist/bin 之后、其它平台目录之前;win32 对应 `rg.exe`。
2. **PATH 兜底**:rg 候选全部失败后,探测 `process.env.PATH` 上的 `rg`(win32 上为 `rg.exe`),命中即用(用户系统级安装的 rg)。实际实现在 `executor.ts` 的 `findRgOnPath()`。
3. **纯 Node 降级**(新文件 `src/agent/tools/grepFallback.ts`):
   - 仅在 rg 完全不可用时启用(慢但永远可用)。
   - 按 `pattern`(转换为大小写不敏感子串或 RegExp)、`glob`、`path` 做行级扫描,输出与 rg 相同格式:`file:line: text`;跳过重型目录(node_modules/.git 等)。
   - `case_insensitive` 支持;`--` 语义(pattern 为字面量时转义)。
   - 返回统一 `ToolExecResult` 形状,调用方无感。
4. **报错信息保留**:仅当降级也失败(如目录无权限)才报错,并附"尝试 `npm i -D @vscode/ripgrep` 或运行 `npm run build` 生成 dist/bin"提示。

### 3.3 Bash 平台感知

1. **系统提示词注入平台段**(`systemPrompt.ts`):
   - `SystemPromptInput` 新增 `platform?: NodeJS.Platform`(shell 不单独传,由 `platformInfo()` 按平台推导)。
   - 构建时新增一段:
     ```
     ## 运行环境
     - OS: Windows (win32)
     - Shell: cmd.exe(Bash 工具经其执行)
     - 路径分隔符: \
     - 命令风格: 用 dir/type/copy;不要用 ls/cat/rm -rf/$HOME
     ```
     Linux/macOS 分支:bash + POSIX 命令风格(`ls`/`cat`/`rm -rf`/`$HOME` 可用)。
   - 未知平台省略该段(`buildRunEnvSegment` 仅 win32/linux/darwin 输出)。
   - 会话层 `chatViewProvider.ts` 构建提示词时传 `platform: process.platform`。
2. **Bash 工具描述更新**(`definitions.ts` + `executor.ts`):
   - `definitions.ts` 通用描述:"Windows 经 cmd.exe 执行,Linux/macOS 经 /bin/bash;请按当前 OS 选择命令风格。"
   - `executor.ts` 的 `bashToolDescription(platform)` 按平台生成精确描述(含当前 shell 与命令风格),`allToolDefs()` 用其覆盖通用版。
3. **平台常量集中**(新文件 `src/util/platformInfo.ts`):
   ```ts
   export function platformInfo(platform?: NodeJS.Platform): { os: string; shell: string; sep: string; commandStyle: string; posix: boolean };
   ```
   供 systemPrompt、definitions、executor 共用,避免各文件散写字符串。

### 3.4 数据流

```
activate() → configureRipgrepPath(pickRipgrepPath(...))   // 注入 rg 绝对路径
会话构建 systemPrompt(platform)                            // 模型感知平台(platformInfo 推导 shell)
agentLoop 拿 allToolDefs() → filterToolDefs(defs, platform) // 平台门禁(核心/MCP/插件统一)
工具执行:
  Grep → resolveRgBinary(ctx) → 有 rg:spawn;无 rg:grepFallback
  Bash → runShell(cmd / bin/bash)                          // 已有,不变
  PowerShell → runPowerShell(powershell.exe,仅 win32 暴露)  // B3 新增
  插件工具 → 平台守卫(platforms 不匹配 → not available)     // B3 新增
```

### 3.5 错误处理

- Grep:rg 不可用 → 静默降级纯 Node(不报错);降级也失败(权限/目录不存在)→ 报错 + 安装提示。
- 门禁:平台字段非法(非 NodeJS.Platform 字符串)→ 视为全平台放行(宽松;插件/MCP 解析时非法值过滤)。
- 提示词平台段:platform 无法识别 → 省略该段(不注入错误信息)。

## 4. 测试计划

全部纯函数化,沿用现有 vitest(node 环境,无 DOM):

| 测试文件 | 用例 |
|---|---|
| `tests/platformGate.test.ts` | 无 platforms → 全放行;声明 win32 → win32 放行/linux 隐藏;空集合;多平台 |
| `tests/ripgrepPath.test.ts`(扩展) | win32 候选含 rg.exe 且优先;PATH 兜底命中;linux 候选 |
| `tests/systemPrompt.test.ts`(新增) | Windows 分支含 dir/type 指引;Linux 分支含 ls/cat;未知平台省略段 |
| `tests/grepFallback.test.ts`(新增) | 行匹配、大小写不敏感、glob 过滤、字面量转义、输出格式 `file:line: text` |
| 既有测试回归 | executor 相关测试不受门禁影响(核心工具全平台) |
| `tests/pluginTools.test.ts`(B3 新增) | manifest platforms 解析/非法过滤/透传/门禁过滤 |
| `tests/mcpRegistry.test.ts`(B3 新增) | .mcp.json platforms 解析、listEnabled 按平台过滤 |
| `tests/tools.test.ts`(B3 扩展) | PowerShell win32 暴露/linux 隐藏、win32 实机执行、非 win32 拒绝 |
| `tests/platformMatrix.test.ts`(CI 新增) | 真实平台冒烟 6 用例(见第 7 节) |

## 5. 验证方式(手工)

- Windows:`Grep` 工具搜索中文/英文内容成功;`Bash` 工具按提示词用 `dir`/`type` 成功;`dist/bin` 未构建时 Grep 走降级仍可用;`PowerShell` 工具可调用。
- Linux(有环境时):`Bash` 提示词为 POSIX 风格;rg 走 linux 候选;`PowerShell` 不对外通告。
- CI:三平台 runner 跑 `platformMatrix.test.ts` 真实冒烟。

## 6. 交付物清单

- `src/agent/tools/types.ts`:ToolDef.platforms、ToolExecContext.platform
- `src/agent/tools/platformGate.ts`(新):filterToolDefs
- `src/agent/tools/grepFallback.ts`(新):纯 Node 降级 Grep
- `src/util/platformInfo.ts`(新):平台信息集中
- `src/util/ripgrepPath.ts`:候选顺序 + PATH 兜底
- `src/agent/tools/executor.ts`:allToolDefs 门禁、resolveRgBinary 兜底
- `src/agent/systemPrompt.ts` + 会话层:平台段注入
- `src/agent/tools/definitions.ts`:Bash 描述更新
- 测试 4 个文件 + 既有测试扩展

### B3 扩展交付物(追加)

- `src/agent/tools/definitions.ts`:PowerShell 工具定义(platforms: ["win32"])
- `src/agent/tools/executor.ts`:runPowerShell + dispatch case + 插件工具平台守卫
- `src/plugins/types.ts`:PluginToolSpec.platforms
- `src/plugins/pluginTools.ts`:parsePlatforms 解析/过滤 + buildPluginToolDef 透传
- `src/mcp/types.ts`:McpServerConfig.platforms
- `src/mcp/mcpRegistry.ts`:platform 注入 + listEnabled/ensureConnected 平台守卫
- 测试:tests/pluginTools.test.ts、tests/mcpRegistry.test.ts、tests/tools.test.ts(B3 分组)

### CI 平台矩阵交付物(追加)

- `tests/platformMatrix.test.ts`:真实平台冒烟 6 用例(三平台 runner)
- `.github/workflows/ci.yml`:Platform info 步骤(打印 process.platform/arch/node 版本/rg 包存在性)

## 7. 实现状态与偏差(2026-08-14)

### 已实现

| 阶段 | 内容 | 验证 |
|---|---|---|
| B1 | 平台门禁(filterToolDefs)、Grep 修复(候选顺序 + PATH 兜底 + 纯 Node 降级)、Bash 平台感知(提示词「运行环境」段 + 描述动态化)、platformInfo 集中 | 括号配平 + 单测(platformGate/ripgrepPath/systemPrompt/grepFallback) |
| B3 | 门禁扩展至插件工具(PluginToolSpec.platforms + 执行守卫)与 MCP 服务器(McpServerConfig.platforms + listEnabled/ensureConnected 过滤);新增 PowerShell 专用工具(仅 win32) | 括号配平 + 单测(pluginTools/mcpRegistry/tools B3 分组) |
| CI | 三平台矩阵(ubuntu/windows/macos)真实冒烟 platformMatrix.test.ts(6 用例);ci.yml 新增 Platform info 步骤 | 括号配平;已在 Windows 实测通过全量 vitest(106 文件/1038 用例,1 个 Windows 无 symlink 权限用例跳过)+ tsc --noEmit + esbuild compile;CI 三平台跑真实冒烟 |

### 与设计的偏差(功能等价)

1. **PATH 兜底位置**:设计写在 `ripgrepPath.ts` 的 `resolveRgBinary`;实际实现在 `executor.ts` 的 `findRgOnPath()`(属于执行层解析),`ripgrepPath.ts` 候选顺序未动(dist → 平台包 → appRoot 已正确)。
2. **shell 字段**:设计 `SystemPromptInput` 加 `platform` + `shell` 两字段;实际只加 `platform`,shell 由 `platformInfo()` 推导,避免两处不一致。
3. **插件/MCP 门禁**:设计时"留位"(当前类型无字段);B3 实际补全了 `PluginToolSpec.platforms` 与 `McpServerConfig.platforms`,并接入门禁与执行守卫。
4. **PowerShell 输出**:设计未定义;实现复用 `formatShellOutput`(exit/stdout/stderr 与 Bash 一致),非 Windows 调用返回 `not available on <platform>`。
5. **门禁过滤优先级**:实现为 `allToolDefs()` 统一过滤核心/MCP/插件;插件/MCP 另在各自注册/执行层守卫,双层保障。

### 仍未做(明确不在范围)

- B2(全平台变体):所有核心工具全平台可用,不硬造无差异变体。
- ContextRecall 冷存储启用:会话配置原因,fail-open 设计,非平台问题。
