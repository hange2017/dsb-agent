# 修复记录：API 400 `messages.N: all messages must have non-empty content`

> 日期：2026-08-15  
> 范围：`dsb-agent` 源码 + 本地会话落盘修复（会话文件不进仓库）

## 现象

运行扩展连接大模型时报：

```text
DSBAgent: API error (400): {"error":{"message":"messages.15: all messages must have non-empty content",...}}
```

表象上易误判为「工作区根目录 `.dsb`（`/mnt/share/DSBAgent/.dsb`）导致、而 `dsb-agent/.dsb` 正常」。二者需区分：

| 路径 | 角色 |
|------|------|
| `/mnt/share/DSBAgent/.dsb` | 父工作区约定目录（skills/checkpoints 等） |
| `/mnt/share/DSBAgent/dsb-agent/.dsb` | 本仓库权威文档与约定 |

**真正原因不是约定目录内容注入空消息**，而是父工作区对应的持久化 API 历史损坏。

## 根因

1. 父工作区 projectKey `mnt-share-dsbagent` 的会话  
   `…/globalStorage/zhaoninghan.dsb-agent/sessions/mnt-share-dsbagent/s_mstq77fa_eg3j.api.json`  
   中 `messages[15]` 为 `{"role":"assistant","content":[]}`。
2. 空 `assistant` 的写入路径：处理侧关闭 thinking（`thinkingProcessEnabled === false`）时，若模型本轮只返回 thinking，过滤后 `persistBlocks` 为空，仍被 `push` 进历史并落盘。
3. 次要路径：`stripThinkingBlocks` / `stripImageBlocks` 在剥光后曾用空 text / `content:""` 占位，同样会触发网关校验。

打开父目录会加载上述损坏会话；打开 `dsb-agent/` 子目录则是另一 projectKey / 干净会话，故表现为「跟根目录 `.dsb` 有关」。

## 修复

### 代码（仓库内）

| 文件 | 改动 |
|------|------|
| `src/agent/capabilityGate.ts` | 新增 `messageHasNonEmptyContent` / `dropEmptyContentMessages`；thinking/image 剥光后**丢弃**消息；`sanitizeOutbound` 发送前统一剔除空 content |
| `src/agent/agentLoop.ts` | `persistBlocks.length === 0` 时不再 push，直接 `done` |
| `tests/capabilityGate.test.ts` | 覆盖「空 content → 发送前丢弃」 |

### 本地会话（不进 git）

已从 `s_mstq77fa_eg3j.api.json` 删除空 `assistant`（16 → 15 条）。若仍异常，新建会话或重载扩展。

## 验证

```bash
npx vitest run tests/capabilityGate.test.ts tests/agentLoopCapabilities.test.ts
```

## 运维提示

若再现同类 400，检查对应 projectKey 下 `*.api.json` 是否含 `content: []` 或 `content: ""`；代码侧发送前会自动剔除，但建议清理落盘以免 UI/压缩侧误用空消息。
