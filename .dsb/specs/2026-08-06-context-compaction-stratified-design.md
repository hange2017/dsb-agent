# 上下文分轨压缩 + 冷存储回查 + 增量压缩 — 设计

> 日期:2026-08-06 · 状态:✅ 已实施(T1–T9 全部完成,2026-08-08 全量 662 测试绿 + tsc + compile)
> 关联:`.dsb/specs/2026-08-06-session-memory-project-scope-design.md`、`.dsb/specs/2026-08-06-skill-list-injection-optimization-design.md`
> 计划:`.dsb/plans/2026-08-06-context-compaction-stratified-plan.md`

## 1. 背景与问题(实测数据)

`ContextManager.compact` 在历史占用 ≥ 窗口 80% 时触发,把最近 4 条以外的**全部历史**交给 LLM 生成 ≤2000 tokens 摘要(100:1 压缩比),tail 4 条保留。

真实会话(280 条消息 / 165 轮)历史 453K 字符 ≈ 226K tokens 构成:

| 类别 | 占比 | 信息价值 | 现状处理 |
|------|------|---------|---------|
| tool_result | 49.4% | ★★★(报错/路径关键,冗余多) | 一锅端进 LLM 摘要 |
| thinking | 24.9% | ★(推理过程,非事实) | 进摘要(浪费) |
| tool_use 参数 | 21.8% | ★★(执行记录,含全文入参) | 进摘要(浪费) |
| assistant 文本 | 3.7% | ★★★★(结论/方案) | 进摘要(100:1 丢失) |
| 用户文本 | 0.2% | ★★★★★(需求真相) | 进摘要(不可再生丢失) |

**问题**:
1. 五类消息重要性差异大,却无差别 100:1 重述——需求真相与推理过程同等对待;
2. thinking 与 tool_use 参数合计 46.7%,几乎可无损剥离/结构化,白白占用摘要预算;
3. 压缩后过程不可查:具体报错、具体输出永远消失;
4. 每次压缩对全部历史重算,O(全历史)成本,且"摘要的摘要"层层衰减。

## 2. 目标与非目标

### 目标
1. **分轨压缩**:五类消息按重要性独立处理(需求/结论零压缩、解释低压缩比、工具结构化、thinking 剥离),合并为结构化压缩块;
2. **过程可查**:被剥离/截断的原文转存冷存储,压缩块内留 `[ctx:seq]` 指针,新增 `ContextRecall` 工具按需回查;
3. **增量压缩**:第二次及以后的压缩只处理新增段,旧压缩块不重算,O(增量)成本;
4. **触发阈值**:80% → 70%(可配置),更早更平滑;
5. **记忆索引联动**:索引瘦身(项目 top-K + 全局 top-K + desc 截断)+ 会话进度记忆 body 精简。

### 非目标(后续)
- 压缩块 → 记忆的自动沉淀管道。(其余两项已于 2026-08-08 实施,见修订历史)

## 3. 设计

### 3.1 分轨压缩总览

`compact(history)` 对 head(除最近 4 条,防拆 tool_use/tool_result 对)做类型级分流:

```
head
 ├─► 需求轨   user 文本        → 原文保留(带轮次序号)
 ├─► 结论轨   assistant 结论/方案 → 原文保留
 ├─► 解释轨   assistant 解释   → 低压缩比 LLM 摘要(保留 ≥60-70%)
 ├─► 履历轨   tool_use        → 结构化一行(规则,零 LLM)
 ├─► 履历轨   tool_result     → 关键行 + 原文转存冷存储
 └─► thinking                → 剥离(零事实损失)

输出 = [压缩块(user 消息), ...tail]
```

### 3.2 轨道规则

| 轨 | 输入 | 处理 | 保真 |
|----|------|------|------|
| 需求 | 用户文本 | 原文,`[r{n}]` 前缀;>2KB 截断 + 指针 | 100% |
| 结论 | assistant 文本段(判定为结论) | 原文 | 100% |
| 解释 | assistant 文本段(判定为解释) | LLM 摘要,目标保留 60-70%(压缩比 30-40%) | 60-70% |
| 工具履历 | tool_use | per-tool 参数摘要一行 | 结构化(≈10%) |
| 工具结果 | tool_result | 成功短输出原文;成功长输出关键行(前 6 + 尾 2);失败保留报错首行;原文转存冷存储 | 关键行 + 可回查 |
| thinking | assistant thinking 块 | 删除 | — |

