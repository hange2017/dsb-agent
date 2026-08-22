# DSB vs dsh Capability Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one implementation-depth comparison document that explains how DSBAgent and deepseek-harness each realize the same Agent capabilities, with file/event anchors and per-side pros/cons.

**Architecture:** Single markdown deliverable built section-by-section. Read DSB (`DSBAgent/`) and DSH (`deepseek-harness/`) sources plus their docs; never change product code. Each capability section follows a fixed template. Core five capabilities are written first at full depth; remaining five next; then cross-cutting summary and glossary.

**Tech Stack:** Markdown research writing; evidence from TypeScript sources and project docs; git commits in `DSBAgent` for tracked copies.

## Global Constraints

- Spec authority: `projects/.dsb/specs/2026-08-22-dsb-vs-dsh-capability-comparison-design.md` (and `DSBAgent/.dsb/specs/` copy).
- Deliverable path: `projects/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md`; also copy to `DSBAgent/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md` for git.
- No product pick; no migration plan; no benchmarks; no edits under `DSBAgent/src/` or `deepseek-harness/packages/` except docs paths listed in this plan.
- Evidence order: source code > DSB `.dsb/docs` > DSH `docs/` + package READMEs; on conflict, source wins with a footnote.
- Every capability section MUST contain exactly these H3s: `### 能力定义`, `### DSB 实现`, `### DSH 实现`, `### 优缺点`.
- Each of `### DSB 实现` / `### DSH 实现` MUST cite ≥1 existing path (file or package dir) that `test -e` would pass from `/home/hange/projects`.
- Pros/cons MUST be mechanism-derived; ban empty claims like「更好」without a linked mechanism sentence.
- No `TBD` / `TODO` / `待补` in the final deliverable.

## File Structure

| File | Role |
|------|------|
| `projects/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md` | Canonical comparison body |
| `DSBAgent/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md` | Git-tracked mirror (same content) |
| Spec (read-only) | `projects/.dsb/specs/2026-08-22-dsb-vs-dsh-capability-comparison-design.md` |

Section ownership (single file, sequential append/edit):

| H2 | Owner task |
|----|------------|
| `#` title + intro + `## 1. 组织范式总览` | Task 1 |
| `## 2. 核心五件套` → `### 2.1 循环` | Task 2 |
| `### 2.2 工具执行` | Task 3 |
| `### 2.3 上下文与压缩` | Task 4 |
| `### 2.4 会话持久化` | Task 5 |
| `### 2.5 扩展机制` | Task 6 |
| `## 3. 其余能力` (3.1–3.5) | Task 7 |
| `## 4. 横切对照小结` + `## 5. 附录：术语对照表` + final polish | Task 8 |

---

### Task 1: Scaffold document + paradigm overview

**Files:**
- Create: `projects/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md`
- Create: `DSBAgent/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md` (mirror)
- Read: `projects/.dsb/specs/2026-08-22-dsb-vs-dsh-capability-comparison-design.md`
- Read: `DSBAgent/.dsb/docs/project-overview.md`
- Read: `DSBAgent/.dsb/docs/system-analysis/01-architecture.md` (sections on 四层 / 引擎 vs 宿主)
- Read: `deepseek-harness/docs/architecture.zh.md`
- Read: `deepseek-harness/packages/README.zh.md`

**Interfaces:**
- Consumes: design §4 directory + §5 paradigm table
- Produces: file with H1, intro (goal / non-goals / how to read), `## 1. 组织范式总览` complete; later tasks append under `## 2.` / `## 3.` placeholders as empty H2 stubs only

- [ ] **Step 1: Create the scaffold file**

Write `projects/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md` with this exact skeleton (fill §1 in Step 3; leave §2–§5 as headings only for now):

```markdown
# DSBAgent vs deepseek-harness：同能力实现对照

> 日期：2026-08-22
> 依据：`.dsb/specs/2026-08-22-dsb-vs-dsh-capability-comparison-design.md`
> 范围：实现级机制对照；不做产品选型结论

## 阅读说明

（本段在 Step 3 写完：目标一句话、非目标三条、章节怎么读）

## 1. 组织范式总览

（Step 3 填写）

## 2. 核心五件套

## 3. 其余能力

## 4. 横切对照小结

## 5. 附录：术语对照表
```

- [ ] **Step 2: Verify required read sources exist**

