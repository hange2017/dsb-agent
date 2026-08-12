# DSBAgent Benchmark CLI(headless 打榜入口)

复用 `src/agent/` 引擎(不依赖 vscode),以 headless 方式运行 SWE-bench-Live 实例。

## 构建

```bash
npm run benchmark:build    # 输出 dist-benchmark/cli.js(不进扩展包)
```

## 冒烟测试(无需 API key)

```bash
npm run benchmark:smoke    # 构建 + vitest 跑 benchmark/smoke.test.ts
```

`smoke.test.ts` 用 `ScriptedProvider` 模拟两轮对话(工具调用 + 完成),验证
AgentSession → ToolExecutor → Bash 工具的整条链路,并校验 patch 提取与成本统计。

## 真实运行

```bash
# 单实例
DSB_API_KEY=sk-xxx node dist-benchmark/cli.js \
  --instance instances/xxx.json --work-dir benchmark/out/work

# 批量(instances-dir 下所有 .json 视为实例,串行执行)
DSB_API_KEY=sk-xxx node dist-benchmark/cli.js \
  --instances-dir instances/ --work-dir benchmark/out/work --continue-on-error
```

## 参数

| 参数 | 说明 |
|------|------|
| `--instance <file>` | 单个 SWE-bench-Live 实例 JSON |
| `--instances-dir <dir>` | 批量实例目录(每个 .json 可含 1 个或多个实例) |
| `--work-dir <dir>` | 工作目录(默认 `benchmark/out/work`;clone 的 repo 与 `.memory` 放这里) |
| `--out-dir <dir>` | 输出目录(默认 `benchmark/out`) |
| `--fake` | 冒烟模式(无需 API key;用 ScriptedProvider) |
| `--model <id>` | 模型(默认 `DSB_MODEL` 或 `deepseek-chat`) |
| `--max-rounds <n>` | 单实例最大工具轮数(默认 200) |
| `--cost-per-call <cny>` | 单次调用成本折算(默认 0.005 元,来自实测均值) |
| `--continue-on-error` | 批量模式下实例失败继续跑 |
| `--git <path>` | git 可执行文件(默认 `git`) |

## 环境变量

- `DSB_API_KEY` — 必填(真实模式)
- `DSB_BASE_URL` — Anthropic 兼容端点(默认 `https://api.deepseek.com`)
- `DSB_MODEL` — 模型(默认 `deepseek-chat`)
- `DSB_COST_PER_CALL` — 单次调用成本(默认 `0.005`)

## 输出物

- `preds.json` — `{ instance_id: patch }`,SWE-bench-Live 提交格式
- `progress.jsonl` — 每实例一行:调用次数 / token / 成本 / patch 长度
- `<instance_id>.cost.jsonl` — 单实例每次 provider.round 的原始 usage
- `<instance_id>.traj.jsonl` — 单实例完整 rollout 轨迹(每次 provider.round 的请求/工具调用/事件)

> ⚠️ **可复现性要求(PR 门槛)**:榜单提交需要 `preds.json` + `results.json` + **完整轨迹日志**,缺轨迹 PR 会被拒。
> 轨迹/成本 JSONL **一律全量落盘,禁止压缩、截断、去重**;同时记录运行元信息(模型、system prompt 版本、rollout 次数、时间戳)到 `manifest.json`。

## 评测公平性

- 系统提示只注入 `buildSystemPrompt({ workspaceRoot, locale: "en" })`,
  **不注入** DSB 项目约定 / 技能 / 记忆(评测可复现)。
- 记忆用空 `MemoryStore`(指向 work-dir/.memory,不预置内容)。
- 权限 `bypassPermissions`,无交互确认。
- prompt 明确要求 agent **不要 commit**,patch 从工作区 `git diff` 提取。
