# DSBAgent vs deepseek-harness：同能力实现对照

> 日期：2026-08-22
> 依据：`.dsb/specs/2026-08-22-dsb-vs-dsh-capability-comparison-design.md`
> 范围：实现级机制对照；不做产品选型结论

## 阅读说明

**目标**：对同一 Agent 能力，写清 DSBAgent（下称 DSB）与 deepseek-harness / `dsh`（下称 DSH）各自如何实现、关键代码锚点、以及该实现方式的优缺点。

**非目标**：

1. 不写产品选型结论，也不写迁移 / 重写实施计划。
2. 不做性能基准实测；不修改两边业务代码。
3. 不逐行审计全部包，也不对每一行工具实现做对比。

**路径约定**：文中 DSB 路径前缀为 `DSBAgent/`，DSH 为 `deepseek-harness/`（相对各自仓库根）。

**怎么读**：§1 先立坐标系（组装 / 内核 / 扩展语言 / 运行载体 / 真相来源）。§2 核心五件套写满实现级；§3 其余能力同模板、可略短；§4 横切收束；§5 术语对照。每节固定：能力定义 → DSB 实现 → DSH 实现 → 优缺点。证据优先级：源码 > DSB `.dsb/docs` > DSH `docs/` 与包 README；冲突以源码为准。

## 1. 组织范式总览

两端不是「同一内核换皮」，而是两种组装哲学。下表只建坐标系，不展开循环 / 工具 / 压缩细节。

| 维度 | DSB | DSH |
|------|-----|-----|
| 组装方式 | `src/extension.ts` 激活时拼好 `deps`，注入 `AgentSession`（`src/agent/agentLoop.ts`） | profile（`web` / `headless`）按序叠 bundle；组合包用 `cordis.patch.yml`（示例侧亦见 `cordis.yml`）挂插件树 |
| 「内核」 | `src/agent/` 相对固定；宿主桥（`src/chat/chatViewProvider.ts`）只接线 UI | 无特权内核；默认驱动是 `packages/core/agent-loop/`（`ctx.agentLoop`），可整包替换 |
| 扩展语言 | 接口注入 + `onEvent`；旁路为 `src/plugins/`、`src/mcp/`、`src/hooks/hookRunner.ts` | Cordis：`ctx.effect()` / `ctx.waterfall()`；能力 seam（Definition / Provider / Consumer） |
| 运行载体 | VS Code Extension（`package.json` contributes）；引擎可被 `benchmark/cli.ts` headless 复用 | 独立进程：`packages/host/` + `packages/client/`（web）、headless、`packages/acp/`、`packages/sdk/` |
| 真相来源 | 循环内 `messages` + `SessionStore` 会话四件套（`<globalStorage>/sessions/<projectKey>/*.jsonl`／`.api.json`／`.todos.json`／`.block.json`，`src/session/sessionStore.ts`）+ `ContextStore` 冷存储（`<globalStorage>/context/<projectKey>/*.context.ndjson`，旧 `.context.json` 惰性迁移，`src/context/contextStore.ts`）+ `~/.dsb/stats/.../events-*.jsonl` | 仅追加 `SessionEvent`（`packages/core/session/`，`ctx.sessions`）；`deriveMessages()` 投影；模型可见 ⟺ 已记录 |

后文按此坐标系对照：DSB 改能力多半改 `src/agent/` 或加注入；DSH 改能力多半挂事件或换 Provider。

## 2. 核心五件套

### 2.1 循环

#### 能力定义

把用户输入推进到「模型请求 →（可选）工具 → 再请求」，直到本轮不再欠工作。对照单位是：一轮内部怎么切（DSB 的 `round` vs DSH 的 turn/step）、扩展钩子挂在循环体内还是瀑布事件上、以及驱动器本身能否整包替换。压缩、工具语义、会话落盘只写它们相对循环的位置，细节留给后文。

#### DSB 实现

驱动器就是 `DSBAgent/src/agent/agentLoop.ts` 里的 `AgentSession`：宿主注入 `deps`，唯一入口是 `send(userText, onEvent, opts)`。一次 `send` 算一次对话（`stats.beginConversation()`），内部 `for (let round = 0; round < maxRounds; round++)` 绕圈；上限 `maxRounds ?? DEFAULT_MAX_ROUNDS`（`1_000_000`）。每圈顺序固定写在 `send` 里：`contextManager.needsCompaction` 则 `compact`（失败只 `onEvent` info，不中断）；抽出 `pendingAppends` 追加到 `messages` 尾部；`injectTodoIntoMessages` 仅在尾部已是普通 user 时改写尾消息（不进 system、不追加伪 user）；`prepareRound` 后 `provider.round`；无 `tool_use` 则 `done`，或按 `needsMaxTokensContinue` 推 `kMaxTokensContinueUserText` 再圈（上限 `kMaxTokensContinueLimit`，不发 `user_message`）；有工具则权限检查 + `mapParallelBatches` / `runWithConcurrency` 执行，全部 `tool_result` 落在紧随其后的一条 user 上，再回到圈顶。超 `maxRounds` 回滚并报 `Exceeded max tool rounds`。

旁路与收尾也在同一文件：`append(text)` 只 `push` 进 `pendingAppends`，下一圈顶部注入（busy 中途插话、前缀不改写）；`cancel()` 清空队列并 `abort`；`takePendingAppends()` 给空闲兜底重发。扩展不是逐步瀑布：生命周期 `hooks` 只在构造 `fireHook(..., "SessionStart")` 与 `send` 的 `finally` 里 `Stop`；对外是 `onEvent`（`AgentLoopEvent`：`text_delta` / `tool_call` / `usage` / `done` / `error` …）和 `onRecord` / `onPersist` / `agentPersist`。换驱动器等于换这个类（或改 `send` 循环体）。

#### DSH 实现

两级模型写在 `docs/architecture.zh.md` §轮次流程：一个 **步骤** = 一次模型请求 + 它调用的工具；一个 **轮次** = 零个或多个步骤——领取首条输入前 `turn/start`，不再欠工作时 `turn/end`。默认驱动器是 `packages/core/agent-loop/`：服务 `AgentLoop`（ctx 键 `ctx.agentLoop`），经 `ctx.agents.setFactory(this)` 注册，消费方走 `ctx.agents.create` / `resume`，不点名包内 `ReactLoopAgent`。`packages/core/agent/README.zh.md` 把 `Agent` 接口与 `agent/*` 词汇放在循环包之外（ctx 键 `ctx.agents`），因此循环可整包替换。

每步入口是 waterfall `agent/pre-step`（`reject` | `enter(messages)`）：可改写已领取批次或拒绝；首次领取被拒或改写为空则关掉一个不含步骤的持久轮次。通过后再 `step/start` → `agent/request` → `llm/stream` → 工具侧 `tools/pre-execute` / `tools/execute` / `tools/post-execute`；监听器必须 `next()` 才能委托。`agent/turn-stopping` 是 serial（无 `next()`），关轮前最后一刀。输入经 inbox：`followup()` → `next-turn` 并唤醒，`steer()` → `next-step` 并唤醒，`inject()` → 同 inbox 不唤醒。配置项 `DEFAULT_MAX_PARALLEL_TOOL_CALLS`（默认 10）限制每步并行池；README 写明**没有内置轮次预算**，失控轮次要挂 `agent/turn-stopping` 等既有点。压缩不在驱动器内：插件在 `agent/pre-step` 观测压力。