Run:

```bash
test -f /home/hange/projects/.dsb/specs/2026-08-22-dsb-vs-dsh-capability-comparison-design.md
test -f /home/hange/projects/DSBAgent/.dsb/docs/project-overview.md
test -f /home/hange/projects/DSBAgent/.dsb/docs/system-analysis/01-architecture.md
test -f /home/hange/projects/deepseek-harness/docs/architecture.zh.md
test -f /home/hange/projects/deepseek-harness/packages/README.zh.md
echo OK
```

Expected: `OK` and all `test` exit 0.

- [ ] **Step 3: Write §阅读说明 and §1 组织范式总览**

Content requirements for §1 (use a markdown table):

| 维度 | DSB | DSH |
|------|-----|-----|
| 组装方式 | … | … |
| 「内核」 | … | … |
| 扩展语言 | … | … |
| 运行载体 | … | … |
| 真相来源 | … | … |

Each cell must name at least one concrete artifact (`extension.ts`, `cordis.yml` / profile, `SessionEvent`, etc.). Keep §1 under ~40 lines. Do not expand into loop/tools/compaction details.

- [ ] **Step 4: Mirror + commit**

```bash
cp /home/hange/projects/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md \
   /home/hange/projects/DSBAgent/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
cd /home/hange/projects/DSBAgent
git add .dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
git commit -m "$(cat <<'EOF'
docs: scaffold DSB vs dsh comparison with paradigm overview

EOF
)"
```

---

### Task 2: Core — Agent loop

**Files:**
- Modify: `projects/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md` (add `### 2.1 循环`)
- Mirror: `DSBAgent/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md`
- Read: `DSBAgent/src/agent/agentLoop.ts` (exports, main loop / round control, append queue if present)
- Read: `DSBAgent/.dsb/docs/system-analysis/01-architecture.md` (§1.2 主循环)
- Read: `deepseek-harness/docs/architecture.zh.md` (§轮次流程)
- Read: `deepseek-harness/packages/core/agent-loop/README.zh.md`
- Read: `deepseek-harness/packages/core/agent/README.zh.md`

**Interfaces:**
- Consumes: Task 1 file + `## 2. 核心五件套` heading
- Produces: complete `### 2.1 循环` with the four required H3s

- [ ] **Step 1: Confirm loop anchors on disk**

```bash
test -f /home/hange/projects/DSBAgent/src/agent/agentLoop.ts
test -d /home/hange/projects/deepseek-harness/packages/core/agent-loop
test -f /home/hange/projects/deepseek-harness/packages/core/agent-loop/README.zh.md
rg -n "export (async )?function|DEFAULT_MAX|append|onEvent|turn|step" \
  /home/hange/projects/DSBAgent/src/agent/agentLoop.ts \
  /home/hange/projects/deepseek-harness/packages/core/agent-loop/src \
  --glob '*.ts' | head -40
```

Expected: tests pass; rg shows concrete symbols to cite.

- [ ] **Step 2: Write `### 2.1 循环`**

Insert under `## 2. 核心五件套`:

```markdown
### 2.1 循环

#### 能力定义
…

#### DSB 实现
…（必须引用 `DSBAgent/src/agent/agentLoop.ts` 及从 Step 1 核实的函数/常量名）

#### DSH 实现
…（必须引用 turn/step、`agent/pre-step`、`packages/core/agent-loop/`、相关 ctx 键）

#### 优缺点
- **DSB 优点：** …
- **DSB 缺点：** …
- **DSH 优点：** …
- **DSH 缺点：** …
```

Cover: round/step model, where extension hooks sit (inside loop vs waterfall), replaceability of the driver.

- [ ] **Step 3: Section gate**

```bash
DOC=/home/hange/projects/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
rg -n "### 2\.1 循环|#### 能力定义|#### DSB 实现|#### DSH 实现|#### 优缺点" "$DOC"
rg -n "agentLoop\.ts|agent-loop|pre-step" "$DOC"
rg -n "TBD|TODO|待补" "$DOC" && echo "FAIL placeholders" || echo "PASS no placeholders"
```

Expected: four `####` headings present under 2.1; both anchors cited; `PASS no placeholders`.

- [ ] **Step 4: Mirror + commit**

