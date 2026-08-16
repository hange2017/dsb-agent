# 07 · 统计体系专题

> 状态:📄 骨架(待填充)

## 目的

梳理 DSBAgent 统计体系:事件类型、聚合口径、与官方数据对账方法、统计开关。

## 待分析问题(填充时逐项回答)

- [ ] 事件清单:provider_send / provider_round / compaction / compaction_qa / context_recall / message_sent 等各事件字段与用途
- [ ] 存储与聚合:events-*.jsonl 格式、聚合函数、保留策略(30 天)
- [ ] 口径对账:cacheReadTokens 与官方数据小时级对账方法(见 .dsb/docs/2026-08-10-压缩成本与缓存雪崩分析.md)
- [ ] 开关体系:dsbAgent.stats.enabled / detailLevel / compactionQa
- [ ] 扩展方向:统计扩展 A 清单 8 项的现状与后续

## 产出形式

事件字典 + 聚合流程 + 对账指南。