#### 优缺点

- **DSB 优点：** 圈控制、追加队列、压缩触发、续写、回滚/persist 同在 `agentLoop.ts`，单文件可推理、可用 `deps` + `onEvent` 脱离宿主单测；`DEFAULT_MAX_ROUNDS` 自带失控上限。
- **DSB 缺点：** 中途策略（拦截本圈请求、否决步骤、换驱动语义）多半改 `send` 循环体；钩子只有 SessionStart/Stop，没有逐步 veto；`round` 不是一等 turn/step 事件，驱动器不可整包替换。
- **DSH 优点：** `Agent` 与循环解耦，默认驱动可替换；扩展挂 `agent/pre-step` 等 waterfall，不必改 `packages/core/agent-loop/`；turn/step + `followup`/`steer`/`inject` 把「下一轮 / 本轮下一步 / 静默注入」分成一等路由。
- **DSH 缺点：** 可观测行为散在驱动器内部 + 多域事件，单文件推理性弱；无内置轮次预算；`pre-step` 拒绝仍落一条无步骤 `turn`，claim/inbox/空轮次增加调试面。

### 2.2 工具执行

#### 能力定义

把模型发出的 tool_use 变成真实副作用，并把结果写回对话。对照单位是：工具怎么注册进本轮可见集合、权限／门禁挂在哪、谁真正执行、结果如何落到模型可见历史；以及策略是会话内精简（DSB 的 toolUse／toolResult trim）还是流水线事件（DSH 的 pre／execute／post waterfall），能力组是否拆成 Definition／Provider／Consumer。循环只写「有工具则执行再回圈」；压缩与会话落盘只写它们相对工具结果的位置。

#### DSB 实现

注册与分发集中在 `DSBAgent/src/agent/tools/`：`definitions.ts` 的 `CORE_TOOLS` 是静态 schema 表（Read／Write／Bash／…＋Todo／Memory／ContextRecall）；`ToolExecutor`（`executor.ts`）再叠 MCP（`mcp.onTools` → `buildMcpToolDef`，名 `mcp__<server>__<tool>`）和插件（`registerPluginTools`，合格名 `plugin__<plugin>__<tool>`）。`allToolDefs()` 合并后经 `filterToolDefs` 按平台过滤，Bash 描述按当前 OS 重写。循环侧 `provider.round` 再按 `modePolicy.ts` 的 `isToolAllowed(mode, name)` 白名单（plan／ask 下写工具与 `mcp__` 不暴露）。权限在执行前：`PermissionManager.check`（`permission.ts`）先看会话模式 `bypassPermissions`／`acceptEdits`（仅 Write／StrReplace／Delete）／`onceApproved`，再 `PermissionRules.match` 得 deny｜allow｜ask，无规则默认 ask；拒绝写成 `ERROR: Permission denied` 的 tool_result，不进 `execute`。

执行入口是 `ToolExecutor.execute`：`fireHook(..., "PreToolUse")` → `dispatch`（`mcp__` 转发 registry、插件走 `commandPath`、其余 `CORE_TOOLS` switch 调 `workspaceFs`／shell／web／subagent）→ 成功才 `PostToolUse`。同轮并行由 `parallelSafe.ts` 的 `mapParallelBatches`：`PARALLEL_SAFE`（Read／Grep／Glob／LS／WebSearch／WebFetch）连续段可 `runWithConcurrency`，其余按原序串行；`serial` 或 `maxParallelTools<=1` 全串行。结果写回：同一条 assistant 的全部 `tool_result` 必须落在紧随其后的一条 user 上（`assertToolResultsComplete`）；`truncateToolResult` 截断。策略精简与执行同管道、为缓存前缀服务：`toolUsePolicy.ts` 对已消费 tool_use 的瞬时字段（`TRANSIENT_FIELDS`：Write.contents 等，阈值 `TRANSIENT_FIELD_MIN_CHARS`／`_BY_KEY`）换成 `[TRANSIENT-SUMMARY…]`，executor 的 Write／StrReplace 拒绝把省略标记写回文件；`toolResultPolicy.ts` 对已消费 tool_result 按 keep／trim／summarize 分类（Bash／Grep 等规则裁剪，MCP／插件未知格式超阈值才摘要）。写前定型让块首次进 `messages` 即最终形态。

#### DSH 实现

注册表是 `packages/core/tools/` 的 `ToolRuntime`（ctx 键 `ctx.tools`）。插件 `ctx.tools.register(definition)`：普通上下文全局、`agent.ctx` 只遮蔽本 agent；必须带规范 `output`；`schemas(agent)` 流入系统提示。呈现 `mode` 为 native／code／both，`presentAs` 可按 agent 遮蔽；`restrict` 是可见性掩码不是权限。流水线写在 `docs/tool-execution-pipeline.zh.md`：`tool/call` 落盘后先 `tools/pre-execute` waterfall（allow／deny／ask；ask 走 `ctx.approval`，无 seam 则退化 deny；**不能改写 arguments**）→ 单调 `ctx.tools.guard()`（后续 waterfall 不能把拒绝改回允许）→ `tools/execute` 环绕分发（超时／重试／指标，只能换 `signal`）→ 工具主体 → 写盘类再经 `fs/write-intent`／`fs/edit-intent` → `tools/post-execute`（接受可换 content 或 value、可附加 `additionalContexts`；阻止变成无值失败）→ 定义持有的同步 `finalizeContent`（只改 content）→ 仅观测的 `tools/result`；循环再追加持久 `tool/result`。`ctx.tools.execute` 冻结参数、分配不透明 token；`executionMode` 仅当 `isConcurrencySafe(args)===true` 才 parallel，未知／抛错一律 exclusive。循环把连续 parallel 放进有界池，exclusive 是顺序屏障；策略与持久结果仍按模型顺序。

能力组按 Definition／Provider／Consumer 拆：以 `packages/fs/README.zh.md` 为例，`fs/` 是 Service Definition（`ctx.fs` 路径／文本 I/O／原子变更与 `fs/*` 事件），`fs-local`／`fs-sandbox`／`fs-e2b` 是可替换 Provider，`tool-fs/` 是面向模型的 Consumer（`read`／`write`／`edit` 注册进 `ctx.tools`，经 `ctx.fs` 读写），`fs-observation-policy/` 只挂 `fs/*` 监听器、不是工具注入的服务——换沙箱或远程执行世界不必改 schema。MCP：每服务器一个插件，发现后 `register`。Code Mode 把保留 `run_code` 与子绑定再送入同一流水线（细节不在本节展开）。

#### 优缺点