```bash
cp /home/hange/projects/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md \
   /home/hange/projects/DSBAgent/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
cd /home/hange/projects/DSBAgent
git add .dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
git commit -m "$(cat <<'EOF'
docs: compare agent loop implementations (DSB vs dsh)

EOF
)"
```

---

### Task 3: Core — Tool execution

**Files:**
- Modify: comparison doc (+ mirror)
- Read: `DSBAgent/src/agent/tools/definitions.ts`
- Read: `DSBAgent/src/agent/tools/executor.ts`
- Read: `DSBAgent/src/agent/tools/parallelSafe.ts`
- Read: `DSBAgent/src/agent/toolUsePolicy.ts`
- Read: `DSBAgent/src/agent/toolResultPolicy.ts`
- Read: `DSBAgent/src/agent/permission.ts`
- Read: `deepseek-harness/docs/tool-execution-pipeline.zh.md`
- Read: `deepseek-harness/packages/core/tools/README.zh.md`
- Read: `deepseek-harness/packages/fs/README.zh.md` (seam pattern example)

**Interfaces:**
- Consumes: Task 2 doc
- Produces: complete `### 2.2 工具执行`

- [ ] **Step 1: Confirm tool anchors**

```bash
test -f /home/hange/projects/DSBAgent/src/agent/tools/executor.ts
test -f /home/hange/projects/deepseek-harness/docs/tool-execution-pipeline.zh.md
test -d /home/hange/projects/deepseek-harness/packages/core/tools
rg -n "pre-execute|post-execute|ctx\.tools|parallelSafe|TRANSIENT" \
  /home/hange/projects/DSBAgent/src/agent \
  /home/hange/projects/deepseek-harness/packages/core/tools \
  /home/hange/projects/deepseek-harness/docs/tool-execution-pipeline.zh.md \
  | head -40
```

- [ ] **Step 2: Write `### 2.2 工具执行`**

Same four-H3 template. Must explain: registration → permission/gate → execute → result write-back; DSB policy trim vs DSH waterfall + Definition/Provider/Consumer split. Cite `executor.ts` and `packages/core/tools/` at minimum.

- [ ] **Step 3: Section gate**

```bash
DOC=/home/hange/projects/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
rg -n "### 2\.2 工具执行|#### 能力定义|executor\.ts|tool-execution|core/tools" "$DOC"
rg -n "TBD|TODO|待补" "$DOC" && echo "FAIL" || echo "PASS"
```

- [ ] **Step 4: Mirror + commit**

```bash
cp /home/hange/projects/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md \
   /home/hange/projects/DSBAgent/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
cd /home/hange/projects/DSBAgent
git add .dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
git commit -m "$(cat <<'EOF'
docs: compare tool execution pipelines (DSB vs dsh)

EOF
)"
```

---

### Task 4: Core — Context and compaction

**Files:**
- Modify: comparison doc (+ mirror)
- Read: `DSBAgent/src/agent/contextManager.ts`
- Read: `DSBAgent/src/agent/contextCompactor.ts`
- Read: `DSBAgent/src/agent/tools/contextRecallTool.ts`
- Read: `DSBAgent/.dsb/docs/system-analysis/03-module-deepdives/001-context-compaction.md`
- Read: `deepseek-harness/packages/compaction/README.zh.md`
- Read: `deepseek-harness/packages/compaction/compaction/README.zh.md` (if present; else group README only)
- Read: `deepseek-harness/docs/architecture.zh.md` (§会话日志 / 模型可见即已记录)

**Interfaces:**
- Consumes: Task 3 doc
- Produces: complete `### 2.3 上下文与压缩`

- [ ] **Step 1: Confirm compaction anchors**

```bash
test -f /home/hange/projects/DSBAgent/src/agent/contextManager.ts
test -f /home/hange/projects/DSBAgent/src/agent/contextCompactor.ts
test -d /home/hange/projects/deepseek-harness/packages/compaction
rg -n "compacted|deriveMessages|ContextRecall|compaction" \
  /home/hange/projects/DSBAgent/src/agent/contextManager.ts \
  /home/hange/projects/DSBAgent/src/agent/contextCompactor.ts \
  /home/hange/projects/deepseek-harness/packages/compaction \
  /home/hange/projects/deepseek-harness/docs/architecture.zh.md \
  | head -50
```

- [ ] **Step 2: Write `### 2.3 上下文与压缩`**

