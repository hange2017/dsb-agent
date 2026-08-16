# 02 · 演进方向

> 状态:✅ 已完成(2026-08-16,基于 01-architecture 现状分析)
> 前置:已完成 [01-architecture.md](01-architecture.md) 整体分析。

## 一、现状基线(能力成熟度)

| 能力域 | 成熟度 | 说明 |
|--------|:------:|------|
| 核心对话循环(agentLoop) | ★★★★☆ | 稳定,60+ 测试;交互式追加、模式(plan/ask)、并行工具、回滚快照齐全 |
| 上下文压缩(compactor) | ★★★★☆ | 分轨压缩 + P0/P1 已落地;P2(append-only)部分落地,仍是最险区域 |
| 缓存前缀稳定性 | ★★★☆☆ | 规则已固化 + 分析脚本;稳定期命中 68~75%,压缩后首轮 ~10%(基线,待 P2 彻底根治) |
| thinking 收敛 | ★★★★☆ | 全链路总开关 + 强度预设 + 归一化,已完成 |
| 统计体系(stats) | ★★★★☆ | provider_round/compaction/message_sent 打点齐全,只记数字不记内容 |
| 记忆系统(memory) | ★★★☆☆ | memoryStore/memoryManager/dream 有,但 ContextRecall 回查实测 0 次成功(见 ba3ebf3) |
| 测试体系 | ★★★★☆ | 107 文件 / ~1012 项,引擎层全单测;webview/SSE/MCP 覆盖盲区 |
| 打榜评测(benchmark) | ★★☆☆☆ | CLI headless 已有;SWE-bench 路线 T1 完成 / T3 进行中,T2/T4 待办 |
| 插件/技能生态 | ★★★☆☆ | marketplace/pluginTools/skillIndex 有;分发与扫描有待打磨 |
| 多模型支持 | ★★★★☆ | modelCatalog/capabilities/fallbackClient 齐全,可加新模型 |

## 二、演进方向候选(按优先级)

### 方向 A:缓存前缀稳定性 P2 彻底落地(根治压缩雪崩)🔴 最高优先

- **现状**:P0(todo 移出 system)+ P1(tool_result 写前定型)已提交;P2(压缩块 append-only:标题恒输出、只删尾部、re-summarize 只动尾部)已在 contextCompactor 落地,但测试语义尚未完全适配,且 `analyze-cache-prefix.py` 未在 P2 后跑过基线对比。
- **目标**:压缩后首轮命中率从 ~10% 提升到与稳定期同量级(目标 ≥50%);消除"每次压缩都是雪崩"的痛点。
- **影响模块**:`contextCompactor.ts` / `contextManager.ts` / `scripts/analyze-cache-prefix.py`
- **工作量**:M(2-3 天):完成 P2 测试适配 → 跑基线 → 修残余断点 → 对账。
- **验收**:`analyze-cache-prefix.py` 对比改前改后,压缩后首轮命中率不降反升;`compaction_qa` 事件无异常。

### 方向 B:benchmark 打榜收尾(成本效率卖点)

- **现状**:`benchmark/cli.ts` headless 可跑;SWE-bench T1 完成 / T3 自包含 VM worklog 进行中;T2/T4 待办。
- **目标**:跑通完整榜单(如 SWE-bench verified 子集),产出可复现的"成本效率"数据(成本/题 + 通过率),支撑"基于 Anthropic Messages 兼容 API + 高缓存命中率"的差异化卖点。
- **影响模块**:`benchmark/`(swebench.ts / stats.ts / scripts)
- **工作量**:L(1-2 周):T3 VM 环境稳定 → T2 完整跑分 → T4 归档/复现保障。
- **验收**:一份可复现的榜单结果(含成本、命中率、通过率),README 有对照表。

### 方向 C:记忆系统回查修复(ContextRecall 0 命中问题)

- **现状**:写入侧正常(压缩块里有 `[r{n}]` 摘要行),但实测回查 0 次成功——说明**回查入口/检索逻辑**有断点(见 `2026-08-16-context-recall-usage-analysis.md`)。
- **目标**:ContextRecall 能按 seq / 关键词从压缩前原文找回细节;跨会话检索可用。
- **影响模块**:`contextRecall` / 压缩块格式 / contextStore 冷存储回捞。
- **工作量**:M(2-3 天)。
- **验收**:写一条长消息 → 压缩 → 回查,能取回原文;单元测试覆盖回查路径。