- **DSB 优点：** 注册表、分发 switch、工作区 I/O 同在 `executor.ts`，`CORE_TOOLS` + `allToolDefs` 一眼看见本轮工具集；权限是循环体内同步 `check`，拒绝路径与执行路径同文件可单测；`toolUsePolicy`／`toolResultPolicy` 把瞬时参数与低密度结果在写历史前定型，直接服务缓存前缀。
- **DSB 缺点：** 工具与 `workspaceFs`／shell 实现耦在同一个 `dispatch` switch，换沙箱或远程 FS 要改执行器本体；策略（权限模式、trim 分类、并行白名单）落在循环与执行器内，没有可重排的 pre／post 门禁；MCP／插件只是命名转发，没有 Definition／Provider 缝。
- **DSH 优点：** `ctx.tools` 流水线与循环解耦，钩子／审批／超时挂 waterfall 不必改工具主体；Definition／Provider／Consumer（`fs/` 族）让换 `fs-sandbox`／`fs-e2b` 不改 `tool-fs` schema；`guard` 单调、`finalizeContent` 与 `tools/result` 观测边界清楚；并行由定义自己的 `isConcurrencySafe` 声明，不是硬编码工具名表。
- **DSH 缺点：** 一次调用要穿过 pre → guard → execute → post → finalize → result，可观测行为散在多包；`restrict` 不是权限、`pre-execute` 不能改写参数，策略作者要认清缝；Code Mode／子分发再入流水线增加调试面。

### 2.3 上下文与压缩

#### 能力定义

在窗口预算内组装模型可见历史；超预算时压缩或外置，并尽量可回查。对照单位是：谁判定该压（DSB 窗口兜底 + tail 预算 vs DSH `ctx.tokenMeter` 压力／溢出）、压缩产物怎么进入模型可见历史（DSB 把 `messages` 头部换成 `[compacted]` 块 vs DSH 仅追加 `surfaceOp: replace` 再由 `deriveMessages()` 投影）、以及被压原文能否回查（DSB 冷存储 + `ContextRecall`；DSH 日志保留已遮蔽事件，检索是独立的 `session-query`）。循环只写「圈顶／`pre-step` 触发」；工具 trim（§2.2 写前定型）与会话落盘只写它们相对压缩的位置。

#### DSB 实现

编排在 `DSBAgent/src/agent/contextManager.ts`。`needsCompaction(messages)` 是 OR：安全阀 `ratio >= triggerRatio`（`lastInput / windowTokens`，`agentLoop.ts` 缺省 `DEFAULT_TRIGGER_RATIO` 0.75），或 `historyTokenBudget` 开启时 tail token ≥ `tail额定 × triggerPct`（缺省 0.75）。预算关则固定 `keepTail`（缺省 4）+ `maxBlockChars`（缺省 8K）自适应；开则 `budgetInfo()` 按 `budgetSplit` 默认 `{compacted:0.45, thinking:0.2, tail:0.35}` 分摊，thinking 关时两段归一化为 compacted 0.5625／tail 0.4375。`agentLoop.send` 每圈顶部调用：成功则 `this.messages = sanitizeOutbound(...)` 并 `persistNow()`（避免「盘上全量、内存已摘要」分叉）；失败 `onEvent` info「继续原对话」，fail-open。手动 `compactNow` 忽略阈值，失败上抛。

`compact()` 从尾向前按 tail 预算留最近消息（`tailKeepCount`），切分点不拆 `tool_use`／`tool_result` 对。head 经 `stratify` 分四轨：user→demands、assistant 结论原文／解释过 `summarize`、tool_use+tool_result→ledger；thinking 剥离进独立 `[thinking]` 块。纯函数层 `contextCompactor.ts`：`buildCompactedBlock` 产出 `[前文摘要]` + `[compacted]` + 恒输出的 `## 需求/结论/说明/工具履历` + 固定 `RECALL_HINT_LINE`；增量时 `parseCompactedBlock` + `mergeCompactedTracks`（旧行前、新行后）；`collapseTailExplanations` 只再摘要该次新增一半；`truncateParts` 截断超长行。预算收缩在 `contextManager.ensureBlockFitsTokens`：先调用上述纯函数，再 `trimTracksToBudget`（同文件，不在 compactor）按最大 seq 只删尾，稳定段前缀字节不变。这是缓存前缀约束（`.dsb/rules/cache-prefix-stability.md`）：历史只允许尾部追加、中部不改写；压缩块一旦成为 `messages[0]`，旧行永不重写、只追加／只删尾、标题恒输出，避免整块重建把后续前缀全部打穿。`presetCompactedBlock` 在会话重建回退时注入上次块字节，减轻「块全新生成」的首轮 miss。可选 `ContextStore`（`src/context/contextStore.ts`）把原文按 `[r{n}]` 写入 `<contextDir>/<sessionId>.context.ndjson`；`ContextRecall`（`src/agent/tools/contextRecallTool.ts`）按 seq 回查、无 seq 返回索引（最多 30）、带 query 可跨会话。无 store fail-open。

#### DSH 实现

压缩是可替换 seam，不嵌在驱动器里：`packages/compaction/compaction/`（`ctx.compaction`）定义 `compactIfNeeded(agent, trigger: 'pressure'|'context-overflow')`／`compactNow`／`compactRegion`；`compaction-basic` 的 `BasicCompactionEngine` 是默认 Provider；`command-compact` 的 `/compact` 走 `compactNow()`；可选 `compaction-tool-result-pruner`（`ctx.toolResultPruner`）在选范围前改写超大 tool result。`auto: true`（缺省）时串行 `agent/pre-step` listener 在派生请求前用 `ctx.tokenMeter` 量规范化 envelope + 当前表层：`thresholdRatio` 缺省 0.8（`floor(routedContextWindow × ratio)`），`retainRatio` 缺省 0.16 保留近期表层；已确认溢出经 `agent/request-error` 做一次最大平衡头部缩减。切分走 `toolPairingBalancedBefore`／`After`，不拆未闭合工具对；不可分单元不在约定内。

真源是仅追加 `SessionEvent`（`docs/architecture.zh.md` §会话日志）。成功压缩不改旧事件：`compaction/start`（锁）→ 直接 `ctx.llm.stream()` 摘要（`purpose: compaction`，回放系统提示／工具／已遮蔽区以复用 KV cache，不走 `agent/request`）→ `compaction/summary` → 一条 `user/message`，`source: compactCheckpointSource(compactionId)` 且 `surfaceOp: { op: 'replace', start, end }`（**唯一表层变更**，正文用 `<compacted-summary>`）→ `compaction/end`。`compaction/*` 不能上表层。`Session.deriveMessages()`（`docs/subsystems/session.zh.md`）把当前表层投影为模型 `Message[]`：摘要渲染为 user，后接已保留节点；已遮蔽事件仍在日志，回放确定。投影冻结，通过投影改历史在类型上不可表达。「模型可见即已记录」——抵达模型的一切必须能从日志重建。seam 写明成功 replace 会使从第一个已遮蔽 token 起的复用失效。回查不在 compaction 包：`packages/session-query/`（`ctx.sessionQuery`）的 `listEvents` 把事件标为 current／shadowed／log-only；面向模型的 `tool-session-query`（`session_search`／`session_event_read`）是 opt-in，默认宿主不挂。`session-reference` 快照明确不还原已遮蔽压缩前文本。

