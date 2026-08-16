# Changelog

DSBAgent 变更记录。版本遵循 [SemVer](https://semver.org/lang/zh-CN/);实现计划与设计说明见 `.dsb/plans/` 与 `.dsb/specs/`。

## [Unreleased]

### 新增

- **Snapshot Store(统一裁剪切点归档)**:
  - `ContextStore` 主存改为 NDJSON 追加(`*.context.ndjson`)+ 异步 `SnapshotQueue`(debounce 50ms / batch 16),旧 `*.context.json` 惰性迁移;索引带字节偏移供 ContextRecall 随机读。
  - 淘汰上限:全量 50MB + thinking 独立 8MB;空闲 compact(>500 条或 >8MB 内容)。
  - thinking / toolResult / StrReplace.old_string 裁切前归档原文,标记嵌入 `[r{seq}]`;回合结束 `flush`。
  - 修复注入链:`ChatViewProvider` 级共享 `ContextStore` 同时注入 Controller / ToolExecutor / AgentSession,ContextRecall 可用。
  - Grep 工具描述补充「rg 不可用时降级为纯 Node」。

### 修复

- **输入框 Ctrl/Cmd+Z 撤销失效**:发送后 `inputEl.value` 被编程式清空会销毁 textarea 原生撤销栈,输入框为空时按 Ctrl/Cmd+Z 现在会恢复上一次发送的文本;vim 模式 normal 状态不再拦截 Ctrl/Cmd/Alt 组合键,撤销/重做/复制/粘贴等浏览器原生行为恢复正常。
- **瞬时参数省略标记污染防护**:瞬时参数摘要模板升级为强标识 `[TRANSIENT-SUMMARY field=... chars=...]` 并附「禁止写入文件」提示,模型不再把省略标记当真实内容复述;`Write`/`StrReplace` 执行前校验 `contents`/`old_string`/`new_string`,命中省略标记直接拒绝写入并提示用 `Read` 重新读取——从源头阻断「占位符污染文件」问题(Windows/Linux 均适用)。
- **输入框躺平小人悬停/输入后消失**:`saluteOut` 动画 `forwards` 锁定 `opacity:0`,而 `saluting` 类仅在 `mouseleave` 时移除;输入清空后即使恢复空闲,inline `opacity` 也被动画覆盖 → 表情永久不可见。现改为空闲分支强制解除 `saluting` 锁定并恢复 😴,悬停敬礼改为一次性问候(0.8s 后自动恢复躺平),忙碌/输入中不触发问候。

### 新增

- **平台感知与工具平台门禁(B1)**:
  - 工具定义新增 `platforms` 元数据(`ToolDef`),`filterToolDefs` 按 `process.platform` 过滤对外通告的工具集,为未来平台专用工具留好机制(当前核心工具全平台可用)。
  - **Grep 不再完全失效**:rg 二进制解析新增 PATH 兜底(`rg`/`rg.exe`);无 rg 时降级为纯 Node 行级搜索(`grepFallback`,输出格式与 rg 一致),Windows 等无 rg 环境 Grep 永远可用(慢但可用)。
  - **Bash 平台感知**:系统提示词新增「运行环境」段(OS/shell/路径分隔符/命令风格,按 `process.platform` 生成,Windows 提示用 `dir`/`type`);Bash 工具描述按平台动态生成,告知模型当前 shell 与命令风格。
  - 新增 `src/util/platformInfo.ts` 集中平台信息,供提示词/工具描述/执行层共用。

### 测试

- 新增 `tests/platformGate.test.ts`(门禁过滤)、`tests/systemPrompt.test.ts`(运行环境段)、`tests/grepFallback.test.ts`(降级搜索);既有 `ripgrepPath.test.ts` 保持覆盖。

### 扩展(B3)

- **平台门禁扩展至 MCP/插件工具 + PowerShell 专用工具**:
  - 插件工具:`PluginToolSpec` 新增可选 `platforms` 字段,manifest 工具条目可声明 `platforms: ["win32"]`(非法平台自动过滤);`buildPluginToolDef` 透传,插件工具按平台通告;执行入口加平台守卫,直接调用不匹配平台的插件工具返回错误。
  - MCP 服务器:`.mcp.json` 服务器条目可声明 `platforms`;`McpRegistry` 注入平台并据此过滤 `listEnabled()`(平台不匹配的服务器不会连接/信任),`ensureConnected` 同样守卫。
  - 新增 **PowerShell 专用工具**(仅 `win32` 暴露):以工作区为 cwd 执行 PowerShell 脚本(`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command`),输出格式与 Bash 一致;非 Windows 平台调用返回「not available」。
- **测试**:新增 `tests/pluginTools.test.ts`(manifest 解析/透传/门禁过滤)、`tests/mcpRegistry.test.ts`(.mcp.json 解析/`listEnabled` 平台过滤);`tests/tools.test.ts` 新增 `ToolExecutor platform gate (B3)` 分组(PowerShell 在 win32 暴露/linux 隐藏、win32 执行、非 win32 拒绝)。

### CI 平台矩阵

- **CI 三平台矩阵显式化**:`ci.yml` 的 `test` job 已覆盖 `ubuntu-latest / windows-latest / macos-latest`,Test 步骤前新增 **Platform info** 步骤(打印 `process.platform`/`arch`/node 版本/内置 rg 包存在性),便于从 CI 日志直接核对平台分支。
- **新增 `tests/platformMatrix.test.ts`**(真实平台冒烟,不注入平台):在 CI 三平台 runner 上验证「platformInfo 报告真实 OS/shell/分隔符」「allToolDefs 在 win32 暴露 PowerShell、其它平台隐藏」「Bash 描述匹配真实 shell(cmd.exe / /bin/bash)」「Bash 真实执行基础命令」「Grep 永远可用(原生 rg 或纯 Node 降级)」共 6 用例,把「每个平台都能跑」从口头约定变成 CI 硬性检查。

### 真实验证(Windows, 2026-08-14)

- 发现 `.tools/node-v20.19.0-win-x64` 便携 Node 后,实际跑通完整测试套件:**106 个测试文件 / 1038 用例全部通过**(1 个 Windows 无符号链接权限用例按平台跳过),`tsc --noEmit` 与 `npm run compile`(esbuild)均通过,`dist/bin/win32-x64-rg.exe` 随打包生成,Grep 不再报 not found。
- 真实验证暴露并修复 4 处问题:
  - `tests/tools.test.ts` 的 `platExec()` 构造参数错位(平台参数落在多余第 15 位被忽略,导致注入 linux 仍暴露 PowerShell)→ 修正为 14 参数,平台门禁用例真实生效。
  - `executor.ts` 的 PowerShell dispatch 缺平台守卫 → 非 win32 直接调用现在返回 `PowerShell is not available on <platform>`。
  - `benchmark/smoke.test.ts` 的 Bash 追加断言不兼容 Windows cmd 的 CRLF 输出 → 断言改为 EOL 规范化比较。
  - `tests/grepFallback.test.ts` 的「无效正则字面量」用例误用 `a+b`(合法正则)→ 改用真正的无效正则 `(text`。
  - `ToolExecContext.platform` 声明但 executor 从未读取(仅构造参数生效)→ dispatch 统一解析 `ctx.platform ?? this.platform ?? process.platform`,执行上下文注入平台真正生效。

## [0.2.1] — 2026-08-12

### 修复

- **Windows 兼容**:Glob 结果统一正斜杠相对路径(不再返回 `sub\file.ts` 反斜杠);marketplace 本地路径判断、rules 展示名归一化正斜杠;测试移除 `/tmp` 硬编码。

### 文档

- README 新增「真实编程使用统计数据」(平均每次调用费用置顶,含命中率/费用明细/官方单价口径),并同步英文版。
- 历史信息总预算设置建议更新为「64K 即可运行,并非越大越好」。
- 新增 `.dsb/docs/toolchain-instability-handbook.md`:本环境工具链不稳定现象与规避手册(占位符污染根因已定位至 `src/agent/toolUsePolicy.ts` + 操作规避)。

### 内部

- CI 测试矩阵扩展到 Windows/macOS 三平台;vitest 使用 github-actions reporter 输出失败注解。

## [0.2.0] — 2026-08-12

### 新增

- **Thinking 全链路总开关**(默认开,可整体关闭)与处理侧开关:关闭时 thinking 剥离不进历史/压缩/脉络。
- **思考强度预设** `thinkingLevel`(`low`/`medium`/`high`)派生预算;全局思考强度兜底注入与供应商默认能力(`supportsThinking` + `thinkingLevel`,缺省 `medium`)。
- **Agent 设置面板「思考模式」卡片**:开关 + 强度下拉,配置读写并同步全局尾底强度。
- **Thinking 关闭时预算归一化**:split 配置层归一化为两段(`compacted`+`tail`)并写入 agent 参数。
- **缓存前缀稳定性 P0~P3**(详见 `.dsb/rules/cache-prefix-stability.md`):
  - P0:todo 清单移出 system,改由 `TodoWrite` tool_result 尾部传播(前缀稳定段不再被清单状态打断)。
  - P1:trim 类 tool_result 写入 messages 前定型(push 前定最终字节形态,消除"先原始后精简"两形态)。
  - P2:压缩块只追加/只删尾部 + 标题恒输出,稳定段前缀字节恒定(re-summarize 只动尾部新增)。
  - P3:trim 类 tool_use / 超阈值 thinking 写前定型 + `planThinkingTrim` 幂等保护。
- **统计扩展**:`provider_send` 内容 hash 指纹与会话标识(方案 B,缓存前缀命中分析);压缩自身成本(`llmCalls`/`llmMs`/`selfTokens`)与 `provider_round` phase/roundMs;压缩质量抽查 `compactionQa` 开关;压缩雪崩量化脚本(`scripts/`)。

### 修复

- `capabilityGate` 修复孤儿/缺 id tool_use 配对,禁止 todo 并入 tool_result。
- 压缩耗时实测统计存档与成本/雪崩综合分析落地(官方单价口径,`未命中×1.0 + 命中×0.02 + 输出×2.0` 元/M)。
- 统计文档中文化并新增数据校验强制流程(官方对账前置)。

### 内部

- 固化缓存前缀稳定性规则(字节稳定三原则 + 缓存杀手清单 + 验证要求),并标记 P0~P3 实施状态。
- 统计口径规则(全项目合并)、README 补充快速开始/安装置顶与绿色设置建议(超级权限 + 历史预算 256K)。

## [0.1.0] — 2026-08-10(首发布)

### 新增

- 上下文分轨压缩(需求/结论/解释/台账) + 冷存储(`ContextStore`),跨会话 `ContextRecall` 回查。
- 老会话完整历史归档(`archivePolicy`):切走/删除会话时把完整历史写入冷存储。
- Thinking 独立压缩:配对上下文一次 LLM 调用压缩为独立 `[thinking]` 块(正确/错误/中性分组);独立预算(≤3500 tokens)、滚动收缩、开关 `dsbAgent.compaction.thinking`。
- 记忆卫生三件套:访问加权排序 + `pinned` 常驻、`MemoryWrite` 相似候选提示、`/memory dream` 双闸门。
- 压缩成本监控:`CompactionStats` 滑动窗口 + agentUI header 徽章 + 迷你趋势柱状图(`windowSeries`)。
- 压缩事件落盘:`~/.dsb/stats/<projectKey>/events-*.jsonl`(`compaction` / `provider_send` breakdown)。
- 每日工作总结提醒、统计大模块、时段图标、动态表情动画、历史懒加载、代码块双击跳转、设置右侧抽屉。

### 修复

- 冷存储偏移索引 + 增量合并 `assertNoSeqOverlap` 前置断言(fail-open)。
- 历史轮次中间时间线折叠、对话身份标签、提交时折叠上一轮等 UI 细节。

### 内部

- 引擎层(`src/` 非 webview 部分)不依赖 `vscode` 模块,便于单测。
- 打包排除 `.deepseek/**`、`.dsb/**`、`.cursor/**`、`.map` 等敏感/冗余文件。

### 发布准备(2026-08-10)

- 新增原创图标 `resources/icon.png`(与任何厂商商标无关)。
- 补全 `categories`(`Chat / Other / AI / Programming Languages`)与 `keywords`。
- 建立根级 `CHANGELOG.md`;README 扩充安装步骤、平台支持矩阵与已知限制。
- 新增 GitHub Actions CI:compile + typecheck + vitest 全量 + `vsce package` 验包。
- 注册 Marketplace Publisher(`zhaoNingHan`);配置 `repository` 与 `publisher`;`vsce package` 本地验包通过(103 文件 / ~5.5MB,无警告)。
- 待办(上架前):配置 Marketplace PAT;Windows/macOS 真机冒烟。

## [0.0.x] — 2026-08-04 之前

早期开发版本(未发布),细目见 `.dsb/docs/` 与 `.dsb/plans/` 验收记录。
