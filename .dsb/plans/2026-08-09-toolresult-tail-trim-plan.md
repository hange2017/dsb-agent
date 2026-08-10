# tail 内 toolResult 精简实现计划

日期:2026-08-09
依据:.dsb/specs/2026-08-09-toolresult-tail-trim-design.md

## T1: 新建 toolResultPolicy.ts(纯函数)

- `ToolResultClass = "keep" | "trim" | "summarize"`
- `classifyToolResult(toolName)`:按工具名分类(Read/Write/StrReplace/Delete/LS/Glob/Todo/Memory 系 → keep;Bash/Grep/WebFetch/WebSearch/Workflow/Agent → trim;mcp__*/插件 → keep)
- `trimToolResult(toolName, content, ok?)`:各工具规则(成功/失败分支),复用/对齐现有 extractKeyLines 风格
- 阈值常量导出:`TRIM_MIN_TOKENS=800`、`TRIM_MIN_LINES=20`、`SUMMARIZE_AFTER_TRIM_TOKENS=3000`、`MAX_LINE=160`、Bash 5/30、Grep 10/200、WebFetch 20/20
- 标记常量:`TRIMMED_MARKER="[tool-result-trimmed]"`、`SUMMARIZED_MARKER="[tool-result-summarized]"`

## T2: 已消费判定 + agentLoop 接线

- 新增纯函数或方法:扫描 messages,对每条 tool_result 消息判定「其后是否存在 assistant 消息」→ 返回需精简的 index 列表
- agentLoop 每轮发送前(prepareRound 之前、onProviderSend 打点之前)调用:
  - 对需精简的 toolResult 消息调用 trimToolResult(分类 trim/summarize)
  - trim 后仍超 summarize 阈值 → await summarizeMessages(仅 trim 类)
  - 替换 msg.content(幂等)
- 打点在精简之后 → messageBreakdown 反映真实发送

## T3: 测试

- tests/toolResultPolicy.test.ts:
  - 分类三分正确
  - Bash 成功超长 → 头5尾30+折叠;Bash 失败 → stderr 全文保留
  - Grep → 分组限量、去重、path:line 保留
  - WebFetch → 首尾
  - 小输出原样、空输出原样、超长升级 summarize 判定
- tests/agentLoop.test.ts:
  - 已消费 toolResult 被替换为精简版(带标记)
  - 最新未消费 toolResult 保留原文
  - 打点 messageBreakdown 的 tool_result tokens 变小

## T4: 全量验证 + 提交

- `npx tsc --noEmit`、`npm test` 全绿、`npm run compile`
- git commit

## 风险点

- summarize 是异步 LLM 调用:只对超阈值低密度输出触发,频率低
- 替换 content 影响持久化:恢复会话时历史 toolResult 为精简版(符合目标)
- 未知工具(mcp__*/插件)保守 keep,仅超阈值 summarize
