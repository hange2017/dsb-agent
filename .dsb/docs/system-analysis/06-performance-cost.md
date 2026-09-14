# 06 · 性能与成本专题

> 状态:✅ 已完成(2026-08-17;2026-09-15 增补阶段 C 96k/3:7 实测)
> 数据源:`~/.dsb/stats/*/events-*.jsonl`(真实 provider_round 口径)+ `scripts/analyze-cache-prefix.py`
> 关联:`.dsb/docs/2026-08-16-P2落地后缓存命中新基线.md`、`.dsb/docs/2026-08-17-压缩后首轮命中率恢复曲线分析.md`、
> `.dsb/docs/2026-09-14-压缩目标漂移修复与96k预算实测.md`(阶段 C 实测)

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
- **预算触发**:历史 token 总预算(`historyTokenBudget`)+ tail 预算(target/hard)双轨。
  - 阶段 B:64K、compacted:tail = **.56 / .44**(tail 触发点约 21120);
  - 阶段 C:96K、compacted:tail = **.30 / .70**(tail 触发点约 50400)。
- **分轨压缩(T1-T9)**:demands / conclusions / explanations / ledger 四轨 + **map 轨(任务地图,常驻块首)**,
  增量合并 + 阈值 0.7。

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
| 历史预算默认 | 设置 | `historyTokenBudget` 默认 150K(窗口 1M);**当前实测阶段 C:96K,compacted:tail = .30:.70** |
| 压缩块稳定 | `contextCompactor.ts`(P2) | 轨标题恒输出 + 裁剪只动非需求轨/需求轨中间行 + re-summarize 只动新增行 → compacted 前缀字节稳定 |
| **任务地图常驻** | `taskMap.ts` / `contextManager.ts`(2026-09-14) | 块首地图永不参与裁剪,goal 与中期澄清不随压缩丢失;灰度 `taskMapEnabled` |

## 五、阶段 C(96k / 3:7)预算实测(2026-09-14)

用户将历史预算与 tail 份额由阶段 B(64K / .56:.44)改为 **96K / .30:.70**,
自 2026-09-14 23:01:40 起,同日 23:46 采样(**同一会话自然对照**)。

成本指数 `effCostIdx = input + 0.1×cacheRead + output`(缓存感知):

| 每轮指标 | 阶段 B | 阶段 C | 变化 |
|---|---|---|---|
| avgInput(cache miss) | 2444 | 3561 | +45.7% |
| avgCacheRead | 44380 | 60088 | +35.4% |
| avgOutput | 830 | 1677 | +102% |
| **effCostIdx** | **7712** | **11242** | **+45.8%** |
| $/round(Sonnet 3/15/0.3) | 0.0331 | 0.0539 | **+62.9%** |
| 请求 avgTail | 16427 | 35337 | **×2.15(主因)** |
| 请求 avgBlock | 15649 | 15311 | −2% |
| compaction / 千轮 | 81.4 | 41.5 | **−49%** |
| 压缩自耗 token/轮 | 12 | 25 | +13 |

**结论**:token 消耗确实加剧(每轮 +45.8% / $ +62.9%),主因 3:7 使 tail 变长 ×2.15;
收益是压缩频率减半,但压缩本身极便宜(12→25 tok/轮),省下的抵不上每轮多带的 tail。
output 翻倍(+102%)最大不确定项,可能为任务强度混淆,需另起两次全新会话同任务对比。

**口径提醒**:`inputTokens / 用户轮` 看似减半,但同期 `rounds / 用户轮` 从 75→28,
二者相除才可比,**不可单独采信**。

## 六、延迟链路

- provider 往返:agentLoop 每轮 `roundMs` 打点;`preparedMs` 记录发送前估算耗时。
- 压缩耗时:`.dsb/docs/2026-08-10-压缩耗时实测统计.md`(压缩本身是 LLM 调用,耗时计入 compact phase)。

## 七、优化机会(优先级排序)

| # | 机会 | 影响 | 工作量 | 预期收益 |
|---|---|---|---|---|
| 1 | **减少压缩频率**(提高 triggerRatio / 预算) | 摊薄一次性成本 | S | 每次压缩省 ~22K miss tokens |
| 2 | **官方小时级对账重跑**(08-10/11 后未做) | 验证统计口径 | S | 确认 provider_round 与官方一致 |
| 3 | tail 也进 compacted(全折叠) | 首轮 miss 只剩增量 | M | **不推荐**(牺牲近期细节可读性) |
| 4 | 会话首轮预热(首次压缩时) | 首轮 7.6% 场景 | M | 仅影响会话重建,频次低 |
| 5 | tool_result trim 阈值调优 | 尾部 tokens 减少 | S | 压缩前窗口内 tail 更小 → 压缩更少 |
| **6** | **tail 份额回调(.40/.60)** | 每轮成本 | S | 阶段 C 证明 tail ×2.15 是成本主因;.40/.60 折中(tail 触发点约 28800),以「少压缩」为先则保持 3:7 |
| **7** | **量化 `context_recall` 调用率** | 验证「模型是否真回读」 | S | 用 `statsStore` 的 `context_recall` 事件统计「压缩后 N 轮内回查率」,替代靠感觉判断 |
| **8** | **查 output 翻倍因果** | 若确认非任务混淆 | M | tail 越长是否导致模型输出更长;output 单价最高,优化杠杆最大 |

> 现状:优化 1/2 已部分落地(triggerRatio 默认 0.75、脚本自检 7 场景);3/4/5 为待评估方向,详见 [02-evolution-roadmap.md](02-evolution-roadmap.md) 方向 A。
