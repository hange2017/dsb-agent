# 01 · 整体架构分析

> 状态:🔄 进行中(第一节「工作流程总览 + 目录模块地图」已完成;依赖图/数据流细节待补)
> 关联:[project-overview.md](../project-overview.md)(能力清单) — 本文档侧重**结构关系**而非能力罗列。

## 一、整体工作流程总览

### 1.1 四层总览:界面 ↔ 交互控制 ↔ 引擎 ↔ 支撑

DSBAgent 在 VS Code 里分成**四层**。**你不是在跟"一个程序"对话,而是在跟一个四层结构对话**——最上面是你看到的界面,中间是传话的主持人、思考的引擎,最下面是让引擎转起来的基础设施:

> **这 4 层是怎么切出来的?**
> 按「**离你有多近 / 离模型有多远**」的职责远近切,不是按代码目录硬切:
> - **L1 界面层**:你 + 聊天面板(webview,浏览器环境)—— 只看得到它,它就是"DSBAgent"在你眼中的样子。
> - **L2 交互控制层**:`chat/` + `context/` —— 把你说的、选的、拖进来的东西整理成引擎能懂的素材;把引擎说的话、工具进度推回界面。它"面向你"但不"在你的浏览器里"。
> - **L3 引擎层**:`agent/` —— 真正思考的地方:组装请求、发模型、决定调工具、执行、压缩上下文。
> - **L4 支撑层**:`providers/`、`settings/`、`projectContext/`、`session/`、`stats/`、`memory/`、`plugins/`、`mcp/`、`hooks/` …—— 引擎转起来要用的"水电煤气"。
>
> 注意:这里的"层"是**职责维度**;还有另一种按「是否依赖 vscode」切的二分(宿主层 vs 引擎层),见 [2.3](#23-分层边界引擎层-vs-宿主层),两者不冲突。

```
┌────────────────────────────────────────────────────────────────────┐
│  你 ──► VS Code 窗口 ──► DSBAgent 聊天面板(webview)                  │
└────────────────────────────────┬───────────────────────────────────┘
                                 │ 你打字 / agent 回话、工具进度
┌────────────────────────────────▼───────────────────────────────────┐
│  交互控制层(主持人)                                                  │
│    src/chat      · 收你的消息、开/存会话、斜杠命令、事件推给界面       │
│    src/context   · 捕获:拖文件/选代码/贴图片 → 变成 prompt 素材       │
└────────────────────────────────┬───────────────────────────────────┘
                                 │ 把消息交给引擎
┌────────────────────────────────▼───────────────────────────────────┐
│  引擎层(大脑)—— 详见下方「1.2 主循环」                               │
│    src/agent     · 主循环 / 上下文管理 / 权限 / 工具 / 记忆 / 客户端   │
└────────────────────────────────┬───────────────────────────────────┘
                                 │ 依赖
┌────────────────────────────────▼───────────────────────────────────┐
│  支撑层(基础设施,让上面转起来)                                        │
│    providers      供应商配置(连哪个 API、用哪个模型)                  │
│    settings       全部设置 + 密钥存储                                 │
│    projectContext 项目约定(.dsb/ 规则/技能 → 注入 system)             │
│    session        会话存盘与恢复                                      │
│    stats          每次调用打点、命中率/成本统计                       │
│    memory         跨会话持久记忆                                     │
│    plugins/mcp/hooks  插件市场 / 外部 MCP 工具 / 生命周期钩子         │
│    i18n/notifications/util  语言字典 / 通知 / 平台工具                │
└────────────────────────────────────────────────────────────────────┘
```

一句话:**你在界面上说话 → 主持人把话整理好 → 大脑思考并决定是否动手 → 动手后把结果放回对话 → 继续思考……直到完成 → 界面把结果告诉你。**

### 1.2 引擎主循环:一个"绕圈"的六环节

引擎不是一条笔直的流水线,而是一个**循环**——模型每"想"一次,如果它决定调用工具,就会带着工具结果再"想"一次,直到它认为任务完成、只回复文本为止。所以一次对话里,下面的圈可能绕 1 次(只聊天)也可能绕几十次(复杂任务):

```
                    你说话 / 上一轮工具结果
                            │
                            ▼
              ┌───────────────────────┐
              │   ① 组装请求包         │
              │   system+历史+工具清单  │  ← 历史超预算先压缩成 [compacted]
              └──────────┬───────────┘
                         │
                         ▼
              ┌───────────────────────┐
              │   ② 发给大模型         │  ← Anthropic Messages 兼容 API
              └──────────┬───────────┘
                         │
                         ▼
              ┌───────────────────────┐
              │   ③ 解析输出           │
              └──────────┬───────────┘
                         │
              ┌──────────▼───────────┐
              │   模型还要调工具吗?   │──── 不调 ──► ④ 显示文本,本轮对话完成
              └──────────┬───────────┘
                         │ 要调
                         ▼
              ┌───────────────────────┐
              │   ⑤ 执行工具(可并行)   │  ← 权限检查;执行前后可挂 hooks
              └──────────┬───────────┘
                         │
                         ▼
              ┌───────────────────────┐
              │   ⑥ 结果放回消息       │  ← tool_result 只追加不改写
              └──────────┬───────────┘
                         │
                         └──────► 回到 ① 再绕一圈(直到 ③ 说"不调了")
```

三个要点,帮助整体把握:

- **绕圈的动力**:模型"要工具 → 给结果 → 再想"是这个循环唯一的推进力;绕圈次数的上限由 `DEFAULT_MAX_ROUNDS` 控制。
- **两个"旁路"**:
  - ① 前有**压缩旁路**——历史消息超预算时,`contextManager` 把旧消息缩成 `[compacted]` 摘要块再继续,保证不超模型窗口。
  - ① 中有**记忆旁路**——system 之外,记忆工具(MemoryRead/Write)让模型能主动读写跨会话记忆。
- **它不是时序图**:①-⑥ 是"环节"不是"步骤",一次对话会反复绕圈;复杂任务里 ⑤ 内部还可以并行执行多个工具,再一次性把结果放回。

### 1.3 一图流:一次完整任务的"体感"

```
你:  "帮我看看这个报错"   ──►  面板显示文字 ──►  引擎组装请求 ──► 大模型
                                                              │
                                                              ▼
你看到: "已定位,错误在 main.ts:42,正在修复…" ◄── 引擎显示文本 ◄── 模型回复文本
                                                              ▲
                                                              │(要调工具)
                        ┌─────────────────────────────────────┘
                        ▼
                   引擎执行工具(Bash/Read/StrReplace…)
                        │  结果放回对话
                        └──► 大模型再想一次 → 直到满意
```

## 二、src 目录模块地图

### 2.1 目录树(真实结构)

```
src/                                  ← 1 个入口文件 + 14 个顶层目录
├── extension.ts                      ← 扩展入口:组装全部依赖、注册命令
├── agent/                            ← 引擎核心(19)
│   ├── memory/                       ← 记忆子系统(5)
│   ├── provider/                     ← 模型 API 客户端(3)
│   └── tools/                        ← 工具系统(10)
├── chat/                             ← 交互控制(11)
├── context/                          ← 上下文捕获(12)
│   └── extractors/                   ← 文档提取(text/pdf/docx/xlsx)(6)
├── hooks/                            ← 生命周期钩子(1)
├── i18n/                             ← 国际化字典(1)
├── mcp/                              ← MCP 客户端与注册表(3)
├── notifications/                    ← 通知封装(1)
├── plugins/                          ← 插件体系(7)
├── projectContext/                   ← 项目约定注入(8)
├── providers/                        ← 供应商与模型能力(8)
├── session/                          ← 会话持久化(3)
├── settings/                         ← 设置与密钥(8)
├── stats/                            ← 统计体系(6)
└── util/                             ← 平台工具(2)
(括号内为该目录 .ts 文件数;合计 115 个 .ts)
```

### 2.2 模块职责一览:它在干什么 + 服务于流程的哪一环

| 目录 | 它是什么(一句话) | 服务于流程的哪一环 |
|---|---|---|
| `extension.ts` | 扩展的**总装车间**:启动时把所有模块拼好、注册全部命令,激活即用 | 开机把整台机器装好;命令入口 |
| `agent/` | **大脑本体**:主循环(`agentLoop`)、上下文压缩(`contextManager`/`contextCompactor`)、权限、模式、系统提示组装、子代理/工作流 | 1.2 主循环的 ①③④⑤⑥ 全部由它驱动 |
| `agent/memory/` | **跨会话记忆**:写入/读取/相似度/整合(dream),供模型主动调用 | 1.2 的旁路:记忆工具在 ⑤ 执行;记忆内容在 ① 可注入 |
| `agent/provider/` | **打电话的人**:Anthropic Messages 兼容客户端 + 回退客户端(搜索等) | 1.2 的 ② 发大模型 |
| `agent/tools/` | **手脚**:工具定义、执行器、并行安全、网络/文件工具、todo、ContextRecall | 1.2 的 ⑤ 执行工具 |
| `chat/` | **主持人**:控制器收你的输入、开/存会话、斜杠命令、把引擎事件推给界面 | 你与引擎之间的全部"传话" |
| `context/` | **素材准备**:捕获选中的代码/拖入的文件/图片,格式化成 prompt 块;快照归档 | 你发消息前的"输入整理";含文档提取器 |
| `hooks/` | **挂钩点**:PreToolUse/PostToolUse/Stop/SessionStart,插件可注册回调 | 挂在 ⑤ 执行前后与整个会话生命周期 |
| `i18n/` | **字典**:中英文界面文案 | 所有界面文字的翻译源 |
| `mcp/` | **外部工具接入**:连接 MCP 服务器,把其工具并入工具清单 | ① 的工具清单来源之一;⑤ 执行时转发 |
| `notifications/` | **喇叭**:信息/警告/错误三级通知 | 贯穿全流程的状态提示 |
| `plugins/` | **应用商店**:插件清单解析、市场安装、插件工具/技能/钩子注册 | 扩展工具/技能/钩子的来源 |
| `projectContext/` | **项目约定**:读 `.dsb/` 的规则/技能/命令/概述 → 注入 system | 1.2 的 ① 组装 system 时 |
| `providers/` | **供应商与模型**:ProviderStore(连谁)、能力注册/探测(模型能做什么)、模型目录/预设 | 1.2 的 ② 决定"发给谁、按什么能力发" |
| `session/` | **档案室**:会话存盘/恢复/进度跟踪 | 主持人保存并恢复你的历史 |
| `settings/` | **控制面板**:全部配置项、密钥(SecretStorage)、设置面板 | 整机调参;密钥安全存取 |
| `stats/` | **记账**:事件打点(provider_round/compaction 等)、聚合、命中率/成本 | 每轮调用都打点,支撑缓存/成本分析 |
| `util/` | **工具箱**:平台信息、ripgrep 路径 | 杂项支撑(找 rg、判断平台) |

### 2.3 分层边界:引擎层 vs 宿主层(依赖维度)

这是本项目最关键的架构决策,也是"能脱离 VS Code 跑起来"的原因。注意:这一节的"层"与 1.1 的职责四层**是两种切法**——这里是按「是否 import `vscode`」一刀切,粒度到**文件**:

- **宿主层(依赖 vscode,共 5 类文件)**:`extension.ts`、`src/chat/chatViewProvider.ts`、`src/context/contextCapture.ts`、`src/settings/` 面板相关、webview 前端 —— 负责装配、UI、密钥、命令注册。经 `grep` 核实,`src/` 115 个 .ts 里依赖 vscode 的只有这些。
- **引擎层(不 import `vscode`)**:`src/` 其余 ~110 个 .ts —— 包括 `agent/` 全部、`context/` 绝大部分、`chat/` 的 controller/sessionService/slashCommands 等(chat/ 仅 chatViewProvider 依赖 vscode)、`providers/`、`stats/`、`memory/`、`plugins/`、`mcp/`、`hooks/`、`session/` 等。所有输入输出走接口注入(`deps`),事件走 `onEvent` 外发 → 可在 Node 里直接单测、可被 `benchmark/cli.ts` headless 复用。
- **桥接方式**:宿主把 `deps`(配置、工具、权限、统计…)注入引擎;引擎把事件(文本、工具调用、状态、统计快照)通过 `onEvent` 抛回宿主 → 界面更新。方向固定、单向,引擎永远不反向依赖宿主。
- **与 1.1 的关系**:1.1 的 L2 交互控制层里,`chat/context` 绝大多数文件其实在依赖维度上属于**引擎侧**(可单测);只有 chatViewProvider / contextCapture 两个是宿主侧。职责分层 ≠ 依赖分层,不要混淆。

## 三、依赖关系:模块间 import 关系图

> 数据来源:`grep -rln` 实测(src/ 115 个 .ts,引用方向 = "谁 import 谁")。

### 3.1 顶层依赖画像(被引用热度)

| 模块 | 被多少文件 import | 角色 |
|------|------:|------|
| `agent/` | 15 | **引擎核心**:几乎所有人都在用(agentLoop、executor、contextManager…) |
| `context/` | 11 | **素材与存储**:contextStore 被 agentLoop/contextManager 等使用 |
| `i18n/` | 8 | **文案**:UI 与错误消息都要本地化 |
| `providers/` | 7 | **模型配置**:providerStore/modelCatalog 是引擎的"模型源" |
| `session/` | 7 | **会话档案**:存盘/恢复 |
| `hooks/` | 6 | **钩子**:hookRunner 被引擎与宿主桥共同调用 |
| `stats/` | 6 | **记账**:providerSendStats/statsStore 被引擎各环节打点 |
| `chat/` | 2 | **交互控制**:主要被宿主桥(chatViewProvider)使用 |

### 3.2 核心枢纽的上下游(实测引用)

```
                    ┌──────────────┐
    webview  ─────► │ chatViewProvider │ ──► ChatController ──► SessionService ──► SessionStore
   (前端界面)       │   (宿主桥,依赖  │      (消息路由/互斥)      (会话生命周期)      (落盘)
                    │    vscode)     │
                    └──────┬───────┘
                           │ new AgentSession({...deps})
                           ▼
              ┌──────────────────────────┐
              │  AgentSession (agentLoop) │ ◄── 被 7 个文件 import:
              │   引擎主循环/唯一入口      │      subagentRunner / executor /
              └──────┬───────────────────┘      contextManager / chatViewProvider /
                     │                           chatController / anthropicMessagesClient
        ┌────────────┼───────────────┬──────────────┐
        ▼            ▼               ▼              ▼
   provider 客户端  ContextManager  tools/executor  stats(providerSendStats)
   (anthropic      (contextCompactor/  (工具执行、      (打点 → statsStore)
    Messages API)    contextStore)      todo/权限)
```

**关键发现**:
- **`extension.ts` 是总装车间**:它 import 了 30+ 个模块,把所有 `deps`(配置/密钥/存储/面板)组装好后一次性注入 `AgentSession` 与 `ChatController`。引擎本身不知道 vscode 存在。
- **`AgentSession` 是引擎的唯一入口**:所有对话(用户消息、子 agent、benchmark CLI、插件调用)最终都走 `session.send()`。它被 7 个文件引用,是当之无愧的枢纽。
- **`memoryStore` 是"被引用最热的叶子"**(9 处):memoryManager/memoryDream/sessionProgress 等都依赖它,但它是纯存储,不反向依赖任何人。
- **`chatController` 只被 2 个文件引用**:它更多是"使用方"(消费 chatViewProvider 的输入、调用 SessionService),本身不是被依赖中心——**枢纽是 AgentSession,不是 chatController**。

## 四、数据流细节:一次对话的全链路

> 与 1.2(主循环六环节)互补:这里偏**时序 + 具体模块**,按一次 `send` 从输入到落盘的顺序。

```
[L1] 你在聊天框输入 "帮我修这个 bug" ──► webview 前端
       │ 前端发 {type:"send", text} 消息
       ▼
[L2] chatViewProvider (宿主桥,依赖 vscode)
       │ 校验 API Key / 工作区 → 组装 deps
       ▼
     ChatController.send(userText)          ← 互斥:busy 时直接 return
       │ · 打点 message_sent(只记长度,隐私友好)
       │ · 展开内联引用(@文件/图片 chips → prompt)
       │ · sessionService.ensureSession(cwd) → 恢复/新建会话
       │ · post({role:"user"}) 让界面先显示你的气泡
       ▼
     SessionService ──► SessionStore(档案)
       ▼
     AgentSession.send(prompt, onEvent, opts)     ← 引擎唯一入口
       │
       ▼  ┌────────────────────────────────────────────┐
       │  │ [主循环] for round = 0..maxRounds          │
       │  │ 1. 准备请求:历史 + system + tools 组装      │
       │  │ 2. provider.send() → AnthropicMessagesClient │
       │  │    └─ onProviderSend 打点(只记 token 数字)   │
       │  │ 3. 解析返回:文本增量 / tool_use / usage      │
       │  │    └─ onEvent({text_delta/thinking_delta})   │
       │  │ 4. 若有 tool_use:                           │
       │  │    ├─ 权限检查(PermissionManager)            │
       │  │    ├─ tools/executor 执行(可并行,防冲突)     │
       │  │    ├─ tool_result 写前定型(trim 类)          │
       │  │    └─ push 回 messages → 下一轮              │
       │  │ 5. 上下文管理:触发阈值 → ContextManager       │
       │  │    ├─ compact:合并旧块 + 追加新内容           │
       │  │    ├─ 超预算:只删尾部 / re-summarize 尾部     │
       │  │    └─ 冷存储:archived 到 contextStore         │
       │  │ 6. 无 tool_use → terminal = done,收尾        │
       │  └────────────────────────────────────────────┘
       │
       ▼
     onEvent 一路回推:chatViewProvider.onAgentEvent → webview 渲染
       │
       ▼
     会话落盘:SessionStore.save(含 rawText 原文,不含展开 prompt)
       ▼
     统计落盘:statsStore.record("provider_round" / "compaction" / "message_sent")
```

**时序要点**:
1. **消息先落历史再请求**:`AgentSession.send` 先把 user 消息 push 进 messages,再发请求——保证发送出去的 messages 与本地历史一致(缓存前缀稳定)。
2. **压缩发生在轮与轮之间**:`ContextManager` 在每次 provider 返回后、下一轮请求前检查 `needsCompaction()`,触发时合并旧压缩块 + 追加新内容(见 §5 的 P2 设计)。
3. **统计只记数字不记内容**:所有打点(`provider_send`/`provider_round`/`compaction`/`message_sent`)只存 token 数、耗时、命中率等数字,消息原文**不落盘**,隐私友好。
4. **回滚快照**:发送前 `this.messages.slice()` 存快照,失败/取消时恢复,避免压缩留下的稀疏空洞污染后续轮。

## 五、关键设计决策与取舍

> 这些决策是项目"为什么长这样"的答案,也是后续演进必须遵守的约束。详见各自规则文档。

### 5.1 缓存前缀稳定性(最高优先级约束)🔴

**为什么**:DeepSeek 独立缓存前缀单元机制(请求边界落盘 / 公共前缀检测 / 固定 token 间隔落盘)。system + tools + 历史 messages 前缀任何一字节变化 → 整段 miss → 缓存雪崩(压缩后首轮命中率曾 ~10%)。

**已落地规则**(规则文档 `.dsb/rules/cache-prefix-stability.md`,2026-08-16 全量核验:代码 + 测试均真实存在):
| 规则 | 内容 | 落地证据 |
|------|------|----------|
| 规则1(P0) | system 禁止放会话内会变的内容(todo 移出 system → 尾部注入) | ✅ `agentLoop.ts:102,598` `injectTodoIntoMessages` |
| 规则2 | 工具 def 顺序跨轮稳定,新增工具在消息层追加说明 | ✅ 现状已符合(executor toolDefs + mcp 插入序 + plugin 会话内不变) |
| 规则3 | 历史消息只追加、尾部变化,永不重写 | ✅ 现状已符合(messages 只 push,回滚恢复原快照) |
| 规则4(P2) | 压缩块只追加、只删尾、标题恒输出 | ✅ `contextCompactor.ts:332` `track(includeEmptyTitle)` + `:470` `collapseTailExplanations` + `contextManager.ts:652` 删尾部;82 测试全绿 |
| 规则5(P3) | 不删中部已消费块(tool_use/thinking 保留) | ✅ `agentLoop.ts:392/421` 只做幂等兜底,中部块保留 |
| 规则6(P1) | 同一内容只允许一种字节形态(tool_result 写前定型) | ✅ `agentLoop.ts:858-866` push 前定型,trim 类首次即最终形态 |

**✅ 基线对比量化已执行(2026-08-17)**:修正 `scripts/analyze-cache-prefix.py`(sendSeq 时间序配对 / 归组补 miss / broken 语义)后,对 08-15/16 全量数据实测并修正真实口径——详见 `.dsb/docs/2026-08-16-P2落地后缓存命中新基线.md` 与 `.dsb/docs/2026-08-17-cache-prefix-analysis-fix.md`。

**硬性验收(修正后基线)**:稳定期命中率 **97.0~97.7%**(旧基线 68~75%);压缩后首轮 **49~54%**(compaction 后**第一个 round**,旧基线 ~10%;「30s 窗口」口径虚高 89.6% 已废弃)。改动 system/压缩块/messages 构造必须跑 `scripts/analyze-cache-prefix.py`(含 `--self-test`)对比,不降命中率是硬性要求。

### 5.2 引擎层不依赖 vscode(可测性/可复用性)

**为什么**:全部逻辑(agent/context/stats/providers)可脱离 VS Code 在 Node 里单测(101 个测试文件 / 1090 tests),且可被 `benchmark/cli.ts` headless 复用打榜。输入输出走 `deps` 接口注入,事件走 `onEvent` 外发,方向固定单向。

**代价**:宿主桥(chatViewProvider/extension)承担全部装配逻辑,代码量大、易碎;任何新能力都要在宿主层"接线"。

### 5.3 thinking 全链路收敛(可剥离、可分级)

**为什么**:不同模型对 thinking 的支持差异大,且 thinking 产物会污染上下文(剥离产出不进历史/压缩/脉络)。收敛成:
- `thinkingProcessEnabled`:流程是否处理 thinking(false = 模型可思考但产物不落历史)。
- `thinkingLevel`:强度预设(off/低/中/高),按模型能力兜底。
- 设置面板全局开关 + 强度兜底,`budgetInfo()` 在关闭时把 split 归一化为两段。

**代价**:配置项增多,模型能力与用户设置的组合矩阵需要 `capabilityGate`/`modePolicy` 兜底。

### 5.4 统计体系:只记数字,不记内容

**为什么**:既要成本/命中率分析,又要隐私友好。`providerSendStats`/`statsStore` 只存 token 数、耗时、缓存命中 token、事件类型,消息正文不进统计。

**代价**:无法事后回溯"当时发了什么",只能看数字;需要另开调试日志才可见内容。

### 5.5 法律严格避让(开源发布约束)

**为什么**:以开源方式发布,产品名 DSBAgent,禁止攀附任何第三方产品名(见 `.dsb/rules/legal-strict-avoidance.md`)。影响所有用户可见文案、README、package.json。

## 六、系统概念对照

> 与 [system-concepts.md](../2026-08-16-system-concepts.md) 对齐:本文用到的关键术语定义。

| 本文术语 | 定义(见 system-concepts) | 出现位置 |
|----------|--------------------------|----------|
| 引擎层 | 不依赖 vscode、走 deps 注入 + onEvent 外发的逻辑层 | §2.3 |
| 宿主层 | 依赖 vscode、负责装配/UI/密钥的层 | §2.3 |
| AgentSession | 引擎唯一入口,一次 send = 一轮对话主循环 | §3.2 / §4 |
| ContextManager | 上下文压缩/裁剪/冷存储的决策者 | §4 步骤5 |
| 缓存前缀 | system+tools+messages 的公共前缀,命中则省 token | §5.1 |
| 压缩块 | `[前文摘要]` 块,append-only 结构 | §5.1 P2 |
| 冷存储 | 超预算历史归档到 contextStore,按需回捞 | §4 步骤5 |
