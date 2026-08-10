# 压缩耗时实测统计(2026-08-10)

> 数据来源:`~/.dsb/stats/3d1dff85bb2f/events-2026-08-10.jsonl`
> 统计口径:2026-08-10 15:58 耗时统计功能(adef265)生效后,`durationMs` 非空的 compaction 事件;同一 `startedAt` 视为同一次压缩流程,取组内最大 `durationMs` 为该次流程总耗时。
> 时间范围:16:21 → 19:42,共 **12 次完整压缩流程**。

## 一、逐次明细

| 开始时间 | 总耗时 | 压缩位置 | before → after(tokens) |
|---------|-------|---------|----------------------|
| 16:21:28 | 13.8s | tail+thinking | 32,418 → 26,083 |
| 16:29:35 | 15.4s | tail+thinking | 38,294 → 31,764 |
| 18:04:02 | 65.3s | tail+thinking | 43,181 → 35,328 |
| 18:16:03 | 19.7s | block+tail+thinking | 47,166 → 39,421 |
| 18:32:54 | 43.5s | block+tail+thinking | 52,079 → 40,547 |
| 18:35:06 | 45.3s | block+tail+thinking+thinking_block | 52,854 → 42,147 |
| 18:38:12 | 59.9s | block+tail+thinking+thinking_block | 53,990 → 42,183 |
| 18:43:06 | 32.9s | block+tail+thinking+thinking_block | 53,752 → 42,235 |
| 18:54:40 | 61.3s | block+tail+thinking+thinking_block | 56,440 → 42,217 |
| 18:57:48 | 35.7s | block+tail+thinking+thinking_block | 53,814 → 42,203 |
| 19:24:19 | 42.7s | block+tail+thinking+thinking_block | 53,463 → 42,226 |
| 19:42:38 | 20.6s | block+tail+thinking+thinking_block | 54,005 → 42,155 |

## 二、汇总

| 指标 | 数值 |
|------|------|
| 压缩流程次数 | 12 次 |
| 平均耗时 | 38.0s |
| 中位数 | 39.2s |
| 最短 / 最长 | 13.8s / 65.3s |
| 分位数 | P10=13.8s · P25=19.7s · P75=45.3s · P90=59.9s |
| 平均缩减量 | ≈53.9K → 42.2K(约 21%) |

## 三、观察与结论

1. **耗时构成**:同一压缩流程内 `durationMs` 累积(block 先完成 → thinking → tail 最后完成),组内最大值即该次流程总耗时。
2. **耗时波动大**(13.8s ~ 65.3s):长耗时集中在 **18:00 后**,此时触发时 before ≈ 53-56K(窗口已接近 150K 预算阈值),压缩动作更重,且含模型重新生成压缩摘要的时间。
3. **体感对应**:38s 平均、65s 最长的压缩窗口,与用户反馈的"卡顿感"一致。
4. **调优建议**:
   - 150K 预算下 tail 触发阈值 ≈ 39.4K,但 before 常达 53K+,触发偏晚/偏频繁;
   - 若想减少卡顿,可把 `triggerPct` 从 0.75 提到 0.85(更早触发,单次更轻);
   - 或按 README 建议将历史信息总预算提到 256K+,降低压缩频率。

## 四、相关代码

- 耗时统计实现:`src/agent/contextManager.ts`(`compactStartedAt` + `emitCompaction` 计算 `durationMs`)
- 事件结构:`src/stats/compactionEvents.ts`(`CompactionRecord` 含 `startedAt` / `durationMs`)
- 统计写入:StatsStore 按天 JSONL,路径 `~/.dsb/stats/<projectKey>/events-YYYY-MM-DD.jsonl`
