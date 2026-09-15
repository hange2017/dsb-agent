#!/usr/bin/env python3
"""重复工作分析脚本 — Duplicate Work Analyzer。

回答一个问题:**工具输出被裁剪/压缩后,agent 是否在重复做同一件事?多花了多少?**

口径:
  - 数据源(只读,不改产品逻辑):
      1. 会话事件流  <globalStorage>/sessions/<projectKey>/s-*.jsonl
         完整工具调用:name / input / status / detail / timestamp
      2. 统计事件流  ~/.dsb/stats/<projectKey>/events-*.jsonl
         provider_round / compaction / context_recall
  - 「同参数重复调用」= 同一会话内,同一 (工具, 规范化参数) 再次出现。
    Bash 按命令字符串规范化(折叠空白);Read 精确到 (path, offset, limit),
    避免把「分段落读同一文件」误判成重复。
  - 「浪费型重复」= 重复且间隔 < --gap 秒(默认 300)。同任务内的重现更可能
    是「看不到内容 → 重新读」,而非跨会话的正常复查。
  - 冗余 token 估算:按重复调用上一次的 detail 文本粗估(CJK 1.5 字符/token,
    其余 4 字符/token);仅供量级参考,非精确计费。
  - 压缩因果:比较「压缩事件后 N 轮内」与「稳定期」的重复率,用于判断重复
    是否由压缩导致(而非 agent 本身啰嗦)。

用法:
  python3 scripts/analyze-duplicate-work.py
    自动扫描上表两个数据源(全项目合并)。
  python3 scripts/analyze-duplicate-work.py --gap 1800
    重复判定窗口改为 30 分钟。
  python3 scripts/analyze-duplicate-work.py --sessions-dir <dir>
    指定会话事件流根目录(默认自动探测 VS Code 与 Cursor 的 globalStorage)。
  python3 scripts/analyze-duplicate-work.py --stats-dir <dir>
    指定统计事件流根目录(默认 ~/.dsb/stats)。
  python3 scripts/analyze-duplicate-work.py --top 20
    榜单条数(默认 15)。
  python3 scripts/analyze-duplicate-work.py --json
    JSON 输出(便于对账/定时任务)。
  python3 scripts/analyze-duplicate-work.py --self-test
    内建合成数据自检:验证规范化/重复判定/分桶/因果归组算法。

输出:
  - 总览:工具调用数、重复数、浪费型重复数、重复率
  - 重复榜 TOP N(定位浪费在哪个文件)
  - 按工具分布 + 按时间间隔分桶
  - 冗余 token 估算
  - 压缩因果对比(压缩后窗口内 vs 稳定期)
  - ContextRecall 频次(信息丢失的直接计分板)
"""
import argparse
import glob
import json
import os
import sys
from collections import Counter, defaultdict

# 只读工具:重复调用不改变工作区状态,是「白读」信号
READONLY_TOOLS = {"Read", "Grep", "Glob", "LS", "ListDir", "Search", "MemoryRead", "MemoryList"}
# 写工具:其出现会重置「白读」判定(改完再看属于合理复查)
WRITE_TOOLS = {"Write", "StrReplace", "Edit", "Delete", "NotebookEdit", "Bash"}

GAP_BUCKETS = [(0, 60, "<1min"), (60, 300, "1-5min"), (300, 1800, "5-30min"),
               (1800, 7200, "30min-2h"), (7200, 10 ** 9, ">2h")]


def norm_input(name, inp):
    """把工具参数规范化成可比对的键。"""
    inp = inp or {}
    if name == "Read":
        return (name, str(inp.get("path", "")), inp.get("offset", 0), inp.get("limit", 0))
    if name == "Grep":
        return (name, str(inp.get("pattern", "")), str(inp.get("path", "")), str(inp.get("glob", "")))
    if name in ("Glob", "LS", "ListDir"):
        return (name, str(inp.get("pattern") or inp.get("path") or ""))
    if name == "Bash":
        return (name, " ".join(str(inp.get("command", "")).split()))
    return (name, json.dumps(inp, sort_keys=True, ensure_ascii=False))


def est_tokens(text):
    """粗估 token:CJK 1.5 字符/token,其余 4 字符/token。"""
    if not text:
        return 0
    cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    return int(cjk / 1.5 + (len(text) - cjk) / 4)


def load_tool_events(path):
    """读取单个会话 jsonl,返回 kind=tool 的事件列表。"""
    out = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if d.get("kind") == "tool":
                out.append(d)
    return out


def find_session_files(root):
    return sorted(glob.glob(os.path.join(root, "*", "*.jsonl")))


