# DSBAgent — 项目总体框架

> 生成时间:2026-08-10(全项目盘点后重写)
> 范围:**当前仓库真实架构与全部模块功能**(源码 `src/` 109 个文件、webview 13 个、tests 100 个测试文件 / 972 项)

## 项目简介

DSBAgent 是一个基于 **Anthropic Messages 兼容 API** 的 VS Code 编码 Agent(开源,非官方;操作方式参考主流编码 Agent 工具)。可对接任意 Anthropic Messages 兼容 `baseUrl`(内置 DeepSeek 等预设,默认端点可在设置中修改)。对话、工具执行、记忆、上下文压缩、冷存储归档等能力全部本地化,密钥存 VS Code SecretStorage,扩展自身不收集遥测。

**技术栈**:TypeScript + VS Code Extension API(引擎层不依赖 `vscode` 模块,便于单测);esbuild 打包(`dist/extension.js` + `dist/webview/`);Vitest 测试(100 文件 / 972 tests)。

## 顶层目录

```
./ — 根(README / CHANGELOG / LICENSE / package.json / esbuild.mjs)
├── src/          引擎 + 扩展宿主(109 个 .ts)
├── webview/      Agent 聊天面板与各设置面板前端(13 个文件,esbuild 产物进 dist/webview)
├── tests/        单元测试(100 个测试文件,972 项)
├── resources/    打包资源(原创图标 resources/icon.png,128×128)
├── scripts/      构建/安装脚本(generate-third-party-notices.mjs、install-extension.sh)
├── .github/      CI 工作流(typecheck → vitest → vsce package)
├── .dsb/         项目约定(技能 skills/、规则 rules/、命令 commands/、代理 agents/、计划 plans/、设计 specs/、文档 docs/)
└── skills/       随扩展分发的技能包(80 个,安装到用户 skills 目录)
```

## 模块总览(按目录)

### 1. 入口与扩展宿主 — `src/extension.ts`
- 激活入口(activationEvents: onStartupFinished),组装全部依赖并注入:
  - 配置(`configuration`)、密钥存储(`apiKeyStore`)、会话服务(`sessionService`)
  - 统计(`StatsStore` / `ActivityStatsStore` / 每日总结提醒)
  - 上下文库(`ContextStore` / 冷存储归档)、记忆(`MemoryManager`)
  - MCP 注册表、插件注册表、Hook 运行器
- 注册 19+ 命令(见下方「命令一览」)。

### 2. 会话与聊天 — `src/chat/`
- `chatController.ts`:会话主控制器,消息流、工具执行编排、事件分发。
- `chatViewProvider.ts`:Webview 面板宿主,注入 HTML/脚本,推送/接收协议事件。
- `protocol.ts`:Webview ↔ 引擎消息协议(状态、消息、工具事件、compaction_stats 等)。
- `sessionService.ts` / `sessionTypes.ts`:会话生命周期与类型。
- `slashCommands.ts`:斜杠命令(`/compact`、`/memory dream` 等)。
- `todoPanel.ts`:任务清单面板;`toolPresentation.ts`:工具调用展示格式化。
- `suggestions.ts`:输入建议;`exportSession.ts`:会话导出;`projectRuntime.ts`:项目运行时探测。
- `toolPresentation` / `format` 协同处理消息渲染。

### 3. 引擎核心 — `src/agent/`(不依赖 vscode 模块,可单测)
- `agentLoop.ts`:Agent 主循环(模型调用 → 工具执行 → 上下文管理 → 压缩判定),`deps` 注入全部依赖,事件通过 `onEvent` 外发(含 `compaction_stats`)。
- `contextManager.ts` / `contextCompactor.ts`:上下文组装、压缩(触发比例 `dsbAgent.compaction.triggerRatio` 默认 0.75)、压缩块 `[compacted]` 摘要、thinking 独立压缩。
- `compactionStats.ts`:压缩成本统计(滑动窗口 100,`windowSeries` 趋势序列,供 UI 徽章/迷你柱状图)。
- `archivePolicy.ts`:老会话完整历史归档到冷存储(压缩时引用,`dsbAgent.contextBrowse` 可浏览)。
- `toolUsePolicy.ts`:工具参数瞬时化策略(`TRANSIENT_FIELDS` 忽略瞬时参数,降 token);`toolResultPolicy.ts` 工具结果精简。
- `modePolicy.ts` / `thinkingPolicy.ts`:运行模式与 thinking 控制;`permission.ts` / `permissionRules.ts` / `capabilityGate.ts`:权限门禁与能力门。
- `systemPrompt.ts` / `agentTemplates.ts`:系统提示组装、子代理模板解析。
- `subagentRunner.ts`:子代理执行;`workflow.ts`:多阶段工作流;`worktree.ts`:Git worktree 隔离。
- `checkpoint.ts`:会话检查点;`projectScope.ts`:项目范围隔离。
- `memory/`:记忆系统 —— `memoryStore.ts` 存储、`memoryManager.ts` 管理、`memorySimilar.ts` 相似度、`memoryDream.ts` 记忆整合(压缩)、`memoryTools.ts` 记忆工具(MemoryRead/Write/List/Delete)。
- `provider/`:**模型供应商客户端** —— `types.ts` 消息类型、`anthropicMessagesClient.ts` 主客户端、`fallbackClient.ts` 回退(DDG→Bing 搜索等)。
- `tools/`:**工具系统** —— `definitions.ts` 定义、`executor.ts` 执行、`parallelSafe.ts` 并行安全、`webTools.ts`(WebSearch/WebFetch)、`workspaceFs.ts` 文件读写、`contextRecallTool.ts` 跨会话回查、`todoTool.ts` 任务清单工具。

