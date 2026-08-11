# 实现计划:Agent 设置面板全局「思考模式」菜单

> 生成时间:2026-08-11
> 状态:✅ 已实施

## 目标

在 DSB Agent 设置面板新增「思考模式」卡片,提供:
1. **全局 thinking 开关**(开 / 关)
2. **思考强度下拉**(低 / 中 / 高 / 跟随模型)
保存后写入 vscode 全局配置并立即生效。

## 现状

- 全局开关 `dsbAgent.thinking.enabled`(boolean,默认 true)已存在,且已通过
  `chatViewProvider.ts:390` `thinkingDisabled: !configuration.thinkingEnabled()` 接入 agentLoop
  (整条链路无 thinking)。
- 思考强度目前是**模型级**(Provider 面板模型配置),通过 `CapabilityRegistry.resolve`
  解析(优先级 `override > remote > profile > 内置能力表 > 供应商默认`)。
- Agent 设置面板(`webview/agentSettingsPanel`)当前只编辑上下文预算 5 项。

## 缺口

1. 全局强度 level 无处配置(只在模型级/Provider 面板可配)。
2. Agent 设置面板无集中「思考模式」菜单。

## 方案

### 数据与持久化

- 复用/新增全局配置:
  - `dsbAgent.thinking.enabled`(已有,开关)
  - `dsbAgent.thinking.level`(新增,string 枚举 `low|medium|high`,default null = 跟随模型)

- 扩展 `AgentBudgetConfig`(host 端,`src/settings/agentSettingsPanel.ts`)增加 `thinking` 段:
  ```ts
  thinking: {
    level: "low" | "medium" | "high" | "";  // "" = 未设置(跟随模型级)
  };
  ```
  **注意**:`enabled` 开关不放进 config 对象,而是由 extension 层独立读写(避免与运行时的
  `thinkingDisabled` 链路耦合),面板通过单独的协议字段收发。

  实际上更简单:把 `enabled` 也放进 config.thinking,由同一 save 协议一并持久化。
  二者都写入 vscode 配置,`enabled` 直接驱动现有链路,`level` 注入 registry。

### 运行时生效链路

- **开关**:沿用现有 `dsbAgent.thinking.enabled` → `chatViewProvider` → `thinkingDisabled`。
  面板只做读写,不改运行时。

- **强度 level**:作为**全局最低优先级 fallback** 注入到 `CapabilityRegistry.resolve`:
  - `CapabilityRegistry` 增加 `globalThinkingLevel?: ThinkingLevel` 状态与
    `setGlobalThinkingLevel(level)` 方法。
  - `resolve()` 返回前兜底:若最终 caps 既无 `thinkingBudgetTokens` 也无 `thinkingLevel`,
    且全局 level 已设置,则赋 `out.thinkingLevel = globalThinkingLevel`。
  - 语义:模型级 override/profile 仍可覆盖;全局 level 只在未指定时兜底。

## 变更清单

| 文件 | 改动 |
|---|---|
| `package.json` | 新增 `dsbAgent.thinking.level` 配置枚举 + i18n description |
| `src/i18n/strings.ts` | 新增面板文案(zh/en) |
| `src/settings/configuration.ts` | 新增 `thinkingLevel()` 读取全局 level |
| `src/providers/capabilityRegistry.ts` | 加 `globalThinkingLevel` 状态 + `setGlobalThinkingLevel` + resolve 兜底 |
| `src/settings/agentSettingsPanel.ts` | `AgentBudgetConfig` 增 `thinking` 段;normalize;reset 语义 |
| `src/extension.ts` | 初始化 registry 全局 level;getBudget/updateBudget 读写 thinking 段 + 同步 registry |
| `webview/agentSettingsPanel.html` | 新增「思考模式」卡片(开关 select + 强度下拉) |
| `webview/agentSettingsPanel.ts` | thinking 段读写 + 协议扩展 |
| `tests/*` | 新增/适配 normalize、registry fallback、configuration 读取测试 |

## 验收

- `npm test` 全绿(agentSettings/capabilityRegistry/configuration 相关新增测试覆盖面广)。
- `npm run compile`(tsc --noEmit)通过。
- 面板保存 thinking 段后:
  - `dsbAgent.thinking.enabled` 与 `dsbAgent.thinking.level` 写入 Global;
  - `capabilityRegistry.resolve` 对未指定 level 的模型得到全局 level 兜底;
  - Provider 面板设置了模型级 level 的模型不受影响(override 优先)。
