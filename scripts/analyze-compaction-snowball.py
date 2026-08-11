#!/usr/bin/env python3
"""压缩雪崩分析脚本 — Compaction Snowball Analyzer。

统计压缩(compaction)前后缓存命中率骤降(雪崩);同时可作为 P2「压缩块 append-only
只增尾部」修复后的前/后对照基线。

原理:
  缓存前缀稳定性优化清单(见 .dsb/docs/2026-08-11-…优化清单.md)的核心痛点:
  「压缩块重建 = 整块重写 → 压缩后首轮前缀断裂 → 命中率骤降(雪崩)」。
  本脚本以「压缩前稳定轮 vs 压缩后首轮」的命中率差来量化雪崩程度:

  1. 收集全部 `compaction` 事件,按时间把相邻(<60s)的若干次合并为一个「压缩批次」。
     (一次上下文压缩会顺序触发多个 position 的 compaction 事件:block/thinking/
      thinking_block/tail。)
  2. 对每个批次,取「批次结束后第一条 phase=chat 且带 cacheReadTokens 的
     provider_round」作为压缩后首轮;它的前一条作为压缩前稳定轮。
  3. 命中率 = cacheReadTokens / (inputTokens + cacheReadTokens)。
  4. 压缩后首轮与压缩前稳定轮的命中率差(负值)即雪崩幅度。

输出:
  - 命中批次总数、雪崩幅度均值/中位数、压缩后首轮命中率<20% 的批次占比
  - 每次压缩的明细(时间/压缩前命中率/压缩后命中率/骤降)
  - cacheRead 累计骤减的 token 数,并按单价折算雪崩成本(元)
  - P2 修复前后对照建议:同一脚本在修复后重跑即可对比。

用法:
  python3 scripts/analyze-compaction-snowball.py [events.jsonl...]
  不传文件时,自动扫描 ~/.dsb/stats/*/ 当天所有 events-*.jsonl(统计口径:全项目合并)。

  --start HH:MM   只分析指定时间之后的事件(如 --start 12:00)
  --compact-gap   相邻 compaction 合并为同批次的间隔阈值 ms(默认 60000)
  --no-recon      关闭与真实 usage 的对账段
  --json          以 JSON 输出结果(便于机器读取/前后对比)
"""
import json
import glob
import os
import sys
from collections import defaultdict
from datetime import date, datetime

# 与成本文档一致的官方单价(元/百万 token)
PRICE_CACHE_READ = 0.02
PRICE_INPUT = 1.0
PRICE_OUTPUT = 2.0

COMPACT_GAP_MS = 60000  # 相邻 compaction 间隔小于该值视为同一批次
SNOWBALL_THRESHOLD = 0.20  # 压缩后首轮命中率低于该值视为「雪崩批次」


def load_events(paths):
    events = []
    for p in paths:
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                events.append(ev)
    return events


def default_paths():
    today = date.today().strftime("%Y-%m-%d")
    return sorted(glob.glob(os.path.expanduser(f"~/.dsb/stats/*/events-{today}.jsonl")))


def hit_rate(d):
    cr = d.get("cacheReadTokens") or 0
    it = d.get("inputTokens") or 0
    return cr / (cr + it) if (cr + it) > 0 else 0.0


def ts_str(t):
    return datetime.fromtimestamp(t / 1000).strftime("%H:%M:%S")


def group_compactions(comp_events, gap_ms):
    """把相邻(间隔 < gap_ms)的 compaction 事件合并成批次。"""
    comp_events = sorted(comp_events, key=lambda e: e.get("t", 0))
    batches = []
    for c in comp_events:
        if batches and c.get("t", 0) - batches[-1][-1].get("t", 0) < gap_ms:
            batches[-1].append(c)
        else:
            batches.append([c])
    return batches


def analyze(events, start_ms=0, gap_ms=COMPACT_GAP_MS):
    comp = [
        e for e in events
        if e.get("type") == "compaction" and e.get("t", 0) >= start_ms
    ]
    chat = [
        e for e in events
        if e.get("type") == "provider_round"
        and e.get("data", {}).get("phase") == "chat"
        and e.get("data", {}).get("cacheReadTokens") is not None
        and e.get("t", 0) >= start_ms
    ]
    chat.sort(key=lambda e: e.get("t", 0))

    batches = group_compactions(comp, gap_ms)
    rows = []
    for b in batches:
        c_end = max(e.get("t", 0) for e in b)
        after = [e for e in chat if e.get("t", 0) > c_end]
        before = [e for e in chat if e.get("t", 0) < c_end]
        if not after or not before:
            continue
        fa = after[0]
        lb = before[-1]
        fd, ld = fa.get("data", {}), lb.get("data", {})
        bh, ah = hit_rate(ld), hit_rate(fd)
        rows.append({
            "time": ts_str(c_end),
            "before_hit": bh,
            "after_hit": ah,
            "delta": ah - bh,
            "before_cache": ld.get("cacheReadTokens") or 0,
            "after_cache": fd.get("cacheReadTokens") or 0,
            "positions": sorted({e.get("data", {}).get("position") for e in b}),
        })
    return rows, batches, chat