#### 优缺点

- **DSB 优点：** 预算三段、四轨块、thinking 管道、冷存储／`ContextRecall` 同在 `contextManager` + `contextCompactor`，可脱离宿主单测；`[compacted]` 只追加／只删尾 + 标题恒输出是为缓存前缀写的，增量合并能保住旧块字节；`[r{n}]` 与冷存储同源，模型可主动取回被压原文。
- **DSB 缺点：** 压缩改写 `messages` 数组本身（真源与模型可见同一份），失败靠 fail-open 留下未压历史；触发阈值、分摊、分轨分类焊在 manager 里，没有可替换 Provider；会话重建缺快照时整块重生（首轮命中最差）。
- **DSH 优点：** 日志仅追加 + `deriveMessages()` 投影，「模型可见即已记录」可断言；Definition／Provider 可换摘要后端；压力检查挂 `agent/pre-step` 不改循环；已遮蔽事件仍在日志，检索／回放／fork 不丢原文；摘要调用回放热前缀以复用 KV cache。
- **DSH 缺点：** 成功 replace 从第一个已遮蔽 token 起 cache 失效（seam 写明）；事务锁、`busy`／`changed`、未匹配 `compaction/start` 增加调试面；不可分单元无法拆；无默认模型侧回查工具（`tool-session-query` 要显式挂）；可观测行为散在 compaction + session + tokenMeter 多包。

### 2.4 会话持久化

#### 能力定义

会话可保存、恢复，并在来源支持时 fork／导出，以撑住 UI 与引擎重启。对照单位是：真源形态（DSB 的展示 JSONL + `.api.json` 消息数组 + 伴生文件 vs DSH 仅追加 `SessionEvent` 日志）、落盘谁来做（DSB `SessionStore` 本地文件 vs DSH `packages/core/session/` 内存日志 + `packages/session/` 可换 JSONL／SQLite 后端）、恢复时模型历史从哪来（DSB 读 `.api.json`，缺则 JSONL 降级；DSH `create({ seed })` 回放再 `deriveMessages()`），以及 UI／fork 是否从同一条日志派生。压缩只写相对落盘的位置（DSB `persistNow`／`.block.json`；DSH 日志追加 `surfaceOp: replace`）。

#### DSB 实现

落盘在 `DSBAgent/src/session/sessionStore.ts`，目录由 `extension.ts` 定为 `<globalStorage>/sessions/<projectKey>/`（旧根文件经 `migrateLegacySessions` 迁入，id 不变，`lastSessionId` 仍可恢复）。每个会话四件套：`<id>.jsonl` 追加 UI 事件（`sessionTypes.ts`：`user`／`assistant`／`tool`／`thinking`，给 webview）；`<id>.api.json` 整文件覆写 `ProviderMessage[]`（与请求同构，含 thinking；tmp+rename，调用方 persist 失败 fail-open）；`<id>.todos.json`；`<id>.block.json` 上次压缩块快照（须含 `[compacted]`）。这与 DSH 的 `SessionEvent` 不是同一类型：DSB JSONL 是展示流，模型续跑读 `.api.json`。`list`／`peekTitle` 只扫 `.jsonl` 头部 256KB 找首条 `kind === "user"`。

`SessionService`（`src/chat/sessionService.ts`）接线：`onRecord` → `append` JSONL；`onPersist` → `saveApiHistory`；`agentPersist` 再写 `.block.json`。`loadSession` 先 `archiveHistory` 当前历史到冷存储（`<globalStorage>/context/<projectKey>/`，§2.3），再 `load` 事件 + `loadApiHistory`；`.api.json` 空或损坏则 `eventsToHistory` 把 JSONL 压成纯文本 user／assistant（丢 tool／thinking）。恢复引擎时注入 `compactedPreset`。面板 init 用按项目隔离的 `lastSessionId`（`exists` 才 `loadSession`），避免空 JSONL。`/export md|json`（`exportSession.ts`）从 `ProviderMessage[]` 导出，json 与 `.api.json` 同构。工作区文件快照是另一条：`.dsb/checkpoints/<sessionId>/`（写工具前备份），不是会话日志 fork。无 `fork` API。

#### DSH 实现

内存真源是 `packages/core/session/`（`ctx.sessions`）：`Session` 是仅追加 `SessionEvent` 日志，**不实现持久化**；模型历史只经 `deriveMessages()` 从 surface 投影，从不单独存一份消息数组。「模型可见即已记录」（`docs/architecture.zh.md` §会话日志）。`session.append` 冻结并校验 surfaceOp／sourceEventSeqs；`ctx.sessions.fork(source, boundary?)` 切已完成轮次前缀并记谱系（`parentSession`／`seedLength`），开放轮次或未加载会话不能 fork。`create(id, { seed })` 回放连续当前格式日志重建 surface。人读 transcript 必须投影追加来源事件，不能读 `session.surface`（已落地 replace 会遮蔽读者已见历史）；模型继续读 surface。

持久化是产品族 `packages/session/`：`session-persistence/` 定义 `ctx.sessionPersistence`（locate／create／append／load／inspect／list）；插件订 `session/event`，`session/flush` 是受等待检查点。第一方后端共享 `PersistenceCoordinator`：JSONL（`session-persistence-jsonl`，默认 `<root>/--<cwd>--/<id>/session.jsonl.zstd`，首行 `SessionHeader`，可 `packChunks`）与可选 SQLite（`session-persistence-sqlite`，默认组合不挂）。`load` 只丢撕裂尾部；崩溃轮次追加合成 closer（`TOOL_NOT_STARTED`／`TOOL_OUTCOME_UNKNOWN` + `turn/end {interrupted}`），不截断已 flush 事件。`SESSION_FORMAT_VERSION` 固定 `0`；不认识且无 `ignorable` 的类型、或非 v0，拒绝。UI 不自己折日志：`session-projection/`（`ctx.sessionProjections`）在已提交事件上折叠全量 view，推 `session/projection`。标题／遥测是同族旁路（`session-title`／`session-telemetry`）。

#### 优缺点

- **DSB 优点：** 展示与 API 历史分文件，webview 不必回放引擎事件；`.api.json` 可直接续跑／`/export json`；原子覆写 + fail-open 路径短，可脱离宿主单测；按项目隔离 + `lastSessionId` 重启即开；冷存储／checkpoint 各有目录，不和会话日志抢真源。
- **DSB 缺点：** 真源分裂（JSONL vs `.api.json` vs `.block.json` vs todos），压缩后必须 `persistNow` 防「盘上全量、内存已摘要」；legacy JSONL 回退丢 tool／thinking；无 fork、无崩溃合成 closer（半写靠跳过坏行）；没有版本信封，格式演进靠兼容读。
- **DSH 优点：** 单一仅追加日志 + 可换 JSONL／SQLite 后端；回放／fork／UI 投影／遥测同流；「模型可见即已记录」可断言；崩溃保留有效尾部并合成 closer；未知事件默认拒绝，保护格式。
- **DSH 缺点：** 内存 `Session` 与持久化 seam／协调器／两套后端分层多；v0 无通用迁移、SQLite 要显式挂；fork 只切实时已闭合轮次；人读 transcript 与模型 surface 不是同一投影（replace 遮蔽），调试要认清。

