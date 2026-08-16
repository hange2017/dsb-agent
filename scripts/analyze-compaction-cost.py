#!/usr/bin/env python3
"""压缩成本分析脚本 — Compaction Cost Analyzer。

统计一段时间内(默认昨天+今天)大模型调用次数、压缩次数,并量化
「压缩后首轮命中率骤降」造成的未命中 token 数量及其占总未命中的比例、
以及按官方单价折算的净额外成本。

口径(与 .dsb/docs/2026-08-10-压缩成本与缓存雪崩分析.md 一致):
  - 大模型调用次数 = provider_round 事件数;compaction_qa 单独列出(输入极小)。
  - 压缩次数 = compaction 事件按 (sessionId, startedAt) 去重(一次上下文压缩会
    顺序产生 block/thinking/tail 等 position 的多条 compaction 事件)。
  - 压缩后第 k 轮 = 某次压缩完成时间之后该 session 的第 k 个 provider_round
    (真实口径;k=1 最差,2/3 展示缓存重建恢复速度,4+ 归稳定期)。
  - 未命中 token = inputTokens;命中 token = cacheReadTokens。
  - 额外未命中 = 压缩首轮未命中 − 稳定期平均每轮未命中 × 首轮数
    (即「若首轮命中率与稳定期相同,本不该多花的未命中」)。
  - 成本单价(元/百万 token):输入 1.0 / 缓存读取 0.02 / 输出 2.0。

用法:
  python3 scripts/analyze-compaction-cost.py
    不传日期时,自动统计「昨天 + 今天」(本地时区 CST)全项目合并。
  python3 scripts/analyze-compaction-cost.py --days 7
    统计最近 N 天(含今天)。
  python3 scripts/analyze-compaction-cost.py --date 2026-08-15 --date 2026-08-16
    统计指定日期(可多次)。默认按本地时区取当天所有 events-*.jsonl。
  python3 scripts/analyze-compaction-cost.py --project 3d1dff85bb2f
    只统计指定 projectKey(默认全项目合并)。
  python3 scripts/analyze-compaction-cost.py --json
    以 JSON 输出结果(便于机器读取/定时任务对账)。

输出:
  - 事件计数:大模型调用 / 压缩(去重) / QA
  - 全部轮命中率;压缩后第 1/2/3 轮命中率(真实口径)
  - 压缩首轮未命中占总未命中比例
  - 额外未命中 token 与净额外成本(元)
"""
import argparse
import glob
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta

# 与成本文档一致的官方单价(元/百万 token)
PRICE_CACHE_READ = 0.02
PRICE_INPUT = 1.0
PRICE_OUTPUT = 2.0

CST = timedelta(hours=8)  # 本地时区(Asia/Shanghai)
STATS_ROOT = os.path.expanduser("~/.dsb/stats")


def load_events(paths):
    """读取 events jsonl,返回事件列表(解析失败的行跳过)。"""
    events = []
    for p in paths:
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return events


def day_paths(day: str, project: str | None):
    """返回某 CST 日期(YYYY-MM-DD)下符合 project 过滤的事件文件路径列表。"""
    pat = os.path.join(STATS_ROOT, project or "*", f"events-{day}.jsonl")
    return [p for p in glob.glob(pat) if os.path.isfile(p)]


def resolve_days(days: int | None, dates: list[str]) -> list[str]:
    """解析 --days / --date 为 CST 日期列表(去重保序)。"""
    if dates:
        return sorted(set(dates))
    today = datetime.now().date()  # 本地时区今天
    n = days or 2
    return [(today - timedelta(days=i)).isoformat() for i in range(n - 1, -1, -1)]


def group_compactions(comp_events):
    """把 compaction 事件按 (sessionId, startedAt) 去重为一次压缩。

    返回 {sessionId: [完成时间 t, ...]}(完成时间 = 组内最大 t)。
    """
    groups = defaultdict(list)
    for e in comp_events:
        d = e.get("data", {})
        key = (d.get("sessionId", "?"), d.get("startedAt", e.get("t", 0)))
        groups[key].append(e)
    by_sess = defaultdict(list)
    for (sid, _), evs in groups.items():
        by_sess[sid].append(max(e.get("t", 0) for e in evs))
    for lst in by_sess.values():
        lst.sort()
    return by_sess


def rounds_by_session(round_events):
    by_sess = defaultdict(list)
    for e in round_events:
        by_sess[e.get("data", {}).get("sessionId", "?")].append(e)
    for lst in by_sess.values():
        lst.sort(key=lambda e: e.get("t", 0))
    return by_sess


