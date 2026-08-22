# DSBAgent vs deepseek-harness：同能力实现对照 — 设计说明

> 日期：2026-08-22  
> 状态：设计已定稿，待用户审阅后进入 implementation plan  
> 范围：研究对照（不改业务代码、不做产品选型结论）

## 1. 目标与读者

**目标**：对同一 Agent 能力，写清 DSBAgent（下称 DSB）与 deepseek-harness / `dsh`（下称 DSH）各自如何实现、关键代码锚点、以及该实现方式的优缺点。服务于理解与后续可能的借鉴，**不做「该用哪个产品」的结论**。

**读者**：熟悉其中一侧、想快速理解另一侧机制的开发者；以及以后要从对照中抽取迁移点的人。

**成功标准**：

- 覆盖能力轴全量（见本设计 §6–§7 / 对照正文目录第 2–3 章）；核心五件套达到实现级深度。
- 每节含：能力定义 → DSB 实现 → DSH 实现 → 分列优缺点。
- 每节两端至少各 1–2 个可定位的文件/包/事件锚点；优缺点可从机制推导。

## 2. 方法与证据

**方法**：能力轴对照（方案 1）。文首半页「组织范式」作钥匙；正文按能力开节；文末横切小结 + 术语附录。

**深度**：实现级 — 机制说明 + 关键模块/包名 + 关键函数/事件/数据流 + 路径锚点。核心五件套写满；其余能力同模板、可略短，但仍须实现级锚点（不低于「一笔带过」）。

**证据优先级**：

1. 源码（冲突时以源码为准，并脚注与文档差异）
2. DSB：`DSBAgent/.dsb/docs/`（含 `project-overview.md`、`system-analysis/`）
3. DSH：`deepseek-harness/docs/architecture*.md`、各包 `README.zh.md`、`AGENTS.md`

**非目标**：

- 不写产品选型结论；不写迁移/重写实施计划
- 不做性能基准实测；不修改两边业务代码
- 不逐行审计全部包；不要求对每一行工具实现做对比

## 3. 产物与落盘

| 产物 | 路径（约定） |
|------|----------------|
| 本设计说明 | `projects/.dsb/specs/2026-08-22-dsb-vs-dsh-capability-comparison-design.md` |
| 设计副本（可 git 跟踪） | `DSBAgent/.dsb/specs/2026-08-22-dsb-vs-dsh-capability-comparison-design.md` |
| 对照研究正文（计划阶段产出） | 默认同目录 `2026-08-22-dsb-vs-dsh-capability-comparison.md`；若用户指定可改到 `projects/.dsb/docs/` |

工作区根目录 `/home/hange/projects` 本身不是 git 仓库；以 DSBAgent 仓库提交设计副本。

## 4. 文档目录（对照正文）

1. **组织范式总览**（半页钥匙）
2. **核心五件套**
   - 2.1 循环
   - 2.2 工具执行
   - 2.3 上下文与压缩
   - 2.4 会话持久化
   - 2.5 扩展机制
3. **其余能力**
   - 3.1 权限与审批
   - 3.2 系统提示与技能
   - 3.3 子代理与工作流
   - 3.4 LLM 接入
   - 3.5 UI / 宿主形态
4. **横切对照小结**
5. **附录：术语对照表**

### 4.1 每节固定模板

| 小节 | 内容 |
|------|------|
| 能力定义 | 一句话：这项能力在 Agent 里干什么 |
| DSB 实现 | 机制 + 关键文件/函数 |
| DSH 实现 | 机制 + 关键包 / `ctx` 键 / 事件 |
| 优缺点 | 分列两端；只谈该能力，不升维到产品选型 |

## 5. 组织范式总览（文首要写清的点）

只建立坐标系，不展开具体能力细节。

| 维度 | DSB | DSH |
|------|-----|-----|
| 组装方式 | `extension.ts` 组装 deps，注入引擎 | profile → bundle → `cordis.yml` 叠插件树 |
| 「内核」 | `src/agent/` 相对固定；宿主桥接 UI | 无特权内核；`agent-loop` 亦可替换 |
| 扩展语言 | 接口注入 + `onEvent`；plugins / MCP / hooks | `ctx.effect` / waterfall / capability seam |
| 运行载体 | VS Code Extension（引擎可 headless） | 独立进程：web / headless / ACP / SDK |
| 真相来源 | 会话消息数组 + context 文件 + 统计 jsonl | 仅追加 `SessionEvent`；模型可见 ⟺ 已记录 |

## 6. 核心五件套 — 写作要点与初锚点

> 下列路径为探索阶段的**初锚点**；写作对照正文时须打开源码核对并补全函数/事件名。

### 6.1 循环

- **能力**：模型请求 →（可选）工具 → 再请求，直到本轮结束。
- **DSB 初锚点**：`DSBAgent/src/agent/agentLoop.ts`；旁路含 `append` 队列、轮次上限、缓存前缀稳定相关策略。
- **DSH 初锚点**：`packages/core/agent-loop/`；`docs/architecture.zh.md` 中 turn/step 与 `agent/pre-step`、`llm/stream`、`tools/*` waterfall。
- **优缺点焦点**：循环可替换性 vs 单文件可推理性；扩展是改循环还是挂事件；调试与测试成本。

### 6.2 工具执行