### 2.5 扩展机制

#### 能力定义

在不改（或少改）核心循环的前提下增加工具、技能、钩子或运行时行为。对照单位是：扩展作者是谁（DSB 的工作区／编辑器用户丢约定文件 vs DSH 的 harness 集成者写 Cordis 插件与 profile patch）、扩展怎么挂上（DSB `.dsb` 扫描 + 市场缓存 + MCP opt-in vs DSH profile 叠 bundle／`cordis.patch.yml` + `ctx.effect()`／waterfall）、以及卸载是否可逆（DSB 删缓存或文件后下次扫描消失；DSH 插件卸载撤销副作用；可选自修改动态包只在进程内存）。循环、工具流水线、压缩、会话落盘只写扩展相对它们的挂点。

#### DSB 实现

约定根在 `DSBAgent/src/projectContext/convention.ts`：`.dsb/` 优先，旧 `.cxxxp/`／`.deepseek/`／`.claude/` 只读回退，每级只取首个存在的根、不混读。用户侧扩展是文件：`DSB.md`（`projectInstruction.ts`，旧 `CLAUDE.md` 回退）、`.dsb/settings.json` + `settings.local.json`（权限与 hooks）、`.dsb/skills/`／`~/.dsb/skills/`、`.dsb/rules/`、`.dsb/commands/`、`.dsb/agents/`。`loadProjectContext` 装配指令／规则／技能／overview；`SkillIndex`（`src/plugins/skillIndex.ts`）四层去重，优先级 project > user > extension > plugin。斜杠命令与子代理模板同样扫项目／用户／插件目录（`slashCommands.ts`／`agentTemplates.ts`）。插件是目录包：`MarketplaceManager`（`src/plugins/marketplace.ts`）把市场加到 `<globalStorage>/marketplaces/`（本地／`npm:`／`owner/repo`／URL／git），`install` 落到 `plugins/<market>/<plugin>/`，相对 `source` 不得逃出市场目录（防 hooks `*.sh` 被拷进缓存）。`scanPluginContent` 读 `plugin.json`（或 `.claude-plugin/plugin.json`）：`skills/`、`.agents/`、`commands/`、`hooks/*.sh`（文件名前缀映射 `PreToolUse`／`PostToolUse`／`Stop`／`SessionStart`）、`tools[]`（`pluginTools.ts` 解析为合格名 `plugin__<plugin>__<tool>`，`commandPath` 锁在插件目录内）。`ProjectRuntime` 每会话 fail-open 扫描缓存：`registerPluginTools`、`buildHookRunner`（settings hooks 为基线再 `addPluginHooks`）、`getSkillIndex`。`/plugins` 走 `Recommender` 关键词粗筛 + LLM 排序后 `install`。

钩子与 MCP 也是旁路、不改 `agentLoop.send`。`HookRunner`（`src/hooks/hookRunner.ts`）四事件；`fireHook` 未注入或失败只 `console.warn`，不否决工具或循环（fail-open）。MCP：工作区 `.mcp.json` → `McpRegistry`（`src/mcp/`）；`dsbAgent.mcpConnect` 显式 opt-in 才 `trustEnabled` + `connectAll`（stdio／streamable-http），工具名 `mcp__<server>__<tool>`，面板打开只 `loadFromMcpJson` 不拉起进程。`MarketplaceManager.remove` 删市场缓存；已 install 的插件目录没有一等卸载命令，下次扫描以盘上目录为准。扩展作者主要是仓库用户和插件清单作者，不是循环实现者。

#### DSH 实现

没有特权内核（`docs/architecture.zh.md` §Cordis）：产品每一部分都是插件，注册是可逆副作用（`ctx.effect()`／`ctx.on()`／`ctx.waterfall()`），卸载撤销。组装是 profile 叠组合包（§Profile 与组合包；`packages/bundle/`）：`dsh-base` 是每个 profile 第一层（模型适配器、工具、持久化、沙箱与审批、设置、凭据、遥测）；`dsh-web-app` 加浏览器表层；`dsh-headless` 加一次性运行器、不含 Host／Web。顺序为空列表上先按 profile 列出的 bundle，再 profile 的 `cordis.patch.yml`，再 home 级，最后 `--patch` overlay。一条 patch 按 id 替换整行 `config` 或插入新条目（无深度合并）；树外包经 `dsh plugin --profile <name> add`。新行为挂已有扩展点（§新行为的归属位置）：`ctx.tools.register`、`ctx.llm` 适配器、`agent/*`／`tools/*` waterfall、`agent.inject()`、扩展 `SessionEventMap`。MCP 是每服务器一个插件、发现后 `register`（§2.2）。

`packages/hooks/` 是桥不是原生钩子：`hook-protocol` 提供 matcher／stdin codec／最严格合并（deny > ask > allow）与 `hook/*` 日志事件；`hooks-claude-code`／`hooks-codex` 把外部 `hooks.json`（或 settings `hooks`）映射到类型化 Decision——能拦 `agent/pre-step`、`tools/pre-execute`、`agent/turn-stopping`（Stop 可 `steer()` 再走一步）。文档写明定制应写同一扩展点上的原生 Cordis 插件；桥只跑 `type: 'command'` 子集，加载失败隔离、不崩启动。可选自修改在 `packages/extensions/`：`tool-cordis` 的 `cordis_inspect`／`define`／`run`／`stop`／`undefine` 加 host／client runner（`ctx.dynamicCordisRunner`）；动态包只在进程内存、按会话可见、可影响同进程其他会话，`stop`／`undefine`／工具集卸载／重启后消失，不写插件文件或 `cordis.yml`。`dsh-base` 不挂这些扩展包；web-app 挂 runner／UI，工具集本身仍是 opt-in。扩展作者主要是 harness 集成者。

#### 优缺点

- **DSB 优点：** 编辑器用户丢 `.dsb/` 文件或 `/plugins` 装市场即可扩展，不必写运行时插件；技能／规则／指令／hooks／斜杠命令同约定根可推理；插件工具与 MCP 只是命名转发进已有 `ToolExecutor`；扫描与 `fireHook` fail-open，坏缓存不阻断会话。
- **DSB 缺点：** 钩子不能 veto 循环或改写工具参数；扩展换不了驱动器或工具流水线；插件卸载不是一等（删缓存才从下次扫描消失）；没有 Definition／Provider 缝，新运行时行为多半改 `src/` 或加 `deps`。
- **DSH 优点：** 插件卸载撤销副作用，profile／bundle／home／`--patch` 可逆叠层；扩展点类型化，钩子桥能 deny／ask／steer；集成者可换循环／工具／LLM 而不改「内核」；可选自修改有明确 define／run／stop／undefine 生命周期。
- **DSH 缺点：** 作者是 harness 集成者，编辑器用户不能只丢 markdown 就改运行时（技能／约定扫描留给后文）；patch 整行替换、组合树调试面大；动态包不是安全边界且同进程跨会话可见；外部 hook 只是 command 兼容子集，配置按进程加载一次。

