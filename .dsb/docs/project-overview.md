# DSBAgent — 项目总体框架

> 生成时间:2026-08-15(最近一周工作同步后重写)
> 范围:**当前仓库真实架构与全部模块功能**(源码 `src/` 115 个 .ts、webview 15 个文件、tests 107 个测试文件 / 1090 项)

## 项目简介

DSBAgent 是一个基于 **Anthropic Messages 兼容 API** 的 VS Code 编码 Agent(开源,非官方;操作方式参考主流编码 Agent 工具)。可对接任意 Anthropic Messages 兼容 `baseUrl`(内置 DeepSeek 等预设,默认端点可在设置中修改)。对话、工具执行、记忆、上下文压缩、冷存储归档等能力全部本地化,密钥存 VS Code SecretStorage,扩展自身不收集遥测。

**技术栈**:TypeScript + VS Code Extension API(引擎层不依赖 `vscode` 模块,便于单测);esbuild 打包(`dist/extension.js` + `dist/webview/`);Vitest 测试(107 文件 / 1090 tests)。

## 顶层目录

```
./ — 根(README.en.md / README / CHANGELOG / LICENSE / package.json / esbuild.mjs / .gitattributes)
├── src/          引擎 + 扩展宿主(115 个 .ts)
├── webview/      Agent 聊天面板与各设置面板前端(15 个文件,esbuild 产物进 dist/webview)
├── tests/        单元测试(107 个测试文件,1090 项)
├── resources/    打包资源(原创图标 resources/icon.png,128×128)
├── scripts/      构建/安装/分析脚本(generate-third-party-notices.mjs、install-extension.sh、analyze-cache-prefix.py、analyze-compaction-snowball.py)
├── benchmark/    打榜评测(SWE-bench headless CLI 包装、T3 实例准备脚本、smoke 测试)
├── .github/      CI 工作流(三平台 typecheck → vitest → vsce package + 发布 job)
├── .dsb/         项目约定(技能 skills/、规则 rules/、命令 commands/、代理 agents/、计划 plans/、设计 specs/、文档 docs/)
└── skills/       随扩展分发的技能包(38 个可扫描技能,安装到用户 skills 目录)
```

## 模块总览(按目录)

### 1. 入口与扩展宿主 — `src/extension.ts`
- 激活入口(activationEvents: onStartupFinished),组装全部依赖并注入:
  - 配置(`configuration`)、密钥存储(`apiKeyStore`)、会话服务(`sessionService`)
  - 统计(`StatsStore` / `ActivityStatsStore` / 每日总结提醒)
  - 上下文库(`ContextStore` / 冷存储归档)、记忆(`MemoryManager`)
  - MCP 注册表、插件注册表、Hook 运行器
- 注册 19 个命令(见下方「命令一览」)。

### 2. 会话与聊天 — `src/chat/`
- `chatController.ts`:会话主控制器,消息流、工具执行编排、事件分发。
- `chatViewProvider.ts`:Webview 面板宿主,注入 HTML/脚本,推送/接收协议事件;executor 构造注入 `statsStore`(ContextRecall 打点)。
- `protocol.ts`:Webview ↔ 引擎消息协议(状态、消息、工具事件、compaction_stats 等)。
- `sessionService.ts` / `sessionTypes.ts`:会话生命周期与类型。
- `slashCommands.ts`:斜杠命令(`/compact`、`/memory dream` 等)。
- `todoPanel.ts`:任务清单面板;`toolPresentation.ts`:工具调用展示格式化。
- `suggestions.ts`:输入建议;`exportSession.ts`:会话导出;`projectRuntime.ts`:项目运行时探测。
- `toolPresentation` / `format` 协同处理消息渲染。
- **交互增强**:消息正文内联路径/URL 双击跳转(`open_url` + linkify,块级 pre 除外)、内联面板显隐工具(`setInlinePanelOpen`/`toggleInlinePanel`)、消息区滚动跟随冻结(上滚查看历史时新内容不拽动视口,回底部自动恢复)+ ▲▼ 轮次导航(▲ 上一个用户输入、▼ 下一个回复/回到最新,平滑滚动 + 目标高亮,与历史懒加载协同)。