- **能力**：把模型发出的 tool_use 变成真实副作用，并把结果写回对话。
- **DSB 初锚点**：`src/agent/tools/definitions.ts`、`executor.ts`、`parallelSafe.ts`；`toolUsePolicy.ts` / `toolResultPolicy.ts`；`permission.ts`。
- **DSH 初锚点**：`packages/core/tools/`（`ctx.tools`）；`docs/tool-execution-pipeline.zh.md`；各能力组（`fs/`、`shell/`、`web/`…）的 Definition / Provider / Consumer。
- **优缺点焦点**：工具与实现耦合；换沙箱/远程执行的成本；策略落在执行器内还是流水线事件上。

### 6.3 上下文与压缩

- **能力**：在窗口预算内组装模型可见历史；超预算时压缩或外置，并尽量可回查。
- **DSB 初锚点**：`contextManager.ts`、`contextCompactor.ts`；冷存储 / `ContextRecall`；缓存前缀稳定性相关规则与文档。
- **DSH 初锚点**：`packages/compaction/`；session log 上的 `deriveMessages()`；「模型可见即已记录」不变量。
- **优缺点焦点**：缓存前缀工程深度 vs 日志投影纯度；回查/冷存储完备度。

### 6.4 会话持久化

- **能力**：会话可保存、恢复、必要时 fork/导出；支撑 UI 与引擎重启。
- **DSB 初锚点**：`src/session/sessionStore.ts`；globalStorage 下 context json/index；checkpoint。
- **DSH 初锚点**：`packages/core/session/`、`packages/session/`（JSONL/SQLite 等后端）；投影与标题/遥测。
- **优缺点焦点**：消息数组 vs 事件日志；回放与 UI 保真；格式演进。

### 6.5 扩展机制

- **能力**：在不改（或少改）核心循环的前提下增加工具、技能、钩子或运行时行为。
- **DSB 初锚点**：`src/plugins/`、`src/mcp/`、`src/hooks/`；`projectContext/` + 仓库 `skills/` + `.dsb/` 约定。
- **DSH 初锚点**：挂插件 / profile patch；`packages/extensions/`；`packages/hooks/`；bundle（`dsh-base` 等）。
- **优缺点焦点**：对编辑器用户友好 vs 对 harness 组合友好；扩展边界与卸载/可逆性。

## 7. 其余能力 — 写作要点与初锚点

### 7.1 权限与审批

- DSB：`permission.ts`、`permissionRules.ts`、`capabilityGate.ts`；设置「超级权限」等。
- DSH：`packages/interaction/`；与 `tools/*` 流水线挂钩的审批 seam。
- 焦点：默认拦截粒度、放行决策者、对编码流畅度的影响。

### 7.2 系统提示与技能

- DSB：`systemPrompt.ts`、`projectContext/`（规则/技能/命令注入）、内置 `skills/`。
- DSH：`packages/core/system-prompt/`；`packages/skill/`；`packages/preset/`。
- 焦点：约定注入时机；技能是扫描注入还是工具拉取。

### 7.3 子代理与工作流

- DSB：`subagentRunner.ts`、`workflow.ts`、`worktree.ts`。
- DSH：`packages/subagent/`、`packages/workflow/`；实验性 agent teams（若仍存在则以源码为准）。
- 焦点：隔离边界（worktree / 进程 / isolate realm）；委托与回传。

### 7.4 LLM 接入

- DSB：`src/agent/provider/anthropicMessagesClient.ts`；`src/providers/` 多供应商与能力探测。
- DSH：`packages/llm/`（`ctx.llm`）；DeepSeek 等 Provider。
- 焦点：统一兼容协议 vs 适配器可插拔；流式/重试所在层。

### 7.5 UI / 宿主形态

- DSB：`webview/` + `chat/chatViewProvider.ts`；命令面板；`benchmark/cli.ts` headless 复用引擎。
- DSH：`packages/host/` + `packages/client/`；`apps/`；ACP / SDK profiles。
- 焦点：编辑器内嵌 vs 独立产品面；同一引擎多宿主成本。

## 8. 横切小结与附录

**横切小结**（只收束，不新开能力）：

- 真相来源：消息数组/文件 vs 事件日志
- 扩展点：改循环代码 vs 挂 waterfall
- 测试边界：引擎不依赖 `vscode` vs 包级门禁 + snapshot
- 「换一块能力」的成本量级（定性）

**附录 · 术语对照**：写作正文时根据核对结果填充；示例方向：Agent Loop ↔ turn/step + `dsh-agent-loop`；`[compacted]` ↔ compaction Provider；ContextRecall ↔ session-query / 相关检索能力（以读码为准）。

## 9. 实施顺序（供 writing-plans 拆任务）

1. 核对并写 §组织范式 + 核心五件套（循环 → 工具 → 压缩 → 会话 → 扩展）
2. 写其余五节能力
3. 写横切小结 + 术语附录
4. 通读：去占位符、去矛盾、统一锚点写法

每步产出可审查的 markdown 增量；对照正文完成后不做代码变更。

## 10. 设计决策记录

| 决策 | 选择 |
|------|------|
| 对照范围 | 全量能力轴（类 A） |
| 深度下限 | 核心五件套实现级；其余同结构且不低于该下限的可读深度（类 B） |
| 证据粒度 | 实现级（类 B） |
| 写法 | 能力轴对照 + 文首范式钥匙（方案 1） |
| 落盘 | `projects/.dsb/specs/` 为主；DSBAgent 仓库保留可提交副本 |
