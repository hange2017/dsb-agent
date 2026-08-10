# 每日工作总结提醒(2026-08-09)

## 需求

- 记录每天用户在 agent 中**最后一次发送问题**的时间(按项目隔离、跨会话);
- 使用 ≥3 个(过去)工作日后,每天到晚上按「最近多个工作日平均收工时间 **提前 20 分钟**」提醒程序员生成本日工作总结,并按工程和项目进度更新项目整体文档。

## 设计

### 数据记录(`src/stats/activityStats.ts`,纯 TS 无 vscode 依赖)

- `ActivityStatsStore`:单文件 `~/.dsb/stats/<projectKey>/daily.json`,按本地日期覆盖当天最后发送时间,保留最近 90 天;`reminded` 标记当日是否已提醒。
- 记录点:`ChatController.send()` 入口(所有用户消息/slash 命令统一路径);提醒器触发的内部消息 `recordActivity: false` 不计入,避免拉晚平均收工时间。

### 提醒计算(`computeDailyReminder`)

- 取最近 `maxDays`(默认 5)个「有记录且非今天」的天(今天的数据还在变动,不参与);
- 不足 `minDays`(默认 3)天 → 不提醒(数据不足);
- 平均收工分钟 − 20 分钟,clamp 到 `[17:00, 23:59]`(避免白天误提醒)。

### 调度与通知

- `DailySummaryReminder`:60s 周期 tick;到达「提醒时刻起 2 小时窗口」→ 标记当日已提醒 → 回调 `notify`。
- `extension.ts` 装配:通知弹窗「今天到你的平均收工时间({time})了。要生成本日工作总结,并按工程进度更新项目文档吗?」→ 按钮「生成今日总结并更新项目文档」→ `dsbAgent.open` 打开面板 → `ChatController.requestDailySummary()`。
- `requestDailySummary`:以用户消息形式发内部 prompt(回顾今日改动/进度/问题,更新 `.dsb/docs/project-overview.md` 或 `docs/` 架构文档,输出精炼留作明日接续)。

## 关键文件

新增:`src/stats/activityStats.ts`、`tests/activityStats.test.ts`(9 例)
修改:`src/chat/chatController.ts`(deps.activityStats + send 记录 + requestDailySummary)、`src/chat/chatViewProvider.ts`(注入 activityStats)、`src/extension.ts`(stats 装配 + reminder 注册)、`tests/chatController.test.ts`(+2)

## 验收

- 797 tests(90 files)全绿 + tsc + compile;
- 计算用例:平均 20:00 → 提醒 19:40;平均 10:30 → clamp 17:00;今天不计入;当日只提醒一次。

## 边界

- 未注入 activityStats(测试/无项目)时静默跳过;
- 周末有记录也计入(数据驱动,注释说明);
- 提醒时间随使用习惯自适应:用户越晚收工,提醒越晚(仍提前 20 分钟)。
