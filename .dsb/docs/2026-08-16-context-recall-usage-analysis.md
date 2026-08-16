# ContextRecall 回查与冷存储使用情况分析

> 生成时间:2026-08-16
> 数据来源:本地会话存储、冷存储、统计事件文件(2026-08-09 ~ 2026-08-16)
> 结论:**冷存储写入侧工作正常;ContextRecall 回查侧 0 次成功**(可观测窗口内 0 次调用)。

---

## 一、结论摘要

| 侧 | 状态 | 证据 |
|---|---|---|
| 冷存储**写入** | ✅ 正常 | 4 个会话持续归档;当前会话 NDJSON 格式 8 秒写入 80 chunks |
| ContextRecall **回查** | ❌ 0 次成功 | 统计事件 0 条;全部会话仅 1 次工具调用且返回「不可用」 |
| 模型面对回查机会 | 约 194 处 `[r{n}]` 摘要标记 | 4 个会话 jsonl 中 `[r{n}]` 标记行合计 ~194 |
| P0 统计埋点 | 已上线(8-16 00:35) | 上线后 context_recall 事件仍为 0 → 埋点窗口内从未被调用 |

---

## 二、数据来源与方法

- 会话:`` ~/.config/Code/User/globalStorage/zhaoninghan.dsb-agent/sessions/*/*.jsonl ``(4 个会话)
- 冷存储:`` ~/.config/Code/User/globalStorage/zhaoninghan.dsb-agent/context/*/*.{ndjson,json} ``(4 个会话 5 个文件)
- 统计:`` ~/.dsb/stats/<projectKey>/events-*.jsonl ``(15 个文件,2026-08-09 ~ 08-16)
- 方法:统计事件全量扫描 `context_recall` 字段;会话 jsonl 按 `kind=tool & name=ContextRecall` 精确匹配工具调用;冷存储文件统计 chunk 数/格式。

---

## 三、冷存储写入侧(✅ 正常)

### 3.1 归档规模(4 个会话)

| 会话 | 工作区 | compacted 累计 | pruned 累计 | 当前 chunk | 格式 |
|---|---|---|---|---|---|
| s_mso6ljzd_ifk9 | 3d1dff85bb2f | 300 | 11218 | 80 | **NDJSON**(新) |
| s_msmv18yl_40t8 | 3d1dff85bb2f | 70 | 4169 | — | JSON(旧) |
| s_mso06ren_cqkd | 3f5ca606a8c1 | 223 | 9870 | — | JSON(旧) |
| s_mstq77fa_eg3j | mnt-share-dsbagent | 24 | 417 | — | JSON(旧) |

- 合计:617 次压缩归档、25,674 条被裁剪内容入冷存储。
- 当前会话(s_mso6ljzd_ifk9)自 2026-08-16 16:37:09 ~ 16:37:17 的 8 秒内写入 80 chunks(seq 2980 起)——**Snapshot Store NDJSON 改造(6c98e81)与注入链修复已生效**,压缩/裁剪原文持续落盘。

### 3.2 注入链现状

- `chatViewProvider` → `agentLoop`(构造参数)→ `executor`(`private readonly contextStore?`, executor.ts:334)链路已通。
- `agentLoop.ts:888` 冷存储异步队列回合结束冲刷;`agentLoop.ts:416` 裁剪切点原文写入冷存储并追加 `[r{seq}]`。
- 结论:写入侧不再存在「注入链断裂」问题(该问题修复于 6c98e81,2026-08-15 21:58)。

---

## 四、ContextRecall 回查侧(❌ 0 次成功)

### 4.1 统计事件:0

- 全部 15 个 `events-*.jsonl` 中 **0 条** `context_recall` 事件(含 unavailable 模式)。
- 埋点代码已确认在线:`executor.ts:632`(`mode:"unavailable"`)与 `executor.ts:637`(成功回查)均调用 `statsStore.record("context_recall", ...)`。
- P0 埋点上线时间:ba7a85e(2026-08-16 00:35)。**上线后至今 0 事件 = 埋点窗口内从未被调用**。

### 4.2 实际工具调用:仅 1 次,且失败

- 全量扫描 4 个会话 jsonl,`kind=tool & name=ContextRecall` 仅 **1 条**(s_mso6ljzd_ifk9.jsonl:1528):
  - 模型场景:压缩块截断了原始需求文本,模型主动说「让我通过 ContextRecall 检索原始需求文本」。
  - 结果:`detail = "ContextRecall 不可用:本会话未启用冷存储。"`(fail-open 返回)。
  - 时点:2026-08-15(注入链修复 **6c98e81 之前**),因此无统计记录且失败合理。
- 注入链修复后(8-15 21:58 起)、P0 埋点上线后(8-16 00:35 起),**模型再未调用过 ContextRecall**。

### 4.3 回查机会与模型行为

- 4 个会话中 `[r{n}]` 压缩摘要标记出现 ~194 行(当前会话 110 行)。
- 模型面对摘要的典型行为(依据会话文本):**靠摘要信息 + 现有上下文推断**,而非调用 ContextRecall 取回原文。
- 唯一一次主动回查尝试发生在工具不可用时期,此后虽工具可用,模型未再尝试。

---

## 五、根因与时间线

| 时间 | 事件 | 对回查的影响 |
|---|---|---|
| 8-14 及之前 | 注入链断裂(executor 拿不到 contextStore) | 回查必失败(fail-open「不可用」) |
| 8-15 21:58 | 6c98e81:Snapshot Store NDJSON + 注入链修复 | 回查技术前提具备;冷存储开始 NDJSON 持续写入 |
| 8-15(修复前) | 模型唯一一次主动回查 →「不可用」 | 模型侧可能因此形成「回查不可用」印象 |
| 8-16 00:35 | ba7a85e:P0 统计埋点 + 工具描述强化 | 埋点窗口开启,至今 0 调用 |
| 8-16 全天 | 50 次 compaction、25 次 compaction_qa、339 轮 provider_round | 模型多次面对 `[r{n}]` 摘要,未调用 ContextRecall |

**结论**:回查为 0 不是技术不可用(写入侧已正常),而是**模型行为层面未触发**——需要引导/信号增强。

---

## 六、建议(后续动作)

1. **验证 P0 埋点可捕获**:在受控会话中手动触发一次 ContextRecall 成功调用,确认 `events-*.jsonl` 出现 `context_recall` 事件(当前 0 可能是「从未调用」而非「埋点失效」,需区分)。
2. **P1 引导效果评估**:记忆表明 P1(提示行/技能引导)已实施,但 8-16 当天仍 0 调用——建议检查引导提示在压缩块上下文中的实际可见性,或增强「摘要信息不足时主动回查」的信号(如在压缩块头部固定提示 `[r{n}] 可回查原文`)。
3. **监控阈值**:若连续 N 天(如 7 天)context_recall 仍为 0,应考虑:
   - 摘要质量是否已足够(模型无需回查,此时回查为 0 是「良性」);
   - 或工具描述/引导是否无效(需 A/B 对比)。
4. **跨会话检索**:ContextRecall 支持跨会话检索(索引合并视图),当前 0 次使用意味着该能力完全闲置——可考虑在启动时或 `memory` 场景提示用户该能力。
