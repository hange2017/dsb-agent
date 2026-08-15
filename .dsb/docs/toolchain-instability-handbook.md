# 本环境工具链不稳定现象与规避手册

> 状态:持续维护(2026-08-14 首版,基于 Windows 实测会话经验)
> Canonical: `dsb-agent/.dsb/docs/`(2026-08-15 自 bbb 迁入;以本仓库为准)
> 适用范围:在 Windows 上运行 DSBAgent 进行开发时,工具链出现的间歇性异常与规避方法
> 关联:占位符生成器已定位至 `src/agent/toolUsePolicy.ts`(见第 3 节)

## 1. 背景

在 Windows 环境下长时间开发(尤其涉及大量 Write 长脚本、内联 Bash/PowerShell、findstr 检索)时,会遇到四类现象。本手册记录现象、根因(已定位/已推断)与可操作的规避方法,避免重复踩坑。

## 2. 现象清单与根因

| # | 现象 | 严重度 | 根因归类 |
|---|---|---|---|
| 1 | Write 写入占位符文本(`[TRANSIENT-SUMMARY field=contents chars=XXXX]...`,文件仅 ~200 字节) | 🔴 高 | **占位符污染**(第 3 节,已定位并修复,见 3.5) |
| 2 | Read/type 显示占位符但文件字节数正常(`len=1446` 等) | 🟡 中 | 显示层省略(无害,与现象 1 共用标记造成误判);2026-08-15 实测发现 Write 长参数在传递层也会被压缩成占位符并到达 executor,被 REFUSED 拦截(未污染,但证明「参数层也可能真实压缩」) |
| 3 | cmd echo 生成 Python/ps1 脚本报 `IndentationError` / 引号丢失 / `\"` 转义 | 🟡 中 | Windows cmd 引号/缩进固有行为 |
| 4 | 内联 `python -c "..."` 报 `SyntaxError: unterminated string literal` | 🟡 中 | cmd 引号解析与 POSIX 不同 |
| 5 | 内联 PowerShell `-Command "..."` 输出被吞 / 报"缺少 ]" | 🟡 中 | PowerShell 引号嵌套 + 控制台代码页 |
| 6 | `findstr /c:"中文"` 搜不到 UTF-8 文件内容 | 🟢 低 | 控制台代码页 GBK vs 文件 UTF-8 |
| 7 | Write 工具间歇性"污染"(写入占位符或错误内容) | 🔴 高 | 现象 1 的表现,见第 3 节 |

## 3. 占位符污染:已定位的根因与完整链路

### 3.1 生成器(已定位)

占位符文本由 **`src/agent/toolUsePolicy.ts`** 的 `transientSummary(fieldName, chars)` 生成:

```ts
export const TRANSIENT_SUMMARY_PREFIX = "[TRANSIENT-SUMMARY";
export const TRANSIENT_FIELD_MIN_CHARS = 200;
export function transientSummary(fieldName: string, chars: number): string {
  return `${TRANSIENT_SUMMARY_PREFIX} field=${fieldName} chars=${chars}] 瞬时参数省略标记:禁止写入文件,请用 Read/StrReplace 重新读取真实内容。`;
}
/** 检测瞬时摘要文本(防御模型把省略标记复述成文件内容);兼容旧标记 `[瞬时参数已省略`(历史污染文件)。 */
export function isTransientSummaryText(text: string): boolean {
  if (typeof text !== "string") return false;
  if (text.includes(TRANSIENT_SUMMARY_PREFIX)) return true;
  if (text.includes("[瞬时参数已省略")) return true;
  return text.includes("瞬时参数省略标记") && text.includes("禁止写入文件");
}
const TRANSIENT_FIELDS = {
  Write: ["contents"],
  StrReplace: ["old_string", "new_string"],
  Workflow: ["stages"],
  Agent: ["task", "system"],
  TodoWrite: ["content"],
  MemoryWrite: ["body"],
};
```

**设计意图**:tail 内 toolUse 精简(纯函数),只应在「发送给模型的历史消息」与「持久化块(P3 写前定型)」中把超过 200 字符的瞬态参数替换为摘要文本,以节省 token。设计注释明确"工具执行用 toolUses(独立对象),不受定型影响"。

### 3.2 注入上下文的位置(已定位)

`src/agent/agentLoop.ts` 两处调用:

1. **`trimConsumedToolUses()`(约 L377)**:发送前,`findConsumedToolUses(this.messages)` 找出「已执行且已消费」的 tool_use 块,把 `block.input` 直接替换为裁剪后对象。
2. **P3 写前定型(约 L625)**:assistant 块首次进入 `this.messages` 前,对 `persistBlocks` 里 tool_use 的瞬态字段做裁剪。

请求构建(约 L541)`requestMessages = this.messages` **直接使用 this.messages**,因此被裁剪后的占位符文本会进入模型上下文。

### 3.3 污染路径(推断,证据充分)

```
1. 模型生成长 contents(>200 字符)的 Write 调用
2. 执行后消息进入 this.messages;trimConsumedToolUses() 将其裁剪为占位符
3. 下一轮请求构建直接用 this.messages → 占位符文本进入模型上下文
4. 模型在上下文中看到占位符(普通中文句子,无"禁止复制"标记)
5. 模型需要重新生成长内容时,可能把占位符文本当真实内容复述/引用
6. 新 Write.contents = 占位符文本 → writeWorkspaceFile 忠实写入 → 文件污染
```

**支持证据**:
- 占位符 `chars` 数字与模型生成脚本长度一致(如 1348),说明是"对某次真实长 contents 的替换结果"而非随机文本;
- 实测模式:**短内容(<200 字符)100% 成功;长内容(>200 字符)频繁污染;`copy` 等不经模型生成长内容的操作 100% 成功**——完全符合"模型复述陷阱"特征;
- src 与 dist 的执行路径(Write → `writeWorkspaceFile`)均忠实写入,`planToolUseTrim` 只改 `persistBlocks`/`this.messages` 中的块(浅拷贝),不改执行用的 `toolUses` 对象——排除了"执行参数被替换"的代码路径。

### 3.4 结论

这是 **`transientSummary` 模板文本设计缺陷**:占位符是普通中文句子,进入模型上下文后缺乏"禁止复制"强标记,诱导模型把省略标记当真实内容写入新文件。项目代码的执行路径本身无污染。

### 3.5 代码层改进(已实施,2026-08-14 验证)

> ⚠️ 本手册旧版曾标注"未实施,供参考",现已过时——三条建议均已落地且测试全绿,后续会话按"已修复"处理。

| # | 建议 | 状态 | 代码位置 |
|---|---|---|---|
| 1 | 改造 `transientSummary` 模板加强标记 | ✅ 已实施 | `src/agent/toolUsePolicy.ts:22-38`(`TRANSIENT_SUMMARY_PREFIX` + `isTransientSummaryText`) |
| 2 | Write 防御性校验 | ✅ 已实施 | `src/agent/tools/executor.ts:400`(Write)、`:414`(StrReplace),命中瞬时摘要文本即 `REFUSED` 并提示用 Read 重读 |
| 3 | 显示层与参数层分离标记 | ✅ 已实施 | `isTransientSummaryText()` 同时识别新标记 `[TRANSIENT-SUMMARY` 与旧标记 `[瞬时参数已省略`(向后兼容历史污染文件) |

**测试证据**(2026-08-14,6 个测试文件 77 个用例全绿):
- `tests/toolUsePolicy.test.ts`:21 条,覆盖标记生成/识别/新旧兼容;
- `tests/tools.test.ts`:`"Write refuses transient summary marker contents"` 用例;
- `tests/agentLoop.test.ts`:trim 后保留 Read toolUse、写前定型等行为;
- `tests/platformGate.test.ts` / `tests/platformMatrix.test.ts` / `tests/grepFallback.test.ts` / `tests/systemPrompt.test.ts`:平台门禁、Grep 降级、运行环境段用例。

**遗留提示**:历史污染文件可能仍含旧标记 `[瞬时参数已省略`,防御校验已兼容;若发现新写入文件含 `[TRANSIENT-SUMMARY`,说明 trim 或持久化链路仍有缺口,按第 4 节规避。

### 3.6 新一轮防线(2026-08-15 实测验证)

> 本次会话实测复现了「参数传递层压缩」:构造 Write 长 contents 时,实际到达 executor 的参数是占位符文本,被 REFUSED 拦截。说明占位符不仅存在于显示层,**长参数在传递层确实会被压缩**,Write/StrReplace 的守卫是最后一道防线。

| # | 防线 | 状态 | 位置 |
|---|---|---|---|
| 1 | Read 大文件输出头行 `(file: ..., lines: N, showing a-b)`,支持分段读 | ✅ 已实施 | `src/agent/tools/workspaceFs.ts`(readWorkspaceFile) |
| 2 | Write/StrReplace tool_result 回显 `bytes/lines/首行预览`,给模型内容锚点 | ✅ 已实施 | `src/agent/tools/executor.ts` |
| 3 | toolUsePolicy 字段细分阈值:`Write.contents` 2000、`StrReplace.new_string` 1000(其余仍 200) | ✅ 已实施 | `src/agent/toolUsePolicy.ts`(`TRANSIENT_FIELD_MIN_CHARS_BY_KEY` / `fieldMinChars`) |
| 4 | REFUSED 提示点名「复述陷阱」,禁止复述省略标记 | ✅ 已实施 | `src/agent/tools/executor.ts` |
| 5 | 行为规则 `.dsb/rules/transient-summary-avoidance.md`(R1-R6:读真实内容、StrReplace 参数从 Read 复制、写后验证、REFUSED 不绕过、分段读、Bash heredoc 优先) | ✅ 已实施 | `.dsb/rules/` |

**残余缺口**(已知,未根治):
- 长参数传递层压缩的触发边界不明确(与长度/内容的确定性关系未验证),守卫拦截是兜底而非根治;
- 历史污染文件(旧标记 `[瞬时参数已省略`)需逐个清理;
- 显示层与参数层的压缩逻辑在代码中未见显式实现,疑似位于消息构造/序列化链路,后续可在 `agentLoop.ts` 消息落盘处加长参数探针确认。

## 4. 规避手册(操作层面,立即可用)

### 4.1 长内容写入:写后立即验证(最重要)

> 2026-08-15 补充:长参数(>200 字符)经 Write/StrReplace 传入有被压缩为占位符的真实风险(已被 REFUSED 拦截过)。**规则/脚本/长文档写入优先用 Bash heredoc**(`cat > f <<'EOF'`),实测可靠;Write/StrReplace 仅用于短参数与精确替换。


任何 `Write` 长内容(>200 字符,尤其脚本文件)后,**立即**做字节数 + 关键词验证:

```bash
# 验证脚本(纯 ASCII,避免引号问题)
echo import io > _v.py
echo s = io.open('target.py', encoding='utf-8', newline='').read() >> _v.py
echo print('len', len(s), 'OK' if 'EXPECTED-KEYWORD' in s and len(s) > 100 else 'POLLUTED') >> _v.py
python _v.py
```

- 期望内容含中文时,关键词用 ASCII(如 `import`、`describe`、函数名);
- `len < 100` 且内容为占位符 → 判定污染 → 删除重写。

### 4.2 生成补丁脚本:优先"非模型生成长内容"的路径

长 Python 补丁脚本是污染重灾区。按优先级选择:

1. **短内容直接 Write**(<200 字符,基本不会污染);
2. **复用已有成功脚本**:`copy _p1.py _p3.py` 后小改动(不经模型重新生成长内容);
3. **Write 到 .txt 中转再 copy**:`copy /y _x.txt _x.py`(历史成功率较高);
4. **cmd echo 逐行生成**:仅限纯 ASCII、无 `()`/`=>`/`&&`/双引号内容;缩进用 `i4 = '    '` 变量拼接;
5. **中文用 `\uXXXX` 转义**写进补丁脚本,避免源码含中文字面量。

### 4.3 cmd echo 限制与替代

| cmd 行为 | 规避 |
|---|---|
| `>` 被当重定向 | 用 `2>nul` 之外避免裸 `>`;或改用 `>>` 前加空格 |
| `&&` 被拆分 | 拆成多条 `echo ... >> f` 或改用 `&`(注意语义) |
| 双引号输出 `\"` | 内容用单引号(echo 不转义单引号)或 `chr(34)` |
| `(` `)` 触发块解析 | 避免在 echo 行用括号;或用 .txt 中转 |
| 行首缩进丢失 | 用 `i4 = '    '` 显式拼接,不在 echo 行首放空格 |
| `%` 被展开 | 批处理中 `%%`;单行命令一般无此问题 |

### 4.4 内联命令不可用 → 用脚本文件

- `python -c "..."` 在 cmd 下引号易断 → 改用 `Write`/echo 生成 `.py` 再 `python _x.py`;
- 内联 `powershell -Command "..."` 变量被吞/输出丢失 → 改用 `-File _x.ps1`;
- `findstr` 搜中文 → 改用 `python` 脚本读 UTF-8 判断(或先确认文件编码);
- 验证脚本输出被 ANSI 码污染 → 先写文件再 `type`,或 Python 里 `replace('\x1b[39m','')` 清洗。

### 4.5 复述陷阱专项:需要重写长脚本时的正确姿势

当需要**重新生成**一个曾经写过、但在历史中可能已被 trim 的长脚本时:

1. **不要从上下文"回忆"脚本内容**——历史里的可能是占位符;
2. 先用 `Read`/`StrReplace` 从**文件系统**读取真实内容(占位符提示"内容已在文件系统",这是唯一可靠来源);
3. 基于读到的真实内容做小修改,而不是凭空重新生成;
4. 写后立即按 4.1 验证。

## 5. 环境事实速查(Windows)

- 便携 Node:`E:\DSBAgent\.tools\node-v20.19.0-win-x64\node.exe`(可用,勿再误判"无 node");
- 便携 rg:`dist/bin/win32-x64-rg.exe`(esbuild compile 后生成);
- Python:`E:\AnacondaNew\python.exe` / `D:\python39\python.exe`(cmd 中 `python` 可用,但 `python -c` 有引号问题);
- PowerShell:`powershell.exe -NoProfile -ExecutionPolicy Bypass -File _x.ps1` 为可靠执行方式;
- 控制台代码页 GBK:输出中文乱码为正常现象,验证以文件字节/关键词为准;
- 源文件 EOL:src 下均为 CRLF;`.dsb/docs` 文档为 LF;写入新文件前先检查 EOL 保持一致。

## 6. 排查占位符污染的快速定位清单

| 步骤 | 操作 |
|---|---|
| 1 | `echo import io > _v.py` + Python 打印 `len` 与关键词,确认是否污染 |
| 2 | 确认污染 → `del` 删除 → 按 4.2 重写 |
| 3 | 排查是否为"复述陷阱" → 检查上下文里是否有 `[TRANSIENT-SUMMARY` / `[瞬时参数已省略` 标记 → 用 Read 从文件取真实内容 |
| 4 | 源码级定位 → 搜 `transientSummary` / `planToolUseTrim`(`src/agent/toolUsePolicy.ts`、`src/agent/agentLoop.ts`) |

---
> 维护提示:遇到新的不稳定现象时,先在本手册第 2 节登记,再补充规避方法;已定位根因的标注代码位置。
