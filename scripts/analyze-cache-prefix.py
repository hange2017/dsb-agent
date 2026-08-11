#!/usr/bin/env python3
"""缓存前缀命中分析(方案 B)脚本。

原理:缓存按请求前缀匹配。相邻两轮(同一 sessionId 的 sendSeq 递增)对比
messageBreakdown 中每条的 hash:
  - 第一个 hash 变化的 index → 前缀断裂点。该点之前的所有部分 = 命中;
    该点及其之后 = 未命中(真实 API 也按整条消息粒度处理缓存)。
  - 按 kind 归属到 compacted / thinking_block / tail(其余)三组,分别统计
    命中与未命中 token。

用法:
  python3 scripts/analyze-cache-prefix.py [events.jsonl...]
  不传文件时,自动扫描 ~/.dsb/stats/*/ 当天所有 events-*.jsonl(统计口径:全项目合并)。

输出:
  - 总体:可判定轮数、前缀断裂轮数
  - 三组(tail/compacted/thinking_block)的命中 / 未命中 / 命中率
  - 压缩雪崩轮(compacted 前缀断裂)单独列出
  - 与真实 usage 的对账(可选,provider_round 存在时)
"""
import glob
import json
import os
import sys
from collections import defaultdict
from datetime import date

# 与成本文档一致的官方单价(元/百万 token)
PRICE_CACHE_READ = 0.02
PRICE_INPUT = 1.0
PRICE_OUTPUT = 2.0

TAIL_KINDS = {"user_text", "tool_result", "image", "text", "tool_use", "assistant_thinking"}


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


def analyze(sends):
    """sends: 按 (sessionId, sendSeq) 排序的 provider_send 事件列表。"""
    grouped = defaultdict(list)
    for ev in sends:
        d = ev.get("data", {})
        sid = d.get("sessionId") or ev.get("data", {}).get("sessionId") or "?"
        grouped[sid].append((d.get("sendSeq", 0), ev.get("t", 0), d))

    stats = {
        "pairs": 0,
        "broken": 0,
        "groups": defaultdict(lambda: {"hit": 0, "miss": 0}),
        "avalanche_rounds": 0,
        "avalanche_miss": 0,
    }
    breakdown_by_kind = {"tail": 0, "compacted": 0, "thinking_block": 0}

    for sid, rows in grouped.items():
        rows.sort(key=lambda r: (r[0], r[1]))
        prev = None
        for seq, t, d in rows:
            mb = d.get("messageBreakdown") or []
            if prev is not None:
                stats["pairs"] += 1
                prev_mb = prev["messageBreakdown"] or []
                # 找第一个 hash 变化点
                break_idx = None
                for i in range(min(len(prev_mb), len(mb))):
                    if prev_mb[i].get("hash") != mb[i].get("hash"):
                        break_idx = i
                        break
                if break_idx is None:
                    # 前缀完全一致(或前一轮更短) → 全部命中
                    break_idx = len(prev_mb)
                if break_idx < len(prev_mb):
                    stats["broken"] += 1
                # 前缀断裂点之前(含未变部分)= 命中;之后 = 未命中
                for i, part in enumerate(prev_mb):
                    kind = part.get("kind", "?")
                    group = (
                        "compacted" if kind == "compacted"
                        else "thinking_block" if kind == "thinking_block"
                        else "tail"
                    )
                    if i < break_idx:
                        stats["groups"][group]["hit"] += part.get("tokens", 0)
                    else:
                        stats["groups"][group]["miss"] += part.get("tokens", 0)
                        breakdown_by_kind[group] += part.get("tokens", 0)
                # 雪崩:compacted 部分发生了断裂
                compacted_miss = sum(
                    p.get("tokens", 0) for p in prev_mb[break_idx:]
                    if p.get("kind") == "compacted"
                )
                if compacted_miss > 0:
                    stats["avalanche_rounds"] += 1
                    stats["avalanche_miss"] += compacted_miss
            prev = d

    return stats, breakdown_by_kind


def main():
    paths = sys.argv[1:] or default_paths()
    if not paths:
        print("未找到 stats 事件文件。请传参或确认 ~/.dsb/stats/ 下有 events 文件。")
        return 1
    events = load_events(paths)
    sends = [ev for ev in events if ev.get("type") == "provider_send"]
    rounds = [ev for ev in events if ev.get("type") == "provider_round"]
    sends.sort(key=lambda ev: (ev.get("data", {}).get("sessionId", "?"), ev.get("data", {}).get("sendSeq", 0), ev.get("t", 0)))

    print(f"文件: {len(paths)} 个 | provider_send {len(sends)} 条 | provider_round {len(rounds)} 条")
    if not sends:
        print("没有 provider_send 数据。")
        return 1

    stats, _ = analyze(sends)
    groups = stats["groups"]

    print("\n=== 前缀命中归属(相邻轮对比,方案 B) ===")
    print(f"可判定相邻对: {stats['pairs']} | 前缀断裂: {stats['broken']} 轮")
    if stats["pairs"] == 0:
        print("不足两轮,无法判定(至少需要同一会话连续两轮)。")
        return 0
    print(f"\n{'分组':<14}{'命中':>10}{'未命中':>12}{'命中率':>10}")
    for g in ("tail", "compacted", "thinking_block"):
        h = groups[g]["hit"]
        m = groups[g]["miss"]
        rate = h / (h + m) * 100 if (h + m) else 0
        print(f"{g:<14}{h:>10,}{m:>12,}{rate:>9.1f}%")
    all_h = sum(g["hit"] for g in groups.values())
    all_m = sum(g["miss"] for g in groups.values())
    print(f"{'合计':<14}{all_h:>10,}{all_m:>12,}{all_h/(all_h+all_m)*100 if all_h+all_m else 0:>9.1f}%")

    # 雪崩
    if stats["avalanche_rounds"]:
        print(f"\n=== 压缩雪崩 ===")
        print(f"compacted 断裂轮: {stats['avalanche_rounds']} | 额外未命中: {stats['avalanche_miss']:,}")
        print(f"雪崩成本 ≈ ¥{stats['avalanche_miss'] * PRICE_INPUT / 1e6:.4f}")

    # 与真实 usage 对账
    if rounds:
        real_miss = sum(r.get("data", {}).get("inputTokens", 0) for r in rounds)
        real_hit = sum(r.get("data", {}).get("cacheReadTokens", 0) for r in rounds)
        est_miss = sum(g["miss"] for g in groups.values())
        est_hit = sum(g["hit"] for g in groups.values())
        print("\n=== 与真实 usage 对账(仅供参考:估算含 system 与前轮系统提示差异) ===")
        print(f"真实: 命中 {real_hit:,} / 未命中 {real_miss:,}")
        print(f"估算: 命中 {est_hit:,} / 未命中 {est_miss:,}")
        if real_hit + real_miss:
            real_rate = real_hit / (real_hit + real_miss) * 100
            est_rate = est_hit / (est_hit + est_miss) * 100 if est_hit + est_miss else 0
            print(f"真实命中率 {real_rate:.1f}% vs 估算 {est_rate:.1f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
