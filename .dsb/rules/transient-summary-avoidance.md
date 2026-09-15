# 瞬时参数省略标记避让规则(防复述污染)

> 生成时间:2026-08-15;更新:2026-09-14(阈值放宽 + 形状校验 + 字段调整)
> 适用范围:所有涉及 Write/StrReplace 写文件、以及从历史上下文引用「曾经写过内容」的操作。
> 依据:.dsb/docs/toolchain-instability-handbook.md(现象 1 复述陷阱)、
> `.dsb/docs/2026-09-14-压缩目标漂移修复与96k预算实测.md`。
> 目的:防止把上下文中的省略标记(`[TRANSIENT-SUMMARY` / `[瞬时参数已省略`)当作真实内容复述写入新文件。

## 核心事实(必须理解)

1. **省略标记不是内容**:`[TRANSIENT-SUMMARY field=xxx chars=N]...` 与 `[瞬时参数已省略:...]` 是系统对超长工具参数的**摘要占位**,真实内容在文件系统/执行状态里,不在上下文。
2. **显示层也会压缩**:工具履历(历史消息)里长参数会被显示为占位符,但**文件系统字节正常**——看到占位符 ≠ 文件被污染,先 Read 核实再判断。
3. **复述 = 污染**:把省略标记复述进 Write.contents / StrReplace.new_string → 文件真实写入占位符文本 → 污染。执行器已有 REFUSED 拦截,但必须主动避让。

## 当前阈值与字段(2026-09-14 现状,务必以代码为准)

`src/agent/toolUsePolicy.ts`:

| 项 | 值 | 说明 |
|---|---|---|
| `TRANSIENT_FIELD_MIN_CHARS`(全局) | **200** | 低于此值不精简 |
| `Write.contents` | **16000** | 正文即工作产物:写普通文件(≤16k 字符 ≈ 400 行)原文完整留存,不再被迫拆成多个 <2k 小文件;仅极端大写入走「头尾预览」 |
| `StrReplace.new_string` | **8000** | 同上 |
| `StrReplace.old_string` | **8000** | 锚点档(B):替换执行后磁盘上**不存在**该旧文本副本,是「我改的是哪一段」的唯一线索 |
| `TRANSIENT_PREVIEW_FIELDS` | `Write.contents` / `StrReplace.new_string` / `StrReplace.old_string` | 精简时保留 **头 + 尾预览**,而非无语义裸标记 |
| `TOOL_USE_KEEP_RECENT_COUNT` | **8** | 最近 8 条**已消费** tool_use 一律不精简(与 thinking 的 15 对齐) |

**已移出精简表**(正文即语义主体):`TodoWrite.content`、`MemoryWrite.body`。
**锚点档字段**(`TRANSIENT_ANCHOR_FIELDS`):`StrReplace.old_string` 在**写前定型**阶段不精简,
仅在跌出近期窗口后按「预览 + `[r{seq}]`」处理。

## 标记判定(形状校验,不再朴素子串匹配)

`isTransientSummaryText` 规则(顺序):
1. 首行匹配 `^\[TRANSIENT-SUMMARY field=… chars=<数字>\]` → **真**(形状即证据,不看长度);
2. 正文长度 > 320 → **假**(太长不可能是纯标记,消除「引用标记的文档被误拒」);
3. 以 `[瞬时参数已省略` 开头 → 真;
4. 以 `瞬时参数省略标记` 开头且含 `禁止写入文件` → 真。

> 修因:旧版用朴素 `includes` 子串匹配,导致**一切引用该标记的正常文档/代码编辑被 REFUSED**(本轮诊断文档与多处代码编辑被误拒,大粒度重构无法进行)。形状校验后误伤消除。

## 行为规则(硬性)

### R1:读真实内容,不凭上下文回忆 🔴
- 需要引用/修改「曾经写入的文件」内容时,**禁止**凭历史消息回忆,一律先 `Read`(读文件系统真实内容)。
- Read 输出已带头行 `(file: ..., lines: N, showing a-b)`;大文件**分段读**(offset/limit),不要漏段。

