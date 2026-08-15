# Snapshot Store (Unified Cut-Off Archive) Design

Status: approved (user confirmed B+C unified approach and 50MB cap on 2026-08-14)
Related: keep original text of all trim/compact cut points locally, retrieve by seq/hash
Next: implemented by .dsb/plans/2026-08-14-snapshot-store.md

## 1. Goal
Upgrade existing ContextStore into the single unified snapshot archive:
- All cut points (compaction, thinking trim, toolResult trim, toolUse transient) append their ORIGINAL text into the archive
- Model sees [r{seq}] marker and uses existing ContextRecall tool to fetch by seq/hash
- No third storage system: upgrade one, reuse all retrieval protocol

## 2. Current Bottlenecks
- ContextStore.append: read whole file, JSON.parse, push, full serialize, write tmp, rename: O(N) and SYNCHRONOUS (fs.writeFileSync), blocks agent loop
- ContextRecall returns "cold storage not enabled": contextStore not injected into executor (injection chain broken)
- thinking trim has NO copy of original: truly lost after trim (highest value to archive)

## 3. Storage Format: NDJSON append-only + separate index
- Original file becomes sessionId.context.ndjson: one compact JSON chunk per line; append = fs.promises.appendFile O(1) sequential write; crash-safe (skip incomplete last line)
- Index file unchanged (sessionId.index.json, no content): on append record byte offset (file length before append) + hash; offset naturally exact, no full rewrite
- Compat: old .context.json still readable; lazy migrate on first write (read once, write NDJSON, delete old file)
- Compaction: when chunks over 500 or bytes over 8MB, rewrite surviving chunks to new NDJSON at process idle (setImmediate); low frequency

## 4. Async Batch Queue (efficiency core)
- Cut points push to in-memory queue (O(1), NEVER await)
- flush on debounce 50ms, or batch over 16, or agent round end
- flush: fs.promises.appendFile (whole batch as one write) + index incremental update (same batch)
- flush failure: keep in memory, retry once, then drop + warn (fail-open)
- NO worker_threads: IO-bound load, worker message serialization overhead is slower; real pain is synchronous write blocking, async queue removes it

## 5. Cut Point Integration + Marker Protocol
- thinking: existing marker ...(truncated); change: append original, marker becomes [r{seq}]; retrieval: ContextRecall seq={seq}
- toolResult: existing marker [TRIMMED]/[SUMMARIZED]; change: append original; retrieval: ContextRecall
- toolUse transient: existing marker [TRANSIENT-SUMMARY field=.. chars=..]; change: ONLY StrReplace.old_string (no copy in filesystem after replace); retrieval: ContextRecall or Read
- compaction: existing marker [r{n}]; existing contextStore.append; existing ContextRecall

## 6. Enable Fix
Audit and fix injection chain chatViewProvider - chatController - agentLoop - executor so new ContextStore(contextRoot) reaches executor; ensure contextRoot has default. ContextRecall works immediately after.

## 7. Lifecycle (user confirmed)
- Single-session total archive cap: 50MB (configurable)
- thinking original independent cap: 8MB (prevent thinking from dominating)
- Over cap: evict oldest at compaction (keep newest)
- Compaction trigger: 500 chunks or 8MB (decoupled from cap: compact often, evict slowly)

## 8. Error Handling (all fail-open, agent never crashes due to archive)
- flush fail: retry once, then drop + warn
- NDJSON corrupt line: skip
- migration fail: keep old JSON
- compaction fail: skip this round

## 9. Testing
- ContextStore NDJSON read/append/offset-read/migrate/compact/prune/corrupt-recover (pure Node)
- queue debounce merge / batch appendFile count / failure retry
- integration: agentLoop trim, enqueue, flush, ContextRecall fetch full chain
- full vitest + npm run compile regression