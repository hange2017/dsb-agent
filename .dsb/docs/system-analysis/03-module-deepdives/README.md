# 03 · 模块级 deep-dive

> 状态:📄 骨架(待填充)
> 说明:本目录按模块逐份深挖。每个模块一份文件,命名 `NNN-<module-name>.md`,内容聚焦该模块的内部实现、关键函数、边界与坑。

## 模块清单(src/ 16 个目录)

| 模块 | 文件数 | 核心文件 | 状态 |
|------|--------|----------|------|
| src/agent | 19 | agentLoop.ts / contextManager.ts / contextCompactor.ts | 🔄 |
| └ 压缩子系统 | — | contextCompactor.ts / contextManager.ts | ✅ [001](001-context-compaction.md) |
| src/agent/tools | 10 | executor.ts / definitions.ts / todoTool.ts | 📄 |
| src/agent/memory | 5 | memoryManager.ts / memoryDream.ts | 📄 |
| src/agent/provider | 3 | anthropicMessagesClient.ts / fallbackClient.ts | 📄 |
| src/chat | 11 | chatController.ts / chatViewProvider.ts / sessionService.ts | 📄 |
| src/context | 12 | contextStore.ts / contextCapture.ts / promptBuilder.ts | 📄 |
| src/providers | 8 | modelCatalog.ts / providerStore.ts / capabilities.ts | 📄 |
| src/settings | 8 | configuration.ts / agentSettingsPanel.ts | 📄 |
| src/stats | 6 | providerSendStats.ts / statsStore.ts / compactionEvents.ts | 📄 |
| src/projectContext | 8 | projectInstruction.ts / rulesReader.ts / skillsScan.ts | 📄 |
| src/session | 3 | sessionStore.ts / sessionProgress.ts | 📄 |
| src/plugins | 7 | marketplace.ts / pluginTools.ts / skillIndex.ts | 📄 |
| src/mcp | 3 | mcpClient.ts / mcpRegistry.ts | 📄 |
| src/hooks | 1 | hookRunner.ts | 📄 |
| src/i18n | 1 | strings.ts | 📄 |
| src/notifications | 1 | notifier.ts | 📄 |
| src/util | 2 | platformInfo.ts / ripgrepPath.ts | 📄 |

## 每份 deep-dive 的模板

```markdown
# <模块名> deep-dive

> 状态:📄/🔄/✅
> 关联文件:<文件列表>

## 职责边界
## 内部结构(关键类/函数/数据结构)
## 与外部模块的交互(依赖方/被依赖方)
## 关键实现细节与坑
## 已知问题/改进空间
```
