# 打榜落地执行计划(SWE-bench-Live Lite + Terminal-Bench 2.0)

> 日期:2026-08-12
> 关联文档:[打榜路线](../docs/benchmark/benchmark-roadmap.md)(已归档)
> 目标:完成路线「阶段一」——以 DSBAgent + DeepSeek-V4-Flash 跑通 SWE-bench-Live Lite(300 实例)与 Terminal-Bench 2.0(84 任务 × 5 trial),分别提交 PR 上榜,并产出"单任务成本全榜最低"的差异化数据。

## 一、现状勘察结论(证据)

| 项 | 结论 | 证据 |
|----|------|------|
| 引擎是否依赖 vscode | **引擎层不依赖 vscode 模块,可脱离宿主运行** | `.dsb/docs/project-overview.md` 明示;`src/agent/agentLoop.ts` 的 `AgentSession` 通过 `deps` 注入 `provider/tools/permissions/workspaceRoot/systemPrompt` |
| 文件工具是否解耦 | **`workspaceFs.ts` 为纯 fs 实现**,`root` 外部传入,无 vscode API | `src/agent/tools/workspaceFs.ts`(resolveWorkspacePath / read / write / glob / strReplace 全用 `fs` + `path`) |
| 工具执行器 | `executor.ts` 不 import vscode;ripgrep 路径经 `ToolExecContext` 注入 | `src/agent/tools/executor.ts` |
| 系统提示 | `buildSystemPrompt(input)` 纯函数,可离线组装 | `src/agent/systemPrompt.ts` |
| Provider 客户端 | `AnthropicMessagesClient` 基于 fetch 的 SSE,构造需 baseUrl + apiKey | `src/agent/provider/anthropicMessagesClient.ts` |
| 单测先例 | `tests/agentLoop.test.ts` 用 fake provider/tools 直接驱动 `AgentSession` 跑完整循环 | 已读代码 |

**结论:headless 打榜 wrapper 的架构风险低**,主要工作量在"扩展宿主层(stub 化)+ 榜单适配层"。

## 二、关键决策:headless wrapper 形态

DSBAgent 是 VS Code 扩展,不能直接在评测环境跑 UI。wrapper 采取:

```
benchmark/
├── cli.ts                  # CLI 入口:读实例 → 组装依赖 → 跑 AgentSession → 收集 patch
├── run-swebench-live.ts    # SWE-bench-Live 适配(实例读取/提示构造/preds.json 生成)
├── run-terminal-bench.ts   # Terminal-Bench 2.0 适配(agentbeats 接口或 LiteLLM 端点形态)
├── host/                   # 扩展宿主 stub(见 §四)
└── types.ts                # 榜单数据结构类型
```

- 复用引擎:`src/agent/`(AgentSession / executor / workspaceFs / provider / memory / systemPrompt)全部原样复用,不打补丁。
- 不打包进 vsix:benchmark 属开发/评测工具,`package.json` 的 `files` 不含该目录(或用独立 npm script 编译)。
- 运行环境:评测任务在**临时目录**(每次实例 clone 对应 repo 到 `<work>/<instance_id>/`),`workspaceRoot` 指向该目录;权限模式 = `bypassPermissions`(评测环境无交互)。

## 二·补、提交前约束(三个坑,2026-08-12 补充)

> 详见路线文档「四·补」。以下三条直接约束 CLI 行为与跑批参数,实现时必须落实。

### 坑一:轨迹日志必须全量落盘(否则 PR 被拒)
- 榜单要求 `preds.json` + `results.json` + **完整 rollout 轨迹日志**。
- CLI 必须默认全量保存:每实例轨迹 JSONL(每次 provider.round / 工具调用 / 事件)、`preds.json`、运行元信息(模型、system prompt 版本、rollout 次数、时间戳)。
- **禁止**任何压缩/截断/去重日志的"省空间"优化。

### 坑二:Terminal-Bench 每任务 ≥5 次 trial
- `-k 5`,`timeout_multiplier = 1.0`,不得覆盖超时与资源限制。
- 成本按单次 ×5 估算;5 次 trial 每次都要有轨迹与通过/失败记录。

### 坑三:SWE-bench-Live 每实例 3 次回归测试
- 官方要求 regression tests 跑 3 次,过滤无效实例后取有效结果。
- 跑量与成本按 ×3 估算;`results.json` 需体现 3 次回归过程(失败/重试/筛选说明)。

## 三、任务分解(对齐路线 Day 1-10)

### T1(Day 1):CLI 骨架 + 依赖组装
- 建 `benchmark/` 目录,esbuild 增加一个 `benchmark` 入口(或独立 tsconfig + tsc 编译)。
  - **已落地(2026-08-12)**:独立 `benchmark/build.mjs`(esbuild)输出 `dist-benchmark/cli.js`,不动扩展的 `esbuild.mjs`;`npm run benchmark:build` / `benchmark:smoke`。
