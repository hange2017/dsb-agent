# 08 · 测试体系专题

> 状态:✅ 已完成(2026-08-17)
> 当前规模:107 测试文件 / **1012 项测试**(2026-08-17);P1 写前定型 +1、t1-t5 收敛 +14。

## 一、规模与增长

- 2026-08-10:780 tests → 08-11:998 → 08-15:998(P2 改 3 个语义断言)→ 08-17:**1012**。
- 增长来源:缓存前缀稳定性(P0-P3)、thinking 设置收敛(t1-t5)、分轨压缩(T1-T9)、统计扩展(A 清单 8 项)。

## 二、分层策略

| 层 | 测试方式 | 代表文件 |
|---|---|---|
| 引擎层(不依赖 vscode) | 纯单测,直接 import src/ | agentLoop / contextManager / contextCompactor / toolUsePolicy / stats 全部 |
| 宿主层 | vscode mock(`vscode` 模块 mock) | extension.test.ts / chatController.test.ts / agentSettingsPanel.test.ts |
| 集成冒烟 | ScriptedProvider 全链路 | smokeContextCompaction / benchmark/smoke.test.ts |
| Webview | 逻辑抽离后单测(i18n/格式化) | i18n.test.ts / format.test.ts;DOM 层薄弱 |

## 三、工具链与模式

- **Vitest 3.2.7**:`include: ["tests/**/*.test.ts", "benchmark/**/*.test.ts"]`。
- **fakeProvider / ScriptedProvider**:脚本化 provider,按轮次返回预设 blocks/toolUses → 可精确驱动 agentLoop 多轮分支。
- **配置样例驱动**:configuration.test.ts 覆盖全部设置项默认值与收敛规则。
- **语义断言优先**:contextCompactor.test.ts / contextManager.test.ts 断言压缩块的字节形态(标题恒输出、只删尾部、re-summarize 只动新增行)——这是缓存前缀稳定的回归护栏。

## 四、关键行为测试(改前必跑)

| 行为 | 测试文件 | 断言要点 |
|---|---|---|
| 缓存前缀稳定 | contextCompactor / contextManager | 空轨标题恒输出、删尾部保留旧稳定行、re-summarize 调用次数 |
| 写前定型 | agentLoop.test.ts(P1) | trim 类 tool_result 入历史前已定型;prefix 稳定 |
| thinking 收敛 | contextManager / modelCatalog | thinking 关闭时 split 归一化两段;能力字段默认值 |
| 统计口径 | aggregate.test.ts / providerSendStats | 雪崩分析恢复轮数、成本汇总、估算 vs 真实 |
| 工具策略 | toolUsePolicy / toolResultPolicy | 瞬态字段省略阈值、trim 升级摘要 |

## 五、覆盖盲区

| 盲区 | 风险 | 现状 |
|---|---|---|
| webview DOM 层 | 前端回归无护栏 | 仅逻辑抽离单测;建议补 jsdom 冒烟(M 级,见 04) |
| SSE 流解析 | 流式增量正确性 | anthropicMessagesClient 有测;极端分片场景缺 |
| MCP 插件生命周期 | 动态工具注册 | 会话内视为只读;缺少注册/失效集成测试 |
| 三平台差异 | Windows 路径/换行 | CI 三平台全绿(08-16 修复路径分隔符归一化) |
| 缓存对账 | 统计口径与官方一致性 | 只有脚本,无自动化断言(建议 S1 补) |

## 六、CI

`.github/workflows/ci.yml`:三平台(typecheck → vitest → vsce package);发布 job 独立。
每次改动验收:`npx tsc --noEmit` + `npx vitest run` 全绿。
