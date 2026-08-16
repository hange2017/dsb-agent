# 09 · benchmark / 打榜专题

> 状态:✅ 已完成(2026-08-17)
> 关联:02-evolution-roadmap.md 方向 D;benchmark/ 目录。

## 一、评测架构

```
benchmark/
├── cli.ts          # headless 入口:SWE-bench-Live 实例 → AgentSession → 工具执行 → patch
├── provider.ts     # ScriptedProvider(fake 冒烟)/ 真实 provider 组装
├── deps.ts         # 复用 src/agent 引擎依赖(不依赖 vscode)
├── swebench.ts     # 实例读取 / problem prompt / repo 准备 / patch 提取 / git 校验
├── stats.ts        # CostTracker(成本统计)
├── build.mjs       # 独立构建(dist-benchmark/,不进扩展包)
└── smoke.test.ts   # 两轮脚本对话全链路冒烟(无 API key)
```

- 复用 `src/agent/` 引擎(AgentSession → ToolExecutor → Bash),headless 运行;
  环境变量 `DSB_API_KEY / DSB_BASE_URL / DSB_MODEL / DSB_COST_PER_CALL`。

## 二、路线图状态(benchmark-roadmap)

| 里程碑 | 状态 | 说明 |
|---|---|---|
| T1 | ✅ 完成 | CLI headless 可跑 + smoke 测试 |
| T3 | 🔄 进行中 | 自包含 VM worklog、probe 实例准备脚本 |
| T2 / T4 | ⏳ 待办 | 完整榜单提交流程 / 结果归档与复现性 |

## 三、成本效率卖点(如何证明)

- **卖点**:低单价模型(默认兼容端点)+ **~95% 缓存命中率**(稳定期 97.0~97.7%,见 06)
  → 同任务成本显著低于无缓存方案。
- **数据来源**:stats 体系(provider_round 真实 usage)→ 07 的口径规则保证可信;
  打榜时 CostTracker 按实例汇总 cost/rounds,可直接产出「单实例成本」证据。
- **待补**:与对照方案的公平对比(同实例、同 prompt、同轮次上限),写入 T2 提交规范。

## 四、后续行动项

1. T3 收尾:自包含 VM 复现环境 + 实例清单版本化。
2. T2:提交规范(实例选择、轮次上限、温度、超时)→ 完整榜单跑批 → 结果归档格式。
3. T4:复现性保障(固定依赖版本、patch 校验、输出哈希)。
4. 卖点数据:跑 5~10 个代表性实例,输出「成本效率对照表」进 README(合规用语,见 rules/legal-strict-avoidance)。