def discover_sessions_dirs():
    """自动探测 VS Code / Cursor 的扩展 globalStorage sessions 目录。"""
    cands = []
    for base in ("Code", "Cursor", "Code - OSS", "VSCodium"):
        for extra in ("User",):
            pat = os.path.expanduser(
                f"~/.config/{base}/{extra}/globalStorage/*dsb*/sessions")
            cands.extend(glob.glob(pat))
    return sorted(set(c for c in cands if os.path.isdir(c)))


def analyze_sessions(files, gap_seconds):
    """统计同参数重复调用。返回结构化结果。"""
    tot = Counter()
    dup_short = Counter()      # 短间隔重复(浪费型)
    dup_detail = Counter()     # (tool, key) -> 次数
    bucket = defaultdict(Counter)
    waste_tokens = 0
    wasted_by_tool = Counter()
    n_tool = 0
    n_dup = 0
    n_waste = 0
    waste_events = []          # (gap_s, tool, desc)

    for f in files:
        events = load_tool_events(f)
        if not events:
            continue
        last = {}   # key -> (ts, had_write_after)
        for d in events:
            name = d.get("name", "")
            ts = d.get("timestamp", 0)
            key = norm_input(name, d.get("input"))
            n_tool += 1
            tot[name] += 1
            prev = last.get(key)
            if prev:
                dt = (ts - prev[0]) / 1000.0
                for lo, hi, label in GAP_BUCKETS:
                    if lo <= dt < hi:
                        bucket[name][label] += 1
                        break
                n_dup += 1
                if dt < gap_seconds:
                    n_waste += 1
                    dup_short[name] += 1
                    dup_detail[(name, key)] += 1
                    t = est_tokens(str(prev[2]))
                    waste_tokens += t
                    wasted_by_tool[name] += t
                    waste_events.append((dt, name, describe(name, key)))
            # 记录/更新:写工具出现后,所有只读键标记「其后有写」
            if name in WRITE_TOOLS:
                for k in list(last.keys()):
                    last[k] = (last[k][0], True, last[k][2])
            last[key] = (ts, False, d.get("detail"))
    return {
        "tool_total": n_tool,
        "dup_total": n_dup,
        "waste_total": n_waste,
        "waste_tokens": waste_tokens,
        "by_tool": tot,
        "waste_by_tool": dup_short,
        "wasted_tokens_by_tool": wasted_by_tool,
        "buckets": bucket,
        "top": dup_detail.most_common(200),
        "top_events": sorted(waste_events, key=lambda r: -r[0]),
    }


def describe(name, key):
    return " | ".join(str(x) for x in key[1:])[:90]