### 3.3 assistant 结论/解释切分(段落级启发式)

按空行/标题切段,每段独立判定:

| 信号 | 结论(保留) | 解释(摘要) |
|------|-----------|-----------|
| 结构 | bullet/编号/表格/代码块/`##` 标题 | 连续散文 |
| 位置 | 首段/末尾总结段 | 中间展开段 |
| 长度 | 整条 <300 字符 | 长回复中段 |
| 结论词 | 含"方案/结论/决定/推荐"/文件名/数字 | 无 |
| 工具关联 | 纯文本轮(无 tool_use) | 伴随 tool_use 的展开 |

粒度:**段落级**,一条回复可"结论段保留 + 解释段摘要"。

### 3.4 压缩块格式(单条 user 消息)

```
[前文摘要]
## 需求
- [r1] <原文>
## 结论
- [r3] <结论段原文>
## 说明
- [r3] <解释段摘要>
## 工具履历
- [r2] Read: src/a.ts
- [r4] Bash: npm test → 606 passed [ctx:1-4]
```

- 前缀 `[前文摘要]` 兼容现状;首行内嵌内部标记 `[compacted]` 供增量检测;
- 履历行格式:`- [r{round}] {Tool}: {摘要} [ctx:{chunk}-{seq}]?`。

### 3.5 冷存储(ContextStore)

```
.dsb/context/<projectKey>/<sessionId>/
  index.json        ← { nextSeq, entries: { [seq]: { chunk, round, type, tool } } }
  chunk-000001.json ← [{ seq, round, type, tool, content }]
```

- **写入**:compact 时被剥离/截断的原文(tool_result 全文、tool_use 参数、解释段原文);
- **seq**:全局递增,指针 `[ctx:{seq}]`;
- **读取**:`read(seq)` 查 index → 读 chunk 文件;
- **上限**:总量 >10MB 时删最旧 chunk(同步更新 index),fail-open;
- **清理**:会话删除时 `clear()`;
- **纯 Node fs**,无 vscode 依赖,可单测。

### 3.6 ContextRecall 工具

```
ContextRecall { input: { seq: number } }
→ ok: { round, type, tool, content } 文本化返回
→ 未找到: ok:false "Context entry not found: {seq}"(fail-open)
```

- 从压缩块指针看到 seq → 需要细节时调用;回显进该轮历史,仅在需要时产生 token;
- 工具定义进 `tools.allToolDefs()`,agent 模式可用;plan/ask 白名单内(只读)。

### 3.7 增量压缩

- 压缩块 user 消息首行带 `[compacted]` 标记;
- 第二次 compact:`history[0]` 是压缩块 → 原样保留,只对 `history.slice(1, cut)` 的新增段分轨处理,结果**追加**到压缩块后(压缩块 v2 = v1 + 新增段);
- 摘要请求每次只发新增解释轨(小),O(增量);
- 压缩块总长上限 8KB,超出时对最旧解释段做一次轻摘要(后续迭代,本次先简单截断最旧段并提示)。

### 3.8 触发阈值

- `DEFAULT_TRIGGER_RATIO` 0.8 → **0.7**(常量),新增配置 `dsbAgent.compaction.triggerRatio`(可选,读 configuration,缺省 0.7)。

### 3.9 记忆索引联动

1. **索引瘦身**:
   - `MemoryStore.index(label, opts?: { limit?, maxDescLen? })`;list() 按 updatedAt 降序取前 limit;
   - 注入:项目 `index("项目", { limit: 30, maxDescLen: 60 })` + 全局 `index("全局", { limit: 5, maxDescLen: 60 })`;
   - 不传 opts 时行为不变(向后兼容);
2. **会话进度 body 精简**:`buildSessionProgressMemory` 去掉"最近工具"长列表(保留最近 3 条且每行 ≤80 字符);工具履历在冷存储/JSONL 中已有;
3. 压缩→记忆管道:**不做**(后续)。

## 4. 影响文件