### 3. 引擎核心 — `src/agent/`(不依赖 vscode 模块,可单测)
- `agentLoop.ts`:Agent 主循环(模型调用 → 工具执行 → 上下文管理 → 压缩判定),`deps` 注入全部依赖,事件通过 `onEvent` 外发(含 `compaction_stats`)。
  - **缓存前缀稳定性(P0-P3)**:todo 移出 system 注入请求尾部(P0);trim 类 tool_result 写前定型(P1);trim 类 tool_use/thinking 写前定型 + thinkingPolicy 幂等保护(P3)——保证 messages 前缀字节跨轮稳定,最大化缓存命中。
  - **thinking 处理侧开关**:thinking 剥离不进历史/压缩/脉络(可整体关闭)。
- `contextManager.ts` / `contextCompactor.ts`:上下文组装、压缩(触发比例 `dsbAgent.compaction.triggerRatio` 默认 0.75)、压缩块 `[compacted]` 摘要、thinking 独立压缩。
  - **P2 压缩块 append-only**:只增尾部/只删尾部、标题恒输出、re-summarize 只动尾部新增行——稳定段前缀字节恒定,根治压缩后缓存雪崩。
  - **回查提示行**:压缩块尾部恒输出 `RECALL_HINT_LINE`(固定 ASCII ~10 tokens),引导模型主动 ContextRecall 回查原文。
  - **thinking 预算归一化**:思考编排关闭时 split 配置层归一化为两段(compacted+tail)。
- `compactionStats.ts`:压缩成本统计(滑动窗口 100,`windowSeries` 趋势序列,供 UI 徽章/迷你柱状图)。
- `archivePolicy.ts`:老会话完整历史归档到冷存储(压缩时引用,`dsbAgent.contextBrowse` 可浏览)。
- `toolUsePolicy.ts`:工具参数瞬时化策略(`TRANSIENT_FIELDS` 忽略瞬时参数,降 token;瞬态字段按「工具.字段」细分阈值:Write.contents 2000 / StrReplace.new_string 1000);`toolResultPolicy.ts` 工具结果精简(Bash/Grep 完整输出保留,trim 阈值 4000/100/12000;thinking 精简阈值 400、最近保留 15)。
- `modePolicy.ts` / `thinkingPolicy.ts`:运行模式与 thinking 控制;`permission.ts` / `permissionRules.ts` / `capabilityGate.ts`:权限门禁与能力门(修复孤儿/缺 id tool_use 配对、禁止 todo 并入 tool_result)。
- `systemPrompt.ts` / `agentTemplates.ts`:系统提示组装、子代理模板解析。
- `subagentRunner.ts`:子代理执行;`workflow.ts`:多阶段工作流;`worktree.ts`:Git worktree 隔离。
- `checkpoint.ts`:会话检查点;`projectScope.ts`:项目范围隔离。
- `memory/`:记忆系统 —— `memoryStore.ts` 存储、`memoryManager.ts` 管理、`memorySimilar.ts` 相似度、`memoryDream.ts` 记忆整合(压缩)、`memoryTools.ts` 记忆工具(MemoryRead/Write/List/Delete)。
- `provider/`:**模型供应商客户端** —— `types.ts` 消息类型、`anthropicMessagesClient.ts` 主客户端、`fallbackClient.ts` 回退(DDG→Bing 搜索等)。
- `tools/`:**工具系统** —— `definitions.ts` 定义、`executor.ts` 执行(注入 statsStore,ContextRecall 打点)、`parallelSafe.ts` 并行安全、`webTools.ts`(WebSearch/WebFetch)、`workspaceFs.ts` 文件读写、`contextRecallTool.ts` 跨会话回查(**P0 统计埋点** `RecallStat` 六模式 + P1 描述强化)、`todoTool.ts` 任务清单工具(经 tool_result 尾部传播)。

### 4. 上下文捕获与格式化 — `src/context/`
- `contextCapture.ts`:捕获(编辑器选中、剪贴板、终端粘贴);`documentAttach.ts` / `imageAttach.ts` 附件。
- `extractors/`:文档提取 —— text / pdf / docx / xlsx(按 kinds 注册)。
- `promptBuilder.ts`:按提示词模板组装上下文;`formatContext.ts` 格式化。
- `composerMarkers.ts` / `displayLabel.ts` / `fileClassify.ts`:标记、显示标签、文件分类。
- `editorPasteMode.ts`:粘贴模式增强。
- **Snapshot Store**:NDJSON 归档 + cut-point recall(6c98e81,快照切点回查)。