def load_stats_events(stats_dir):
    """读取 ~/.dsb/stats/*/events-*.jsonl,按 type 归组。"""
    groups = defaultdict(list)
    for p in sorted(glob.glob(os.path.join(stats_dir, "*", "events-*.jsonl"))):
        with open(p, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                t = d.get("type")
                if t:
                    groups[t].append(d)
    return groups


def analyze_compaction_causality(files, comps, window_rounds=3):
    """压缩因果:比较「压缩后 window 轮内」与其余时间的重复率。

    简化口径:以压缩时间戳为界,把工具调用分成「压缩后 5 分钟内」与「其余」,
    比较两组的重复率。若压缩后显著更高 → 重复更可能由压缩/裁剪导致。
    """
    comp_ts = sorted(c.get("t", 0) for c in comps if c.get("t"))
    if not comp_ts:
        return None
    WINDOW_MS = 5 * 60 * 1000
    near_tot = near_dup = far_tot = far_dup = 0
    for f in files:
        events = load_tool_events(f)
        last = {}
        for d in events:
            name = d.get("name", "")
            ts = d.get("timestamp", 0)
            key = norm_input(name, d.get("input"))
            # 二分定位是否在某次压缩后 5 分钟内
            near = False
            lo, hi = 0, len(comp_ts) - 1
            while lo <= hi:
                mid = (lo + hi) // 2
                if comp_ts[mid] <= ts:
                    if ts - comp_ts[mid] <= WINDOW_MS:
                        near = True
                    lo = mid + 1
                else:
                    hi = mid - 1
            is_dup = key in last
            if near:
                near_tot += 1
                near_dup += 1 if is_dup else 0
            else:
                far_tot += 1
                far_dup += 1 if is_dup else 0
            last[key] = ts
    return {
        "near_total": near_tot, "near_dup": near_dup,
        "far_total": far_tot, "far_dup": far_dup,
    }


def self_test():
    """内建合成数据自检:验证规范化/重复判定/分桶/因果算法。"""
    cases = []

    # 1. Read 规范化:同文件不同 offset 不算重复
    k1 = norm_input("Read", {"path": "a.h", "offset": 0, "limit": 0})
    k2 = norm_input("Read", {"path": "a.h", "offset": 100, "limit": 50})
    cases.append(("Read 不同 offset 不同键", k1 != k2))
    cases.append(("Read 同参同键", k1 == norm_input("Read", {"path": "a.h"})))

    # 2. Bash 空白折叠
    b1 = norm_input("Bash", {"command": "git  diff   x"})
    b2 = norm_input("Bash", {"command": "git diff x"})
    cases.append(("Bash 折叠空白", b1 == b2))
    cases.append(("Bash 不同命令不同键",
                  b1 != norm_input("Bash", {"command": "git status"})))

    # 3. token 估算:CJK 与 ASCII
    cases.append(("ASCII 4 字符/token", est_tokens("abcd" * 25) == 25))
    cases.append(("CJK 1.5 字符/token", est_tokens("中" * 15) == 10))
    cases.append(("空串 0 token", est_tokens("") == 0))
    cases.append(("CJK 高于同长度 ASCII", est_tokens("中" * 100) > est_tokens("a" * 100)))

    # 4. 重复判定 + 分桶:构造临时会话
    import tempfile
    tmp = tempfile.mkdtemp()
    p = os.path.join(tmp, "s.jsonl")
    with open(p, "w", encoding="utf-8") as f:
        f.write(json.dumps({"kind": "tool", "name": "Read",
                            "input": {"path": "a.h"}, "timestamp": 1000,
                            "detail": "x" * 400}) + "\n")
        f.write(json.dumps({"kind": "tool", "name": "Read",
                            "input": {"path": "a.h"}, "timestamp": 1030 * 1000,
                            "detail": "x" * 400}) + "\n")
        f.write(json.dumps({"kind": "tool", "name": "Read",
                            "input": {"path": "a.h"}, "timestamp": 1030 * 1000 + 120 * 1000,
                            "detail": "x" * 400}) + "\n")
        f.write(json.dumps({"kind": "tool", "name": "Grep",
                            "input": {"pattern": "z"}, "timestamp": 1030 * 1000 + 600 * 1000,
                            "detail": "y" * 40}) + "\n")
    r = analyze_sessions([p], gap_seconds=300)
    cases.append(("工具调用计数", r["tool_total"] == 4))
    cases.append(("重复计数=2(3 次 Read 中 2 次重复)", r["dup_total"] == 2))
    # 第 2 次间隔 1029s(超窗不计),第 3 次间隔 120s(计浪费 1 次)
    cases.append(("超窗不计浪费、窗内计 1 次", r["waste_total"] == 1))
    # 第 2 次间隔 1029s -> 5-30min;第 3 次间隔 500s -> 1-5min
    cases.append(("分桶:5-30min(1029s)", r["buckets"]["Read"]["5-30min"] == 1))
    cases.append(("分桶:1-5min(500s)", r["buckets"]["Read"]["1-5min"] == 1))
    cases.append(("Grep 不重复", r["waste_by_tool"]["Grep"] == 0))

    # 短间隔重复
    with open(p, "w", encoding="utf-8") as f:
        for i in range(3):
            f.write(json.dumps({"kind": "tool", "name": "Read",
                                "input": {"path": "b.h"}, "timestamp": 1000 + i * 1000,
                                "detail": "z" * 400}) + "\n")
    r2 = analyze_sessions([p], gap_seconds=300)
    cases.append(("短间隔重复计入浪费", r2["waste_total"] == 2))
    cases.append(("冗余 token > 0", r2["waste_tokens"] > 0))

    # 5. 写工具重置:Read → StrReplace → Read 仍算重复(键重现),但语义上是复查
    with open(p, "w", encoding="utf-8") as f:
        f.write(json.dumps({"kind": "tool", "name": "Read",
                            "input": {"path": "c.h"}, "timestamp": 1000,
                            "detail": "a"}) + "\n")
        f.write(json.dumps({"kind": "tool", "name": "StrReplace",
                            "input": {"path": "c.h", "old_string": "a", "new_string": "b"},
                            "timestamp": 2000, "detail": "ok"}) + "\n")
        f.write(json.dumps({"kind": "tool", "name": "Read",
                            "input": {"path": "c.h"}, "timestamp": 2500,
                            "detail": "b"}) + "\n")
    r3 = analyze_sessions([p], gap_seconds=300)
    cases.append(("写后重读仍计重复(键重现)", r3["dup_total"] == 1))

    # 6. 因果归组:压缩后窗口内 vs 之外
    comps = [{"t": 10000}]
    with open(p, "w", encoding="utf-8") as f:
        f.write(json.dumps({"kind": "tool", "name": "Read",
                            "input": {"path": "d.h"}, "timestamp": 5000,
                            "detail": "q"}) + "\n")
        f.write(json.dumps({"kind": "tool", "name": "Read",
                            "input": {"path": "d.h"}, "timestamp": 6000,
                            "detail": "q"}) + "\n")   # 压缩前重复 -> far
    # 压缩后(10000)窗口内重复
    with open(p, "w", encoding="utf-8") as f:
        f.write(json.dumps({"kind": "tool", "name": "Read",
                            "input": {"path": "e.h"}, "timestamp": 5000, "detail": "q"}) + "\n")
        f.write(json.dumps({"kind": "tool", "name": "Read",
                            "input": {"path": "e.h"}, "timestamp": 11000, "detail": "q"}) + "\n")
    # near e.h 首次在 5000(far),第二次 11000(near) -> near 有 1 次 dup, far 1 次
    cc = analyze_compaction_causality([p], comps)
    cases.append(("因果:near 统计到压缩后调用", cc["near_total"] == 1))
    cases.append(("因果:far 统计到压缩前调用", cc["far_total"] == 1))
    cases.append(("因果:near_dup 正确", cc["near_dup"] == 1))

    # 7. 无压缩事件时返回 None
    cases.append(("无压缩返回 None", analyze_compaction_causality([p], []) is None))

    failed = [n for n, ok in cases if not ok]
    for n, ok in cases:
        print(f"  [{'OK' if ok else 'FAIL'}] {n}")
    if failed:
        print(f"self-test FAILED: {failed}")
        return 1
    print("self-test OK")
    return 0


def build_report(args):
    """采集并分析,返回结构化报告 dict。"""
    if args.sessions_dir:
        roots = [args.sessions_dir]
    else:
        roots = discover_sessions_dirs()
    files = []
    for r in roots:
        files.extend(find_session_files(r))
    stats_dir = args.stats_dir or os.path.expanduser("~/.dsb/stats")
    stats = load_stats_events(stats_dir)

    sess = analyze_sessions(files, args.gap)
    comps = stats.get("compaction", [])
    causality = analyze_compaction_causality(files, comps)
    recalls = stats.get("context_recall", [])
    rounds = stats.get("provider_round", [])

    recall_modes = Counter((r.get("data") or {}).get("mode", "?") for r in recalls)
    empty_recall = sum(1 for r in recalls if (r.get("data") or {}).get("results", 0) == 0)

    return {
        "files": files,
        "session": sess,
        "compaction_count": len(comps),
        "round_count": len(rounds),
        "recall_count": len(recalls),
        "recall_empty": empty_recall,
        "recall_modes": dict(recall_modes),
        "causality": causality,
    }


def print_report(rep, top_n):
    s = rep["session"]
    tot = s["tool_total"]
    print("=" * 78)
    print("DSBAgent 重复工作分析 (只读;数据源 = 会话事件流 + ~/.dsb/stats 统计事件流)")
    print("=" * 78)
    print(f"会话文件: {len(rep['files'])}   工具调用: {tot:,}   LLM 轮次: {rep['round_count']:,}")

    # ---- 总览 ----
    print("\n=== 总览 ===")
    print(f"  同参数重复调用      : {s['dup_total']:>6,}  ({s['dup_total'] / max(tot, 1) * 100:.2f}%)")
    print(f"  其中「浪费型」(<{int(rep['_gap'])}s 内): {s['waste_total']:>6,}  ({s['waste_total'] / max(tot, 1) * 100:.2f}%)")
    print(f"  冗余 token(估算)   : {s['waste_tokens']:>6,}")
    roi = sum(r.get("detail") or "" for r in [])  # 占位:保持字段语义清晰
    del roi
    est_cost = s["waste_tokens"] / 1_000_000 * args_price()
    print(f"  折算输入成本(约)    : {est_cost:>6.2f} 元 (按 {args_price()} 元/百万 token)")

    # ---- 榜单 ----
    print(f"\n=== 重复榜 TOP {top_n}(按浪费次数) ===")
    if not s["top"]:
        print("  (无重复调用)")
    for (name, key), cnt in s["top"][:top_n]:
        print(f"  {cnt:>4}x  {name:<9} {describe(name, key)}")

    # ---- 按工具 ----
    print("\n=== 按工具分布 ===")
    print(f"  {'工具':<12}{'调用':>8}{'重复':>8}{'浪费':>8}{'冗余tok':>10}")
    for name, c in s["by_tool"].most_common(12):
        print(f"  {name:<12}{c:>8}{s['buckets'][name] and sum(s['buckets'][name].values()) or 0:>8}"
              f"{s['waste_by_tool'][name]:>8}{s['wasted_tokens_by_tool'][name]:>10,}")

    # ---- 时间分桶 ----
    print("\n=== 重复按时间间隔分桶 ===")
    labels = [b[2] for b in GAP_BUCKETS]
    print(f"  {'工具':<12}" + "".join(f"{l:>10}" for l in labels))
    for name, c in s["by_tool"].most_common(10):
        row = s["buckets"].get(name) or {}
        if not row:
            continue
        print(f"  {name:<12}" + "".join(f"{row.get(l, 0):>10}" for l in labels))

    # ---- 压缩因果 ----
    print("\n=== 压缩因果(压缩后 5min 内 vs 其余时间的重复率) ===")
    cc = rep["causality"]
    print(f"  压缩事件数: {rep['compaction_count']:,}")
    if cc:
        nr = cc["near_dup"] / max(cc["near_total"], 1) * 100
        fr = cc["far_dup"] / max(cc["far_total"], 1) * 100
        print(f"  压缩后窗口内: {cc['near_dup']:>5} / {cc['near_total']:>6} = {nr:5.2f}%")
        print(f"  其余时间    : {cc['far_dup']:>5} / {cc['far_total']:>6} = {fr:5.2f}%")
        if fr > 0:
            print(f"  抬升倍数    : {nr / fr:.2f}x  "
                  f"({'压缩后重复更集中' if nr > fr else '未见明显抬升'})")
    else:
        print("  (无压缩事件,跳过)")

    # ---- ContextRecall ----
    print("\n=== ContextRecall(agent 主动回查被压缩原文 = 信息丢失计分板) ===")
    print(f"  调用次数: {rep['recall_count']:,}   其中空结果: {rep['recall_empty']:,}")
    if rep["recall_modes"]:
        for k, v in sorted(rep["recall_modes"].items(), key=lambda kv: -kv[1]):
            print(f"    {v:>5}  mode={k}")

    # ---- 结论 ----
    print("\n=== 判读 ===")
    rate = s["waste_total"] / max(tot, 1) * 100
    if rate < 1:
        print("  浪费型重复占比 <1%:裁剪/压缩造成的返工不显著,无需调整策略。")
    elif rate < 5:
        print("  浪费型重复占比 1~5%:存在局部返工,建议按榜单定位高重复文件。")
    else:
        print("  浪费型重复占比 >5%:返工显著,建议优先核查被反复重读的文件类型。")
    print()


def args_price():
    return PRICE_INPUT


PRICE_INPUT = 1.0


def main():
    ap = argparse.ArgumentParser(
        description="重复工作分析:量化工具输出被裁剪/压缩后 agent 的返工消耗(只读)")
    ap.add_argument("--sessions-dir", help="会话事件流根目录(默认自动探测 VS Code/Cursor)")
    ap.add_argument("--stats-dir", help="统计事件流根目录(默认 ~/.dsb/stats)")
    ap.add_argument("--gap", type=int, default=300, help="浪费型重复的时间窗口秒数(默认 300)")
    ap.add_argument("--top", type=int, default=15, help="榜单条数(默认 15)")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出")
    ap.add_argument("--self-test", action="store_true", help="内建自检")
    args = ap.parse_args()

    if args.self_test:
        return self_test()

    rep = build_report(args)
    rep["_gap"] = args.gap
    if args.json:
        out = {
            "files": len(rep["files"]),
            "tool_total": rep["session"]["tool_total"],
            "dup_total": rep["session"]["dup_total"],
            "waste_total": rep["session"]["waste_total"],
            "waste_tokens": rep["session"]["waste_tokens"],
            "compaction_count": rep["compaction_count"],
            "round_count": rep["round_count"],
            "recall_count": rep["recall_count"],
            "recall_empty": rep["recall_empty"],
            "causality": rep["causality"],
            "top": [{"tool": n, "key": describe(n, k), "count": c}
                    for (n, k), c in rep["session"]["top"][:args.top]],
        }
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0
    print_report(rep, args.top)
    return 0


if __name__ == "__main__":
    sys.exit(main())
