# 05 · 数据与存储梳理

> 状态:✅ 已完成(2026-08-17)
> 范围:会话 / 冷存储 / 记忆 / 快照 / 统计 / 导出 六类数据的格式与生命周期。

## 一、会话存储(sessionStore)

| 文件 | 格式 | 内容 | 用途 |
|---|---|---|---|
| `<sessionsDir>/<id>.jsonl` | JSONL append | 会话消息流 | 主存储 |
| `<sessionsDir>/<id>.api.json` | JSON | API 历史(与请求同构,含 thinking 块) | 续跑/调试 |
| `<sessionsDir>/<id>.todos.json` | JSON | todo 清单状态 | 任务管理 |

## 二、冷存储(contextStore,压缩替换出的原文)

```
<contextDir>/<sessionId>.context.ndjson   —— 主存 NDJSON 追加
<contextDir>/<sessionId>.index.json       —— 索引(seq/type/role/summary/ts/hash/offset/length)
<contextDir>/<sessionId>.context.json     —— 旧格式(只读兼容,首次 append/写时惰性迁移)
```

- **写入**:SnapshotQueue 异步批量落盘(debounce 50ms / batch 16),fail-open;append 立即更新内存(load/get/index 同步可见)。
- **检索**:只读索引优先(命中后按 offset/length 读原文),避免整文件解析;索引损坏时惰性重建。
- **淘汰**:非 thinking 块按条数淘汰最旧(maxChunks 默认 80);单会话容量上限 8MB、thinking 8MB。
- **跨会话**:mergeView 合并 / dedupe 去重 / merge 跨会话归档;ContextRecall 跨会话检索走索引。

## 三、记忆系统(memoryStore)

```
<memoryDir>/<projectKey>/<name>.json      —— 项目作用域记忆(JSON,含 body/scope/pinned 等)
<memoryDir>/meta.json                     —— 最近一次 /memory dream 整合时间戳
```

- 项目 scope 可见 = 项目记忆 + 全局记忆(全局跨项目共享,兼容旧版)。
- 记忆卫生:访问加权 + pinned 常驻、相似检测提示、Dream 双闸门(见 `memory-hygiene-triad`)。
- 上下文注入:记忆索引进 system(会话内只读一次,遵循缓存前缀稳定性规则)。

## 四、快照(checkpoint)

```
.dsb/checkpoints/<sessionId>/<stamp>-<key>   —— 每次工具调用前的文件快照(时间戳前缀)
```

- `snapshot / list / restore` 接收绝对路径;`ABSENT` 标记记录「文件当时不存在」。

## 五、统计(statsStore)

```
~/.dsb/stats/<sessionId-hash>/events-YYYY-MM-DD.jsonl   —— JSONL append,30 天保留
```

- 事件类型与口径详见 [07-stats-system.md](07-stats-system.md);只记数字不记内容。

## 六、导出(exportSession)

| 命令 | 格式 | 用途 |
|---|---|---|
| `/export md` | Markdown | 面向人阅读/再编辑的互操作格式 |
| `/export json` | JSON | 面向机器续跑/调试;与 `.api.json` 同构,可直接作后续请求历史 |

## 七、生命周期与可靠性原则

1. **追加优先**:会话/冷存储/统计全部 JSONL append(崩溃安全、前缀稳定)。
2. **索引与原文分离**:冷存储索引(小、可缓存)与原文(大、按需读)分离,检索 O(1)。
3. **fail-open**:任何持久化失败不影响主流程(统计/冷存储写入 catch 后跳过)。
4. **原子写**:关键状态(会话索引、记忆 meta)用临时文件 + rename 保证原子性。
5. **容量控制**:冷存储 8MB + maxChunks 80、统计 30 天、快照按需;均有淘汰/清理路径。
