# 历史信息 Token 预算实现计划

> 日期:2026-08-09 · spec:`.dsb/specs/2026-08-09-history-token-budget-design.md`
> 基线:812 tests / 92 files 全绿(commit `dc0cc20` 起)

## 文件结构

| 文件 | 责任 | 变更 |
|---|---|---|
| `src/stats/providerSendStats.ts` | 新增 `estimateMessageTokens(msg)` 单条消息估算(供 tail 累加与压缩块预算);`estimateProviderSendTokens` 内部复用它,行为不变 | 改 |
| `src/settings/configuration.ts` | 新增 `historyTokenBudget()`(默认 10000,<0 回退)/ `budgetSplit()`(默认 45/20/35,非法回退) | 改 |
| `src/agent/contextManager.ts` | `ContextManagerOptions` 增 `historyTokenBudget?` / `budgetSplit?`;compact 预算实现(tail 连续 slice + 压缩块预算内收缩 + thinking 预算内收缩;预算关闭回退现状) | 改 |
| `src/agent/agentLoop.ts` | deps 增 `historyTokenBudget?` / `budgetSplit?`,自建 ContextManager 时透传 | 改 |
| `src/chat/chatViewProvider.ts` | `new AgentSession` 传 `historyTokenBudget: this.configuration.historyTokenBudget()` 等;⚙ 设置面板加「参数设置…」按钮 → 命令 | 改 |
| `src/settings/agentSettingsPanel.ts`（新） | host 面板服务:读配置下发 `state`、接收 `budget_update` 写 Global 配置(归一化);协议类型 | 新 |
| `webview/agentSettingsPanel.ts`（新） | 面板 UI 逻辑:总预算数字输入 + 三滑块归一化 + 换算 tokens 显示 + 第二层置灰占位 | 新 |
| `webview/agentSettingsPanel.html`（新） | 面板 HTML:分区卡片布局(本次仅「上下文预算」区) | 新 |
| `src/extension.ts` | 注册命令 `dsbAgent.agentSettings`(createWebviewPanel + createAgentSettingsPanel) | 改 |
| `package.json` | contributes.commands 增 `dsbAgent.agentSettings`;configuration 增 `dsbAgent.compaction.historyTokenBudget` / `budgetSplit`;i18n 文案 | 改 |
| `src/i18n/strings.ts` | 新增面板文案中英 key | 改 |

## 任务清单

### T1 基线确认
- [ ] `npm test` 812 全绿;`npx tsc --noEmit` 通过

### T2 单条消息估算纯函数(providerSendStats)
- [ ] 在 `src/stats/providerSendStats.ts` 导出 `estimateMessageTokens(msg: ProviderMessage): number`:把现有遍历逻辑抽成单条估算(按 role/block 分类累加,口径不变);`estimateProviderSendTokens` 改为循环调用它,行为保持
- [ ] `tests/providerSendStats.test.ts` 追加:单条 user 文本 / tool_result / assistant(含 text+tool_use+thinking)/ image 的估算;整包 = 各条之和
- [ ] `npx vitest run tests/providerSendStats.test.ts` 全绿;commit `test(providerSendStats): 抽取单条消息 token 估算`

### T3 configuration 配置项
- [ ] `src/settings/configuration.ts`:
  - `historyTokenBudget(): number` 读 `dsbAgent.compaction.historyTokenBudget`,默认 10000,非有限数/<0 回退 10000
  - `budgetSplit(): { compacted; thinking; tail }` 读 `dsbAgent.compaction.budgetSplit`(getJson),三项均为有限数且 >0 且和 >0 时按和归一化,否则回退 `{0.45, 0.20, 0.35}`
- [ ] `tests/configuration.test.ts` 追加:默认值;自定义有效值归一化;非法(缺项/负数/非数/全 0)回退
- [ ] 跑该测试全绿;commit `feat(config): historyTokenBudget + budgetSplit 配置项`

### T4 ContextManager 预算实现(核心)
- [ ] `ContextManagerOptions` 增 `historyTokenBudget?: number`(0/缺省=关闭)、`budgetSplit?: { compacted; thinking; tail }`
- [ ] `compact()`:
  - 预算关闭(≤0)→ 现状逻辑不变(keepTail=4 / maxBlockChars 8K 自适应 / thinking 6000→4000)
  - 预算开启:
    - `tailBudget = floor(total × split.tail)`;从尾部向前累加 `estimateMessageTokens`,预算内尽量多留(**当前轮必留**:keep 为 0 时无条件保留第一条);cut 点向前扫描不拆散 `tool_use/tool_result`(复用 `isToolResultUserMessage`)
    - 压缩块:`ensureBlockFits` 的目标与硬上限都改为 `floor(total × split.compacted)`(token 口径,用 `estimateTokens` 对块行估算);**取消 4× 自适应扩容**,超限按三段式收缩(再摘要 → 截断超长行 → 按 seq 最旧截断轨道行)到预算内
    - thinking 块:`ensureThinkingFits` 阈值/目标改为 `floor(total × split.thinking)`(token 口径)
