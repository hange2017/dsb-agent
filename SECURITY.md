# DSBAgent Security Notice

> 本说明覆盖 **本地代码执行面**（Bash / 插件 Shell / MCP / 写文件）的风险与门禁。  
> **不构成律师或渗透测试意见。**  
> 相关：[PRIVACY.md](./PRIVACY.md) · [README](./README.md) · [待优化](docs/architecture/待优化.md)

---

## 1. 能力面（无完整沙箱）

| 能力 | 行为 |
|------|------|
| **Bash** | 在工作区 cwd 执行 shell（Linux/macOS `bash -lc`；Windows `cmd /c`）；**无**网络/文件系统沙箱 |
| **Write / StrReplace / Delete** | 修改工作区内文件（路径逃逸校验存在，但非完整沙箱） |
| **WebSearch / WebFetch** | 向公网发请求；抓取内容可进入后续模型上下文 |
| **插件 `tools[]` / Hooks** | 可执行本地命令；只安装信任来源 |
| **MCP** | 可启动本地 stdio 进程或连接远程 HTTP；工具结果可回传模型 |

---

## 2. 当前门禁（用户知情 + 运行时）

| 门禁 | 行为 |
|------|------|
| 权限模式 `default` | 未命中项目规则时 **一律询问**（含编辑类工具） |
| `acceptEdits` | 仅自动放行 Write/StrReplace/Delete；其余仍询问 |
| `bypassPermissions` / UI「超级权限」 | **跳过多数确认**——仅在自担风险时开启 |
| 权限询问 detail | 含工具名与关键参数摘要 |
| MCP `enabled` | `.mcp.json` 中 `enabled: false` 的服务器不会连接/调用 |
| MCP `trusted` | 默认未信任；须 `trusted: true` **或** 运行 **DSBAgent: Connect MCP Servers**（显式 opt-in 后本会话信任并连接） |
| 面板打开 | **不会**自动 spawn MCP 进程 |

---

## 3. 已知限制（诚实披露）

- **无** OS 级容器 / seccomp / 网络隔离  
- Hooks 失败默认 fail-open（不阻断主路径）  
- 项目规则 / 插件可放宽工具行为；勿在不可信仓库开启 bypass  
- 更多体验项见 [待优化.md](docs/architecture/待优化.md)

---

## 4. 建议用法

1. 保持默认询问权限；共享机器勿开超级权限  
2. MCP：先审 `.mcp.json`，再用 Connect MCP 命令显式连接  
3. 插件只装可信市场/来源  
4. WebFetch 仅用于开发辅助；遵守目标站点 ToS  

修订日期：2026-08-04