def parse_args(argv):
    """轻量参数解析:支持 --opt value 与布尔 --flag,其余视为事件文件路径。"""
    opts = {"json": False, "no_recon": False, "start": None, "gap_ms": None}
    paths = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("-h", "--help"):
            print(__doc__)
            raise SystemExit(0)
        elif a == "--json":
            opts["json"] = True
            i += 1
        elif a == "--no-recon":
            opts["no_recon"] = True
            i += 1
        elif a == "--start":
            if i + 1 < len(argv):
                opts["start"] = argv[i + 1]
                i += 2
            else:
                i += 1
        elif a == "--compact-gap":
            if i + 1 < len(argv):
                try:
                    opts["gap_ms"] = int(argv[i + 1])
                except ValueError:
                    pass
                i += 2
            else:
                i += 1
        else:
            paths.append(a)
            i += 1
    return opts, paths


def main():
    opts, paths = parse_args(sys.argv[1:])
    if not paths:
        print("未找到 stats 事件文件。请传参或确认 ~/.dsb/stats/ 下有 events 文件。")
        return 1

    start_ms = 0
    if opts.get("start"):
        try:
            h, m = opts["start"].split(":")
            start_ms = int(datetime(2026, 1, 1, int(h), int(m)).timestamp() * 1000) % 86400000
            # 实际绑定到当天:用 date.today 的时分
            today = date.today()
            start_ms = int(datetime(today.year, today.month, today.day, int(h), int(m)).timestamp() * 1000)
        except (ValueError, IndexError):
            pass
    gap_ms = opts.get("gap_ms") or COMPACT_GAP_MS

    events = load_events(paths)
    rows, batches, chat = analyze(events, start_ms, gap_ms)

    rounds = [e for e in events if e.get("type") == "provider_round" and e.get("t", 0) >= start_ms]

    out = {}
    if rows:
        bmean = sum(r["before_hit"] for r in rows) / len(rows)
        amean = sum(r["after_hit"] for r in rows) / len(rows)
        dmean = sum(r["delta"] for r in rows) / len(rows)
        dsorted = sorted(r["delta"] for r in rows)
        dmed = dsorted[len(dsorted) // 2]
        lows = [r for r in rows if r["after_hit"] < SNOWBALL_THRESHOLD]
        total_cache_loss = sum(r["before_cache"] - r["after_cache"] for r in rows)
        out = {
            "batches_found": len(rows),
            "batch_total": len(batches),
            "before_hit_mean": bmean,
            "after_hit_mean": amean,
            "delta_mean": dmean,
            "delta_median": dmed,
            "snowball_count": len(lows),
            "snowball_ratio": len(lows) / len(rows) if rows else 0,
            "total_cache_loss_tokens": total_cache_loss,
            "snowball_cost_yuan": total_cache_loss * PRICE_INPUT / 1e6,
        }

    if opts.get("json"):
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    print(f"文件: {len(paths)} 个 | compaction {sum(len(b) for b in batches)} {len(batches)} 批 | provider_round {len(rounds)} 条")
    if start_ms:
        print(f"分析起始时间: {opts.get('start')} 之后")
    print(f"压缩后首轮可用批次: {len(rows)} / {len(batches)} (其余批次缺少前后 chat 轮,跳过)")

    if not rows:
        print("没有可判定的压缩批次(需要同一批次压缩前、后都存在带 cacheReadTokens 的 chat 轮)。")
        return 0

    print("\n=== 明细:压缩前稳定轮 vs 压缩后首轮 ===")
    print(f"{'时间':<9}{'before命中':>9}{'after命中':>9}{'骤降':>7}{'position'}")
    for r in rows:
        print(f"{r['time']:<9}{r['before_hit']*100:>8.0f}%{r['after_hit']*100:>8.0f}%{r['delta']*100:>+6.0f}pp  {','.join(r['positions'])}")

    print("\n=== 压缩雪崩量化(P2 前/后对照) ===")
    print(f"压缩前稳定轮平均命中率: {out['before_hit_mean']*100:.1f}%")
    print(f"压缩后首轮平均命中率 : {out['after_hit_mean']*100:.1f}%")
    print(f"平均骤降(负=雪崩)    : {out['delta_mean']*100:+.1f}pp | 中位 {out['delta_median']*100:+.1f}pp")
    print(f"压缩后首轮<{SNOWBALL_THRESHOLD*100:.0f}% 命中率的批次: {out['snowball_count']}/{len(rows)} ({out['snowball_ratio']*100:.0f}%)")
    print(f"因雪崩 cacheRead 累计骤减: {out['total_cache_loss_tokens']:,} tokens")
    print(f"按输入单价估算雪崩成本  : ¥{out['snowball_cost_yuan']:.4f}")

    if not opts.get("no_recon"):
        real_hit = sum(r.get("data", {}).get("cacheReadTokens", 0) for r in rounds)
        real_miss = sum(r.get("data", {}).get("inputTokens", 0) for r in rounds)
        if real_hit + real_miss:
            print("\n=== 与真实 usage 对账(仅供参考) ===")
            print(f"真实: 命中 {real_hit:,} / 未命中 {real_miss:,} (总命中率 {real_hit/(real_hit+real_miss)*100:.1f}%)")
    print("\n提示:P2 (压缩块 append-only) 修复后重跑本脚本,对比压缩后首轮命中率是否回升。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