### R2:StrReplace 参数从 Read 输出复制 🔴
- `old_string` / `new_string` 必须来自**最近一次 Read 的真实输出**,不得来自工具履历(可能显示为占位符)。
- 替换完成后**立即 Read 验证**目标区段字节与预期一致。

### R3:Write 后必须验证
- 写长内容(>200 字符)后,立即 `grep` 关键词 + 行数/字节校验;若发现内容含省略标记字样,判定污染,删除重写。

### R4:REFUSED 是善意拦截
- Write/StrReplace 收到 `REFUSED: ... 疑似瞬时参数省略标记` = 参数里复述了占位符(或锚点过期)。**不要绕过**;按提示 Read 真实内容后重写参数(StrReplace 必须**重新 Read 取新锚点**)。

### R5:分段读长文件
- Read 输出含 `(file: ..., lines: N, showing a-b)` 头行;当 `showing` 末行 < `lines` 时,继续 Read(offset=末行+1)直到读完。禁止假设「文件就这么长」。

### R6:长内容写入优先 Bash heredoc
- Write/StrReplace 的长参数(>200 字符)有被压缩为占位符的风险;规则/脚本/长文档写入优先用 Bash heredoc(`cat > f <<'EOF'`),写后立即验证。

### R7:记忆与清单的回读指引(2026-09-14 新增)
- 标记文案已区分工具:`记忆 → MemoryRead`,`文件 → Read`。**不要把二者弄反**(旧文案纯文件导向,是「虽保存却未真读」的根因之一)。

---

## 三层防线(2026-08-17 加固,均为代码强制)

模型侧规则(R1-R7)之外,代码侧已有三层防线,事故「漏网也伤不到人」:

| 层 | 位置 | 作用 |
|---|---|---|
| L1 写前守卫 | `src/agent/tools/executor.ts`(4 个写入口) + `isTransientSummaryText` | 整段即标记 → `REFUSED`,根本不落盘 |
| L2 写后自检 + 回滚 | `executor.ts` `selfCheckWrittenBytes` + `scanTransientMarkerLines` | 落盘后逐行扫字节;**新引入**标记行 → 用编辑前快照回滚 + 返回 `ROLLED BACK` |
| L3 仓库门禁 | `scripts/scan-transient-pollution.mjs`(CI 步骤) | 扫全仓,拦住标记以独立成行形态进入版本库 |

要点:
- **为什么需要 L2**:L1 只判「整段内容是不是标记」,对**大文件里夹带单行标记**无感(整段长度 > 320 即提前返回 `false`)。L2 逐行扫,补这个洞。
- **L2 只回滚「本次新引入」的标记行**:编辑前就存在的引用行不算(`preSet` 差集),避免误伤文档中既有的引用。
- **L2 命中后是失败结果(红)**:返回 `ROLLED BACK: ...`,必须 Read 取真实内容后重写;不要当成功忽略。
- **埋点(2026-08-17)**:L1 拒绝落 `transient_marker_refused`(含 tool/field/chars/sample),L2 回滚落 `transient_marker_rollback`(含 op/file/lines/sample),可用 `~/.dsb/stats/<project>/events-*.jsonl` 量化「偶发 vs 高频」。
- **L3 白名单**:仅 `src/agent/toolUsePolicy.ts`(检测器自身)与 `tests/`(需构造标记样本);其余一律拦截。
- **本文件自身的写法约束**:描述标记时必须**拆写**(如用省略号或反引号包裹后接中文),不得写成整行标记形态,否则会被 L3 拦下。

## 已知陷阱

- **误伤扫描**:任何文档/代码若**引用**该标记字面前缀会被旧版误拒;新版形状校验已修,但文档中仍应避免写入**整行标记形态**的样例(建议拆写,如 `[TRANSIENT-SUMMARY …]` 中间用省略号)。
- **运行时合成文本**:`[续写]` 续写提示、`[输出中断]` 占位由系统注入,非用户语义,亦不得复述为正文。
