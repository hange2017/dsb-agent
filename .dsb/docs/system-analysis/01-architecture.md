# 01 · 整体架构分析

> 状态:📄 骨架(待填充)
> 关联:[project-overview.md](../project-overview.md)(能力清单) — 本文档侧重**结构关系**而非能力罗列。

## 目的

系统性梳理 DSBAgent 整体框架:模块职责、模块间依赖关系、数据流、分层架构,形成一份"系统说明书"。

## 待分析问题(填充时逐项回答)

- [ ] 模块全景图:src/ 下 16 个目录(agent/chat/context/providers/settings/stats/projectContext/session/plugins/mcp/hooks/i18n/notifications/util/…)各自的职责边界
- [ ] 依赖关系:模块间 import 关系图,核心枢纽(agentLoop / chatController / contextManager / extension.ts)的上下游
- [ ] 数据流:一次对话从输入 → 模型调用 → 工具执行 → 上下文管理 → 压缩 → 统计落盘的全链路
- [ ] 分层架构:引擎层(src/agent 等不依赖 vscode)与宿主层(extension.ts / chatViewProvider)的边界与交互方式
- [ ] 关键设计决策与取舍:缓存前缀稳定性、thinking 收敛、写前定型等为什么这么做
- [ ] 系统概念对照:与 [system-concepts.md](../2026-08-16-system-concepts.md) 的概念定义对齐

## 产出形式

模块图 / 依赖图 / 数据流图(可用 ASCII 或 mermaid)+ 文字说明。