- 实现 `host/` stub(见 §四),把 `AgentSession` 需要的一切依赖从 vscode 侧换成 CLI 配置。
- 冒烟:`benchmark/cli.ts --help` 可运行;构造 `AgentSession` 成功。

### T2(Day 1):SWE-bench-Live 实例适配
- 输入:SWE-bench-Live 实例 JSON(字段含 `instance_id`、`problem_statement`、`repo`、`base_commit`、`patch` 等)。
- 流程:clone 指定 repo + checkout base_commit → 组装 problem prompt → 跑 `AgentSession.send(problem)` → 从会话事件中提取模型产出 patch。
- 输出:每个实例的 `preds.json`(`{ instance_id: patch }`)。
- **patch 提取策略**:首选拦截 `Bash(git diff)` 输出;兜底要求模型以 `<patch>` 块输出;评测前用官方 evaluation script 验证格式。

### T3(Day 1):本地端到端验证 1 个实例
- 手动指定 1 个简单实例,完整跑通:clone → prompt → agent 循环 → patch → 用官方评测脚本本地验证 pass/fail。
- 验证 token 埋点:统计 `provider_send` 事件(缓存命中、input/output token、成本)落盘到 `~/.dsb/stats/` 或 CLI 独立统计文件。

### T4(Day 2-5):批量跑 Lite 子集(300 实例 × 3 次回归)
- 本地脚本按 `num_workers`(建议 4-8)并发跑,每实例独立临时目录。
- 断点续跑:完成实例写 `<work>/progress.jsonl`,失败/超时重试策略(每实例最多 3 轮,超时 30min)。
- 实时监控:缓存命中率、单任务成本、失败率、resolve 进度,输出到 `benchmark/out/` 目录。
- **坑一落实**:每实例轨迹 JSONL 全量落盘(provider.round / 工具调用 / 事件),不压缩不截断。
- **坑三落实**:每实例跑 **3 次**回归取有效结果;3 次记录(含失败/重试)一并归档进 `results.json` 素材。
- **坑二落实**:总跑量按 ×3 估算与排期(300 × 3 = 900 runs 量级),优先半夜时段批跑。

### T5(Day 6):结果生成 + PR 提交
- 用官方 evaluation script 生成 `results.json`。
- 按路线归档的提交方式:fork `SWE-bench-Live/submission` → `submissions/lite/dsb-agent/deepseek-v4-flash/` → `preds.json` + `results.json` + `trajs/` + `README`(写清 scaffold、rollout 次数、采样方式、成本数据)→ PR。

### T6(Day 7):Terminal-Bench 2.0 适配
- 复核 agentbeats 接口要求(`scenario.toml` → `agentbeats_id` + `AGENT_LLM` LiteLLM 兼容字符串;GitHub Actions + Docker Compose 自动评测)。
- 两条实现路径(实现时选通):
  a) **模型端点形态**:把 DSBAgent 引擎包成 LiteLLM 兼容的"模型"端点(TB 场景把任务作为 user 消息,agent 工具循环在服务端跑)——需要在基准仓库侧配置 API keys;
  b) **本地 runner 形态**:自己跑 TB 评测(官方 harness + DSBAgent wrapper),把通过率/成本数据整理成对比报告(适合阶段二技术文章,同时为 a) 铺路)。
- 5 次 trial(`-k 5`),`timeout_multiplier = 1.0`,**不得覆盖超时与资源限制**(坑二)。

### T7(Day 8):Terminal-Bench 结果 + PR
- 按仓库 README 流程提交(或先以数据报告形式发布)。

### T8(Day 9-10):技术内容产出
- 成本拆解报告(基于真实埋点数据):单任务 token / 成本 / 缓存命中率。
- 博客初稿 + 数据卡片(与 Claude Code/Cursor 横向对比)。

## 四、依赖注入清单(stub 化工作量)

`AgentSession` 构造所需依赖与 CLI 侧提供方式:

| 依赖 | CLI 侧提供 |
|------|-----------|
| `provider: ProviderClient` | 真 `AnthropicMessagesClient`(baseUrl + apiKey 从环境变量 `DSB_API_KEY` / `DSB_BASE_URL` / 配置文件读) |
| `tools: ToolExecutor` | 真 `executor.ts`(构造需 `ripgrepPath`、MCP 注册表(空)、插件(空)、记忆存储等,见下) |
| `permissions: PermissionManager` | 真实现,gateway = `{ request: async () => true }`(评测环境免交互),rules = 空 |
| `workspaceRoot` | 每实例临时目录 |
| `ripgrepPath` | 复用 `dist/bin/rg` 或 `@vscode/ripgrep` 的 `rgPath` |
| `systemPrompt` | `buildSystemPrompt({ workspaceRoot, locale: "en", projectInstruction: 榜单任务指令 })`——**不注入 DSB 项目约定/技能/记忆**(保持评测可复现、公平) |
| `onProviderSend / onProviderRound / onCompaction` | CLI 统计器:落 JSONL(缓存命中、token、成本) |
| `contextStore / memory` | 空实现或按需(第一版**关闭**记忆,保证可复现;记忆影响作为阶段三实验) |
| `stats: CompactionStats` | 可选注入,记录压缩统计 |

