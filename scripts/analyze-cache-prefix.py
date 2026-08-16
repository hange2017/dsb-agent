#!/usr/bin/env python3
"""缓存前缀命中分析(方案 B)脚本。

原理:缓存按请求前缀匹配。相邻两轮(同一 sessionId 的 sendSeq 递增)对比
messageBreakdown:
  - 按「消息 index 对齐」逐消息对比(同一消息内多个 block 保序合并)。
    找到第一条内容变化的消息 = 前缀断裂点:该消息之前全部命中;
    该消息起及其后 = 未命中(严格前缀口径,与真实 API 行为一致)。
  - 对 compacted 块(整块一个 hash)做块内近似:若前后两轮 compacted 块
    hash 不同但都位于 index 0,近似「新块以旧块为前缀」→ 命中 min(prev, cur)
    tokens,未命中 = cur - prev(增量)。与实测吻合:压缩后首轮 hit ≈
    system+tools + 旧 compacted 块,tail 0 命中(严格前缀)。

真实口径(权威):provider_round 的 cacheReadTokens / inputTokens 按天汇总,
并单独统计「压缩后首轮」命中率 = 每个 compaction 事件(完成时间 t)之后的
**第一个** provider_round(不是 30s 窗口内的所有轮——那会把已重建缓存的
正常轮混入,严重高估)。

实测(2026-08-15/16 修正后):
  - 稳定期(其余轮):平均 94.1~94.7%(中位 98.7~99.2%)
  - 压缩后首轮:平均 50.5~55.7%(中位 53.8~58.0%),仍有少量 <20% 的雪崩轮

用法:
  python3 scripts/analyze-cache-prefix.py [events.jsonl...]
  不传文件时,自动扫描 ~/.dsb/stats/*/ 当天所有 events-*.jsonl(统计口径:全项目合并)。

输出:
  - 总体:可判定轮数、前缀断裂轮数
  - 三组(tail/compacted/thinking_block)的命中 / 未命中 / 命中率
  - 压缩雪崩轮(compacted 前缀断裂)单独列出
  - 真实口径:稳定期 / 压缩后首轮(第一个 round)的命中率
  - 与真实 usage 的对账(估算不含 system+tools,真实含)
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


def group_by_index(mb):
    """把 messageBreakdown 条目按 index 分组(同消息多 block 保序合并),返回 [(index, [blocks]), ...]。"""
    groups = defaultdict(list)
    for p in mb:
        groups[p.get("index", 0)].append(p)
    return sorted(groups.items())


def compare_message(prev_blocks, cur_blocks):
    """比较同一 index 的两条消息(block 序列)。返回 (hit, miss, is_extend)。
    规则(严格前缀,与真实 API 一致):
    - cur 的 block 序列以 prev 的 block 序列为前缀且 cur 更长 → 块级追加:
      命中相同块,miss 新增块(前缀未断)
    - 首块不同 / 中部某块不同 → 该消息起前缀断裂,之后即使内容相同也不命中
    """
    n = min(len(prev_blocks), len(cur_blocks))
    same = 0
    for i in range(n):
        if prev_blocks[i].get("hash") == cur_blocks[i].get("hash"):
            same += 1
        else:
            break
    cur_tokens = sum(p.get("tokens", 0) for p in cur_blocks)
    if same == 0:
        return 0, cur_tokens, False
    hit = sum(p.get("tokens", 0) for p in cur_blocks[:same])
    is_extend = same == len(prev_blocks) and len(cur_blocks) > len(prev_blocks)
    return hit, cur_tokens - hit, is_extend


def analyze(sends):
    """sends: 按 (sessionId, sendSeq) 排序的 provider_send 事件列表。"""
    grouped = defaultdict(list)
    for ev in sends:
        d = ev.get("data", {})
        sid = d.get("sessionId") or "?"
        grouped[sid].append((d.get("sendSeq", 0), ev.get("t", 0), d))

    # 注意:轮次按时间序配对(t 主,seq 辅助),避免同 sessionId 多时间线交错时
    # 按 seq 排序产生时间倒挂的误配(修复前 sendSeq 因 createSession 重建而多线交错)。
    # 修复后(2026-08-17 起)sendSeq 全局递增,同一会话轮次天然时间序。

    stats = {
        "pairs": 0,
        "broken": 0,
        "groups": defaultdict(lambda: {"hit": 0, "miss": 0}),
        "avalanche_rounds": 0,
        "avalanche_miss": 0,
    }

    for sid, rows in grouped.items():
        rows.sort(key=lambda r: (r[1], r[0]))
        prev = None  # (sendSeq, data)
        for seq, t, d in rows:
            mb = d.get("messageBreakdown") or []
            if prev is not None:
                prev_seq, prev_d = prev
                # sendSeq 重置/回退 = 会话重建(restore/复用):前后请求消息列表独立,
                # 不可按相邻轮对比(否则误报前缀断裂),跳过配对仅更新 prev。
                if seq <= prev_seq:
                    prev = (seq, d)
                    continue
                stats["pairs"] += 1
                prev_idx = group_by_index(prev_d["messageBreakdown"] or [])
                cur_idx = group_by_index(mb)

                # 逐消息(index 对齐)对比,严格前缀:找到断裂点后其后的消息即使
                # 内容与 prev 相同也不再命中(字节位置已偏移)。
                groups = defaultdict(lambda: {"hit": 0, "miss": 0})
                broken_at = None       # 前缀断裂的消息 index(既有消息内容变化)
                prefix_broken = False  # 已发生断裂(其后消息全 miss)
                for k, (idx, cur_blocks) in enumerate(cur_idx):
                    if prefix_broken:
                        for p in cur_blocks:
                            groups[kind_of(p)]["miss"] += p.get("tokens", 0)
                        continue
                    if k < len(prev_idx) and prev_idx[k][0] == idx:
                        h, m, is_extend = compare_message(prev_idx[k][1], cur_blocks)
                        # compacted 块内近似:前后两轮 index 0 都是 compacted 且内容
                        # 变化 → 近似「新块以旧块为前缀」→ 命中 min(prev, cur)。
                        # 与实测吻合:压缩后首轮 hit ≈ system+tools + 旧 compacted 块。
                        if m > 0 and idx == 0 and cur_blocks and cur_blocks[0].get("kind") == "compacted" \
                           and prev_idx[0][1] and prev_idx[0][1][0].get("kind") == "compacted":
                            p_tok = sum(p.get("tokens", 0) for p in prev_idx[0][1])
                            c_tok = sum(p.get("tokens", 0) for p in cur_blocks)
                            h = min(p_tok, c_tok)
                            m = max(0, c_tok - h)
                        if m > 0 and not is_extend:
                            # 既有消息内容变化 → 前缀断裂(该消息起全 miss)
                            prefix_broken = True
                            broken_at = idx
                        # 归组:按块依次分摊命中,剩余计 miss(保证 hit+miss=cur 块总 tokens)
                        rem_hit = h
                        for p in cur_blocks:
                            t = p.get("tokens", 0)
                            take = min(rem_hit, t) if rem_hit > 0 else 0
                            groups[kind_of(p)]["hit"] += take
                            groups[kind_of(p)]["miss"] += t - take
                            rem_hit = max(0, rem_hit - take)
                    else:
                        # cur 有 prev 没有的消息:若在 prev 消息数之后(尾部新增)
                        # 且此前未断裂 → 仅追加,前缀未断(新增 token 是正常成本);
                        # 否则(index 序列不匹配,如压缩后重排)→ 前缀断裂。
                        if k >= len(prev_idx):
                            for p in cur_blocks:
                                groups[kind_of(p)]["miss"] += p.get("tokens", 0)
                            continue
                        prefix_broken = True
                        broken_at = idx
                        for p in cur_blocks:
                            groups[kind_of(p)]["miss"] += p.get("tokens", 0)
                for g, v in groups.items():
                    stats["groups"][g]["hit"] += v["hit"]
                    stats["groups"][g]["miss"] += v["miss"]
                if broken_at is not None:
                    stats["broken"] += 1
                if groups["compacted"]["miss"] > 0:
                    stats["avalanche_rounds"] += 1
                    stats["avalanche_miss"] += groups["compacted"]["miss"]
            prev = (seq, d)

    return stats


def kind_of(part):
    kind = part.get("kind", "?")
    if kind == "compacted":
        return "compacted"
    if kind == "thinking_block":
        return "thinking_block"
    return "tail"


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

    stats = analyze(sends)
    groups = stats["groups"]

    print("\n=== 前缀命中归属(相邻轮对比,消息级对齐,严格前缀) ===")
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
        print(f"compacted 未命中轮: {stats['avalanche_rounds']} | 额外未命中: {stats['avalanche_miss']:,}")
        print(f"雪崩成本 ≈ ¥{stats['avalanche_miss'] * PRICE_INPUT / 1e6:.4f}")

    # 真实口径(权威):provider_round 命中率,按「压缩后首轮 / 其余轮」分组。
    # 压缩后首轮 = compaction 完成(t)之后**第一个** round(不是 30s 窗口内全部)。
    comps = [ev for ev in events if ev.get("type") == "compaction"]
    if rounds:
        # 每会话:round 按 t 排序;标记哪些 round 是某压缩后的第一个
        comp_times_by_sess = defaultdict(list)
        for c in comps:
            d = c.get("data", {})
            comp_times_by_sess[d.get("sessionId", "?")].append(c.get("t", 0))
        real_groups = {
            "压缩后首轮(compaction 后第一个 round)": {"hit": 0, "miss": 0, "n": 0},
            "其余轮(稳定期)": {"hit": 0, "miss": 0, "n": 0},
        }
        round_by_sess = defaultdict(list)
        for r in rounds:
            d = r.get("data", {})
            round_by_sess[d.get("sessionId", "?")].append(r)
        for sid, rs in round_by_sess.items():
            rs.sort(key=lambda r: r.get("t", 0))
            first_after = set()
            for ct in sorted(comp_times_by_sess.get(sid, [])):
                for i, r in enumerate(rs):
                    if r.get("t", 0) >= ct:
                        first_after.add(i)
                        break
            for i, r in enumerate(rs):
                d = r.get("data", {})
                g = real_groups["压缩后首轮(compaction 后第一个 round)"] if i in first_after else real_groups["其余轮(稳定期)"]
                g["n"] += 1
                g["hit"] += d.get("cacheReadTokens", 0)
                g["miss"] += d.get("inputTokens", 0)
        print("\n=== 真实口径(provider_round,权威;压缩后首轮=compaction 后第一个 round) ===")
        for name, g in real_groups.items():
            h, m = g["hit"], g["miss"]
            rate = h / (h + m) * 100 if (h + m) else 0
            print(f"{name:<38} [{g['n']:>4}轮] 命中 {h:>10,} / 未命中 {m:>10,} / {rate:.1f}%")
        # 压缩后首轮的雪崩(<20%)计数
        low = 0
        for sid, rs in round_by_sess.items():
            rs.sort(key=lambda r: r.get("t", 0))
            for ct in sorted(comp_times_by_sess.get(sid, [])):
                for i, r in enumerate(rs):
                    if r.get("t", 0) >= ct:
                        d = r["data"]
                        h, m = d.get("cacheReadTokens", 0), d.get("inputTokens", 0)
                        if h + m > 0 and h / (h + m) < 0.2:
                            low += 1
                        break
        if low:
            print(f"其中命中率 <20% 的雪崩首轮: {low} 次")

    # 与真实 usage 对账
    if rounds:
        real_miss = sum(r.get("data", {}).get("inputTokens", 0) for r in rounds)
        real_hit = sum(r.get("data", {}).get("cacheReadTokens", 0) for r in rounds)
        est_miss = sum(g["miss"] for g in groups.values())
        est_hit = sum(g["hit"] for g in groups.values())
        print("\n=== 与真实 usage 对账(估算不含 system+tools,真实含;估算偏低于真实) ===")
        print(f"真实: 命中 {real_hit:,} / 未命中 {real_miss:,}")
        print(f"估算: 命中 {est_hit:,} / 未命中 {est_miss:,}")
        if real_hit + real_miss:
            real_rate = real_hit / (real_hit + real_miss) * 100
            est_rate = est_hit / (est_hit + est_miss) * 100 if est_hit + est_miss else 0
            print(f"真实命中率 {real_rate:.1f}% vs 估算 {est_rate:.1f}%(消息部分口径)")
    return 0


def self_test():
    """内建合成数据自检:验证配对/断裂/归组算法。`python3 scripts/analyze-cache-prefix.py --self-test`"""
    def blk(kind, idx, tokens, tag):
        return {"kind": kind, "index": idx, "tokens": tokens, "hash": f"h_{kind}_{tag}"}

    def send(seq, t, mb):
        return {"type": "provider_send", "t": t,
                "data": {"sessionId": "S", "sendSeq": seq, "messageBreakdown": mb}}

    c_old = blk("compacted", 0, 18000, "c1")
    m1 = blk("user_text", 1, 100, "m1")
    m2 = blk("tool_result", 2, 500, "m2")
    m3 = blk("text", 3, 50, "m3")
    s1 = send(1, 100, [c_old, m1, m2, m3])
    s2 = send(2, 200, [c_old, m1, m2, m3, blk("user_text", 4, 80, "m4_new")])

    cases = []

    # 1) 尾部追加:前缀不断,仅新增消息 miss
    st = analyze([s1, s2])
    g = st["groups"]
    cases.append(("append 不裂", st["broken"] == 0 and g["tail"]["hit"] == 650 and g["tail"]["miss"] == 80))

    # 2) 压缩轮:compacted 近似命中旧块,tail 全 miss
    s3 = send(3, 300, [blk("compacted", 0, 18200, "c2"), blk("tool_use", 1, 300, "tu"), blk("tool_result", 2, 400, "tr")])
    st = analyze([s1, s2, s3])
    g = st["groups"]
    cases.append(("压缩轮近似", st["broken"] == 1 and g["compacted"]["hit"] == 36000
                  and g["compacted"]["miss"] == 200 and g["tail"]["miss"] == 780 and st["avalanche_rounds"] == 1))

    # 3) 同消息首块插入 → 该消息起断裂,其后全 miss
    s4 = send(4, 400, [c_old, blk("tool_use", 1, 500, "tu1"), blk("tool_result", 2, 300, "tr2")])
    s5 = send(5, 500, [c_old, blk("text", 1, 20, "tx1"), blk("tool_use", 1, 500, "tu1"), blk("tool_result", 2, 300, "tr2")])
    st = analyze([s4, s5])
    g = st["groups"]
    cases.append(("块插入断裂", st["broken"] == 1 and g["tail"]["hit"] == 0 and g["tail"]["miss"] == 820))

    # 4) 同消息尾部块追加 → 前缀不断,仅新增块 miss
    s6 = send(6, 600, [c_old, blk("tool_use", 1, 500, "tu1"), blk("tool_result", 2, 300, "tr2")])
    s7 = send(7, 700, [c_old, blk("tool_use", 1, 500, "tu1"), blk("tool_result", 2, 300, "tr2"), blk("text", 2, 40, "tr3")])
    st = analyze([s6, s7])
    g = st["groups"]
    cases.append(("块追加不裂", st["broken"] == 0 and g["tail"]["hit"] == 800 and g["tail"]["miss"] == 40))

    # 5) sendSeq 重置(会话重建)跳过配对
    s8 = send(1, 800, [blk("compacted", 0, 9000, "c9")])
    s9 = send(2, 900, [blk("compacted", 0, 9100, "c9b")])
    st = analyze([s1, s2, s8, s9])
    cases.append(("seq 重置跳过", st["pairs"] == 2 and st["broken"] == 1))

    # 6) 稳定期多轮 append
    s3b = send(3, 300, [c_old, m1, m2, m3, blk("user_text", 4, 80, "m4_new"), blk("user_text", 5, 60, "m5")])
    st = analyze([s1, s2, s3b])
    g = st["groups"]
    cases.append(("稳定期多轮", st["broken"] == 0 and g["tail"]["hit"] == 1380 and g["tail"]["miss"] == 140))

    failed = [name for name, ok in cases if not ok]
    for name, ok in cases:
        print(f"  {'✓' if ok else '✗'} {name}")
    if failed:
        print(f"self-test FAILED: {failed}")
        return 1
    print("self-test OK")
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    sys.exit(main())
