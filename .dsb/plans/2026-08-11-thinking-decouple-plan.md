# 实现计划:thinking 数字解耦(模型侧能力 vs 处理侧流程)

> 生成时间:2026-08-11
> 关联清单:.dsb/docs/2026-08-11-缓存前缀稳定性优化清单.md

## 背景与目标

当前 `dsbAgent.thinking.enabled`(`thinkingEnabled()`)**同时捆绑**了三个职责(一个开关锁死全链路):
1. **请求层**:是否给模型带 thinking 预算(`withThinkingDisabled` → `thinkingDisabled:true`)。
2. **历史/剥离**:`supportsThinking:false` 触发 `sanitizeOutbound` 剥离历史 thinking 块。
3. **压缩/流程**:`setThinkingEnabled(false)` 让 contextManager 不收集/不压缩 thinking。

用户明确诉求:**解耦为两个正交开关**
- **模型侧能力**(`dsbAgent.thinking.enabled`):是否让模型「先思考」(请求带 thinking)。开=模型会产出 thinking。
- **处理侧流程**(`dsbAgent.compaction.thinking`,**已定义但未接入业务**):模型产出的 thinking 是否进入我们的信息处理流程(历史保留/压缩/脉络/冷存储)。关=即使模型思考了,我们也不保留不处理。

**首要用例**:模型侧开 + 处理侧关 → 模型先思考再回答,但流程不处理 thinking(思想发生但丢弃)。
另一个正交用例:模型侧关 + 处理侧开 → 模型不思考(等效无 thinking)。

## 正交语义矩阵

| 模型侧(`thinking.enabled`) | 处理侧(`compaction.thinking`) | 效果 |
|---|---|---|
| 开 | 开 | 模型思考 + 完整处理(现状 agent 模式默认)|
| **开** | **关** | **模型先思考再答,流程不处理**(丢弃思想)|
| 关 | 开 | 模型不思考(等效无 thinking)|
| 关 | 关 | 全关最省 |

## 实现方案

### 1. 配置层(已存在,仅澄清注释)
- `thinkingEnabled()`:`dsbAgent.thinking.enabled` → **模型侧能力开关**。
- `compactionThinkingEnabled()`:`dsbAgent.compaction.thinking` → **处理侧流程开关**(从「thinking 独立压缩块」语义扩展为「整条流程是否处理 thinking」)。两者都是 `!== "false"` 判开,已就绪。

### 2. agentLoop deps
在现有 `thinkingDisabled`(模型侧)旁新增:
```ts
/** 处理侧 thinking 流程开关:false 时即使模型产出 thinking 也剥离不保留/不压缩。缺省 true(=跟随现状)。 */
thinkingProcessEnabled?: boolean;
```

### 3. 模型侧:请求层(保持现状)
- `thinkingDisabled` 仍控制 `withThinkingDisabled`(请求带 `thinking.disabled:true` + `supportsThinking:false` 剥离历史)。
- 模型侧**开**时 `withThinkingDisabled` 不触发 → 请求带 thinking budget,模型可思考。

### 4. 处理侧:剥离本轮 thinking(核心新增)
在 `agentLoop` 构造 `effectiveProvider` 后,维护一个「处理侧是否剥离」标志:
- 当 `thinkingProcessEnabled === false` 时,即使模型产出 thinking(模型侧开),在 **push 进 messages 前**把 `assistantBlocks` 里的 `thinking` 块过滤掉 → 思想不落历史。
- 同时压缩时 `collectThinking` 需保持关闭(处理侧关)。

### 5. 处理侧:跨轮历史剥离(鲁棒)
- 若处理侧从「开」切到「关」,历史中已有的 thinking 块不应继续带进下一轮。处理侧 false 时,在发送前对 messages 额外 `stripThinkingBlocks`(无论 supportsThinking)。`stripThinkingBlocks` 已在 capabilityGate 导出。

### 6. 压缩收集
- `setThinkingEnabled` 现有参数 `!thinkingDisabled && thinkingEnabledForMode(mode)` 追加处理侧:改为 `(!thinkingDisabled && thinkingProcessEnabled !== false) && thinkingEnabledForMode(mode)`。

### 7. Webview / UI
- 菜单已可通过设置控制 `dsbAgent.thinking.enabled` 与 `dsbAgent.compaction.thinking`。检查 agentSettingsPanel 是否展示,若已展示则无需新增;若 compaction.thinking 未展示,可加一行说明(可选)。

### 8. 测试
- 新增 agentLoop 测试:模型侧开 + 处理侧关 → 首轮 assistant 产出 thinking,但 push 后 messages 中无 thinking 块;压缩不收集 thinking。
- 新增/修正 configuration 测试(compactionThinkingEnabled 语义)。

## 验证
- `npx vitest run tests/agentLoop.test.ts tests/contextManager.test.ts tests/settings/*` 全绿。
- `npx tsc --noEmit` 通过。
- 影响 system/messages 构造 → 跑 `python3 scripts/analyze-cache-prefix.py` 对比(本次仅新增独立开关,默认值 true 保持现状命中率)。

## 范围边界
- 不改变默认行为(两个开关缺省都开 → 完全等同现状)。
- 不改 provider/sanitizeOutbound 签名;剥离在 agentLoop 内完成。
