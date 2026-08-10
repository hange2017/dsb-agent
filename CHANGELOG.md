# Changelog

DSBAgent 变更记录。版本遵循 [SemVer](https://semver.org/lang/zh-CN/);实现计划与设计说明见 `.dsb/plans/` 与 `.dsb/specs/`。

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
