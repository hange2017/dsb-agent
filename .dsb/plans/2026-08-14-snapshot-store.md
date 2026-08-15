# Implementation Plan: Snapshot Store (2026-08-14)

Spec: .dsb/specs/2026-08-14-snapshot-store-design.md
Goal: ContextStore NDJSON append-only + async batch queue + offset index; all trim cut points archive original text; ContextRecall enabled via injection fix.

## Step 1: ContextStore NDJSON core (src/context/contextStore.ts) — DONE
- add ndjsonFileFor(); append() writes lines via fs.promises.appendFile (batch), records offsets into index entries
- read(): if ndjson exists parse lines (skip corrupt); else fallback old json; lazy migrate on append (read old json, write ndjson, delete old)
- persist() becomes appendBatch() with offsets; keep write()/rebuildIndexWithOffsets for migration/compaction
- add compact(): when chunks over 500 or bytes over 8MB, rewrite surviving (after prune) to new ndjson at idle
- prune(): evict oldest beyond cap (50MB total / 8MB thinking), keep newest
- keep API: append/load/prune/updateSummaries; append stays sync-visible but delegates to async queue internally

## Step 2: Async batch queue (src/context/snapshotQueue.ts NEW) — DONE
- class SnapshotQueue: enqueue(chunk) O(1); debounce 50ms or batch 16 flush; flush via fs.promises.appendFile + index append
- retry once on failure then drop + warn; flushNow() for agent round end; drain() on dispose
- ContextStore owns one SnapshotQueue per session; append() enqueues only
- flushNow 串行化(避免 batchSize 触发并发 append 偏移错乱)

## Step 3: thinking trim integration (src/agent/thinkingPolicy.ts + agentLoop.ts) — DONE
- thinkingPolicy: findConsumedThinking stays; add helper to build archive chunk from original thinking text
- agentLoop.trimConsumedThinking: before replacing block.thinking, append original to store; marker uses [r{seq}] from returned seq

## Step 4: toolResult trim integration (src/agent/toolResultPolicy.ts + agentLoop.ts) — DONE
- before replacing tool_result content with TRIMMED/SUMMARIZED, append original text chunk

## Step 5: toolUse transient (StrReplace.old_string only) (src/agent/toolUsePolicy.ts + agentLoop.ts) — DONE
- only when toolName=StrReplace: append old_string original before trim

## Step 6: Injection chain fix — DONE
- chatViewProvider: ensure contextRoot default; pass contextStore into controller (already at line 175/378)
- chatController: pass contextStore into AgentLoop deps (verify)
- agentLoop: pass this.deps.contextStore into ToolExecutor (verify existing param at executor.ts:327)
- executor: ContextRecall already checks this.contextStore; fix makes it non-null
- 实现:同一 `ContextStore` 实例先构造再注入 `ToolExecutor` + `AgentSession`

## Step 7: Tests — DONE
- tests/contextStore.test.ts: extend NDJSON append/offset/read/migrate/compact/prune/corrupt
- tests/snapshotQueue.test.ts: debounce merge, batch count, retry, drain (+ 串行 flush)
- tests/thinkingPolicy.test.ts + toolResultPolicy.test.ts + toolUsePolicy.test.ts: marker seq / archive helpers
- integration: `tests/agentLoop.test.ts` — trim → archive → flush → get/ContextRecall 全链

## Step 8: CHANGELOG + verify — DONE
- CHANGELOG.md Unreleased entry; vitest related suites green; `tsc --noEmit` exit 0

## Hard-gap follow-up (2026-08-15)
- Grep 描述补全; Provider 级 sharedContextStore; SDD progress + worklog 文档; 集成测; commit
