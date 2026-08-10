# DSBAgent Privacy Notice

> 本说明描述 **DSBAgent**（`dsb-agent`）扩展如何处理数据。  
> **不构成律师法律意见。** 跨境传输与服务商条款以你所选 API / 站点的政策为准。  
> 相关：[README](./README.md)

**结论：** 扩展作者**不**收集遥测、分析或崩溃上报。对话与代码上下文发往**你配置的**模型 `baseUrl`；密钥存于 VS Code SecretStorage；会话与记忆主要在本地。

---

## 1. 我们不收集什么

- 无遥测 / analytics / 崩溃上报到扩展作者或本仓库运营方  
- 无广告标识符、无强制账号体系  
- API Key **不会**写入仓库文件或 `ProviderDef` 配置明文

---

## 2. 发往网络的数据

| 去向 | 内容 | 触发 |
|------|------|------|
| 你配置的 **`baseUrl`**（Anthropic Messages 兼容） | 对话、`system` 提示（可含工作区路径、项目约定、规则、技能摘要、记忆索引）、工具定义与结果、附件（图片 base64 / 文档摘录） | 发消息、压缩摘要、记忆整理、测试连接、回退模型 |
| `{baseUrl}/v1/models`（或兼容路径） | 鉴权头（若已配置 Key） | 刷新模型列表 |
| **WebSearch** | 搜索查询 | Agent 调用 WebSearch（默认 DuckDuckGo HTML，失败可回退其他公开搜索页） |
| **WebFetch** | 对目标 URL 的 HTTP 请求 | Agent 调用 WebFetch |
| 插件市场源 | 拉取 `marketplace.json` / 插件包 | 你主动添加/安装插件（GitHub / URL / npm / 本地等） |
| **MCP**（若启用） | 与 MCP 服务器进程或 HTTP 端点交换工具参数与结果 | 你连接 MCP 或批准相关工具 |

默认未改配置时，`baseUrl` 可能指向公开兼容端点（见设置中的 Base URL）。**改 `baseUrl` 即改变数据接收方。**

---

## 3. 本地存储

| 数据 | 大致位置 |
|------|----------|
| API Key | VS Code **SecretStorage**（按供应商；另有旧版单 Key 回退） |
| 供应商列表（无 Key） | VS Code 用户设置 `dsbAgent.providers` 等 |
| 会话记录 | 扩展 `globalStorage` 下 `sessions/`（事件、api 历史、todos） |
| 跨会话记忆 | 默认 `~/.dsb/memory/`（可用 `dsbAgent.memoryDir` 覆盖） |
| 检查点 | 工作区 `.dsb/checkpoints/<sessionId>/` |
| 项目约定 / 规则 / 技能 | 工作区 `.dsb/`、用户级 `~/.dsb/`（及旧路径只读回退） |
| 插件缓存 | 扩展 `globalStorage` 下 `marketplaces/`、`plugins/` |
| cc-switch 导入 | 仅**本机只读** `~/.cc-switch/cc-switch.db`（复用已保存的 API 配置；不写入、不备份、不上传） |
| UI 状态 | VS Code `globalState`（如最近会话 id） |

卸载扩展**不一定**删除 `~/.dsb/` 或工作区 `.dsb/`；请自行清理敏感本地数据。

---

## 4. 敏感信息与日志

- 源码路径中**未发现**将 API Key 打印到 `console.log`  
- UI 仅暴露是否已配置 Key（布尔），不展示 Key 正文  
- 模型服务返回的错误正文可能被截断后显示在界面；若服务商回显敏感内容，请勿在不可信环境操作  

---

## 5. 你的责任

- 遵守所选模型 API、搜索引擎与抓取目标站点的服务条款与隐私政策  
- 勿将密钥、客户机密或未授权代码库内容发往不可信的 `baseUrl`  
- 在共享机器上注意 SecretStorage / 本地会话与记忆目录的访问控制  
- 权限模式（含 `bypassPermissions`）影响本机 Bash / 写文件 / MCP 行为，见 README「权限与风险」

---

## 6. 变更

隐私相关行为变更时，应更新本文件与 README「隐私与数据」节。  

修订日期：2026-08-04