### 4. 上下文捕获与格式化 — `src/context/`
- `contextCapture.ts`:捕获(编辑器选中、剪贴板、终端粘贴);`documentAttach.ts` / `imageAttach.ts` 附件。
- `extractors/`:文档提取 —— text / pdf / docx / xlsx(按 kinds 注册)。
- `promptBuilder.ts`:按提示词模板组装上下文;`formatContext.ts` 格式化。
- `composerMarkers.ts` / `displayLabel.ts` / `fileClassify.ts`:标记、显示标签、文件分类。
- `editorPasteMode.ts`:粘贴模式增强。

### 5. 供应商与模型 — `src/providers/`
- `profiles.ts`:内置模型预设(deepseek-v4-flash / pro / reasoner / chat 等)。
- `modelCatalog.ts`:模型目录;`providerStore.ts` 供应商存储;`capabilities.ts` / `capabilityRegistry.ts` / `remoteCapabilities.ts` 能力声明与探测;`ccSwitchImport.ts` 旧配置迁移。

### 6. 设置与面板 — `src/settings/` + `src/chat/todoPanel.ts` + `webview/`
- `configuration.ts`:全部配置项读取;`apiKeyStore.ts`:密钥(SecretStorage);`providerChoices.ts` 供应商选择。
- 面板:主聊天面板(`webview/index.html` + `main.ts` + `styles.css` + `chips.ts` + `format.ts` + `vim.ts`)、Agent 设置(`agentSettingsPanel`)、上下文浏览(`contextPanel`)、记忆(`memoryPanel`)、供应商设置(`providerSettings`)。

### 7. 项目约定注入 — `src/projectContext/`
- 首次进入项目自动生成 `.dsb/` 骨架(`ensureWorkspaceDsb.ts`)与框架文档 `project-overview.md`(`projectOverview.ts`,docs/ 下已有框架文档时跳过)。
- `projectInstruction.ts`:注入项目指令(DSB.md);`rulesReader.ts`:注入项目规则(rules/*.md)。
- `skillsScan.ts` / `convention.ts`:技能扫描与目录约定;`settingsReader.ts` 设置读取。

### 8. 插件 / MCP / 钩子
- `src/plugins/`:插件系统 —— manifest 清单、marketplace 市场、pluginTools 插件工具、skillIndex/skillDescription 技能索引、recommend 推荐。
- `src/mcp/`:MCP 客户端与注册表(`mcpClient` / `mcpRegistry`),支持外部 MCP 服务器接入工具。
- `src/hooks/hookRunner.ts`:生命周期钩子。

### 9. 会话持久化与统计 — `src/session/` + `src/stats/`
- `session/sessionStore.ts` / `sessionProgress.ts`:会话落盘与进度记忆。
- `stats/statsStore.ts`:事件日志(`~/.dsb/stats/<projectKey>/events-YYYY-MM-DD.jsonl`,按项目隔离,保留 30 天)。
- `stats/providerSendStats.ts`:provider_send 消息组成统计(compactedBlock / tool_result / thinking / system 等占比)。
- `stats/compactionEvents.ts`:压缩事件;`stats/activityStats.ts`:活动统计 + 每日总结提醒。

### 10. 其它
- `src/i18n/strings.ts`:界面文案(中文);`src/notifications/notifier.ts`:通知;`src/util/ripgrepPath.ts`:内置 rg 路径解析。

## 命令一览(contributes.commands)

`dsbAgent.open` 打开面板 · `newSession` 新会话 · `setApiKey` 设置密钥 · `memory`/`memoryManage` 记忆 · `contextBrowse` 冷存储浏览 · `rewind` 回退 · `listSessions` 会话列表 · `pluginAdd`/`pluginInstall`/`plugins` 插件 · `mcpConnect` MCP 连接 · `hooks` 钩子 · `skill` 技能 · `captureEditorCopy`/`attachTerminalClipboard` 捕获 · `manageProviders`/`providerSettings`/`agentSettings` 设置。

## 项目约定目录(.dsb/)

- 项目指令 → `.dsb/DSB.md`(或仓库根 `DSB.md`)
- 规则 → `.dsb/rules/`;技能 → `.dsb/skills/`(随扩展分发的内置技能见根 `skills/`)
- 斜杠命令 → `.dsb/commands/`;子代理模板 → `.dsb/agents/`
- 实现计划 → `.dsb/plans/`;设计说明 → `.dsb/specs/`;其它文档 → `.dsb/docs/`
- 会话检查点 → `.dsb/checkpoints/`(gitignore,不推送)

## 数据与存储位置

| 数据 | 位置 |
|------|------|
| 会话上下文 | `<globalStorage>/context/<projectKey>/`(`<sessionId>.context.json` + `.index.json`,冷存储归档) |
| 事件统计 | `~/.dsb/stats/<projectKey>/events-*.jsonl`(provider_send / compaction / message_sent 等) |
| 密钥 | VS Code SecretStorage |
| 会话文件 | `<globalStorage>/sessions/` 等 |

## 测试与验证

- 单测:`npx vitest run`(100 文件 / 972 项);类型检查:`npx tsc --noEmit`;打包:`npx vsce package`(103 文件 / ~5.5MB)。
- CI:`.github/workflows/ci.yml`(typecheck → vitest → vsce package)。
- 引擎层(src/ 非 webview)不依赖 `vscode` 模块,全部逻辑可脱离宿主单测。
