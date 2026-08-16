# 06 · 性能与成本专题

> 状态:✅ 已完成(2026-08-17,基于 08-15/16 实测 + 08-17 恢复曲线分析)
> 数据源:`~/.dsb/stats/*/events-*.jsonl`(真实 provider_round 口径)+ `scripts/analyze-cache-prefix.py`
> 关联:`.dsb/docs/2026-08-16-P2落地后缓存命中新基线.md`、`.dsb/docs/2026-08-17-压缩后首轮命中率恢复曲线分析.md`

## 一、缓存命中率基线(真实口径,权威)

| 分组 | 命中率 | 说明 |
|---|---|---|
| 稳定期(压缩后第 4+ 轮) | **97.0~97.7%** | P2 落地后压缩块前缀稳定生效;旧基线(整块重写)仅 ~10% |
| 压缩后第 1 轮(最差) | **49~54%** | 结构性一次性成本(见下),非持续劣化 |
| 压缩后第 2 轮 | **97.1%** | 前缀与第 1 轮相同 → 全部命中,**恢复速度 = 1 轮** |
| 压缩后第 3 轮 | 96.4% | 同上 |
| 会话首轮(重建/首次压缩) | 最低 7.6% | compacted 全新生成,无旧块可命中;仅 6/184 次 <20% |

### 压缩后首轮 miss 构成(平均值,08-16)

```
总输入 48,803 = system+tools(~17.2K) + compacted(18.0K) + tail(13.7K)
命中 26,738   = system+tools(部分) + compacted(全命中)
未命中 22,065 ≈ tail 全 miss(13.7K) + system/tools 变化部分(~8.4K)
```

**断裂点定位(字节级 hash 对比)**:184 次压缩事件全部在 **index 1**(compacted 之后)断裂——
- compacted(index 0):hash 100% 相同 → 全命中(P2「只追加不重写」真实生效);
- tail(index 1 起):hash 全不同 → 全 miss。原因:**压缩折叠中间历史后,后续消息前缀位置前移**,
  字节流整体变化 → 即使 tail 内容未变也无法命中。这是**任何压缩方案的结构性代价**。

## 二、压缩成本

### 触发机制(contextManager.ts)
- **窗口兜底**:`lastInput / windowTokens >= triggerRatio`(默认 0.75)→ 压缩。
- **预算触发**:历史 token 总预算(默认 **150K**)+ tail 预算(target/hard)双轨。
- **分轨压缩(T1-T9)**:demands / conclusions / explanations / ledger 四轨,增量合并 + 阈值 0.7。

### 自耗成本
- 压缩流程的 LLM 调用单独打点(`phase="compact"` 的 provider_round),统计口径已闭环。
- CompactionStats 滑动窗口(agentUI header 徽章)监控压缩频率与耗时。
- 收益核算:每次压缩一次性成本 ≈ 22K tokens 未命中;收益为压缩后每轮仅发送
  compacted(18K)+tail(13.7K)+system/tools(17K) ≈ 49K(不压缩则 132 个块全量发送)。
  压缩间隔 7~10 轮,收益 >> 成本。

## 三、token 优化手段

| 手段 | 位置 | 说明 |
|---|---|---|
| tool_use 瞬态字段省略 | `toolUsePolicy.ts` | 瞬时字段 ≥200 字符(按 key 可调)→ `[瞬时参数已省略:...]` 占位;StrReplace old_string 保留回查标记 |
| tool_result 规则裁剪 | `toolResultPolicy.ts` | 低密度工具(Bash/grep/WebFetch)trim;trim 后仍超阈值 → LLM 摘要;`[tool-result-trimmed]` 标记 |
| tool_result 写前定型 | `agentLoop.ts`(P1) | trim 类 tool_result 在写入 messages 前定型最终字节形态,避免发送前改写破坏前缀 |
| thinking 精简 | 压缩块 append-only(P2) | thinking 独立压缩块 + 脉络行 summary 回写 |
| 历史预算默认 | 设置 | `historyTokenBudget` 默认 150K(窗口 1M) |
| 压缩块稳定 | `contextCompactor.ts`(P2) | 4 轨标题恒输出 + 只删尾部 + re-summarize 只动新增行 → compacted 前缀字节稳定 |

## 四、延迟链路

- provider 往返:agentLoop 每轮 `roundMs` 打点;`preparedMs` 记录发送前估算耗时。
- 压缩耗时:`.dsb/docs/2026-08-10-压缩耗时实测统计.md`(压缩本身是 LLM 调用,耗时计入 compact phase)。

## 五、优化机会(优先级排序)

| # | 机会 | 影响 | 工作量 | 预期收益 |
|---|---|---|---|---|
| 1 | **减少压缩频率**(提高 triggerRatio / 预算) | 摊薄一次性成本 | S | 每次压缩省 ~22K miss tokens |
| 2 | **官方小时级对账重跑**(08-10/11 后未做) | 验证统计口径 | S | 确认 provider_round 与官方一致 |
| 3 | tail 也进 compacted(全折叠) | 首轮 miss 只剩增量 | M | **不推荐**(牺牲近期细节可读性) |
| 4 | 会话首轮预热(首次压缩时) | 首轮 7.6% 场景 | M | 仅影响会话重建,频次低 |
| 5 | tool_result trim 阈值调优 | 尾部 tokens 减少 | S | 压缩前窗口内 tail 更小 → 压缩更少 |

> 现状:优化 1/2 已部分落地(triggerRatio 默认 0.75、脚本自检 7 场景);3/4/5 为待评估方向,详见 [02-evolution-roadmap.md](02-evolution-roadmap.md) 方向 A。
