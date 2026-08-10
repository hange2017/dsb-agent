# 设计:消息正文内联路径/URL 双击跳转

> 日期:2026-08-10 · 状态:已实现 · 关联提交:待填

## 背景

对话消息正文(用户输入、助手 text 步骤)中常出现文件路径(`src/agent/agentLoop.ts`)、`path:line`(如 `src/chat/chatController.ts:383`)和 http(s) 链接。当前仅代码块与 Grep 表可双击跳转,正文内联文本中的路径/链接不可交互。

## 目标

- 消息正文文本中的 `path` / `path:line` 双击 → 打开文件并定位行
- 消息正文中的 http(s) URL 双击 → 系统浏览器打开
- 不破坏现有 markdown 渲染(markdown 子集:代码块 / 行内代码 / 加粗 / 表格 / 转义)
- 不误标:代码 span 内、标签内、普通英文单词、不带路径特征的文本

## 方案

### 渲染层(webview/format.ts)

`renderMarkdown` 输出经转义后的 HTML(标签+文本+实体混合)。新增 `linkifyJumpables(html)`:

1. 用 `HTML_TOKEN_RE = /<\/?[a-z][^>]*>|&(?:amp|lt|gt|quot|#\d+);/g` 切分标签/实体与纯文本
2. 纯文本段用 `INLINE_JUMP_RE` 匹配:
   - `(?<url>https?://[^\s<>"'`]+)` — URL(剥尾部标点)
   - `(?<path>...)` — 路径形态:以 `./`、`../`、盘符、`/` 或 `段/` 开头,含 `/` 或 `\` 分段
   - 可选 `:(?<line>\d+)` 行号
   - 负向断言避免匹配单词内部
3. 命中处包成 `<span class="jumpable jump-path" data-jump-path data-jump-line>` 或 `<span class="jumpable jump-url" data-jump-url>`

匹配跳过标签与实体,天然不会改坏 `<a>`、`<code>`、表格结构。行内代码内的路径**不**跳转(避免与 `markJumpableInText` 的代码块语义冲突,且代码常含非路径内容)。

### 交互层(webview/main.ts)

dblclick 事件委托扩展:`.jumpable` 上优先读 `data-jump-url` → `post({type:"open_url", url})`;否则走原 `data-jump-path` 逻辑。

### 宿主层(src/chat/)

- `protocol.ts`:`WebviewToHostMessage` 增加 `{ type: "open_url"; url: string }`
- `chatController.ts`:`openUrl` 校验协议(仅 http/https)后动态 `import("vscode")` 调 `env.openExternal`,失败 toast
- `i18n/strings.ts`:新增「无法打开链接:{url}」

### 样式(webview/styles.css)

行内 `.jumpable` 继承现有悬停虚线轮廓,URL 与 path:line 用 `text-decoration: underline dotted` 区分可交互性。

## 测试

- `tests/format.test.ts`:路径、path:line、URL 标点剥离、误标排除、表格内路径
- `tests/chatControllerOpenUrl.test.ts`:mock vscode,验证 openExternal 调用与无效 URL 拦截

## 边界

- 仅 http/https,`javascript:` 等协议拒绝
- 相对路径在宿主按工作区根解析(沿用 openFile 逻辑)
- 行号越界:openFile 已 clamp 到文档行数
