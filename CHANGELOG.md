# Changelog

DSBAgent 变更记录。版本遵循 [SemVer](https://semver.org/lang/zh-CN/);实现计划与设计说明见 `.dsb/plans/` 与 `.dsb/specs/`。

## [0.2.0] — 2026-08-12

### 新增

- **Thinking 全链路总开关**(默认开,可整体关闭)与处理侧开关:关闭时 thinking 剥离不进历史/压缩/脉络。
- **思考强度预设** `thinkingLevel`(`low`/`medium`/`high`)派生预算;全局思考强度兜底注入与供应商默认能力(`supportsThinking` + `thinkingLevel`,缺省 `medium`)。
- **Agent 设置面板「思考模式」卡片**:开关 + 强度下拉,配置读写并同步全局尾底强度。
- **Thinking 关闭时预算归一化**:split 配置层归一化为两段(`compacted`+`tail`)并写入 agent 参数。
- **缓存前缀稳定性 P0~P3**(详见 `.dsb/rules/cache-prefix-stability.md`):
  - P0:todo 清单移出 system,改由 `TodoWrite` tool_result 尾部传播(前缀稳定段不再被清单状态打断)。
  - P1:trim 类 tool_result 写入 messages 前定型(push 前定最终字节形态,消除"先原始后精简"两形态)。
  - P2:压缩块只追加/只删尾部 + 标题恒输出,稳定段前缀字节恒定(re-summarize 只动尾部新增)。
  - P3:trim 类 tool_use / 超阈值 thinking 写前定型 + `planThinkingTrim` 幂等保护。
- **统计扩展**:`provider_send` 内容 hash 指纹与会话标识(方案 B,缓存前缀命中分析);压缩自身成本(`llmCalls`/`llmMs`/`selfTokens`)与 `provider_round` phase/roundMs;压缩质量抽查 `compactionQa` 开关;压缩雪崩量化脚本(`scripts/`)。

### 修复

- `capabilityGate` 修复孤儿/缺 id tool_use 配对,禁止 todo 并入 tool_result。
- 压缩耗时实测统计存档与成本/雪崩综合分析落地(官方单价口径,`未命中×1.0 + 命中×0.02 + 输出×2.0` 元/M)。
- 统计文档中文化并新增数据校验强制流程(官方对账前置)。

### 内部

- 固化缓存前缀稳定性规则(字节稳定三原则 + 缓存杀手清单 + 验证要求),并标记 P0~P3 实施状态。
- 统计口径规则(全项目合并)、README 补充快速开始/安装置顶与绿色设置建议(超级权限 + 历史预算 256K)。

## [0.1.0] — 2026-08-10(首发布)

### 新增

- 上下文分轨压缩(需求/结论/解释/台账) + 冷存储(`ContextStore`),跨会话 `ContextRecall` 回查。
- 老会话完整历史归档(`archivePolicy`):切走/删除会话时把完整历史写入冷存储。
- Thinking 独立压缩:配对上下文一次 LLM 调用压缩为独立 `[thinking]` 块(正确/错误/中性分组);独立预算(≤3500 tokens)、滚动收缩、开关 `dsbAgent.compaction.thinking`。
- 记忆卫生三件套:访问加权排序 + `pinned` 常驻、`MemoryWrite` 相似候选提示、`/memory dream` 双闸门。
- 压缩成本监控:`CompactionStats` 滑动窗口 + agentUI header 徽章 + 迷你趋势柱状图(`windowSeries`)。
- 压缩事件落盘:`~/.dsb/stats/<projectKey>/events-*.jsonl`(`compaction` / `provider_send` breakdown)。
- 每日工作总结提醒、统计大模块、时段图标、动态表情动画、历史懒加载、代码块双击跳转、设置右侧抽屉。

### 修复

- 冷存储偏移索引 + 增量合并 `assertNoSeqOverlap` 前置断言(fail-open)。
- 历史轮次中间时间线折叠、对话身份标签、提交时折叠上一轮等 UI 细节。

### 内部

- 引擎层(`src/` 非 webview 部分)不依赖 `vscode` 模块,便于单测。
- 打包排除 `.deepseek/**`、`.dsb/**`、`.cursor/**`、`.map` 等敏感/冗余文件。

### 发布准备(2026-08-10)

- 新增原创图标 `resources/icon.png`(与任何厂商商标无关)。
- 补全 `categories`(`Chat / Other / AI / Programming Languages`)与 `keywords`。
- 建立根级 `CHANGELOG.md`;README 扩充安装步骤、平台支持矩阵与已知限制。
- 新增 GitHub Actions CI:compile + typecheck + vitest 全量 + `vsce package` 验包。
- 注册 Marketplace Publisher(`zhaoNingHan`);配置 `repository` 与 `publisher`;`vsce package` 本地验包通过(103 文件 / ~5.5MB,无警告)。
- 待办(上架前):配置 Marketplace PAT;Windows/macOS 真机冒烟。

## [0.0.x] — 2026-08-04 之前

早期开发版本(未发布),细目见 `.dsb/docs/` 与 `.dsb/plans/` 验收记录。