## 3. 其余能力

### 3.1 权限与审批

#### 能力定义

决定一次工具副作用能不能发生：默认谁拦截、谁放行、放行是一次性还是会话级。对照单位是：DSB 循环体内同步 `PermissionManager.check` + 会话模式 vs DSH `tools/pre-execute` 的 ask 转入 `ctx.approval` 与权限预设。工具流水线细节见 §2.2；本节只写审批决策者与粒度。

#### DSB 实现

`DSBAgent/src/agent/permission.ts` 的 `PermissionManager.check` 在 `execute` 前同步判定：`bypassPermissions`（设置／面板「超级权限」，`configuration.ts` 的 `dsbAgent.permissionMode`）整会话放行；`acceptEdits` 只放行 `Write`／`StrReplace`／`Delete`；`onceApproved` 按工具名记住一次。然后 `PermissionRules.match`（`permissionRules.ts`，来自 `.dsb/settings.json` 的 allow／deny／ask；deny 优先；`Bash(pwd*)` 才前缀匹配，精确参数防 `pwd; rm`）得 deny｜allow｜ask；无规则默认 ask。ask 走 `PermissionGateway.request`——`chatController.makeGateway` 发 `ask_permission`，webview 点选后 `handlePermissionResponse`。拒绝写成 `ERROR: Permission denied` 的 tool_result，不进 `execute`。`capabilityGate.ts` 不参与人机审批：它是 `prepareRound`／`sanitizeOutbound` 的模型能力门（剥 thinking／image、修 tool 配对），给 LLM 客户端用（§3.4）。

#### DSH 实现

人机平面在 `packages/interaction/`：`user-approval` 的 `ctx.approval.request` 返回 `allowed-once`／`rejected`／`cancelled`／`unavailable`；应答者是 `approval/request` waterfall，缺应答者 fail-closed。`ApprovalPolicy` 只有 `ask`｜`never`（`never` 在交互分发前拒）；审计写 `approval/asked`／`decided`，模型只见消费方最终 tool result。工具流水线的 ask 路由此 seam（§2.2）。`permission-presets`（`ctx.permissionPresets`）把 `sandbox/mode` + `approval/policy` 捆成具名预设（默认 `workspace-write`+`ask`、`danger-full-access`+`never`）；`set` 先记日志再改调节项，已开会话不跟后续 Settings。没有 allow-always／规则记忆；请求不带工具参数。

#### 优缺点

- **DSB 优点：** 模式 + 规则 + 默认 ask 同在 `check`，可脱离宿主单测；项目规则可按参数前缀放行；超级权限一键切会话。
- **DSB 缺点：** 默认逐工具询问打断编码流畅度；`onceApproved` 按工具名而非参数；gateway 绑 webview Promise，无头路径要自己接。
- **DSH 优点：** 审批与循环解耦，预设把沙箱+策略一次切；审计入日志且模型不见 UI；无应答者 fail-closed。
- **DSH 缺点：** 仅一次性授权、无规则记忆；`never` 无升权；应答者缺失即拒，headless 必须显式挂 ACP／机器策略。

### 3.2 系统提示与技能

#### 能力定义

约定与可复用指令何时进入模型可见上下文。对照单位：DSB 会话构造时拼一段 system + 技能目录扫描注入 vs DSH 每步 `ctx.systemPrompt.assemble` + 技能目录事件／`skill` 工具拉取。

#### DSB 实现

`DSBAgent/src/agent/systemPrompt.ts` 的 `buildSystemPrompt` 在 `ChatViewProvider.createSession` 调一次：工作区约定、`projectInstruction`、`## 可用技能` 目录、`rules`、记忆索引、`projectOverview`（截断 1500）、可选 dreamHint、OS／shell 段。`loadProjectContext`（`src/projectContext/`）扫指令／规则／技能；`SkillIndex` 四层去重（project > user > extension > plugin），`listForPrompt` 把描述压成短行。技能正文不进 system：`SkillIndex.loadSkill` 读 `SKILL.md`，`invokeSkill` 拼「按以下技能执行:」——入口是 `/skill`、chip、命令面板，不是 `CORE_TOOLS` 里的模型工具（`definitions.ts` 无 Skill；提示词文案「用 Skill 工具加载」以源码为准）。

#### DSH 实现

`packages/core/system-prompt/`（`ctx.systemPrompt`）每步组装：插件贡献有序段／变量／工具 schema；`harness:identity`（−100）+ `deployment:persona`（0）；`system-prompt/assemble` waterfall；一个 `complete` 段可盖掉其余。`packages/skill/`：`ctx.skills` 注册表 + `skill-filesystem` 发现 + `tool-skill` 在 `agent/pre-step` 发持久 `<available_skills>` 目录，模型用 `skill` 工具按名拉正文。`packages/preset/` 的 `agent-presets` 按会话挂 `agent.cordis.yml`，只改该 agent 的工具与提示段。

#### 优缺点

- **DSB 优点：** 一次拼接可推理、可单测；目录扫描即注入，编辑器用户丢 `.dsb/skills/` 即见；正文按用户手势进 user 消息，不占每轮 system。
- **DSB 缺点：** system 在会话创建时冻结，中途改技能／规则要重建会话；提示词提到的 Skill 工具并不存在，模型只能靠 Read 或等人注入。
- **DSH 优点：** 每步组装 + 可替换段／preset；技能目录热刷新且模型可主动拉取；agent 作用域可遮蔽全局 persona。
- **DSH 缺点：** 组装／waterfall／complete 段调试面大；目录是持久 user 消息，digest 变化会追加替换；空工具视图则省略目录。

### 3.3 子代理与工作流

#### 能力定义

把任务委派给另一个 agent 并收回结果；可选多阶段编排。对照单位：隔离边界（同进程共享工具 vs 可换 Provider／进程外）和回传通道。

#### DSB 实现

`DSBAgent/src/agent/subagentRunner.ts`：`runSubagent` 深度门禁 `MAX_SUBAGENT_DEPTH`（3），`signal` abort 级联 `session.cancel()`。`Agent` 工具（`SUBAGENT_DEF`）经 `executor.ts`：可选 `agent` 名解析 `.dsb/agents/` 模板，未命中报 `Unknown agent`。工厂在 `chatViewProvider.ts` 建嵌套 `AgentSession`，**共享** provider／`ToolExecutor`／permissions／workspace（`runSubagent` 传入的 `tools: []` 被工厂忽略）。`WorkflowRunner`（`workflow.ts`）按 `dependsOn` 拓扑批跑，每阶段再 `runSubagent`；失败变 `ERROR` 文本继续，不中断整图。`GitWorktree`（`worktree.ts`）是宿主旁路：`chatController.runInWorktree` 在 `.dsb/worktrees/` 建隔离树再跑一次性会话，默认 `Agent` 工具不走 worktree。