需要 stub 的**扩展宿主侧**(不在 `AgentSession` 内,但 `executor` 的部分工具依赖):
- `src/settings/configuration.ts` 读取(改成从环境变量/CLI 参数读)
- `apiKeyStore`(SecretStorage → CLI 环境变量)
- `mcpRegistry` / 插件注册表:空实现(评测不需要 MCP/插件)
- `contextStore`:可选(冷存储归档,评测期可关闭)
- `hooks`:空 `HookRunner`
- `sessionStore`:可选(CLI 不需要 UI 会话)

> 注:`executor.ts` 构造需要的具体参数(PluginCommandRunner、WebSearchImpl、MemoryStore 等)在实现 T1 时逐个核对;上表是已知全集,不排除 1-2 个小依赖。

## 五、埋点与成本核算(差异化卖点数据源)

- 复用 `src/stats/providerSendStats.ts` 口径:`onProviderSend` 记录每次请求 token 组成。
- `onProviderRound` 记录真实 usage(含 `cache_read_tokens` / `cache_write_tokens`),即"缓存命中率 ~95%"的实证来源。
- CLI 汇总输出 `benchmark/out/cost.json`:`{ instance_id, calls, inputTokens, outputTokens, cacheReadTokens, costUSD, resolve }`。
- 单任务成本 = Σ(输入×价 + 输出×价 − 缓存抵扣);按 DeepSeek V4 Flash 官方价目折算,写入博客与 PR README。

### 5.1 成本预算(2026-08-12 更新,实测口径 ≈0.005 元/次调用)

| item | calls | cost CNY | note |
|------|-------|----------|------|
| SWE-bench-Live Lite (300 instances x 3 regressions) | ~7200-12000 | ~36-60 | 8-13 calls/instance x3 |
| Terminal-Bench 2.0 (84 tasks x 5 trials = 420 runs) | ~2100-4200 | ~10-21 | -k 5, timeout_multiplier=1.0 |
| SWE-bench-Live Full (300 x 3, phase 3) | ~19500-39000 | ~97-195 | harder instances, more calls |

Stage1 subtotal (Lite x3 + TB x5): ~46-81 CNY; all phases: ~150-280 CNY. Keep 2x margin (~100-160 / ~300-560 CNY).

### 5.2 成本探针(T3 前置步骤,先验证再放量)

1. 取 **3-5 个代表性实例**(简单/中等/复杂各若干),完整跑通并记录每次调用 token 与成本。
2. 实测每实例平均调用次数 → 外推 300 实例总成本;若远超预算上限(如 >2 倍),暂停放量,先优化(如精简 system prompt、调大窗口降压缩率)。
3. 将实测单价回填到路线文档 §六,作为 PR README 的成本披露数据。

## 六、里程碑与验证

| 里程碑 | 验证方式 |
|--------|---------|
| M1:CLI 能跑通 1 个 SWE-bench-Live 实例 | 端到端:clone → prompt → agent → patch → 官方评测脚本给出 pass/fail |
| M2:Lite 300 实例批量完成 | `out/progress.jsonl` 300 条;`preds.json` 可被官方 evaluation script 消费;**每实例轨迹 JSONL 完整落盘**(坑一) |
| M3:resolve rate 决策点 | < 15% → 停止打榜,先强化自主任务拆解(路线§五);≥ 20% → 正式提交 |
| M4:Terminal-Bench 跑通 1 任务 × 5 trial | harness 输出通过率 |
| M5:PR 提交 | 提交物齐全(坑一):`preds.json` + `results.json` + `trajs/` + README;榜单仓库审核状态 |

## 七、风险与对策

| 风险 | 对策 |
|------|------|
| patch 提取格式不符评测 | T3 端到端先验证;以官方 evaluation script 可消费为准 |
| DeepSeek 长上下文/压缩在长任务上退化 | 打开 `windowTokensOverride` 调大窗口;监控压缩频率 |
| 评测环境无网络(部分 repo 依赖) | SWE-bench-Live 用本地 clone + 离线模式;实例依赖安装脚本可能需预置 |
| API 速率限制 | `num_workers` 调低 + 指数退避重试 |
| Terminal-Bench 提交形态复杂(agentbeats) | 先出本地数据报告(路径 b),再评估 a 的投入产出 |
| 打榜暴露低分影响口碑 | 路线§四已定义叙事:"性价比极致";PR README 主动披露成本数据 |

## 八、不在本次范围

- 阶段二/三(技术博客、AA 对标、Memory Leaderboard)——完成阶段一并验证数据后另行计划。
- 修改扩展本体能力(除非 M3 判定需强化任务拆解)。