Four-H3 template. Must cover: budget trigger, what `[compacted]` / compaction provider does, append-only / cache-prefix concerns on DSB side, log projection (`deriveMessages`) on DSH side, recall/cold storage if present on DSB.

- [ ] **Step 3: Section gate**

```bash
DOC=/home/hange/projects/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
rg -n "### 2\.3 上下文与压缩|contextManager|contextCompactor|compaction|deriveMessages|ContextRecall" "$DOC"
rg -n "TBD|TODO|待补" "$DOC" && echo "FAIL" || echo "PASS"
```

- [ ] **Step 4: Mirror + commit**

```bash
cp /home/hange/projects/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md \
   /home/hange/projects/DSBAgent/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
cd /home/hange/projects/DSBAgent
git add .dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
git commit -m "$(cat <<'EOF'
docs: compare context compaction approaches (DSB vs dsh)

EOF
)"
```

---

### Task 5: Core — Session persistence

**Files:**
- Modify: comparison doc (+ mirror)
- Read: `DSBAgent/src/session/sessionStore.ts`
- Read: `DSBAgent/src/chat/sessionService.ts`
- Read: `DSBAgent/.dsb/docs/system-analysis/05-data-storage.md`
- Read: `deepseek-harness/packages/core/session/README.zh.md`
- Read: `deepseek-harness/packages/session/README.zh.md`
- Read: `deepseek-harness/docs/subsystems/session.zh.md` (if missing, use core session README + architecture §会话日志)

**Interfaces:**
- Consumes: Task 4 doc
- Produces: complete `### 2.4 会话持久化`

- [ ] **Step 1: Confirm session anchors**

```bash
test -f /home/hange/projects/DSBAgent/src/session/sessionStore.ts
test -d /home/hange/projects/deepseek-harness/packages/core/session
test -d /home/hange/projects/deepseek-harness/packages/session
ls /home/hange/projects/deepseek-harness/docs/subsystems/session.zh.md \
  /home/hange/projects/deepseek-harness/docs/subsystems/session.md 2>/dev/null || true
```

- [ ] **Step 2: Write `### 2.4 会话持久化`**

Four-H3 template. Contrast message/context files vs append-only `SessionEvent` log + backends (JSONL/SQLite). Mention restore/fork/UI projection only as supported by sources.

- [ ] **Step 3: Section gate**

```bash
DOC=/home/hange/projects/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
rg -n "### 2\.4 会话持久化|sessionStore|SessionEvent|packages/session|core/session" "$DOC"
rg -n "TBD|TODO|待补" "$DOC" && echo "FAIL" || echo "PASS"
```

- [ ] **Step 4: Mirror + commit**

```bash
cp /home/hange/projects/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md \
   /home/hange/projects/DSBAgent/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
cd /home/hange/projects/DSBAgent
git add .dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
git commit -m "$(cat <<'EOF'
docs: compare session persistence models (DSB vs dsh)

EOF
)"
```

---

### Task 6: Core — Extension mechanisms

**Files:**
- Modify: comparison doc (+ mirror)
- Read: `DSBAgent/src/plugins/` (list + key files: manifest / marketplace / pluginTools if present)
- Read: `DSBAgent/src/mcp/`
- Read: `DSBAgent/src/hooks/hookRunner.ts`
- Read: `DSBAgent/src/projectContext/` (skillsScan / rulesReader / projectInstruction)
- Read: `deepseek-harness/docs/architecture.zh.md` (§Profile 与组合包, §新行为的归属位置)
- Read: `deepseek-harness/packages/extensions/README.zh.md`
- Read: `deepseek-harness/packages/hooks/README.zh.md`
- Read: `deepseek-harness/packages/bundle/README.zh.md`

**Interfaces:**
- Consumes: Task 5 doc
- Produces: complete `### 2.5 扩展机制` — finishes core five

- [ ] **Step 1: Confirm extension anchors**

```bash
test -f /home/hange/projects/DSBAgent/src/hooks/hookRunner.ts
test -d /home/hange/projects/DSBAgent/src/plugins
test -d /home/hange/projects/deepseek-harness/packages/extensions
test -d /home/hange/projects/deepseek-harness/packages/bundle
ls /home/hange/projects/DSBAgent/src/plugins
ls /home/hange/projects/deepseek-harness/packages/bundle
```

- [ ] **Step 2: Write `### 2.5 扩展机制`**