### 方向 D:测试体系补盲区(webview / SSE / MCP)

- **现状**:引擎层单测 1000+;但 webview 前端、SSE 流式解析、MCP 交互基本靠手动。
- **目标**:webview 逻辑(消息渲染/按钮状态)抽纯函数单测;SSE 解析用 fake stream 测;MCP 客户端用 fake 服务器测。
- **影响模块**:`webview/`、`anthropicMessagesClient.ts`、`mcp/`
- **工作量**:M(3-5 天,分三小块)。
- **验收**:新增 ≥30 测试;核心流式解析分支覆盖 ≥80%。

### 方向 E:插件/技能生态打磨

- **现状**:marketplace 有安装/管理;skillIndex 有扫描;但"技能发现 → 一键启用 → 使用统计"链路未闭环。
- **目标**:技能市场页(浏览/安装/卸载/评分)、技能使用频率统计、`/skill` 命令补全。
- **影响模块**:`plugins/`、`settings/`、webview
- **工作量**:L(1 周)。
- **验收**:能在一个面板完成技能浏览/安装/启用;统计能看到哪些技能被高频使用。

### 方向 F:多模型支持深化(按需)

- **现状**:modelCatalog 已支持自定义 baseUrl + 模型 id + capabilities;fallbackClient 有降级。
- **目标**:模型切换面板支持"能力画像"(vision/thinking/上下文窗口)可视化;出错时自动降级提示。
- **影响模块**:`providers/`、`settings/`
- **工作量**:S-M(2-3 天)。
- **验收**:切换模型时能力不匹配(如无 vision 但拖图)有明确提示而非静默失败。

## 三、优先级排序总表

| 优先级 | 方向 | 理由 | 工作量 | 依赖 |
|:------:|------|------|:------:|------|
| P0 | A 缓存前缀 P2 | 雪崩是成本痛点,规则已固化,只差收尾 | M | 无 |
| P1 | B benchmark 收尾 | 卖点需真实数据,T3 已在推进 | L | 无 |
| P1 | C 记忆回查修复 | 功能"写了但用不上",价值流失 | M | 无 |
| P2 | D 测试补盲区 | 提升长期可维护性 | M | 无 |
| P2 | E 插件生态 | 增长型,非必需 | L | 无 |
| P3 | F 多模型深化 | 已有基础,锦上添花 | S-M | 无 |

## 四、约束边界(明确**不做**的事)

- **不做沙箱/容器隔离**:工具执行信任用户本机环境(Bash 风险已在 README 声明),不引入 docker/sandbox——除非未来做 benchmark 复现需要。
- **法律严格避让**:永不攀附第三方产品名/官方关系(见 `.dsb/rules/legal-strict-avoidance.md`),营销文案只讲"Anthropic Messages 兼容 API + 非官方独立开源扩展"。
- **缓存前缀稳定性是硬约束**:任何改动 system/压缩块/messages 构造的 PR,必须跑 `analyze-cache-prefix.py` 对比,不降命中率是验收门槛。
- **引擎层不依赖 vscode 是红线**:新增引擎功能不得 import vscode;宿主接线在 extension/chatViewProvider。
- **统计只记数字**:不引入消息内容落盘,保持隐私友好。

## 五、里程碑建议(每方向验收)

| 里程碑 | 内容 | 验收标准 |
|--------|------|----------|
| A1 | P2 测试适配 + 基线对比 | 压缩后首轮命中率 ≥50% 或相对基线显著提升 |
| B1 | T3 VM 稳定 + T2 完整跑分 | 产出可复现榜单(成本/通过率/命中率) |
| B2 | T4 归档 + README 对照 | 榜单结果可一键复现 |
| C1 | 回查单测 + 手工验证 | 压缩后能按 seq/关键词取回原文 |
| D1 | webview 纯函数抽测 | 新增 ≥30 测试,流式解析分支覆盖 ≥80% |
| E1 | 技能市场面板 | 浏览/安装/启用/统计闭环 |
| F1 | 能力画像可视化 | 切换模型能力不匹配有明确提示 |
