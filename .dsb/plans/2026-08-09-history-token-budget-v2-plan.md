# 流水线式预算压缩实现计划 v2

> 日期:2026-08-09 · spec:`.dsb/specs/2026-08-09-history-token-budget-v2-design.md`
> 基线:837 tests / 93 files 全绿

## 文件结构

| 文件 | 责任 | 变更 |
|---|---|---|
| `src/settings/configuration.ts` | `contextWindowTokens()`(默认 0=跟随模型)/ `triggerPct()`(默认 0.75)/ `targetPct()`(默认 0.5,约束 0<target<trigger≤1) | 改 |
| `src/agent/contextManager.ts` | options 增 `triggerPct?`/`targetPct?`;`needsCompaction(messages?)` 加 tail 自驱动触发;compact 压缩目标改 targetPct(压缩块/thinking/tail 三处) | 改 |
| `src/agent/agentLoop.ts` | deps 增 `windowTokensOverride?`/`triggerPct?`/`targetPct?`;自建 ContextManager 传入;`needsCompaction(this.messages)` 传参;窗口覆盖生效 | 改 |
| `src/chat/chatViewProvider.ts` | new AgentSession 透传新配置 | 改 |
| `src/settings/agentSettingsPanel.ts` | 协议 state 增 windowTokens/triggerPct/targetPct;budget_update 携带;services.getBudget/updateBudget 扩展 | 改 |
| `webview/agentSettingsPanel.ts/.html` | 面板新增:窗口总长度输入、触发比例/目标比例输入 | 改 |
| `src/extension.ts` | services 装配扩展(读/写 5 项配置) | 改 |
| `package.json` + nls | 配置项 `contextWindowTokens`/`triggerPct`/`targetPct` + 文案 | 改 |
| `src/i18n/strings.ts` | 面板新文案中英 | 改 |
| `tests/*` | configuration/contextManager/agentLoop/agentSettingsPanel 各补用例 | 改 |

## 任务清单

### T1 基线确认
- [ ] `npm test` 837 全绿;`npx tsc --noEmit` 通过

### T2 configuration 新配置项
- [ ] `contextWindowTokens()`:读 `dsbAgent.contextWindowTokens`,默认 0(跟随模型),非有限数/<0 回退 0
- [ ] `triggerPct()`:读 `dsbAgent.compaction.triggerPct`,默认 0.75,(0,1] 有效
- [ ] `targetPct()`:读 `dsbAgent.compaction.targetPct`,默认 0.5,约束 0 < target < trigger(读取时与 triggerPct 比较,非法回退 0.5)
- [ ] tests/configuration.test.ts 追加;commit `feat(config): 窗口总长度 + 触发/目标比例配置`

### T3 ContextManager 流水线(核心)
- [ ] options 增 `triggerPct?`/`targetPct?`(缺省 0.75/0.5)
- [ ] `needsCompaction(messages?)`:保留窗口判定(ratio ≥ triggerRatio);新增 tail 自驱动——messages 存在时计算 tail token(tail 边界 = 压缩块/thinking 块之后的连续消息,复用现有 isCompactedMessage/isThinkingMessage),`tailToken ≥ floor(historyTokenBudget×split.tail)×triggerPct` 也触发
- [ ] `compact()`:
  - tailKeepCount 目标改为 `floor(tail额定×targetPct)`(压缩后 tail 回目标线;触发线 75% 由 needsCompaction 负责)
  - 压缩块收缩目标改为 `floor(compacted额定×targetPct)`(v1 是 100% 预算,现为 50%)
  - thinking 收缩目标改为 `floor(thinking额定×targetPct)`
  - 压缩产物追加/合并逻辑沿用 mergeCompactedTracks(追加语义),seq 继续推进
- [ ] tests/contextManager.test.ts 追加:
  - tail 涨到额定×75% 触发(窗口占比低时也触发);压缩后 tail ≤ 额定×50%
  - 压缩块收缩到额定×50%(不超 target)
  - thinking 收缩到额定×50%
  - 窗口兜底仍触发(ratio ≥ 0.75)
  - 自定义 triggerPct/targetPct(如 0.8/0.4)生效
  - 预算关闭回退现状
- [ ] 跑相关测试;commit `feat(context): 流水线触发与目标线(tail 自驱动 + 50/75 滞回)`

### T4 agentLoop / chatViewProvider 装配
- [ ] agentLoop:deps 增 `windowTokensOverride?`/`triggerPct?`/`targetPct?`;自建 ContextManager 传入;`windowTokensOverride>0` 时覆盖 `effectiveContextWindowTokens`;`needsCompaction(this.messages)` 传参
- [ ] chatViewProvider:new AgentSession 传 `windowTokensOverride: this.configuration.contextWindowTokens()`、`triggerPct`、`targetPct`
- [ ] tests/agentLoop.test.ts 追加:tail 自驱动触发在 agentLoop 全链路生效(小窗口大 tail 场景);覆盖配置透传
- [ ] 跑相关测试;commit `feat(loop): 透传窗口覆盖与触发参数`

### T5 设置面板扩展
- [ ] agentSettingsPanel.ts:state 增 windowTokens/triggerPct/targetPct;budget_update 携带;normalize 校验(0<target<trigger≤1)
- [ ] webview HTML/TS:窗口总长度输入(0=跟随模型,placeholder 显示模型默认)、触发比例输入、目标比例输入;保存/恢复默认包含新参数
- [ ] extension.ts:services.getBudget 返回 5 项;updateBudget 写 5 项(比例项 object/数字)
- [ ] package.json + nls + i18n:3 个配置项 + 面板文案
- [ ] tests/agentSettingsPanel.test.ts 追加:state 5 项下发、update 写 5 项、非法 target≥trigger 回退
- [ ] 编译 + 单测;commit `feat(settings): 参数面板扩展(窗口/触发/目标)`

### T6 全量验证 + 文档同步
- [ ] `npm test` 全绿;tsc;compile;dist 同步(agentSettingsPanel.*)
- [ ] 冒烟:真实会话 provider_send 统计每块 ≤ 额定;tail 触发符合滞回
- [ ] 文档:remaining-issues.md(v2 关闭项)、agentarchitecture.md(ContextManager 行)、changelog、spec 状态
- [ ] 最终验证;commit `docs: 同步流水线压缩 v2 状态`

## 关键实现要点

- **触发判定进 needsCompaction(messages)**:ContextManager 需要 messages 才能算 tail token;兼容旧签名(不传则只窗口判定)。
- **tail 边界识别**:复用 `isCompactedMessage`/`isThinkingMessage`——messages 从头部跳过压缩块/thinking 块后即 tail。
- **目标线统一**:触发后压缩块/thinking/tail 都收缩到各自的 `额定×targetPct`;触发线由 needsCompaction 用 `额定×triggerPct` 判定。
- **窗口覆盖**:`windowTokensOverride>0` 时代替 `effectiveContextWindowTokens(caps)`(影响 ratio 分母 + CapabilityGate max_tokens)。
- **回退保证**:`historyTokenBudget=0` 走现状(固定 4 条/窗口触发);`triggerPct/targetPct` 缺省 0.75/0.5 与现状等价。

## 验收

1. 面板 5 参数可调并持久化(窗口/总预算/比例/触发/目标);
2. tail 自驱动:tail ≥ 额定×75% 即压缩(窗口占比低也触发),压缩后回 50%;
3. 压缩块滚动:追加 + 收缩到额定×50%;
4. 窗口兜底:ratio ≥ 0.75 仍触发;
5. 全量测试绿 + tsc + compile + dist。