Four-H3 template. Cover: `.dsb` conventions + skills + plugins + MCP + hooks on DSB; plugins/effects + profile/bundle patches + optional self-modification + hook bridges on DSH. Pros/cons on reversibility and who the extension author is (extension user vs harness integrator).

- [ ] **Step 3: Core-five completeness gate**

```bash
DOC=/home/hange/projects/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
rg -n "^### 2\.[1-5] " "$DOC"
# expect exactly five section headers 2.1-2.5
rg -n "TBD|TODO|待补" "$DOC" && echo "FAIL" || echo "PASS"
```

Expected: lines for 2.1 through 2.5; PASS.

- [ ] **Step 4: Mirror + commit**

```bash
cp /home/hange/projects/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md \
   /home/hange/projects/DSBAgent/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
cd /home/hange/projects/DSBAgent
git add .dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
git commit -m "$(cat <<'EOF'
docs: compare extension mechanisms; finish core five

EOF
)"
```

---

### Task 7: Remaining capabilities (3.1–3.5)

**Files:**
- Modify: comparison doc (+ mirror)
- Read (permission): `DSBAgent/src/agent/permission.ts`, `permissionRules.ts`, `capabilityGate.ts`; `deepseek-harness/packages/interaction/README.zh.md`
- Read (prompt/skills): `DSBAgent/src/agent/systemPrompt.ts`, `DSBAgent/src/projectContext/`; `deepseek-harness/packages/core/system-prompt/README.zh.md`, `deepseek-harness/packages/skill/README.zh.md`, `deepseek-harness/packages/preset/README.zh.md`
- Read (subagent/workflow): `DSBAgent/src/agent/subagentRunner.ts`, `workflow.ts`, `worktree.ts`; `deepseek-harness/packages/subagent/README.zh.md`, `deepseek-harness/packages/workflow/README.zh.md`
- Read (LLM): `DSBAgent/src/agent/provider/anthropicMessagesClient.ts`, `DSBAgent/src/providers/`; `deepseek-harness/packages/llm/README.zh.md`
- Read (UI/host): `DSBAgent/src/chat/chatViewProvider.ts`, `DSBAgent/webview/`, `DSBAgent/benchmark/cli.ts` (or `benchmark/` entry); `deepseek-harness/packages/host/README.zh.md`, `deepseek-harness/packages/client/README.zh.md`, `deepseek-harness/apps/`

**Interfaces:**
- Consumes: Task 6 doc (core five done)
- Produces: `### 3.1` … `### 3.5` each with the four H3s (may be shorter than core five, but same template and ≥1 path anchor per side)

- [ ] **Step 1: Confirm remaining anchors exist**

```bash
test -f /home/hange/projects/DSBAgent/src/agent/permission.ts
test -f /home/hange/projects/DSBAgent/src/agent/systemPrompt.ts
test -f /home/hange/projects/DSBAgent/src/agent/subagentRunner.ts
test -f /home/hange/projects/DSBAgent/src/agent/provider/anthropicMessagesClient.ts
test -f /home/hange/projects/DSBAgent/src/chat/chatViewProvider.ts
test -d /home/hange/projects/deepseek-harness/packages/interaction
test -d /home/hange/projects/deepseek-harness/packages/skill
test -d /home/hange/projects/deepseek-harness/packages/subagent
test -d /home/hange/projects/deepseek-harness/packages/llm
test -d /home/hange/projects/deepseek-harness/packages/host
echo OK
```

- [ ] **Step 2: Write all five remaining sections**

Under `## 3. 其余能力` add:

| Section | Title | Must cite (min) |
|---------|-------|-----------------|
| 3.1 | 权限与审批 | `permission.ts` + `packages/interaction/` |
| 3.2 | 系统提示与技能 | `systemPrompt.ts` or `projectContext/` + `system-prompt` / `skill` |
| 3.3 | 子代理与工作流 | `subagentRunner.ts` + `packages/subagent/` or `workflow/` |
| 3.4 | LLM 接入 | `anthropicMessagesClient.ts` + `packages/llm/` |
| 3.5 | UI / 宿主形态 | `chatViewProvider.ts` + `packages/host/` or `client/` |

Each uses the four-H3 template. Length target: ~half of a core section, not a stub.

- [ ] **Step 3: Remaining-sections gate**

