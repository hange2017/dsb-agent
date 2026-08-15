---
name: context-recall-usage
description: "Use when you see a compacted summary line `- [r{n}] ...` and need the full original text, when a past conclusion or decision feels too vague to rely on, when you need the exact wording of an error or a previous tool output, or when recalling cross-session experience — call ContextRecall(seq=n) for the archived original and ContextRecall(query=...) for cross-session search."
license: MIT (see root LICENSE)
---

<!--
  DSBAgent bundled skill (original, no upstream).
-->

# Context Recall Usage

## Overview

Compacted summaries (`- [r{n}] ...` lines in the `[前文摘要]` block, memory index entries, etc.) are **pointers to archived originals**, not replacements for them. When a summary is used as the basis of a decision, reference, or answer, recall the original via `ContextRecall` first — this prevents paraphrasing drift and hallucinated details.

## When to Use

- You see a `- [r{n}] ...` summary line in the compacted block and need the full context behind it (decision rationale, error stack, tool output fragment).
- A past conclusion or decision in the summary feels too vague to rely on verbatim.
- You need the exact wording of an error message, a command, or a previous tool result.
- You want experience from earlier sessions (use `query` — cross-session search happens automatically when the current session has no hits).
- A memory entry is ambiguous and you need to confirm the original wording before acting on it.

## How to Use

- **By seq (current session only):** `ContextRecall(seq=n)` where `n` comes from the `[r{n}]` marker of the exact line you need. Returns the full original (up to 2000 chars per entry).
- **By query (index + cross-session):** `ContextRecall(query=关键词)` filters the current session index first; if nothing matches, it automatically searches archived sessions (results are prefixed with `[session]`).
- **Locate then fetch:** for unknown seq, call `ContextRecall` without arguments to list the index (≤ 30 summaries), then fetch the specific `seq`.

## Recall Policy

1. **Quote with confidence:** before quoting a historical conclusion, error, or number in a tool call or answer, recall the original and quote it — never paraphrase from the summary.
2. **Resolve conflicts:** when a summary conflicts with a memory entry or current observation, the recalled original (and current filesystem state) wins.
3. **Batch only when needed:** index mode is cheap; use it to locate, then fetch precisely. Avoid repeated full scans.
4. **Unavailable fallback:** if cold storage is disabled, `ContextRecall` returns a fail-open hint — proceed with the summary, noting reduced fidelity.
