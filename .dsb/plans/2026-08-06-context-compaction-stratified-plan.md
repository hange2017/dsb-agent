# 上下文分轨压缩 + 冷存储 + 增量压缩 实现计划

> For agentic workers:每任务 TDD(先测试→最小实现→全绿→compile→commit)。
> 关联 spec:`.dsb/specs/2026-08-06-context-compaction-stratified-design.md`

**Goal:** 历史压缩从"整段 100:1 LLM 重述"改为"分轨处理"(需求/结论零压缩、解释低压缩比、工具结构化、thinking 剥离)+ 冷存储过程可查 + 增量压缩,并把记忆索引瘦身。

**Architecture:** 新增纯 TS `contextCompactor`(分类/摘要映射/关键行/合并块)与 `contextStore`(冷存储 fs,无 vscode 依赖);`ContextManager.compact` 改分轨 + 增量;新增 `ContextRecall` 工具;`memoryStore.index` 支持 limit/desc 截断。

## Phase 1 — 分轨压缩核心

### T1. contextCompactor 纯函数
- [ ] 新建 `tests/contextCompactor.test.ts`:
  - `classifyAssistantText`:bullet/标题/代码块/短文本 → 结论;散文长段 → 解释;段落级混合切分
  - `summarizeToolUse`:Read/Write/StrReplace/Bash/Grep/WebSearch/Agent/MemoryRead/未知 各一行摘要
  - `extractKeyLines`:成功短输出原文;长输出前6+尾2;失败保留报错首行
  - `buildCompactedBlock`:`[前文摘要]\n[compacted]\n## 需求…## 结论…## 说明…## 工具履历…` 结构
  - `isCompactedBlock` 检测
- [ ] 新建 `src/agent/contextCompactor.ts`
- [ ] 相关测试全绿;compile;commit `feat(context): 分轨压缩纯函数(分类/摘要映射/关键行/合并块)`

### T2. contextStore 冷存储
- [ ] 新建 `tests/contextStore.test.ts`:写读往返/seq 递增/read 未命中/损坏文件 fail-open/prune 上限/clear
- [ ] 新建 `src/agent/contextStore.ts`(`.dsb/context/<projectKey>/<sessionId>/` index.json + chunk-*.json;总量 >10MB prune 最旧)
- [ ] 全绿;compile;commit `feat(context): 冷存储 ContextStore(index/chunk/prune)`

### T3. ContextManager 分轨 + 增量
- [ ] 改 `tests/contextManager.test.ts` + 新增用例:
  - 分轨输出结构(含各轨标题)、tail 4 条保留、防拆 tool_use/tool_result
  - 增量:history[0] 为压缩块时只处理新增段,旧块不重算(summarize 只收新增解释文本)
  - 无 contextStore 退化(不写冷存储)
  - summarize 签名:纯文本(text, {maxTokens})
- [ ] 改 `src/agent/contextManager.ts`:compact 分轨(调 compactor + store.writeChunk 回填 [ctx:seq]);增量检测
- [ ] 全绿;compile;commit `feat(context): compact 分轨压缩 + 增量(冷存储指针)`

### T4. agentLoop 接线(文本摘要 + 阈值 0.7)
- [ ] 改 `tests/agentLoop*.test.ts` 或新增:summarize 走文本摘要;DEFAULT_TRIGGER_RATIO=0.7
- [ ] 改 `src/agent/agentLoop.ts`:summarizeMessages 接收纯文本;常量 0.8→0.7;deps 增加可选 contextStore 传入自建 ContextManager
- [ ] 全绿;compile;commit `feat(context): agentLoop 文本摘要 + 触发阈值 0.7`

## Phase 2 — ContextRecall 工具

### T5. ContextRecall 工具 + executor + 白名单
- [ ] 新增测试:executor ContextRecall 分支(命中/未命中/无 store fail-open);modePolicy 白名单含 ContextRecall
- [ ] 新建 `src/agent/tools/contextRecallTool.ts`;改 `src/agent/tools/executor.ts`(注入 contextStore);改 `src/agent/modePolicy.ts`(plan/ask 只读白名单加入)
- [ ] 全绿;compile;commit `feat(tools): ContextRecall 按 seq 回查冷存储原文`

## Phase 3 — 装配与配置

### T6. chatViewProvider/extension 装配 + triggerRatio 配置
- [ ] extension.ts:装配 contextRoot(globalStorage/context)传入 provider;ChatViewProvider 构造参数 +createSession 内 `new ContextStore(contextRoot/projectKey/sessionId)` 注入 AgentSession
- [ ] configuration.ts:`dsbAgent.compaction.triggerRatio`(缺省 0.7);agentLoop 读取(经 deps 或 configuration)
- [ ] 相关测试(配置解析/装配冒烟);全绿;compile;commit `feat(context): 装配冷存储目录与压缩阈值配置`

## Phase 4 — 记忆索引联动

### T7. memoryStore.index limit/desc 截断 + top-K 注入
- [ ] 改 `tests/memoryStoreScoped.test.ts` + 新增:index({limit,maxDescLen}) 截断与降序;不传参数行为不变
- [ ] 改 `src/agent/memory/memoryStore.ts`;改 `src/chat/chatViewProvider.ts` 注入项目 top-30 + 全局 top-5
- [ ] 全绿;compile;commit `feat(memory): 记忆索引瘦身(项目 top-30/全局 top-5/desc 截断)`

### T8. sessionProgress body 精简
- [ ] 改测试:最近工具列表 ≤3 条且每行截断;body 不再含长工具列表
- [ ] 改 `src/session/sessionProgress.ts`
- [ ] 全绿;compile;commit `feat(context): 会话进度记忆精简(去长工具列表)`

## Phase 5 — 验收

### T9. 验收
- [ ] `npx vitest run` 全量全绿;`npx tsc --noEmit`;`npm run compile`
- [ ] 构造 fixture 会话历史 → 触发 compact → 检查压缩块结构 + 冷存储文件 + ContextRecall 回查(脚本冒烟)
- [x] 更新 `.dsb/specs/2026-08-06-context-compaction-stratified-design.md` 状态为已实施;更新 `docs/remaining-issues.md` / `docs/architecture/agentarchitecture.md` / `docs/changelog-2026-08-06.md`
- [ ] 最终 commit