| 文件 | 变更 |
|------|------|
| `src/agent/contextCompactor.ts`(新) | 分轨纯函数:分类/摘要映射/关键行/合并块 |
| `src/agent/contextStore.ts`(新) | 冷存储:index/chunk/read/prune/clear |
| `src/agent/contextManager.ts`(改) | compact 分轨 + 增量;options 增加 contextStore、summarize 签名改纯文本 |
| `src/agent/agentLoop.ts`(改) | summarizeMessages 改文本摘要;triggerRatio 0.7 |
| `src/agent/tools/contextRecallTool.ts`(新) | ContextRecall 工具定义 + 解析 |
| `src/agent/tools/executor.ts`(改) | ContextRecall 分支;注入 contextStore |
| `src/chat/chatViewProvider.ts`(改) | 装配 contextStore(按 projectKey/sessionId);记忆索引 top-K 注入 |
| `src/agent/memory/memoryStore.ts`(改) | index() 支持 limit/maxDescLen |
| `src/session/sessionProgress.ts`(改) | 最近工具列表精简 |
| `src/settings/configuration.ts`(改) | compaction.triggerRatio 可选配置 |
| `src/agent/modePolicy.ts`(改) | ContextRecall 进 plan/ask 白名单(只读) |
| 测试 | contextCompactor / contextStore / contextRecall / contextManager / memoryIndex / sessionProgress |

## 5. 测试计划

- compactor:文本段分类(结论/解释)、per-tool 摘要映射、tool_result 关键行抽取、压缩块格式;
- 冷存储:写读往返、seq 递增、prune 上限、clear、损坏文件 fail-open;
- ContextRecall:命中/未命中/无 store 回退;
- contextManager:分轨压缩输出结构、tail 4 条保留、防拆 tool_use/tool_result、增量(第二次只处理新增)、无冷存储退化;
- 记忆索引:limit/desc 截断/向后兼容;
- sessionProgress:body 精简后不含长工具列表;
- 全量回归 + compile + tsc。

## 6. 修订历史

| 日期 | 说明 |
|------|------|
| 2026-08-06 | 初版:方案 B 分轨压缩 + 冷存储 + 增量;用户确认结论/解释区分、过程可查定位 |
| 2026-08-08 | 已实施。与初版的实现偏差(等价或简化):冷存储改为单文件 `<contextRoot>/<sessionId>.context.json`(chunks 数组 + compacted/pruned 计数,避免碎片);块行 `[r{n}]` 的 `n` 即冷存储 seq,不再另加 `[ctx:seq]` 指针;seq 为实例级单调计数器(增量压缩从旧块推断已用最大序号继续推进,避免碰撞);记忆注入 maxDescLen 用 120、会话进度工具行 100 字符;压缩块 8KB 上限与最旧解释段再摘要未实施(留作后续迭代) |
| 2026-08-08 | 后续迭代完成:① 压缩块 8KB 上限(`maxBlockChars`,默认 8000):超限先对最旧解释段再摘要(预算 maxCompactTextTokens/4),其次截断超长行(240),仍超限放行保需求原文;② 冷存储跨会话合并/去重:`listSessions`/`mergeView`(只读聚合视图,内容去重,chunk 附 `session`)/`dedupe`/`merge`(物理合并到 `__all__` 并删源),ContextRecall query 模式本会话无命中时自动跨会话检索;③ 冷存储 UI 浏览页:命令 `dsbAgent.contextBrowse` + `src/settings/contextPanel.ts` + `webview/contextPanel.ts/.html`(会话列表/类型过滤/展开全文/清空/删除/合并去重),全量 675 tests 绿 + tsc + compile |
| 2026-08-08 | 追加:压缩块上限自适应——`maxBlockCharsHard`(默认 maxBlockChars×4=32KB):再摘要后仍超默认上限但未超硬上限时自动扩容返回(不截断,避免损失),仅超硬上限才截断超长行;全量 677 tests 绿 + tsc + compile |
| 2026-08-08 | 追加:冷存储会话索引(A+C)——每会话旁新增 `<session>.index.json`(seq/type/role/summary/ts/hash,无 content,约原文 1/10);`contentHash`(djb2)使索引不存 content 也能准确跨会话去重;统一 `persist` 原文+索引同步原子写,`delete` 连删索引;`index()/stats()` 改读索引、`mergeView` 基于索引聚合;mtime+size 内存缓存;旧会话无索引惰性迁移,损坏重建 fail-open;ContextRecall 跨会话匹配 summary/type(不再匹配 content 全文);浏览面板列表统计不再 load 全文;全量 685 tests 绿 + tsc + compile |
