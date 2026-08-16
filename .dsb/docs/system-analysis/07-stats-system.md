# 07 · 统计体系专题

> 状态:✅ 已完成(2026-08-17)
> 范围:事件写入 → JSONL 落盘 → 聚合分析 → 口径规则 全链路。

## 一、存储(StatsStore)

- **位置**:`~/.dsb/stats/<sessionId-hash>/events-YYYY-MM-DD.jsonl`(按日分文件)。
- **格式**:JSONL append,单行 `{t, type, data}`,崩溃安全。
- **保留**:默认 30 天,写入时 1% 概率抽样清理过期文件(避免每次写都扫目录)。
- **可靠性**:fail-open——统计写入失败不影响主流程;`data` 只记数字/轻量字段,不记内容(隐私友好)。

## 二、事件类型清单

| 事件 | 写入点 | 关键字段 | 用途 |
|---|---|---|---|
| `message_sent` | chatController | textLen | 用户消息量 |
| `provider_send` | chatViewProvider onProviderSend | 消息组成 token 估算、sessionId、sendSeq | 发送前消息构成(估算口径) |
| `provider_round` | chatViewProvider onProviderRound | inputTokens、outputTokens、cacheReadTokens、sessionId | **真实 usage(权威命中率口径)** |
| `compaction` | chatViewProvider onCompaction | startedAt、原因、before/after tokens、llmDetail(可关) | 压缩事件定位 |
| `compaction_qa` | chatViewProvider onCompactionQa | qa 输入/输出 tokens | 压缩自审成本 |
| `context_recall` | executor / contextRecallTool | 回查模式/结果 | ContextRecall 使用量 |
| `settings_change` | extension | 改前/改后配置 | 配置变更追踪 |

## 三、聚合与分析(aggregate.ts)

### 1. `analyzeCacheAfterCompact` — 压缩雪崩分析
- 收集所有聊天轮 `MissRatePoint`(missTokens = input - cacheRead,负数按 0)。
- 对每次 `compaction`:基线 = 压缩前最近 5 轮 missRate **中位数**;
  输出 `CompactAvalanche` { firstMissRate, extraMissTokens, recoveryRounds(连续 3 轮 ≤ 基线判定恢复) }。
- 汇总 `totalExtraMissTokens` + `avgRecoveryRounds`。

### 2. `hourlyCostSummary` — 小时成本汇总
- 按本地小时键 `YYYY-MM-DDTHH:00` 聚合:rounds / compactions / inputHit / inputMiss / output。
- 成本按单价计算(`DEFAULT_PRICES`:hit 0.02、miss 1、output 2 美元/百万 token,可覆盖)。
- `realCost = costTotal - qaCost`(剔除压缩自审成本)。

### 3. `sessionRoundAgg` — 会话轮次聚合
- RoundResult / WindowAgg:按窗口字段聚合轮次级指标(压缩耗时、QA 抽查等)。

## 四、口径规则(权威结论,2026-08-17 固化)

1. **真实口径为准**:`provider_round` 的 `cacheReadTokens / inputTokens` 是唯一权威;`provider_send` 的估算偏悲观(消息粒度全有全无),仅用于「压缩前/后消息构成对比」。
2. **估算 ≠ 真实**:估算不含 system+tools(约 17K tokens/轮);补上后与真实高度吻合(08-16 估算 96.0% vs 真实 95.0%)。
3. **30s 窗口口径已废弃**:早期「窗口内所有 round」把已恢复命中的轮次计入首轮,虚高 89.6%;真实首轮 49~54%。**必须按压缩后第 k 轮分组**(第 1/2/3/4+),见 `analyze-cache-prefix.py`。
4. **sendSeq 配对规则**:按 `(t, seq)` 时间序排序;seq 回退/相等 = 会话重建,跳过配对(避免误配)。
5. **broken 语义**:仅统计既有消息内容变化;追加/块扩展不算断裂。

## 五、分析脚本

| 脚本 | 用途 | 自检 |
|---|---|---|
| `scripts/analyze-cache-prefix.py` | 相邻轮 hash 对比 → 命中归属 + 压缩后第 k 轮恢复曲线 | `--self-test` 7 场景全绿 |
| `scripts/analyze-compaction-snowball.py` | 压缩雪球效应监控 | — |

## 六、已知缺口

- 官方小时级对账(08-10/11 之后)未重跑,可在下次数据采集时顺带完成。
- `compaction` 事件 `detailLevel=basic` 时丢弃 llmDetail,聚合无法还原逐位置明细(有意取舍,控制体积)。