def analyze(events, label=""):
    """核心分析。events 为该时间段内全部事件。返回 dict 结果。"""
    rounds = [e for e in events if e.get("type") == "provider_round"]
    comps = [e for e in events if e.get("type") == "compaction"]
    qas = [e for e in events if e.get("type") == "compaction_qa"]

    comp_sessions = group_compactions(comps)
    by_sess = rounds_by_session(rounds)

    def miss(e):
        return e.get("data", {}).get("inputTokens", 0)

    def hit(e):
        return e.get("data", {}).get("cacheReadTokens", 0)

    # 压缩后第 k 轮(k=1,2,3),同一轮只归属一次
    used = set()
    k_rounds = defaultdict(list)
    for sid, ctlist in comp_sessions.items():
        for t_comp in ctlist:
            after = [
                e for e in by_sess.get(sid, [])
                if e.get("t", 0) > t_comp and id(e) not in used
            ]
            for i, e in enumerate(after[:3]):
                if i == 0:
                    used.add(id(e))
                k_rounds[i + 1].append(e)

    total_miss = sum(miss(e) for e in rounds)
    total_hit = sum(hit(e) for e in rounds)
    total_rounds = len(rounds)
    ncomp = sum(len(v) for v in comp_sessions.values())

    k_stats = {}
    for k in sorted(k_rounds):
        kl = k_rounds[k]
        m = sum(miss(e) for e in kl)
        h = sum(hit(e) for e in kl)
        k_stats[k] = {
            "count": len(kl),
            "miss": m,
            "hit": h,
            "hit_rate": (h / (m + h) * 100) if (m + h) else None,
        }

    k1 = k_stats.get(1, {"count": 0, "miss": 0})
    k1_miss = k1["miss"]
    n_k1 = k1["count"]

    # 额外未命中:首轮实际未命中 − 若按稳定期平均每轮未命中
    stable_avg = 0.0
    extra_miss = 0.0
    if total_rounds > n_k1:
        stable_avg = (total_miss - k1_miss) / max(1, total_rounds - n_k1)
        extra_miss = k1_miss - stable_avg * n_k1

    hit_rate_all = (total_hit / (total_miss + total_hit) * 100) if (total_miss + total_hit) else None
    share = (k1_miss / total_miss * 100) if total_miss else None

    return {
        "label": label,
        "rounds": total_rounds,
        "compactions": ncomp,
        "compaction_events": len(comps),
        "qa": len(qas),
        "total_miss": total_miss,
        "total_hit": total_hit,
        "hit_rate_all": hit_rate_all,
        "k": k_stats,
        "k1_miss": k1_miss,
        "k1_share_of_miss": share,
        "stable_avg_miss": stable_avg,
        "extra_miss": extra_miss,
        "cost_total_input": (total_miss * PRICE_INPUT + total_hit * PRICE_CACHE_READ) / 1e6,
        "cost_k1_actual": k1_miss * PRICE_INPUT / 1e6,
        "cost_k1_if_hit": k1_miss * PRICE_CACHE_READ / 1e6,
        "cost_extra": extra_miss * PRICE_INPUT / 1e6,
    }


def format_report(res, verbose=True):
    lines = []
    lines.append(f"=== 压缩成本分析 [{res['label'] or '全项目合并'}] ===")
    lines.append(f"  大模型调用(provider_round): {res['rounds']} 次 | "
                 f"压缩: {res['compactions']} 次(事件 {res['compaction_events']} 条) | "
                 f"QA: {res['qa']} 次")
    if res["hit_rate_all"] is not None:
        lines.append(f"  全部轮: 未命中 {res['total_miss']:,}  命中 {res['total_hit']:,}  "
                     f"命中率 {res['hit_rate_all']:.2f}%")
    for k in sorted(res["k"]):
        ks = res["k"][k]
        if ks["hit_rate"] is None:
            continue
        lines.append(f"  压缩后第{k}轮: {ks['count']} 轮  命中率 {ks['hit_rate']:.1f}%  "
                     f"未命中 {ks['miss']:,}")
    if res["k1_share_of_miss"] is not None:
        lines.append(f"  压缩首轮未命中 {res['k1_miss']:,} / 全部未命中 {res['total_miss']:,} "
                     f"= {res['k1_share_of_miss']:.1f}%")
    lines.append(f"  稳定期均轮未命中 ≈ {res['stable_avg_miss']:,.0f};"
                 f"压缩首轮额外未命中 ≈ {res['extra_miss']:,.0f} token")
    lines.append(f"  成本: 总输入 ≈ {res['cost_total_input']:.2f} 元 | "
                 f"压缩首轮实际 ≈ {res['cost_k1_actual']:.2f} 元(若命中仅 "
                 f"{res['cost_k1_if_hit']:.3f} 元) | 净额外 ≈ {res['cost_extra']:.2f} 元")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="压缩成本分析(调用次数/压缩次数/首轮未命中占比/额外成本)")
    ap.add_argument("--days", type=int, default=None, help="统计最近 N 天(含今天);默认 2(昨天+今天)")
    ap.add_argument("--date", action="append", dest="dates", default=None,
                    help="指定日期 YYYY-MM-DD(可多次);默认昨天+今天")
    ap.add_argument("--project", default=None, help="只统计指定 projectKey(默认全项目合并)")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出")
    ap.add_argument("--by-project", action="store_true", help="除合并外再按项目分别输出")
    args = ap.parse_args()

    days = resolve_days(args.days, args.dates)
    paths = []
    for day in days:
        paths.extend(day_paths(day, args.project))
    if not paths:
        print(f"未找到事件文件: 日期 {days}, project={args.project or '*'}", file=sys.stderr)
        sys.exit(1)

    events = load_events(paths)
    label = ",".join(days)
    res = analyze(events, label=label)

    if args.json:
        out = {"days": days, "project": args.project, **res}
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return

    print(format_report(res))
    if args.by_project:
        by_proj = defaultdict(list)
        for p in paths:
            key = p.split("/stats/")[1].split("/")[0]
            by_proj[key].extend(load_events([p]))
        for key in sorted(by_proj, key=lambda k: -len(by_proj[k])):
            evs = by_proj[key]
            if not any(e.get("type") == "provider_round" for e in evs):
                continue
            print()
            print(format_report(analyze(evs, label=f"[{key}]")))


if __name__ == "__main__":
    main()