#### DSH 实现

`packages/subagent/`（`ctx.subagents`）：具名 Provider 共存——进程内 spawn／fork、ACP／SDK／Codex／Claude 进程外。`start` 一次性；`startContinuable`＋`followup`／`interrupt`／`reportFrom` 可续跑。子级经 `applyChildComposition` 加入父 preset，否则工具表为空。面向模型的是 `tool-subagent`／control／report。`packages/workflow/`：模型写的编排脚本在 `workflow-worker-thread` 跑（隔离事件循环、非安全边界）；`tool-ralph` 固定新 agent 工作流。实验性 `tool-agent-team` 在 `dsh-base` 默认禁用。

#### 优缺点

- **DSB 优点：** 深度／取消／模板同文件可单测；工作流 DAG 无依赖可并行；worktree API 给后台任务真隔离目录。
- **DSB 缺点：** 默认子代理与父共享工具与工作区，不是沙箱；无续跑／inbox；Workflow 阶段失败只记 ERROR 继续。
- **DSH 优点：** Provider 可换进程边界；可续跑＋report 通道；子级组装强制走父 preset。
- **DSH 缺点：** 家族包多、续跑／冷恢复调试面大；worker thread 不是安全边界；agent teams 实验且默认关。

### 3.4 LLM 接入

#### 能力定义

谁把循环的「一轮请求」变成供应商 HTTP／流。对照单位：统一 Anthropic Messages 兼容客户端 vs `ctx.llm` 适配器注册表；流式与重试落在哪一层。

#### DSB 实现

唯一协议客户端是 `DSBAgent/src/agent/provider/anthropicMessagesClient.ts`：`round` 把 `ProviderMessage[]` 经 `sanitizeOutbound`（`capabilityGate.ts`）发到 `{baseUrl}/v1/messages`（SSE），`x-api-key` + `anthropic-version`。`normalizeAnthropicBaseUrl` 剥误填的 `/v1`。多供应商在 `src/providers/`：`ProviderStore` 管 id／baseUrl／secret；`CapabilityRegistry.resolve` 按 override > remote > profile > 默认得到 thinking／vision／窗口。`FallbackClient` 对 429／5xx／timeout 惰性换模型并按该 client 重跑 `prepareRound`。重试与流解析都在客户端内，没有独立 adapter seam。

#### DSH 实现

`packages/llm/`（`ctx.llm`）：`registerAdapter` 按 provider 路由；`stream` 出 `StreamChunk`，`BlockAssembler` 组装块。`llm-deepseek`／`llm-pi-ai` 是可替换 Provider；`llm-retry` 挂 `agent/request-error`，服务本身不重试。`prepareCall` 绑定适配器世代与不可变重试策略；`llm/stream` waterfall 可拦截。消息词汇（text／reasoning／tool-call）是共享真源的一部分。

#### 优缺点

- **DSB 优点：** 一条兼容协议覆盖任意 Anthropic-like 网关，配置成本低；`FallbackClient`＋能力表可单测；sanitize 挡空内容／残缺 tool 对导致的 400。
- **DSB 缺点：** 换非 Messages 协议要改／换 `AnthropicMessagesClient`；重试焊在 Fallback 正则上；能力探测与客户端分离但仍服务同一 `round`。
- **DSH 优点：** 适配器可插拔，DeepSeek 可走原生协议；重试／计量独立消费方；`prepareCall` 防 HMR 串世代。
- **DSH 缺点：** 双适配器＋目录／发现／归因分层多；消费方必须认 `finish.error` 而不是抛错。

### 3.5 UI / 宿主形态

#### 能力定义

人怎么看见并驱动同一套引擎。对照单位：编辑器内嵌 webview vs 独立 host/client 进程；同一引擎复用到无头／自动化的成本。

#### DSB 实现

宿主是 VS Code Extension：`DSBAgent/src/chat/chatViewProvider.ts`（`viewType = dsbAgent.chat`）建 `WebviewPanel`，装配 `AgentSession`／权限／MCP／hooks，把 `onEvent` 交给 `ChatController` 推 webview（`webview.postMessage`）。`SessionService`（§2.4）把 `onRecord`／`onPersist`／`agentPersist` 落到 `SessionStore` 四件套；面板 init 用按项目隔离的 `lastSessionId`。UI 在 `DSBAgent/webview/`（`main.ts`／`index.html`：对话、超级权限按钮、设置／记忆／provider 面板）；审批对话框走 `ask_permission`（§3.1）。命令面板与 `package.json` contributes 同树。无头复用：`benchmark/cli.ts` 直接 `buildSession` 跑引擎，不加载 vscode。引擎层不 import `vscode`，但产品面只有这一个 UI——换 IDE／浏览器要重写 `ChatViewProvider`＋webview。

#### DSH 实现

独立产品面：`packages/host/`（`apiproxy`＋`webserver`，`ctx.apiProxy`／`ctx.webServer`）+ `packages/client/`（浏览器 shell、`ui-slots`、会话／工具／权限 UI）。UI 不自己折日志：`session-projection/`（§2.4）在已提交事件上折叠 view，推 `session/projection`。`apps/cli` 的 `dsh --profile web|headless` 叠 bundle；另有 `packages/acp/` 自动化与 `packages/sdk/`。同一内核多宿主是 profile 成本，不是再写一套循环；编辑器内嵌不是一等，要经 ACP 等桥。

#### 优缺点

- **DSB 优点：** 装扩展即用，无独立进程；引擎可被 benchmark 无头复用；webview 与 `SessionStore` JSONL 对齐（§2.4）。
- **DSB 缺点：** UI 绑 VS Code；换 IDE／浏览器要重写 `ChatViewProvider`＋webview；无 ACP／SDK 产品面。
- **DSH 优点：** host/client 分离，web／headless／ACP／SDK 同组装；UI 按 slot 插件化。
- **DSH 缺点：** 必须跑独立 host；客户端包面大；编辑器内嵌不是一等（要经 ACP 等桥）。

## 4. 横切对照小结

只收束 §§1–3 已写过的机制，不新开能力。

### 真相来源

两端的「什么算已经发生」不是同一种东西。DSB 真源分裂：循环里的 `messages` 数组（与请求同构）、展示用 `<id>.jsonl`、整文件覆写的 `<id>.api.json`、压缩块 `<id>.block.json`，外加 `<globalStorage>/context/*.context.json`／ndjson 冷存储与 `~/.dsb/stats/.../events-*.jsonl` 统计（§1、§2.3、§2.4）。压缩直接改写 `messages` 头部为 `[compacted]`，所以必须 `persistNow()`，否则盘上全量、内存已摘要。DSH 只有一条仅追加 `SessionEvent` 日志（`packages/core/session/`，`ctx.sessions`）：成功压缩追加 `surfaceOp: replace`，模型历史只经 `deriveMessages()` 投影，从不另存一份消息数组。「模型可见即已记录」——抵达模型的一切必须能从日志重建。UI／fork／遥测读同一条流的不同投影，而不是第二份真源。

