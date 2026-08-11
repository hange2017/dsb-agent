# Thinking 设置收敛设计

> 生成时间：2026-08-11
> 状态：定稿（待实现）
> 关联：`.dsb/plans/2026-08-11-thinking-settings-converge-plan.md`

## 背景与问题

当前 DSBAgent 存在**三处** agent 侧 thinking 相关设置，职责重叠、歧义明显：

1. **模型能力侧（供应商界面）**：`supportsThinking`（模型是否有思考能力）+ `thinkingLevel`（强度，per-model 覆盖）。
2. **全链路总开关（全局配置 `dsbAgent.thinking.enabled`）**：`configuration.thinkingEnabled()` → `agentLoop.deps.thinkingDisabled` → 用 `withThinkingDisabled` 包装 provider，强制 `supportsThinking=false` + 请求 `thinkingDisabled:true`。**它无法直接给供应商界面传参，且与 `supportsThinking` 职责重叠** —— 用户想在供应商界面关闭思考，与全局总闸关闭，语义冲突不清。
3. **全局强度兜底（全局配置 `dsbAgent.thinking.level`）**：`configuration.thinkingLevel()` → `capabilityRegistry.setGlobalThinkingLevel()` → 对无模型级 level/预算的模型兜底强度。**与供应商界面的 `thinkingLevel`（模型级覆盖）重复** —— 兜底是给"未配置模型级强度的模型"用的，但用户已能在供应商界面给任意模型设置强度，兜底反而造成"强度写在哪"的歧义。
4. **处理侧开关（`dsbAgent.compaction.thinking`）**：`configuration.compactionThinkingEnabled()` → `deps.thinkingProcessEnabled` → 控制压缩时是否剥离/收集 thinking。**职责清晰**。

## 目标状态：整体只有两个 thinking 设置

| 设置 | 所在界面 | 配置键 | 语义 |
|---|---|---|---|
| **① 模型是否有思考能力 + 强度** | 供应商设置 | `supportsThinking`（能力）+ `thinkingLevel`（强度，per-model） | "模型侧是否思考 + 多强" |
| **② thinking 数据链路 + 上下文分配** | 参数设置 | `dsbAgent.compaction.thinking`（开关）+ `dsbAgent.compaction.budgetSplit.thinking`（上下文大小） | "agent 是否把 thinking 编入历史/压缩 + 分配多少上下文" |

**移除项**：
- `dsbAgent.thinking.enabled` —— 全链路总闸 `thinkingDisabled`（与 `supportsThinking` 重叠、歧义）。
- `dsbAgent.thinking.level` —— 全局强度兜底 `globalThinkingLevel`（与供应商 `thinkingLevel` 重叠）。

## 变更点

### 1. 配置读取（`src/settings/configuration.ts`）
- **删除** `thinkingEnabled()` 方法（`dsbAgent.thinking.enabled`）。
- **删除** `thinkingLevel()` 方法（`dsbAgent.thinking.level`）。
- 保留 `compactionThinkingEnabled()`（`dsbAgent.compaction.thinking`）。

### 2. 能力解析（`src/providers/capabilityRegistry.ts`）
- **删除** `globalThinkingLevel` 字段与 `setGlobalThinkingLevel()`。
- `resolve()` 中删除"无模型级 level/预算时用全局兜底"的分支，直接返回 resolved caps。

### 3. 主循环（`src/agent/agentLoop.ts`）
- deps 里**删除** `thinkingDisabled?: boolean`。
- 构造函数里**删除** `withThinkingDisabled` 包装，`this.effectiveProvider = this.deps.provider`。
- **删除** `withThinkingDisabled` 导出函数（含 `thinkingDisabled:true` round 包装）。
- 压缩 `setThinkingEnabled(...)` 调用：去掉 `!this.deps.thinkingDisabled &&`，简化为 `setThinkingEnabled(this.deps.thinkingProcessEnabled !== false && thinkingEnabledForMode(mode))`。
- `deps` 注释同步更新。
- `thinkingProcessEnabled` 保留（它来自 `compaction.thinking`，属设置②）。

> 注：删除整条总闸后，"是否思考"完全由供应商界面的 `supportsThinking` 决定。参数界面不再有"关闭思考"的入口 —— 去供应商界面把 `supportsThinking` 关闭即可。

### 4. 面板注入（`src/chat/chatViewProvider.ts`）
- **删除** `thinkingDisabled: !this.configuration.thinkingEnabled()` 注入行。
- 保留 `thinkingProcessEnabled: this.configuration.compactionThinkingEnabled()`。

### 5. 扩展宿主（`src/extension.ts`）
- **删除** `capabilityRegistry.setGlobalThinkingLevel(configuration.thinkingLevel())` 注入。
- 参数设置面板：`getBudget()`/`updateBudget()` 中**删除** `thinking.enabled` / `thinking.level` 的读写。

### 6. 参数面板接口（`src/settings/agentSettingsPanel.ts`）
- `AgentThinkingConfig` 语义变更：从 `{ enabled, level }` 改为 `{ compact: boolean }`（对应 `dsbAgent.compaction.thinking`）。
- `normalizeThinkingConfig`、`normalizeConfig` 默认值相应变更。
- 注释更新。

### 7. 参数面板 UI（`webview/agentSettingsPanel.html` + `.ts`）
- "思考模式"行从「开关（`thinkingEnabledChk`）+ 强度下拉（`thinkingLevelSel`）」改为「**一个开关**，绑定 `dsbAgent.compaction.thinking`（thinking 数据链路/压缩）」。
- thinking 上下文大小滑块（`split.thinking`）保留。
- i18n 文案同步。

### 8. 测试
- `tests/agentLoop.test.ts`：删除/改写 `withThinkingDisabled` 相关 2 个测试；`thinkingDisabled` 相关断言清理。
- `tests/anthropicMessagesClient.test.ts` / `tests/modePolicy.test.ts`：清理 `thinkingDisabled` 引用。
- 参数面板相关测试若引用 `thinking.enabled/level` 需同步。

## 语义变化说明（重要）

1. **删除总闸 ≠ 无法关闭思考**。供应商界面 `supportsThinking=false` 是所有"模型是否思考"的唯一权威路径，capabilityGate 已据此剥 thinking 块、不请求预算。原来的总闸仅是"包装一层强制关闭"，二者二选一，保留后者即可。
2. **参数界面只保留"thinking 数据链路"开关**：`compaction.thinking` 控制 agent 是否把 thinking 编入历史/压缩（`thinkingProcessEnabled`）。这是纯粹的**数据处理**开关，与"模型是否思考"正交，不会歧义。
3. `thinkingLevel`（供应商界面，模型级）是强度的唯一权威；`dsbAgent.thinking.level` 全局兜底删除后，未设置强度的模型回退到模型 catalog 默认（`resolveCapabilities` 已有 profile/内置能力表/供应商默认链），与"跟随模型"一致。

## 验收

- `npm test` 全绿，`npx tsc --noEmit` 通过。
- 供应商界面 `supportsThinking` 开/关仍正确控制请求预算与 thinking 剥离。
- 参数界面仅有一个 thinking 开关（`compaction.thinking`）+ thinking 上下文滑块；保存后写 `dsbAgent.compaction.thinking`。
- 全库无 `dsbAgent.thinking.enabled` / `dsbAgent.thinking.level` 残留。
