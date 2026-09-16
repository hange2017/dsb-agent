# Changelog

DSBAgent 变更记录。版本遵循 [SemVer](https://semver.org/lang/zh-CN/);实现计划与设计说明见 `.dsb/plans/` 与 `.dsb/specs/`。

## [Unreleased]

> 主线:**撤掉 6 段「任务地图」,降级为单行「会话目标」锚** —— 消除「模型输出→结论轨→地图结果段→锚→回喂自身」的自我强化闭环。

### 修复

- **去掉常驻「任务地图」(删除 `src/agent/taskMap.ts`)**:地图六段(目标/最新要求/近期需求/更早的需求/已做/结果)在语义上**全是压缩块 4 轨的投影**,零新增信息;且:
  - 「已做」段来源是 `ledger`(工具履历**原文**),旁白过滤规则治不到它;
  - 「结果」段来源是 `conclusions`(模型结论/过程旁白)。
  二者构成**自我强化闭环**:模型自己的过程旁白 → 结论轨 → 地图「结果」段 → 任务锚 → 回喂模型自身。
  **实证**:短消息(≤15 字)到 LLM 轮次的中位数从 **5 轮 → 56 轮**;决定性单例「现在重启了」5 字跑了 **56 轮 / 151 次工具调用**。
  多次打补丁(旁白降级/只读化/输出行剔除/提示去标签)均未消除物理入口,故整块删除。
- **降级为单行目标锚**:`ContextManager` 不再构建地图,只维护 `residentGoal`(= 压缩块需求轨**最新一条**真实需求,即当前正在推进的任务;已滚出视野的目标由它复述,仍在 tail 里的最新需求模型直接可见,无需重复);任务锚新增 `**会话目标:**` 单行(1 行即可把目标搬到消息尾部,拿到「注意力更强」这一唯一真价值)。锚的其余部分不变:`### 下一步`(来自 `TodoManager` 真实未完成待办)+ 当前清单 + `ContextRecall` 回查入口。
- **目标跟随当前任务(不再钉死最初需求)**:目标取值从「需求轨首条」改为「最新一条」。跨多个任务的长会话里,最初需求往往早已完成(实测本会话第 1 条「完成git处理」被钉死数十天,持续诱导模型回跑早已结束的任务)。旧版对需求轨首条(及末尾 N 条)的**裁剪免裁特例同时移除**:裁剪改为**严格「只删块尾」**(按 section 从后往前:工具履历 → 说明 → 结论 → 需求,段内 seq 最新优先),删除点恒在块末、前缀保留最长,首条作为块内最前缀行**天然留到最后**,不再需要任何特例保护。附带修正:旧版「需求轨只删中间」本身违反规则 4(中部删行 → 其后各段整体前移 → 前缀中部断裂)。
- **设置项默认关闭**:`dsbAgent.compaction.goalAnchorEnabled` 默认 `false`(仅 `"true"` 开启);**旧键 `taskMapEnabled` 回退兼容**(老用户若显式设过 `true` 仍开启,不静默失效)。关闭时块字节与旧版一致。
- **彻底移除 `CompactBlockParts.map` 字段**:`parse`/`merge`/`truncate` 三处分支一并删除;旧会话遗留的 `## 任务地图` 段在解析时被**自然丢弃**(不匹配任何现存轨),不会污染需求/结论轨,目标改由需求轨重建。
- **块尾 hint 行文案修正**:`RECALL_HINT_LINE` 由「目标见「需求」轨**首条**」改为「当前目标见任务锚」——旧文案把需求轨首条指为会话目标,与「目标取最新条」的新语义矛盾,会把模型引回早已完成的陈旧目标(实测同一条「完成git处理」被钉死数十天),正好抵消本次修复。旧 v1/v2 文案登记为 legacy(`isRecallHintLine` 兼容跳过),历史会话已落盘的块仍能正确解析、不被串进业务轨。

### 文档

- 新增 `.dsb/specs/2026-09-16-去任务地图-降级为单行目标锚-design.md`;
- 同步 `.dsb/docs/project-overview.md`(能力清单 + 近期工作重点)。

### 新增(统计:轮次档案)

> 为「Agent 效果评估」补齐分母:一次大任务(一次 send)的散落计数在**收尾时落一条** `turn_summary`。

- **`turn_summary` 事件**(新模块 `src/agent/turnSummary.ts`,纯 TS 可单测):记录
  `rounds` / `toolCalls` / `toolErrors` / `distinctTools` / `toolRepeatCount` /
  `toolRepeatWasteCount` / `redundantTokens` / `compactionCount` / `contextRecallCalls` /
  `appends` / 四项 token / `durationMs` / `chatMs` / `endReason`(`done`/`error`/`aborted`/`maxRounds`)。
  此前 `tool_repeat` **只有分子没有分母**,算不出重复率;`ContextRecall` 调用次数则是信息丢失的直接计分板。
- **派生命中率**:`cacheHitRate` 用**权威口径** `cacheReadTokens / (cacheReadTokens + inputTokens)`
  (与 `scripts/analyze-cache-prefix.py` 一致,拒绝自造口径);分母为 0 时**不写该字段**(不用 0% 误导)。
  另落 `repeatWasteRate = toolRepeatWasteCount / toolCalls`(浪费型重复,排除合理复查)。
- **`message_sent` 补 `sessionId`**:首轮此刻会话尚未 ensure,取不到则不带该字段,
  完整会话归属由收尾的 `turn_summary` 提供。
- **统计保留期可配置**:新增 `dsbAgent.stats.retentionDays`,**默认 365 天**(旧硬编码 30 天,
  跨月回看时会把早期样本清掉),`0` = 永久保留。
- **纯旁路**:不进入任何发给 provider 的载荷 → 不触碰 system/压缩块/tail/messages 字节,
  **不影响缓存前缀稳定性**;只记数字不记内容;收尾打点 fail-open。

### 文档(统计)

- 新增 `.dsb/specs/2026-09-16-轮次档案埋点-design.md`。

## [0.4.0] — 2026-09-15

> 主线:**消灭多轮压缩后的「目标漂移」与「已存内容读不回来」**。核心手段是把任务目标从
> 「最先被裁掉、且离当前回合最远」的位置,搬到「永不裁剪、且每轮都能看见」的位置。
> 设计见 `.dsb/specs/2026-09-14-任务地图与需求轨保护-design.md`,实测见
> `.dsb/docs/2026-09-14-压缩目标漂移修复与96k预算实测.md`。

### 本版本亮点

- **常驻「任务地图」(新模块 `taskMap.ts`)**:压缩块首段固定输出 `## 任务地图`,六段
  =「目标 / 最新要求 / 近期需求 / 更早的需求 / 已做 / 结果」。地图轨**不参与裁剪**,因此
  「目标是什么 / 干了什么 / 得到什么」在任意轮次都可回答;中期「目标澄清/修正」一旦进入
  地图即**粘住**(累积式,不被滑动窗口挤出),不再随压缩消失。
- **需求轨保护**:压缩超预算时,需求轨**最后才删**且**首条永不删**,只删中间行
  (非需求轨仍按 seq 最新优先删以保 KV 前缀稳定)——目标不再是被优先丢弃的那个。
- **任务锚进工具执行轮**:一轮工具跑完后消息尾部是 `tool_result`,原实现会**跳过注入**,
  导致"决定下一步做什么"时看不到目标与计划;现改为把任务锚**追加在同一条 user 消息内**
  (不新增 user 消息 → 不破坏角色交替),并对 `tool_result` 轮生效。
- **修掉一处数据损坏**:`TodoWrite.content` / `MemoryWrite.body` 曾被瞬时参数省略机制
  替换成占位标记(>200 字符即触发),并且**真的写进清单/记忆库**——模型看不到自己刚存了
  什么,重写时又把标记复述回去,属**落盘级数据丢失**。现将这两字段移出精简表,并给执行层
  补上与 `Write` 同款的占位标记防护。

### 新增

- **`src/agent/taskMap.ts`**(纯函数、确定性、无 `vscode` 依赖):
  `buildTaskMap` / `taskMapLines` / `extractMapSectionItems` / `accumulateRecentDemands`;
  同输入同输出,保证压缩块字节稳定、不破 KV 缓存前缀。
- **地图常驻 + 每轮重建**:`ContextManager.buildResidentMap(parts, prevMap)` 于每次压缩重建
  地图并置于压缩块首段;`compact()` 抽出 `pickTrimVictim` 实现需求轨两阶段收敛保护。
- **真实「下一步」段**:`agentLoop.buildNextStepSection(pendingTodos)` 只接受
  `TodoManager.list()` 中 `done=false` 的条目(去空白、≤3 条、空则不输出)。
- **灰度开关** `dsbAgent.compaction.taskMapEnabled`(boolean,默认 `true`,仅显式 `false` 关闭)。
- **运行时合成文本过滤(前缀感知)**:`isRuntimeContinueMessage` 在入轨前跳过 `[续写]` 提示,
  `isRuntimeSyntheticText` 统一剥离 `- ` / `[rN] ` 前缀后比对(旧实现只 `startsWith` 会漏判
  轨行 `- [rN] [续写] …`);地图构建与 `compact()` 两层过滤,避免续写提示/输出中断污染需求轨
  并**永久合并**进压缩块。
- **增强的压缩块回查提示**:`RECALL_HINT_LINE` 明确指引「需要更早原文 → `ContextRecall`;
  当前目标见本块『需求』轨」;新增 `isRecallHintLine()` 兼容历史已落盘旧块(字节仍恒定)。
- **`MemoryWrite` 回显强化**:tool_result 回显新条目 `name + description`;系统提示「持久记忆」
  段改为「**动手前先 `MemoryRead` 读全文**」。

### 修复

- **瞬时参数省略标记的误伤与误写**:
  - `TodoWrite.content` / `MemoryWrite.body` **移出** `TRANSIENT_FIELDS`(正文即语义主体);
  - `isTransientSummaryText` 改为**形状校验**(长度 > 320 直接为假;仅当内容基本就是标记本身
    才为真),消除"引用该标记的正常内容被误拒"——此前诊断文档写入与多处代码编辑因此被 `REFUSED`,
    大粒度重构无法进行;
  - 省略标记文案按工具给出**正确回读指引**(文件 → `Read`;记忆 → `MemoryRead`;清单 → `todo list`),
    不再一律指向文件工具;
  - 阈值调整:全局 200;`Write.contents` 16000;`StrReplace.new_string`/`old_string` 8000。
- **执行层防护补齐**:`TodoWrite` / `MemoryWrite` 内容疑似占位标记时返回 `REFUSED`,从源头阻断
  「照历史标记再写一遍」的污染落盘(`Write` / `StrReplace` 原已有此防护)。
- **跨平台(Windows/Linux)行尾加固**:`extractMapSectionItems` 内先做 `\r` 归一化——
  JS 正则的 `.` **不匹配 `\r`**(line terminator),`/^\s*-\s+(.*)$/` 对 CRLF 行会整条匹配失败,
  使累积式「近期需求」**静默失效**(中期澄清不再粘住,即目标漂移回归)。
  内部生成一律 `\n`(工程内无 `os.EOL`),但外部以 CRLF 另存的会话块(`*.block.json`)会触发;
  与 `agentTemplates.ts` / `slashCommands.ts` 既有的 CRLF 归一化保持一致。
- **地图不再冒充待办**:早期实现用「需求轨较早的中间需求」填 `### 下一步`,而历史需求**没有
  完成度信息** → 会把**已完成**事项显示为"下一步",诱导重复劳动。现该段更名为「更早的需求」
  (语义为历史需求,不含完成度暗示),真实待办只由任务锚注入。

### 测试

- 新增 `tests/taskMap.test.ts`(地图生成/去重/截断/段提取/累积粘住/CRLF 兼容);
- `tests/contextManager.test.ts` 新增常驻地图、需求轨保护、轨道级合成文本清理等大量用例;
- `tests/agentLoop.test.ts` 更新任务锚注入断言(工具轮注入、不新增 user 消息、`pendingTodos`);
- `tests/toolUsePolicy.test.ts` / `tests/tools.test.ts` 按新行为改写断言(旧断言明确写了
  "TodoWrite/MemoryWrite 会被精简""工具轮不注入清单",均已修正)。
- **验证**:`tsc --noEmit` 0 错误;`vitest run` **110 文件 / 1175 项通过 / 1 跳过**。
  关键用例均做**反证**(撤掉改动后如期失败再还原),避免"假绿"。

### 文档

- 新增 `.dsb/specs/2026-09-14-任务地图与需求轨保护-design.md`、
  `.dsb/plans/2026-09-14-压缩目标漂移修复-plan.md`、
  `.dsb/docs/2026-09-14-压缩目标漂移修复与96k预算实测.md`(含跨平台核查结论);
- 同步 `.dsb/docs/project-overview.md`、`system-analysis/`(03-001 上下文压缩 / 04 技术债 /
  06 性能成本 / README)、`.dsb/rules/transient-summary-avoidance.md`。


## [0.3.0] — 2026-08-19

### 本版本亮点

- **缓存前缀稳定性(缓存命中率 97% 级)**:固化前缀稳定性规则(P0),todo 清单移出 system 改为消息尾部注入;trim 类 tool_result 改为写入前定型(P1),避免「原始+精简」两形态导致前缀断裂;tail 预算分级折叠、preset 压缩块快照恢复(方向 2/3),压缩后首轮命中率由 ~10% 提升至 ~50%。
- **thinking 收敛与默认思考能力**:思考编排开关与强度预设收敛(默认 medium);思考关闭时 split 归一化为两段并写入 agent 参数;Agent 设置面板新增「思考模式」卡片。
- **max_tokens 自动续跑**:解析 `stop_reason=max_tokens` 与不完整 tool_use 块,自动继续生成直至完整(上限保护)。
- **交互式追加与轮次导航**:busy 期间可追加消息到当前轮;消息区滚动冻结跟随 + ▲▼ 轮次导航。
- **ContextRecall 压缩块回查**:压缩块内置回查提示行,支持按 seq 回查原文(当前会话 + 跨会话)。
- **默认预算调整**:历史信息总预算默认 64K、总窗口默认 600K(不再默认 1M 窗口/150K 历史),降低默认资源占用。

### 新增

- **Snapshot Store(统一裁剪切点归档)**:
  - `ContextStore` 主存改为 NDJSON 追加(`*.context.ndjson`)+ 异步 `SnapshotQueue`(debounce 50ms / batch 16),旧 `*.context.json` 惰性迁移;索引带字节偏移供 ContextRecall 随机读。
  - 淘汰上限:全量 50MB + thinking 独立 8MB;空闲 compact(>500 条或 >8MB 内容)。
  - thinking / toolResult / StrReplace.old_string 裁切前归档原文,标记嵌入 `[r{seq}]`;回合结束 `flush`。
  - 修复注入链:`ChatViewProvider` 级共享 `ContextStore` 同时注入 Controller / ToolExecutor / AgentSession,ContextRecall 可用。
  - Grep 工具描述补充「rg 不可用时降级为纯 Node」。

### 修复

- **输入框 Ctrl/Cmd+Z 撤销失效**:发送后 `inputEl.value` 被编程式清空会销毁 textarea 原生撤销栈,输入框为空时按 Ctrl/Cmd+Z 现在会恢复上一次发送的文本;vim 模式 normal 状态不再拦截 Ctrl/Cmd/Alt 组合键,撤销/重做/复制/粘贴等浏览器原生行为恢复正常。
- **瞬时参数省略标记污染防护**:瞬时参数摘要模板升级为强标识 `[TRANSIENT-SUMMARY field=... chars=...]` 并附「禁止写入文件」提示,模型不再把省略标记当真实内容复述;`Write`/`StrReplace` 执行前校验 `contents`/`old_string`/`new_string`,命中省略标记直接拒绝写入并提示用 `Read` 重新读取——从源头阻断「占位符污染文件」问题(Windows/Linux 均适用)。
- **输入框躺平小人悬停/输入后消失**:`saluteOut` 动画 `forwards` 锁定 `opacity:0`,而 `saluting` 类仅在 `mouseleave` 时移除;输入清空后即使恢复空闲,inline `opacity` 也被动画覆盖 → 表情永久不可见。现改为空闲分支强制解除 `saluting` 锁定并恢复 😴,悬停敬礼改为一次性问候(0.8s 后自动恢复躺平),忙碌/输入中不触发问候。
- **▲▼ 轮次导航按钮被刷新内容遮挡**:导航按钮背景仅 `color-mix(... 10%, transparent)` + `opacity: 0.85` 近乎透明,且 `z-index: 20` 偏低;时间线动态刷新时新内容块(蓝框 USER/DSB 消息、代码块等)滚动划过按钮位置会从半透明按钮中透出,视觉上像「内容漂浮在箭头上面」。现改为 `z-index: 500`(高于消息区全部内容层 ≤3,低于设置抽屉 1000)+ 以编辑器背景为主的实底背景 + 加深阴影,箭头始终清晰浮于最上层。

### 新增

- **平台感知与工具平台门禁(B1)**:
  - 工具定义新增 `platforms` 元数据(`ToolDef`),`filterToolDefs` 按 `process.platform` 过滤对外通告的工具集,为未来平台专用工具留好机制(当前核心工具全平台可用)。
  - **Grep 不再完全失效**:rg 二进制解析新增 PATH 兜底(`rg`/`rg.exe`);无 rg 时降级为纯 Node 行级搜索(`grepFallback`,输出格式与 rg 一致),Windows 等无 rg 环境 Grep 永远可用(慢但可用)。
  - **Bash 平台感知**:系统提示词新增「运行环境」段(OS/shell/路径分隔符/命令风格,按 `process.platform` 生成,Windows 提示用 `dir`/`type`);Bash 工具描述按平台动态生成,告知模型当前 shell 与命令风格。
  - 新增 `src/util/platformInfo.ts` 集中平台信息,供提示词/工具描述/执行层共用。

### 测试

- 新增 `tests/platformGate.test.ts`(门禁过滤)、`tests/systemPrompt.test.ts`(运行环境段)、`tests/grepFallback.test.ts`(降级搜索);既有 `ripgrepPath.test.ts` 保持覆盖。

### 扩展(B3)

- **平台门禁扩展至 MCP/插件工具 + PowerShell 专用工具**:
  - 插件工具:`PluginToolSpec` 新增可选 `platforms` 字段,manifest 工具条目可声明 `platforms: ["win32"]`(非法平台自动过滤);`buildPluginToolDef` 透传,插件工具按平台通告;执行入口加平台守卫,直接调用不匹配平台的插件工具返回错误。
  - MCP 服务器:`.mcp.json` 服务器条目可声明 `platforms`;`McpRegistry` 注入平台并据此过滤 `listEnabled()`(平台不匹配的服务器不会连接/信任),`ensureConnected` 同样守卫。
  - 新增 **PowerShell 专用工具**(仅 `win32` 暴露):以工作区为 cwd 执行 PowerShell 脚本(`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command`),输出格式与 Bash 一致;非 Windows 平台调用返回「not available」。
- **测试**:新增 `tests/pluginTools.test.ts`(manifest 解析/透传/门禁过滤)、`tests/mcpRegistry.test.ts`(.mcp.json 解析/`listEnabled` 平台过滤);`tests/tools.test.ts` 新增 `ToolExecutor platform gate (B3)` 分组(PowerShell 在 win32 暴露/linux 隐藏、win32 执行、非 win32 拒绝)。

### CI 平台矩阵

- **CI 三平台矩阵显式化**:`ci.yml` 的 `test` job 已覆盖 `ubuntu-latest / windows-latest / macos-latest`,Test 步骤前新增 **Platform info** 步骤(打印 `process.platform`/`arch`/node 版本/内置 rg 包存在性),便于从 CI 日志直接核对平台分支。
- **新增 `tests/platformMatrix.test.ts`**(真实平台冒烟,不注入平台):在 CI 三平台 runner 上验证「platformInfo 报告真实 OS/shell/分隔符」「allToolDefs 在 win32 暴露 PowerShell、其它平台隐藏」「Bash 描述匹配真实 shell(cmd.exe / /bin/bash)」「Bash 真实执行基础命令」「Grep 永远可用(原生 rg 或纯 Node 降级)」共 6 用例,把「每个平台都能跑」从口头约定变成 CI 硬性检查。

### 真实验证(Windows, 2026-08-14)

- 发现 `.tools/node-v20.19.0-win-x64` 便携 Node 后,实际跑通完整测试套件:**106 个测试文件 / 1038 用例全部通过**(1 个 Windows 无符号链接权限用例按平台跳过),`tsc --noEmit` 与 `npm run compile`(esbuild)均通过,`dist/bin/win32-x64-rg.exe` 随打包生成,Grep 不再报 not found。
- 真实验证暴露并修复 4 处问题:
  - `tests/tools.test.ts` 的 `platExec()` 构造参数错位(平台参数落在多余第 15 位被忽略,导致注入 linux 仍暴露 PowerShell)→ 修正为 14 参数,平台门禁用例真实生效。
  - `executor.ts` 的 PowerShell dispatch 缺平台守卫 → 非 win32 直接调用现在返回 `PowerShell is not available on <platform>`。
  - `benchmark/smoke.test.ts` 的 Bash 追加断言不兼容 Windows cmd 的 CRLF 输出 → 断言改为 EOL 规范化比较。
  - `tests/grepFallback.test.ts` 的「无效正则字面量」用例误用 `a+b`(合法正则)→ 改用真正的无效正则 `(text`。
  - `ToolExecContext.platform` 声明但 executor 从未读取(仅构造参数生效)→ dispatch 统一解析 `ctx.platform ?? this.platform ?? process.platform`,执行上下文注入平台真正生效。

## [0.2.1] — 2026-08-12

### 修复

- **Windows 兼容**:Glob 结果统一正斜杠相对路径(不再返回 `sub\file.ts` 反斜杠);marketplace 本地路径判断、rules 展示名归一化正斜杠;测试移除 `/tmp` 硬编码。

### 文档

- README 新增「真实编程使用统计数据」(平均每次调用费用置顶,含命中率/费用明细/官方单价口径),并同步英文版。
- 历史信息总预算设置建议更新为「64K 即可运行,并非越大越好」。
- 新增 `.dsb/docs/toolchain-instability-handbook.md`:本环境工具链不稳定现象与规避手册(占位符污染根因已定位至 `src/agent/toolUsePolicy.ts` + 操作规避)。

### 内部

- CI 测试矩阵扩展到 Windows/macOS 三平台;vitest 使用 github-actions reporter 输出失败注解。

## [0.2.0] — 2026-08-12

### 新增

- **Thinking 全链路总开关**(默认开,可整体关闭)与处理侧开关:关闭时 thinking 剥离不进历史/压缩/脉络。
- **思考强度预设** `thinkingLevel`(`low`/`medium`/`high`)派生预算;全局思考强度兜底注入与供应商默认能力(`supportsThinking` + `thinkingLevel`,缺省 `medium`)。
- **Agent 设置面板「思考模式」卡片**:开关 + 强度下拉,配置读写并同步全局尾底强度。
- **Thinking 关闭时预算归一化**:split 配置层归一化为两段(`compacted`+`tail`)并写入 agent 参数。
- **缓存前缀稳定性 P0~P3**(详见 `.dsb/rules/cache-prefix-stability.md`):
  - P0:todo 清单移出 system,改由 `TodoWrite` tool_result 尾部传播(前缀稳定段不再被清单状态打断)。
  - P1:trim 类 tool_result 写入 messages 前定型(push 前定最终字节形态,消除"先原始后精简"两形态)。
  - P2:压缩块只追加/只删尾部 + 标题恒输出,稳定段前缀字节恒定(re-summarize 只动尾部新增)。
  - P3:trim 类 tool_use / 超阈值 thinking 写前定型 + `planThinkingTrim` 幂等保护。
- **统计扩展**:`provider_send` 内容 hash 指纹与会话标识(方案 B,缓存前缀命中分析);压缩自身成本(`llmCalls`/`llmMs`/`selfTokens`)与 `provider_round` phase/roundMs;压缩质量抽查 `compactionQa` 开关;压缩雪崩量化脚本(`scripts/`)。

### 修复

- `capabilityGate` 修复孤儿/缺 id tool_use 配对,禁止 todo 并入 tool_result。
- 压缩耗时实测统计存档与成本/雪崩综合分析落地(官方单价口径,`未命中×1.0 + 命中×0.02 + 输出×2.0` 元/M)。
- 统计文档中文化并新增数据校验强制流程(官方对账前置)。

### 内部

- 固化缓存前缀稳定性规则(字节稳定三原则 + 缓存杀手清单 + 验证要求),并标记 P0~P3 实施状态。
- 统计口径规则(全项目合并)、README 补充快速开始/安装置顶与绿色设置建议(超级权限 + 历史预算 256K)。

## [0.1.0] — 2026-08-10(首发布)

### 新增

- 上下文分轨压缩(需求/结论/解释/台账) + 冷存储(`ContextStore`),跨会话 `ContextRecall` 回查。
- 老会话完整历史归档(`archivePolicy`):切走/删除会话时把完整历史写入冷存储。
- Thinking 独立压缩:配对上下文一次 LLM 调用压缩为独立 `[thinking]` 块(正确/错误/中性分组);独立预算(≤3500 tokens)、滚动收缩、开关 `dsbAgent.compaction.thinking`。
- 记忆卫生三件套:访问加权排序 + `pinned` 常驻、`MemoryWrite` 相似候选提示、`/memory dream` 双闸门。
- 压缩成本监控:`CompactionStats` 滑动窗口 + agentUI header 徽章 + 迷你趋势柱状图(`windowSeries`)。
- 压缩事件落盘:`~/.dsb/stats/<projectKey>/events-*.jsonl`(`compaction` / `provider_send` breakdown)。
- 每日工作总结提醒、统计大模块、时段图标、动态表情动画、历史懒加载、代码块双击跳转、设置右侧抽屉。

### 修复

- 冷存储偏移索引 + 增量合并 `assertNoSeqOverlap` 前置断言(fail-open)。
- 历史轮次中间时间线折叠、对话身份标签、提交时折叠上一轮等 UI 细节。

### 内部

- 引擎层(`src/` 非 webview 部分)不依赖 `vscode` 模块,便于单测。
- 打包排除 `.deepseek/**`、`.dsb/**`、`.cursor/**`、`.map` 等敏感/冗余文件。

### 发布准备(2026-08-10)

- 新增原创图标 `resources/icon.png`(与任何厂商商标无关)。
- 补全 `categories`(`Chat / Other / AI / Programming Languages`)与 `keywords`。
- 建立根级 `CHANGELOG.md`;README 扩充安装步骤、平台支持矩阵与已知限制。
- 新增 GitHub Actions CI:compile + typecheck + vitest 全量 + `vsce package` 验包。
- 注册 Marketplace Publisher(`zhaoNingHan`);配置 `repository` 与 `publisher`;`vsce package` 本地验包通过(103 文件 / ~5.5MB,无警告)。
- 待办(上架前):配置 Marketplace PAT;Windows/macOS 真机冒烟。

## [0.0.x] — 2026-08-04 之前

早期开发版本(未发布),细目见 `.dsb/docs/` 与 `.dsb/plans/` 验收记录。