### 扩展点

DSB 改能力多半改 `src/agent/` 循环体或加 `deps` 注入：`send` 圈序、权限 `check`、`ToolExecutor.dispatch`、`contextManager` 阈值都焊在固定管道里；旁路是 `onEvent`、`.dsb/` 文件扫描、`HookRunner` 四事件（不能 veto）、MCP／插件命名转发。DSH 改能力多半挂已有 waterfall／seam：`agent/pre-step`、`tools/pre-execute`／`execute`／`post-execute`、`llm/stream`、`ctx.effect()`；循环、工具、压缩、LLM、FS 都是可替换 Provider，不必改 `packages/core/agent-loop/`。代价是可观测行为散在多包，调试要沿事件而不是单文件。

### 测试边界

DSB 的可测边界是「引擎层不 import `vscode`」：`src/agent/` 等走 `deps` + `onEvent`，可在 Node 里单测，也可被 `benchmark/cli.ts` headless 复用（§1、§3.5；`DSBAgent/.dsb/docs/system-analysis/01-architecture.md` §引擎层 vs 宿主层）。宿主桥（`extension.ts`／`chatViewProvider.ts`／webview）不进这条边界。DSH 的可测边界是包级门禁加组装后 snapshot：`docs/testing.zh.md` 规定 `packages/*/*/src` 按文件 100% 覆盖（`pnpm run test:coverage`），以及无密钥 `test:snapshot`（`packages/test-support/acp-snapshot/` 驱动 ACP／headless 回放，diff 归一化 JSON-RPC 与持久化日志）。单元测试证明包内约定；snapshot 证明组合后的对外行为。两端都不是「测完循环就等于测完全产品」。

### 「换一块能力」的成本量级

定性：低 = 不改循环／真源，只换文件或 Provider；中 = 要对接既有词汇或焊点，但不换真源；高 = 改驱动器本体或日志／消息数组契约。各举已在正文出现的 1 例：

| 成本 | 例 | 机制理由 |
|------|----|----------|
| 低 | DSB：丢 `.dsb/skills/` 或 `/plugins` 装市场包 | 约定扫描 + 命名转发进已有 `ToolExecutor`，不改 `send`（§2.5、§3.2） |
| 低 | DSH：`fs-local` 换成 `fs-sandbox`／`fs-e2b` | Definition／Provider／Consumer 缝，`tool-fs` schema 不动（§2.2） |
| 中 | DSB：改权限规则或会话模式 | `.dsb/settings.json` + `PermissionManager.check` 可调，但仍焊在循环体内同步判定（§3.1） |
| 中 | DSH：换默认循环包或挂 `agent/pre-step` | `ctx.agents.setFactory`／waterfall 不必改驱动器源码，但仍要对齐 turn/step／inbox 词汇（§2.1） |
| 高 | DSB：换工具执行世界或非 Messages 协议 | `dispatch` 耦 `workspaceFs`；换协议要改／换 `AnthropicMessagesClient`（§2.2、§3.4） |
| 高 | DSH：改 `SessionEvent`／`surfaceOp` 语义 | 回放、fork、`deriveMessages()`、UI 投影都绑同一条仅追加日志（§2.3、§2.4） |

## 5. 附录：术语对照表

下表只收录 §§1–4 已用过的名称，不另造同义词。DSB／DSH 都出现过 `SessionEvent`，类型不同，分行列出以免混名。

| 概念 | DSB 名称/锚点 | DSH 名称/锚点 |
|------|---------------|---------------|
| Agent 循环 | `AgentSession.send` 的 `round`（`src/agent/agentLoop.ts`） | turn/step + `ctx.agentLoop`（`packages/core/agent-loop/`）；`Agent` 接口在 `ctx.agents` |
| 工具注册/执行 | `CORE_TOOLS` + `ToolExecutor.dispatch`（`src/agent/tools/`）；MCP／插件名 `mcp__`／`plugin__` | `ctx.tools`／`ToolRuntime`；`tools/pre-execute` → `guard` → `execute` → `post-execute`（`packages/core/tools/`） |
| 上下文压缩 | `contextManager` + `[compacted]` 块（`contextManager.ts`／`contextCompactor.ts`） | `ctx.compaction` + `surfaceOp: replace` + `deriveMessages()`（`packages/compaction/`） |
| 会话持久化 | `SessionStore` 四件套：`.jsonl`／`.api.json`／`.todos.json`／`.block.json`（`src/session/sessionStore.ts`） | 仅追加 `SessionEvent`（`packages/core/session/`，`ctx.sessions`）+ `ctx.sessionPersistence`（`packages/session/`，JSONL／SQLite） |
| 扩展/插件 | `.dsb/` 约定扫描 + `MarketplaceManager` + MCP opt-in（`src/plugins/`／`src/mcp/`／`src/hooks/hookRunner.ts`） | Cordis `ctx.effect()`／`ctx.waterfall()`；profile 叠 bundle + `cordis.patch.yml` |
| 系统提示 | `buildSystemPrompt`（`systemPrompt.ts`），会话创建时拼一次 | `ctx.systemPrompt.assemble` 每步组装（`packages/core/system-prompt/`） |
| 技能 | `SkillIndex` 目录注入 + `invokeSkill`（`/skill`／chip；**不是** `CORE_TOOLS` 里的工具） | `ctx.skills` + `tool-skill` 的 `skill` 工具按名拉正文（`packages/skill/`） |
| 子代理 | `runSubagent`／`Agent` 工具（`subagentRunner.ts`），默认共享 `ToolExecutor`／工作区 | `ctx.subagents` + `tool-subagent`（`packages/subagent/`）；Provider 可换进程边界 |
| 权限/审批 | `PermissionManager.check` + `PermissionGateway.request`（`permission.ts`）；模式 `bypassPermissions`／`acceptEdits`／`onceApproved` | `tools/pre-execute` 的 ask → `ctx.approval`；`permission-presets`（`packages/interaction/`） |
| LLM 客户端 | `AnthropicMessagesClient.round` + `FallbackClient`（`src/agent/provider/`） | `ctx.llm` + `registerAdapter`（`packages/llm/`）；`llm-deepseek`／`llm-pi-ai` |
| 会话事件（勿混名） | JSONL 展示流 `user`／`assistant`／`tool`／`thinking`（`sessionTypes.ts`）；**不是**模型真源 | 仅追加 typed `SessionEvent` 日志；模型可见 ⟺ `deriveMessages()` 投影 |
| 压缩回查 | `ContextRecall` + `ContextStore` ndjson（`[r{n}]`） | `session-query`／`tool-session-query`（opt-in；默认宿主不挂） |
| 真相来源 | `messages` 数组 + `.api.json` + context 文件 + stats jsonl | 仅追加 `SessionEvent`；「模型可见即已记录」 |
