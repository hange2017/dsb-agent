
# 开源发布 · 法律严格避让

本仓库以**开源方式**发布，产品名为 **DSBAgent**。任何新增/修改的文档、UI 文案、`package.json`、README、注释，必须遵守：

## 禁止

- 「仿 / 平替 / 复刻 / 1:1 / 官方兼容」+ 第三方产品名
- 「官方插件 / 官方出品 / 官方认证」或暗示与任一模型厂商存在从属关系
- 将第三方商标（含模型厂商名）用作本产品卖点、扩展名或 Marketplace `description`
- 在用户可见文案中用第三方产品名描述「风格/体验对齐」

## 允许（中性）

- 产品名 **DSBAgent**；约定根 `.dsb/`、`DSB.md`
- 「Anthropic Messages **兼容 API**」（协议事实）
- 「非官方独立开源扩展」；默认 `baseUrl` / 上游 **模型 id** 可为技术标识（调用模型不受影响）
- 「常见 Agent 约定 / 活动时间线 / 默认兼容端点」等中性用语
- 路径只读回退：`.cxxxp/`、`.deepseek/`、`.claude/`、`.claude-plugin/`（事实兼容，不写进营销）

## 文档与历史规格

- **全库文档**禁止攀附与厂商品牌卖点；合规说明可在「不推荐」对照中描述禁止项
- 新增用户可见字符串禁止再引入模型厂商品牌名（模型 id / API host 除外）

## 开源物料

- 根目录须有 `LICENSE`；用户可见须有 `README`（非官方声明、隐私/数据流、Bash/插件风险）
- 新增依赖时核对许可证，必要时更新 `THIRD_PARTY_NOTICES`

## 示例

```text
❌ DeepSeek Agent / DeepSeek 官方(内置模板)
✅ DSBAgent / 默认兼容端点(内置模板)

❌ 与 DeepSeek 协作
✅ 开始对话

❌ 仿 Claude Code
✅ 基于 Anthropic Messages 兼容 API 的编码 Agent
```
