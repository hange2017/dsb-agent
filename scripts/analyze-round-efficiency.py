#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按「日 × 项目」统计 agent 运行效率与压缩质量(用于预算/压缩策略的前后对比)。

用法:
  py scripts/analyze-round-efficiency.py                      # 全部项目、全部日期
  py scripts/analyze-round-efficiency.py --project e-dsb      # 只看某项目
  py scripts/analyze-round-efficiency.py --dates 2026-09-15 2026-09-19 --project e-dsb
  py scripts/analyze-round-efficiency.py --config             # 只打印配置变更时间线

统计口径(与 scripts/analyze-cache-prefix.py 保持一致的字段来源):
  * provider_round{phase:"chat"}  = 一次「agent ↔ 大模型」的对话轮(压缩/QA 轮不计入分母)
  * 命中率 = cacheReadTokens / (cacheReadTokens + inputTokens)   ← 与 turn_summary.cacheHitRate 同口径
  * 压缩次数 = 去重后的 (sessionId, startedAt) 数(一次压缩可能落多条事件)
  * 压缩后第 k 轮 = 该会话内,距最近一次压缩已发生过的 chat 轮序号
"""

import argparse
import collections
import glob
import json
import os
import statistics
import sys
import time

STATS_ROOT = os.path.expanduser("~/.dsb/stats")


def load(payload):
    """返回 (events, groups) —— groups: (project, date) -> [event, ...]"""
    events = []
    groups = collections.defaultdict(list)
    for path in payload:
        project = os.path.basename(os.path.dirname(path))
        date = os.path.basename(path).replace("events-", "").replace(".jsonl", "")
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            e["_project"] = project
            e["_date"] = date
            e["_file"] = path
            events.append(e)
            groups[(project, date)].append(e)
    return events, groups


def pct(a, b):
    return (a / b * 100) if b else 0.0


def med(xs):
    return statistics.median(xs) if xs else 0


def fmt_hhmm(ts_ms):
    return time.strftime("%m-%d %H:%M", time.localtime(ts_ms / 1000))


def hhmm(ts_ms):
    return time.strftime("%H:%M", time.localtime(ts_ms / 1000))


def group_metrics(evs):
    """单个 (project,date) 分组的核心指标。"""
    rounds = [e for e in evs if e.get("type") == "provider_round"]
    chat = [e for e in rounds if e.get("data", {}).get("phase", "chat") == "chat"]
    other = [e for e in rounds if e.get("data", {}).get("phase", "chat") != "chat"]
    comps_raw = [e for e in evs if e.get("type") == "compaction"]
    comps = {}
    for e in comps_raw:
        d = e["data"]
        comps[(d.get("sessionId"), d.get("startedAt") or e.get("t"))] = e
    comp_list = sorted(comps.values(), key=lambda e: e.get("t", 0))
    qas = [e for e in evs if e.get("type") == "compaction_qa"]
    recalls = [e for e in evs if e.get("type") == "context_recall"]
    sends = [e for e in evs if e.get("type") == "message_sent"]
    turns = [e for e in evs if e.get("type") == "turn_summary"]
    repeats = [e for e in evs if e.get("type") == "tool_repeat"]

    hit = sum(e["data"].get("cacheReadTokens", 0) for e in chat)
    miss = sum(e["data"].get("inputTokens", 0) for e in chat)
    out = sum(e["data"].get("outputTokens", 0) for e in chat)
    n = len(chat)

    # 压缩后第 k 轮恢复曲线
    by_sess = collections.defaultdict(list)
    for e in chat:
        by_sess[e["data"].get("sessionId")].append(e)
    comp_times = collections.defaultdict(list)
    for c in comp_list:
        comp_times[c["data"].get("sessionId")].append(c["data"].get("startedAt") or c.get("t"))
    buckets = collections.defaultdict(lambda: {"n": 0, "hit": 0, "miss": 0})
    avalanche = 0
    for sid, rs in by_sess.items():
        rs.sort(key=lambda e: e.get("t", 0))
        cs = sorted(comp_times.get(sid, []))
        if not cs:
            for r in rs:
                b = buckets["无压缩轮"]
                b["n"] += 1
                b["hit"] += r["data"].get("cacheReadTokens", 0)
                b["miss"] += r["data"].get("inputTokens", 0)
            continue
        for r in rs:
            prev = [c for c in cs if c <= r.get("t", 0)]
            if not prev:
                key = "压缩前轮"
            else:
                k = sum(1 for x in rs if prev[-1] <= x.get("t", 0) <= r.get("t", 0))
                key = f"压缩后第{k}轮" if k <= 3 else "其余轮(稳定期,4+)"
            b = buckets[key]
            b["n"] += 1
            b["hit"] += r["data"].get("cacheReadTokens", 0)
            b["miss"] += r["data"].get("inputTokens", 0)
        for ct in cs:
            first = next((r for r in rs if r.get("t", 0) >= ct), None)
            if first:
                h, m = first["data"].get("cacheReadTokens", 0), first["data"].get("inputTokens", 0)
                if h + m > 0 and h / (h + m) < 0.2:
                    avalanche += 1

    budgets = collections.Counter()
    for c in comp_list:
        b = c["data"].get("budget") or {}
        budgets[(b.get("total"), b.get("compacted"), b.get("thinking"), b.get("tail"))] += 1

    return {
        "chat_rounds": n,
        "other_rounds": len(other),
        "rounds": len(rounds),
        "sessions": len(by_sess),
        "sends": len(sends),
        "turns": len(turns),
        "hit": hit, "miss": miss, "out": out,
        "hit_rate": pct(hit, hit + miss),
        "in_per_round": (hit + miss) / n if n else 0,
        "miss_per_round": miss / n if n else 0,
        "out_per_round": out / n if n else 0,
        "total_per_round": (hit + miss + out) / n if n else 0,
        "rounds_per_send": n / len(sends) if sends else 0,
        "compactions": len(comp_list),
        "comp_events": len(comps_raw),
        "rounds_per_comp": n / len(comp_list) if comp_list else 0,
        "comp_before_med": med([c["data"].get("beforeTokens", 0) for c in comp_list]),
        "comp_after_med": med([c["data"].get("afterTokens", 0) for c in comp_list]),
        "comp_llm_calls": sum(c["data"].get("llmCalls", 0) for c in comp_list),
        "comp_positions": collections.Counter(c["data"].get("position") for c in comp_list),
        "comp_reasons": collections.Counter(c["data"].get("reason") for c in comp_list),
        "budgets": budgets,
        "buckets": dict(buckets),
        "avalanche": avalanche,
        "qa_n": len(qas),
        "qa_answerable": sum(1 for e in qas if e["data"].get("answerable")),
        "qa_in": sum(e["data"].get("qaInputTokens", 0) for e in qas),
        "qa_out": sum(e["data"].get("qaOutputTokens", 0) for e in qas),
        "recalls": len(recalls),
        "repeats": len(repeats),
        "first_t": min((e.get("t", 0) for e in evs), default=0),
        "last_t": max((e.get("t", 0) for e in evs), default=0),
    }


def print_group(key, m):
    project, date = key
    print(f"\n### {project} / {date}   ({fmt_hhmm(m['first_t'])} → {hhmm(m['last_t'])})")
    print(f"  会话 {m['sessions']} | 用户发送 {m['sends']} | chat 轮 {m['chat_rounds']} "
          f"(压缩/QA 等其它轮 {m['other_rounds']}) | 轮/发送 {m['rounds_per_send']:.1f}")
    print(f"  每轮输入 {m['in_per_round']:,.0f}(未命中 {m['miss_per_round']:,.0f} + 命中 "
          f"{m['in_per_round'] - m['miss_per_round']:,.0f}) | 每轮输出 {m['out_per_round']:,.0f} | "
          f"每轮合计 {m['total_per_round']:,.0f}")
    print(f"  整体命中率 {m['hit_rate']:.1f}%  (命中 {m['hit']:,} / 未命中 {m['miss']:,})")
    print(f"  压缩 {m['compactions']} 次(事件 {m['comp_events']} 条)| 每 {m['rounds_per_comp']:.1f} 轮压缩一次 "
          f"| 压缩块 {m['comp_before_med']:,.0f} → {m['comp_after_med']:,.0f} tok | 压缩内 LLM 调用 {m['comp_llm_calls']}")
    print(f"  压缩位置 {dict(m['comp_positions'])} 原因 {dict(m['comp_reasons'])}")
    print(f"  预算快照 {dict(m['budgets'])}")
    order = ["压缩前轮", "压缩后第1轮", "压缩后第2轮", "压缩后第3轮", "其余轮(稳定期,4+)", "无压缩轮"]
    print("  命中率分组:")
    for name in order:
        b = m["buckets"].get(name)
        if not b:
            continue
        print(f"    {name:<18} [{b['n']:>4} 轮] 命中率 {pct(b['hit'], b['hit'] + b['miss']):5.1f}%")
    print(f"  雪崩首轮(<20%): {m['avalanche']} 次")
    print(f"  压缩后抽查 QA {m['qa_n']} 次 | 可答 {m['qa_answerable']} "
          f"({pct(m['qa_answerable'], m['qa_n']):.1f}%) | QA 开销 {m['qa_in']:,}+{m['qa_out']:,} tok")
    print(f"  回查 ContextRecall {m['recalls']} 次(每百轮 {pct(m['recalls'], m['chat_rounds']):.1f})"
          f" | 重复工具调用 {m['repeats']} 次 | 大任务档案 {m['turns']} 条")


def config_timeline(groups):
    print("=== 配置变更时间线(settings_change) ===")
    for key in sorted(groups):
        for e in sorted(groups[key], key=lambda e: e.get("t", 0)):
            if e.get("type") != "settings_change":
                continue
            d = e["data"]
            print(f"{fmt_hhmm(e['t'])}  [{key[0]}/{key[1]}] scope={d.get('scope')} "
                  f"changed={d.get('changed')}")
            if d.get("scope") == "budget":
                print(f"            before={json.dumps(d.get('before'), ensure_ascii=False)}")
                print(f"            after ={json.dumps(d.get('after'), ensure_ascii=False)}")
    print("\n=== 压缩时实际生效的预算快照(budget.total / split) ===")
    seen = collections.defaultdict(list)
    for key in sorted(groups):
        for e in groups[key]:
            if e.get("type") == "compaction":
                b = e["data"].get("budget") or {}
                tot = b.get("total")
                split = (b.get("compacted"), b.get("thinking"), b.get("tail"))
                seen[(key[0], key[1], tot, split)].append(e.get("t", 0))
    for (proj, date, tot, split), ts in sorted(seen.items(), key=lambda kv: min(kv[1])):
        print(f"{fmt_hhmm(min(ts))}  [{proj}/{date}] budget.total={tot} "
              f"(压缩块={split[0]} 思考={split[1]} tail={split[2]}) 次数={len(ts)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", action="append", default=[])
    ap.add_argument("--dates", action="append", default=[])
    ap.add_argument("--config", action="store_true", help="只打印配置时间线")
    ap.add_argument("--files", action="append", default=[])
    args = ap.parse_args()

    paths = args.files or sorted(glob.glob(os.path.join(STATS_ROOT, "*", "events-*.jsonl")))
    if args.project:
        paths = [p for p in paths if os.path.basename(os.path.dirname(p)) in args.project]
    if args.dates:
        paths = [p for p in paths if os.path.basename(p).replace("events-", "").replace(".jsonl", "") in args.dates]
    if not paths:
        print("未找到 stats 事件文件。")
        return 1
    _, groups = load(paths)
    print(f"文件 {len(paths)} 个:" + ", ".join(sorted(os.path.basename(p) for p in paths)))
    config_timeline(groups)
    if args.config:
        return 0
    print("\n=== 逐日分组指标 ===")
    for key in sorted(groups):
        print_group(key, group_metrics(groups[key]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