```bash
DOC=/home/hange/projects/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
rg -n "^### 3\.[1-5] " "$DOC"
for s in 3.1 3.2 3.3 3.4 3.5; do
  echo "--- $s ---"
  # crude: ensure 能力定义 appears after this heading before next ### 
  rg -n "^### $s |#### 能力定义|#### DSB 实现|#### DSH 实现|#### 优缺点" "$DOC" | head -20
done
rg -n "TBD|TODO|待补" "$DOC" && echo "FAIL" || echo "PASS"
```

Expected: five section headers; PASS.

- [ ] **Step 4: Mirror + commit**

```bash
cp /home/hange/projects/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md \
   /home/hange/projects/DSBAgent/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
cd /home/hange/projects/DSBAgent
git add .dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
git commit -m "$(cat <<'EOF'
docs: compare remaining Agent capabilities (DSB vs dsh)

EOF
)"
```

---

### Task 8: Cross-cutting summary, glossary, final polish

**Files:**
- Modify: comparison doc (+ mirror)
- Read: entire comparison doc written so far
- Read: design §8 (横切 + 术语)

**Interfaces:**
- Consumes: Tasks 1–7 complete body
- Produces: finished `## 4` + `## 5`; document ready for human read

- [ ] **Step 1: Write `## 4. 横切对照小结`**

Must include four bullets/subsections (no new capability deep-dives):

1. 真相来源（消息数组/文件 vs 事件日志）
2. 扩展点（改循环 vs waterfall）
3. 测试边界（引擎无 `vscode` vs 包级门禁/snapshot — cite only what sources support）
4. 「换一块能力」的成本量级（定性：低/中/高 + 一句机制理由，各举 1 例）

- [ ] **Step 2: Write `## 5. 附录：术语对照表`**

Markdown table with columns: `概念 | DSB 名称/锚点 | DSH 名称/锚点`. Minimum rows:

| 概念 |
|------|
| Agent 循环 |
| 工具注册/执行 |
| 上下文压缩 |
| 会话持久化 |
| 扩展/插件 |
| 系统提示 |
| 技能 |
| 子代理 |
| 权限/审批 |
| LLM 客户端 |

Fill cells from terms already used in §§1–4 (no new invented synonyms).

- [ ] **Step 3: Full-document gate**

```bash
DOC=/home/hange/projects/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
test -f "$DOC"
rg -n "^## [1-5]\. " "$DOC"
rg -n "^### 2\.[1-5] |^### 3\.[1-5] " "$DOC"
# count #### 能力定义 — expect 10 (2.1-2.5 + 3.1-3.5)
rg -c "#### 能力定义" "$DOC"
rg -n "TBD|TODO|待补|XXXX|lorem" "$DOC" && echo "FAIL placeholders" || echo "PASS placeholders"
# spot-check cited paths still exist (sample)
test -f /home/hange/projects/DSBAgent/src/agent/agentLoop.ts
test -d /home/hange/projects/deepseek-harness/packages/core/agent-loop
wc -l "$DOC"
```

Expected: H2 1–5 present; ten capability sections; `#### 能力定义` count = 10; PASS placeholders; `wc -l` roughly ≥200 lines (if far below, sections are too thin — expand before commit).

- [ ] **Step 4: Mirror + final commit**

```bash
cp /home/hange/projects/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md \
   /home/hange/projects/DSBAgent/.dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
cd /home/hange/projects/DSBAgent
git add .dsb/docs/2026-08-22-dsb-vs-dsh-capability-comparison.md
git commit -m "$(cat <<'EOF'
docs: finish DSB vs dsh comparison (summary + glossary)

EOF
)"
```

---

## Plan Self-Review

| Spec item | Task |
|-----------|------|
| 能力轴全量 + 核心五深写 | Tasks 2–6 (core), Task 7 (rest) |
| 实现级锚点 + 四段模板 | Global Constraints + each task Step 2/3 |
| 组织范式钥匙 | Task 1 |
| 横切小结 + 术语表 | Task 8 |
| 非目标（不选型/不改代码/不测基准） | Global Constraints |
| 落盘 projects/.dsb + DSBAgent mirror | Every task Step 4 |

Placeholder scan: none intentional in steps. Type/name consistency: section IDs `2.1`–`2.5`, `3.1`–`3.5` and H3 titles fixed across tasks.
