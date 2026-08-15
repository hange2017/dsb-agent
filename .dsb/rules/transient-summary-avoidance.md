# 瞬时参数省略标记避让规则(防复述污染)

> 生成时间:2026-08-15
> 适用范围:所有涉及 Write/StrReplace 写文件、以及从历史上下文引用「曾经写过内容」的操作。
> 依据:.dsb/docs/toolchain-instability-handbook.md(现象 1 复述陷阱)。
> 目的:防止把上下文中的省略标记(`[TRANSIENT-SUMMARY` / `[瞬时参数已省略`)当作真实内容复述写入新文件。

## 核心事实(必须理解)

1. **省略标记不是内容**:`[TRANSIENT-SUMMARY field=xxx chars=N]...` 与 `[瞬时参数已省略:...]` 是系统对超长工具参数的**摘要占位**,真实内容在文件系统/执行状态里,不在上下文。
2. **显示层也会压缩**:工具履历(历史消息)里长参数会被显示为占位符,但**文件系统字节正常**——看到占位符 ≠ 文件被污染,先 Read 核实再判断。
3. **复述 = 污染**:把省略标记复述进 Write.contents / StrReplace.new_string → 文件真实写入占位符文本 → 污染。执行器已有 REFUSED 拦截,但必须主动避让。

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
- Write/StrReplace 收到 `REFUSED: ... 疑似瞬时参数省略标记` = 参数里复述了占位符。**不要绕过**;按提示 Read 真实内容后重写参数。

### R5:分段读长文件
- Read 输出含 `(file: ..., lines: N, showing a-b)` 头行;当 `showing` 末行 < `lines` 时,继续 Read(offset=末行+1)直到读完。禁止假设「文件就这么长」。

### R6:长内容写入优先 Bash heredoc
- Write/StrReplace 的长参数(>200 字符)有被压缩为占位符的风险;规则/脚本/长文档写入优先用 Bash heredoc(`cat > f <<'EOF'`),写后立即验证。