### 5. 供应商与模型 — `src/providers/`
- `profiles.ts`:内置模型预设(deepseek-v4-flash / pro / reasoner / chat 等)。
- `modelCatalog.ts`:模型目录;`providerStore.ts` 供应商存储;`capabilities.ts` / `capabilityRegistry.ts` / `remoteCapabilities.ts` 能力声明与探测(**thinkingLevel 预设 low/medium/high 派生预算;供应商默认思考能力兜底 medium;URL 清洗自愈、401/空列表报错、import 后内存同步**);`ccSwitchImport.ts` 旧配置迁移。
- **thinking 设置收敛**:移除 `thinking.enabled` 总闸与 `thinking.level` 全局兜底,收敛为供应商 `supportsThinking` + `thinkingLevel` 与参数面板 `dsbAgent.compaction.thinking`(默认关闭,不编排 thinking 链路)。

### 6. 设置与面板 — `src/settings/` + `src/chat/todoPanel.ts` + `webview/`
- `configuration.ts`:全部配置项读取;`apiKeyStore.ts`:密钥(SecretStorage);`providerChoices.ts` 供应商选择。
- 面板:主聊天面板(`webview/index.html` + `main.ts` + `styles.css` + `chips.ts` + `format.ts` + `vim.ts`)、Agent 设置(`agentSettingsPanel`,含上下文预算 5 项 + **思考模式卡片**(开关+强度下拉))、上下文浏览(`contextPanel`)、记忆(`memoryPanel`)、供应商设置(`providerSettings`,配置 API Key/编辑供应商 popover、「设为当前使用」、新建供应商 Base URL 默认预填兼容端点)。
- **i18n**:webview 全面语言修复(按钮/placeholder/title/表格列名/动态文本),默认语言英文(`dsbAgent.language`)。

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
- `stats/providerSendStats.ts`:provider_send 消息组成统计(compactedBlock / tool_result / thinking / system 等占比)+ **内容 hash 指纹与会话标识**(方案 B 缓存前缀命中分析)。
- `stats/compactionEvents.ts`:压缩事件(含 LLM 调用统计字段 llmCalls/llmMs/algoMs/selfTokens);`stats/activityStats.ts`:活动统计 + 每日总结提醒。
- **统计扩展 A 清单(全量落地)**:A1 压缩自身成本统计 + A2 provider_round phase/roundMs + A7 逐位置明细 + A5 QA 抽查 + A8 preparedMs + 聚合函数 + 统计开关。
- **压缩质量抽查(`compaction_qa` 事件)**:压缩后对 `[r{n}]` 键值提问验证信息保真(seq / answerable / qaMs / qaIn·qaOutputTokens + 该轮 in/outTokens)。落盘为 `compaction_qa` 事件(聚合时单列扣减,不混入真实使用成本)。**可开关**:`dsbAgent.stats.compactionQa`(默认 true);关闭时完全不触发抽查(不额外 provider 请求、不落盘)。
- **ContextRecall 埋点(`context_recall` 事件)**:`RecallStat` 六模式(seq_hit/seq_miss/index_hit/index_empty/cross_session/unavailable)+ queryLen/queryHash(sha1 16hex),可随 stats 总开关 `dsbAgent.stats.enabled=false` 经 `?.` 静默关闭。
- **provider_round**:记录每次 provider 交互真实 token 与缓存命中率(`cacheReadTokens` 等),官方数据小时级对账口径见 `.dsb/docs/`。

### 10. 其它
- `src/i18n/strings.ts`:界面文案(默认英文,支持中文);`src/notifications/notifier.ts`:通知;`src/util/ripgrepPath.ts`:内置 rg 路径解析(打包内置 win32/darwin/linux 多平台二进制)。

## 命令一览(contributes.commands)

`dsbAgent.open` 打开面板 · `newSession` 新会话 · `setApiKey` 设置密钥 · `memory`/`memoryManage` 记忆 · `contextBrowse` 冷存储浏览 · `rewind` 回退 · `listSessions` 会话列表 · `pluginAdd`/`pluginInstall`/`plugins` 插件 · `mcpConnect` MCP 连接 · `hooks` 钩子 · `skill` 技能 · `captureEditorCopy`/`attachTerminalClipboard` 捕获 · `manageProviders`/`providerSettings`/`agentSettings` 设置。

## 项目约定目录(.dsb/)