- [ ] `tests/contextManager.test.ts` 追加:
  - 预算开启:tail 条数随预算缩放(预算小→保留少,预算大→保留多)
  - 当前轮必留:预算极小(如 10 tokens)仍保留最后一条 user
  - 防拆散:cut 落在 tool_result 时向前扩展
  - tail 为连续 slice:并入压缩的是最旧消息
  - 压缩块:预算内收缩,不超预算(不 4× 扩容)
  - thinking:预算内滚动收缩
  - 预算关闭:与现状完全一致(回归)
- [ ] `npx vitest run tests/contextManager.test.ts tests/agentLoop.test.ts` 全绿;commit `feat(context): 历史 token 预算(三层比例)压缩实现`

### T5 agentLoop / chatViewProvider 装配
- [ ] `src/agent/agentLoop.ts`:deps 增 `historyTokenBudget?` / `budgetSplit?`,自建 ContextManager 时传入;`ContextManagerOptions` 类型检查
- [ ] `src/chat/chatViewProvider.ts`:`new AgentSession` 传 `historyTokenBudget: this.configuration.historyTokenBudget()`、`budgetSplit: this.configuration.budgetSplit()`
- [ ] `tests/agentLoop.test.ts` 追加:注入自定义预算时透传(可用假 ContextManager 捕获 options);缺省时回退现状
- [ ] 跑相关测试;commit `feat(loop): 透传历史 token 预算配置`

### T6 独立参数设置面板
- [ ] `src/settings/agentSettingsPanel.ts`(新):
  - 协议:`state`(host→webview: budget, split, locale) / `budget_update`(webview→host: budget, split)
  - `createAgentSettingsPanel(services)`:services 含 `getLocale` / `getBudget(): { budget; split }` / `updateBudget(budget, split)`(写 Global 配置,split 归一化)
- [ ] `webview/agentSettingsPanel.html`(新):分区卡片;「上下文预算」区 = 总预算数字输入 + 三个滑块(带 % 与 tokens 换算显示)+ 第二层置灰占位;复用 memoryPanel 的样式模式(webview/styles.css 或内联)
- [ ] `webview/agentSettingsPanel.ts`(新):渲染 state;滑块拖动时其余等比例归一(总和恒 100%);改动防抖 post `budget_update`;toast 反馈
- [ ] `src/extension.ts`:注册 `dsbAgent.agentSettings` 命令(createWebviewPanel 复用 memoryManage 模式);`src/chat/chatViewProvider.ts` ⚙ 设置抽屉加「参数设置…」按钮(open_agent_settings → executeCommand)
- [ ] `package.json`:commands 增 `dsbAgent.agentSettings`;configuration 增两个配置项(含 description 与默认值)
- [ ] `src/i18n/strings.ts`:新增面板文案(标题/分组/字段/提示)中英
- [ ] 单测 host 逻辑:`tests/agentSettingsPanel.test.ts`(新)验证 getBudget/updateBudget 归一化与非法回退(用假 services 不依赖 vscode)
- [ ] 跑单测 + tsc;commit `feat(settings): 独立参数设置面板(上下文预算)`

### T7 全量验证 + 文档同步
- [ ] `npm test` 全绿;`npx tsc --noEmit`;`npm run compile`;确认 `dist/webview/agentSettingsPanel.*` 生成
- [ ] 冒烟(手动):真实会话触发压缩后 `~/.dsb/stats/*/events-*.jsonl` 中 `provider_send.tailTokens ≤ 预算×35%`
- [ ] 文档:`docs/remaining-issues.md`(关闭项)、`docs/architecture/agentarchitecture.md`(ContextManager 行)、`.dsb/docs/2026-08-09-stats-module-design.md`(预算联动)同步
- [ ] 最终全量验证;commit `docs: 同步历史 token 预算实现状态`

## 关键实现要点

- **估算口径统一**:预算判定与 `provider_send` 打点共用 `estimateTokens`(CJK≈1 token/字、其余≈1/4 字符),保证"预算所见 = 发送所测"。
- **tail 连续 slice**:消息顺序不可打乱,不能跳留;`cut = history.length - keep`;防拆散向前扫描复用现有 `isToolResultUserMessage`。
- **预算关闭回退**:`historyTokenBudget ≤ 0` 时 compact 走现有分支,行为零变化(回归测试证明)。
- **压缩块硬上限**:取消 `maxBlockCharsHard` 的 4× 自适应扩容;预算内三段式收缩后仍超 → 按 seq 最旧截断轨道行兜底(尽力而为,保证需求/结论原文优先)。
- **配置实时生效**:面板写 Global 配置;新会话(createSession)读取;会话内不热更新。
- **第二层预留**:UI 置灰占位 + `budgetSplit` JSON 层级可扩展,不实现。

## 验收

1. `npm test` 全绿 + tsc + compile + dist 同步;
2. 面板可打开(⚙ 按钮 + 命令),预算与比例可改并持久化;
3. 压缩后三块各 ≤ 预算×比例(单测断言);
4. `historyTokenBudget=0` 时与现状完全一致。
