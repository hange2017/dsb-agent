# 06 · 性能与成本专题

> 状态:📄 骨架(待填充)

## 目的

系统性梳理性能与成本维度:缓存命中率、压缩成本、token 优化、延迟等,形成可量化的优化基线。

## 待分析问题(填充时逐项回答)

- [ ] 缓存前缀稳定性:当前基线(稳定期命中率 **97.0~97.7%**、压缩后首轮 **49~54%**,2026-08-17 修正口径,见 `2026-08-16-P2落地后缓存命中新基线.md`)、优化手段(P0-P3)、验证脚本(scripts/analyze-cache-prefix.py,含 `--self-test`)
- [ ] 压缩成本:压缩耗时/自耗 token 统计、triggerRatio 阈值、CompactionStats 滑动窗口
- [ ] token 优化:toolUsePolicy 瞬态字段、toolResultPolicy trim、thinking 精简、历史预算默认 150K
- [ ] 延迟链路:provider 往返、preparedMs、QA 抽查成本
- [ ] 优化机会:从 [04-tech-debt.md](04-tech-debt.md) 与数据中发现的性能短板

## 产出形式

基线数据表 + 优化机会清单(含影响面/工作量/预期收益)。
