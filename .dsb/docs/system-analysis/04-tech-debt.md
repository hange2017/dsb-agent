# 04 · 健康度 / 技术债清单

> 状态:✅ 已完成(2026-08-17,首版)
> 评估时间点:2026-08-17(src 115 个 .ts、tests 107 文件 / 1012 项)
> 说明:评分为 1-5(5 最优);测试覆盖以 tests/ 对应文件数为据,webview 前端按人工审查。

## 一、逐模块健康度评分

| 模块 | 职责清晰 | 耦合度 | 测试覆盖 | 技术债 | 综合 | 备注 |
|---|---|---|---|---|---|---|
| extension.ts(宿主组装) | 4 | 4 | 3 | 2 | ★★★★ | DI 清晰;宿主层部分逻辑难单测 |
| agentLoop.ts(核心循环) | 4 | 3 | 5 | 2 | ★★★★ | 复杂但模块化;60+ 测试 |
| contextCompactor / contextManager | 4 | 3 | 5 | **3** | ★★★★ | **字节稳定性高风险区**;测试覆盖高 |
| toolUsePolicy / toolResultPolicy | 5 | 4 | 5 | 1 | ★★★★★ | 职责单一,策略与执行分离 |
| providers(modelCatalog/configuration) | 4 | 3 | 4 | 2 | ★★★★ | 能力字段收敛后更清晰 |
| stats(6 文件) | 4 | 4 | 4 | 1 | ★★★★ | 口径已固化,脚本自检 |
| memory(记忆系统) | 4 | 3 | 4 | 2 | ★★★★ | hygiene 三支柱;注入遵循前缀规则 |
| context(冷存储) | 4 | 3 | 4 | 2 | ★★★★ | NDJSON+索引;惰性迁移旧格式 |
| webview(15 文件前端) | 3 | 3 | 2 | 2 | ★★★ | i18n 已全面;前端测试薄弱 |
| benchmark | 3 | 3 | 2 | **3** | ★★★ | SWE-bench T2/T4 待办 |

## 二、高风险区(改动最危险)

1. **contextCompactor / contextManager 的字节稳定性** 🔴
   - 风险:任何「旧行重写 / 中间插入 / 标题不恒输出」都会导致缓存前缀断裂 → 压缩雪崩。
   - 已固化规则:`.dsb/rules/cache-prefix-stability.md`(只追加、只删尾、写前定型、标题恒输出)。
   - 改动要求:影响 system/压缩块/tail/messages 的改动必须跑 `analyze-cache-prefix.py` 对比改前改后。
2. **agentLoop.ts 的消息构造**
   - 风险:历史消息只追加不重写;tool_result 写前定型;中部块不得删除。
   - 已有 P1(写前定型)+ P2(压缩块 append-only)护栏与对应测试。
3. **webview 与引擎的消息协议**
   - 风险:onEvent 事件类型变更需引擎/前端同步;新增事件无类型护栏(字符串字面量)。

## 三、已知问题清单(按优先级)

| # | 问题 | 影响 | 修复方向 | 工作量 |
|---|---|---|---|---|
| 1 | 官方小时级对账未重跑(08-10/11 之后) | 统计口径可信度 | 采集 24h 数据后跑对账脚本 | S |
| 2 | 压缩后首轮 tail 全 miss(结构性) | 每次压缩 ~22K miss tokens | 方向 A:调 triggerRatio/预算摊薄 | S |
| 3 | 会话首轮(重建/首次压缩)命中 7.6% | 低频高成本 | 预热/预压缩,频次低 | M |
| 4 | webview 前端测试薄弱 | 回归风险 | 补 vitest + jsdom 冒烟 | M |
| 5 | benchmark SWE-bench T2/T4 待办 | 打榜能力缺口 | 按 roadmap 推进 | M/L |
| 6 | 工具执行无沙箱(Bash 信任本机) | 安全风险 | 已声明,不引入 docker;未来仅 benchmark 复现考虑 | — |

## 四、清理建议

- **S1(S 级,建议尽快)**:对账脚本 + triggerRatio 调优实验,量化后更新 06/07 基线。
- **M2**:webview 冒烟测试(事件协议回归),优先于功能新增。
- **M3**:contextStore 旧 `.context.json` 惰性迁移验证(8MB/80 chunks 淘汰路径单测)。
- **L4**:benchmark T2/T4(依赖 roadmap 方向 D)。

> 无遗留 TODO/FIXME 注释(全库 0 处,排除 todo 工具定义);「瞬时参数已省略」占位是 toolUsePolicy 的有意设计,非技术债。
