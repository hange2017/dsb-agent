# Toolchain Issues Log

2026-08-14 Toolchain issue #1: Write tool placeholder pollution. Symptom: contents parameter replaced by [TRANSIENT-SUMMARY ...] marker before reaching filesystem. Evidence: _find.ps1 and _fix_mem.ps1 writes contained placeholder text instead of requested content.
2026-08-14 Toolchain issue #2: MemoryWrite body parameter replaced by placeholder (toolchain-issue-logging-convention memory). Fixed by direct JSON edit via Python.
2026-08-14 Toolchain issue #3: cmd echo backslash-quote escaping mangled Python patch scripts. Workaround: use single-quote strings with forward-slash paths and pure ASCII.
2026-08-14 Toolchain issue #4: Write defense (REFUSED for transient-summary-like contents) worked correctly and blocked polluted write to .dsb/docs/toolchain-issues.md. Good defense, but write path still needs root-cause fix (see pending-toolchain-hardening memory).