- 项目指令 → `.dsb/DSB.md`(或仓库根 `DSB.md`)
- 规则 → `.dsb/rules/`(含缓存前缀稳定性、瞬时参数省略标记避让、法律严格避让、仓库开发约定);技能 → `.dsb/skills/`(随扩展分发的内置技能见根 `skills/`,38 个可扫描)
- 斜杠命令 → `.dsb/commands/`;子代理模板 → `.dsb/agents/`
- 实现计划 → `.dsb/plans/`;设计说明 → `.dsb/specs/`;其它文档 → `.dsb/docs/`
- 会话检查点 → `.dsb/checkpoints/`(gitignore,不推送)

## 数据与存储位置

| 数据 | 位置 |
|------|------|
| 会话上下文 | `<globalStorage>/context/<projectKey>/`(`<sessionId>.context.json` + `.index.json`,冷存储归档) |
| 事件统计 | `~/.dsb/stats/<projectKey>/events-*.jsonl`(provider_send / provider_round / compaction / compaction_qa / context_recall / message_sent 等) |
| 密钥 | VS Code SecretStorage |
| 会话文件 | `<globalStorage>/sessions/` 等 |

## 打榜相关(Benchmark)

项目正在按 [打榜路线](../docs/benchmark/benchmark-roadmap.md) 推进公开榜单评测,目标是用真实开放数据证明 DSBAgent 的"成本效率"差异化卖点(DeepSeek V4 Flash + ~95% 缓存命中率)。落地进展:
- **T1 完成**:headless CLI 包装(`benchmark/cli.ts`),将 `src/agent/` 引擎(不依赖 vscode,可 headless 运行)包装成 SWE-bench 评测接口,含 provider/stats 组装(`benchmark/provider.ts` / `stats.ts`)与 smoke 测试(已纳入 vitest 配置)。
- **T3 进行中**:probe 实例准备脚本(`benchmark/scripts/`),自包含 VM worklog。
- 执行计划见 [2026-08-12-benchmark-execution-plan](../plans/2026-08-12-benchmark-execution-plan.md)。

## 测试与验证

- 单测:`npx vitest run`(107 文件 / 1090 项);类型检查:`npx tsc --noEmit`;打包:`npx vsce package`(108 文件 / ~11MB,内置多平台 ripgrep)。
- CI:`.github/workflows/ci.yml`(typecheck → vitest → vsce package,**windows/macos/ubuntu 三平台矩阵** + Marketplace/Open VSX/GitHub Release 发布 job)。
- 引擎层(src/ 非 webview)不依赖 `vscode` 模块,全部逻辑可脱离宿主单测。

## 近期工作重点(2026-08-10 ~ 2026-08-15)

1. **缓存前缀稳定性工程(P0-P3 全落地)**:todo 移出 system、tool_result/tool_use/thinking 写前定型、压缩块 append-only 只增尾部/只删尾部;规则固化于 `.dsb/rules/cache-prefix-stability.md`,命中率量化脚本 `scripts/analyze-cache-prefix.py` / `analyze-compaction-snowball.py`;provider_send 增加内容 hash 指纹(方案 B 分析)。
2. **thinking 设置收敛**:全链路开关 + thinkingLevel 强度预设(low/medium/high 派生预算)+ 面板思考模式卡片;`dsbAgent.compaction.thinking` 默认关闭;关闭时预算归一化为两段。
3. **统计扩展 A 清单全量落地**:压缩成本(A1)、provider_round(A2)、逐位置明细(A7)、QA 抽查(A5,`compactionQa` 开关)、preparedMs(A8)、聚合函数与统计开关。
4. **ContextRecall 回查提升(P0+P1)**:统计埋点六模式 + 工具描述强化 + 压缩块尾部恒输出回查提示行 + 原创技能 `skills/context-recall-usage`(随扩展分发)。
5. **发布 0.2.0 / 0.2.1**:Windows/三平台 CI 兼容修复、打包内置多平台 ripgrep、.vscodeignore 排除 benchmark 修复 vsce 打包卡死、README 双语重排 + 真实使用统计、Open VSX 安装说明。
6. **工具策略优化**:toolResultPolicy trim 阈值上调(Bash/Grep 完整输出保留)、thinking 精简阈值 150→400 最近保留 15、toolUsePolicy 瞬态字段按「工具.字段」细分阈值、Read 头行分段提示 + StrReplace 回显锚点。
7. **其它**:webview 全面 i18n + 默认英文、内联路径/URL 双击跳转、消息区滚动跟随冻结 + ▲▼ 轮次导航、供应商模型探测增强(URL 清洗自愈/401 报错/import 内存同步)、Snapshot Store NDJSON 归档、上下文预算默认值窗口 1M / 历史 150K。
