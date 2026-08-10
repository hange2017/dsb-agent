# Thinking 独立压缩块实现计划

> 日期:2026-08-09 · spec:`.dsb/specs/2026-08-09-thinking-trace-compaction-design.md`
> 基线:685 tests / 82 files 全绿

## 任务清单

- [x] T1 基线确认(685 tests 全绿)
- [x] T2 contextCompactor 纯函数扩展:
      `THINKING_COMPACTION_RULES` 常量、`ThinkingBlockParts`、
      `buildThinkingBlock` / `parseThinkingBlock` / `mergeThinkingBlocks` /
      `isThinkingBlock` / `estimateThinkingChars` / `trimThinkingBlock`(丢最旧行) + 单测
- [x] T3 contextStore: `ColdChunkType` 增 `thinking`、`maxThinkingBytes`(默认 2MB)、
      prune 对 thinking 独立按字节淘汰(不挤占非 thinking 条数池) + 单测
- [x] T4 contextManager: stratify 收集 thinking + 配对上下文(同消息 text /
      该轮 tool_result 摘要 / 后续 1~2 轮 assistant text)、独立 thinking 块组装
      (位置:[压缩块, thinking块, ...tail])、滚动收缩(>3000 tokens → 丢至 ≤2000)、
      `thinkingEnabled` 开关 + 单测
- [x] T5 configuration: `dsbAgent.compaction.thinking` 配置项
      `compactionThinkingEnabled()`(缺省 true) + 单测
- [x] T6 agentLoop/modePolicy 装配: thinkingSummarize 注入规则、plan/ask 模式关闭
      (`thinkingEnabledForMode` + `ContextManager.setThinkingEnabled`)、
      冷存储 thinking chunk 回填、messages 组装位置 + 相关测试
- [x] T7 冒烟测试扩展 + 全量验证:npm test 718 tests / 82 files 全绿
      (基线 685 + 33 新增),npx tsc --noEmit 通过,npm run compile 通过

## 验证结果

- `npm test`:718 passed (82 files),全绿
- `npx tsc --noEmit`:无错误
- `npm run compile`:dist 构建成功
- 新增测试:
  - tests/contextCompactor.test.ts:thinking 纯函数 9 个(31 总)
  - tests/contextStore.test.ts:thinking chunk 5 个(30 总)
  - tests/contextManager.test.ts:thinking 收集/配对/收缩/兜底/开关/冷存储 9 个 + 冒烟 1 个(23 总)
  - tests/configuration.test.ts:compactionThinkingEnabled 1 个(9 总)
  - tests/modePolicy.test.ts:thinkingEnabledForMode 1 个(7 总)
  - tests/agentLoop.test.ts:装配 4 个(28 总)

## 实现偏差与说明

- spec §7「默认窗口 128K → 256K」已实施:`kDefaultContextWindowTokens` 128_000 → 256_000,
  **deepseek-v4-flash/pro 与 `deepseek-v4-` 前缀 profile 同步 256K**(用户明确要求默认用户生效;
  deepseek-chat/reasoner 保持 128K 不动),并同步更新依赖默认窗触发压缩的测试。
- thinking chunk 的 `summary` 在压缩成功后**回写为推理脉络行**(`ContextStore.updateSummaries`,
  失败时回写占位行,content 原文不变);`ContextRecall` 列表即可命中推理脉络。
- thinking 压缩输出**宽容解析**:模型不带 `[thinking]` 标记、行无 `- ` 前缀均可识别,
  按 `[r{n}]` 子串匹配避免有效脉络行被误判 missing 补占位。
- 滚动收缩字符估算:1 token ≈ 2 字符(中文折中),阈值 6000/4000 字符对应
  spec 的 3000/2000 tokens;数值可通过 options 覆盖。
- 预算修复:`summarizeMessages` 的 `maxTokens` 改为 `min(prepared.maxTokens, 预算)`,
  explanation 800 / thinking 3500 预算真正约束 provider 输出(此前被能力上限覆盖)。

## 验证结果(2026-08-09 追加)

- `npm test`:727 passed (82 files),全绿(718 + 9:updateSummaries 2、宽容解析 3、
  parse 宽容 2、profile 256K 1、summarize 预算 1)
- `npx tsc --noEmit` / `npm run compile` 通过
- 文档:`docs/architecture/agentarchitecture.md`(ContextManager/Compactor/Store 行、
  默认窗 256K、4.3 thinking 独立压缩、测试基线)、`docs/architecture/待优化.md`(P1-4 状态 + 修订表)、
  `docs/remaining-issues.md`(Thinking 独立压缩/默认窗 256K 已关闭项 + 冒烟项)已同步。



## 实现要点

- thinking 块格式:
  ```
  [thinking]
  ## 正确
  - [r9] 链路:...
  ## 错误
  - [r10] 方向:... | 结论:...
  ## 中性
  - [r12] 概要:...
  ```
- token↔字符估算:`chars ≈ tokens × 2`(中文折中),测试用小值注入
- 配对上下文:assistant 消息 i → thinking + 同消息 text + (i+1 tool_result 摘要)
  + 后续最多 2 条 assistant text(i+2, i+4 跳 tool_result)
- 滚动收缩:按字符估算总量,>trim 阈值 → 按 seq 从小到大丢整行,直至 ≤ trim 目标
- 开关:ContextManagerOptions.thinkingEnabled(缺省 true);agentLoop 按 mode + config 决定
- 失败兜底:thinking 摘要失败 → 占位行 `- [r{n}] 推理:(原文已省略)`,冷存储仍写原文
- 兼容:compact 返回 `ProviderMessage[]`,thinking 块为空/关闭时退化为现状
