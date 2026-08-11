# Thinking 设置收敛实现计划

> 依据：`.dsb/specs/2026-08-11-thinking-settings-converge-design.md`
> 目标：移除 `dsbAgent.thinking.enabled`（总闸 `thinkingDisabled`）与 `dsbAgent.thinking.level`（全局兜底 `globalThinkingLevel`），只保留供应商 `supportsThinking`+`thinkingLevel` 与参数界面 `compaction.thinking`+`split.thinking`。

## T1 配置读取 · `src/settings/configuration.ts`
删 `thinkingEnabled()`、`thinkingLevel()`；保留 `compactionThinkingEnabled()`。

## T2 能力解析 · `src/providers/capabilityRegistry.ts`
删 `globalThinkingLevel` 字段、`setGlobalThinkingLevel()`、`resolve()` 里的兜底分支。

## T3 主循环 · `src/agent/agentLoop.ts`
删 deps.`thinkingDisabled`；`this.effectiveProvider = this.deps.provider`；删 `withThinkingDisabled` 导出；`setThinkingEnabled` 调用去掉 `!this.deps.thinkingDisabled &&`。

## T4 面板注入 · `src/chat/chatViewProvider.ts`
删 `thinkingDisabled: !this.configuration.thinkingEnabled()` 行；保留 `thinkingProcessEnabled`。

## T5 扩展宿主 · `src/extension.ts`
删 `setGlobalThinkingLevel(...)` 注入；参数面板 `getBudget/updateBudget` 去掉 `thinking.enabled/level` 读写。

## T6 参数面板接口 · `src/settings/agentSettingsPanel.ts`
`AgentThinkingConfig` 从 `{enabled,level}` 改为 `{compact}`；`normalizeThinkingConfig`/`normalizeConfig` 默认值同步。

## T7 参数面板 UI · `webview/agentSettingsPanel.html` + `.ts`
"思考模式"行改为单一开关（绑 `compaction.thinking`），删强度下拉；i18n 同步。

## T8 测试清理
- `tests/agentLoop.test.ts`：删/改写 `withThinkingDisabled` 2 个测试；清理 `thinkingDisabled` 断言。
- `tests/anthropicMessagesClient.test.ts` / `tests/modePolicy.test.ts`：清理 `thinkingDisabled` 引用。
- 参数面板相关测试同步。

## 验证
`npm test` 全绿 + `npx tsc --noEmit` 通过 + 全库无 `dsbAgent.thinking.enabled`/`level` 残留。
