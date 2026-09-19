# -*- coding: utf-8 -*-
"""压缩预算口径 · 窗口对比分析与复算脚本

用途:对比「历史信息预算」不同配置下的压缩频率、压缩后缓存命中率、稳态命中率与每轮成本。
数据源:~/.dsb/stats/<project>/events-YYYY-MM-DD.jsonl。
  * project 默认**自动探测**(取本机 stats 下事件最多的目录),跨机器复现时无需手写 projectKey;
  * 输出默认写到仓库 `.dsb/docs/budget-windows-report.txt`,便于提交与跨机器逐行对比。

用法:
  python scripts/analyze-budget-windows.py                    # 自动探测项目 + 全部窗口
  python scripts/analyze-budget-windows.py --list             # 列出窗口定义(含日期区间)
  python scripts/analyze-budget-windows.py --window 30k       # 只算名称含 30k 的窗口
  python scripts/analyze-budget-windows.py --stdout           # 同时打印到终端
  python scripts/analyze-budget-windows.py --project e-dsb --out report.txt

注意:窗口的日期区间是**绝对时间**。若换机器后该机器只有部分日期的数据,
不存在的窗口会自动标注「无数据」而不是报错;报告头部的「预算档自动识别」
一节会列出该机实际出现过的预算档与首现时间,便于核对两台机器配置是否一致。

口径(与 .dsb/docs/2026-09-16-agent效果评估基线.md 第四/五章一致):
  命中率 = cacheRead / (cacheRead + input)  ← 权威口径
  effIdx/轮 = input + 0.1*cacheRead + output ← 折扣有效输入(衡量真实工作量)
  $/轮 = 3*input/1e6 + 15*output/1e6 + 0.3*cacheRead/1e6(DeepSeek 档位近似)
  压缩批次 = 1 分钟内的 compaction 事件合并为 1 次(一次压缩会 emit block/tail 多条事件)
  稳态轮 = 距离任意压缩批次结束 > 2 轮的 round;冷启动轮 = 压缩后前 2 轮
"""
import argparse
import glob
import io
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime

WINDOWS = [
    # 名称, 起, 止
    ("【A】64k / 0.56-0.44 / trig0.75(09-14 21:26~23:03)", "2026-09-14 21:26", "2026-09-14 23:03"),
    ("【B】96k / 0.30-0.70(09-14 23:03~09-15 00:00)", "2026-09-14 23:03", "2026-09-15 00:00"),
    ("【B2】96k 整日(09-15)", "2026-09-15 00:00", "2026-09-16 00:00"),
    ("【B3】96k 时代合计(09-14 23:03~09-18 00:00,含 09-15/09-17)", "2026-09-14 23:03", "2026-09-18 00:00"),
    ("【C】30k / 0.20-0.80 / trig0.85(09-19 21:48~09-20 00:00)", "2026-09-19 21:48", "2026-09-20 00:00"),
    ("【C2】30k(09-20 00:00~00:40)", "2026-09-20 00:00", "2026-09-20 00:40"),
    ("【C3】30k 合计(09-19 21:48~09-20 00:40)", "2026-09-19 21:48", "2026-09-20 00:40"),
]


def ts(s):
    return datetime.strptime(s, "%Y-%m-%d %H:%M").timestamp() * 1000


def load_all(d):
    evs = []
    for p in sorted(glob.glob(os.path.join(d, "events-*.jsonl"))):
        for line in open(p, encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            try:
                evs.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    evs.sort(key=lambda e: e.get("t", 0))
    return evs


def med(v):
    if not v:
        return 0.0
    s = sorted(v)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0


def hit(d):
    cr = d.get("cacheReadTokens") or 0
    it = d.get("inputTokens") or 0
    return cr / (cr + it) if (cr + it) > 0 else 0.0


def batches_of(comp):
    out = []
    for c in comp:
        if out and c["t"] - out[-1][-1]["t"] < 60000:
            out[-1].append(c)
        else:
            out.append([c])
    return out


def analyze(evs, name, a, b, out):
    t0, t1 = ts(a), ts(b)
    es = [e for e in evs if t0 <= e["t"] < t1]
    chat = [e for e in es if e.get("type") == "provider_round" and e["data"].get("phase") in (None, "chat")]
    wc = [e for e in chat if e["data"].get("cacheReadTokens") is not None]
    comp = [e for e in es if e.get("type") == "compaction"]
    snd = [e for e in es if e.get("type") == "provider_send"]
    tsx = [e for e in es if e.get("type") == "turn_summary"]
    qa = [e for e in es if e.get("type") == "compaction_qa"]
    rec = [e for e in es if e.get("type") == "context_recall"]
    # 压缩后「前缀保留率」= 压缩后首轮 cacheRead / 压缩前末轮 cacheRead(旧前缀存活比例)
    keep = []
    curve = defaultdict(list)
    for bt in batches_of(comp):
        end = max(c["t"] for c in bt)
        before = [e for e in wc if e["t"] < bt[0]["t"]]
        after = [e for e in wc if e["t"] > end]
        if before and after and (before[-1]["data"].get("cacheReadTokens") or 0) > 0:
            keep.append((after[0]["data"].get("cacheReadTokens") or 0) / before[-1]["data"]["cacheReadTokens"])
        for i, e in enumerate(after[:6]):
            curve[min(i, 5)].append(hit(e["data"]))
    rep = [e for e in es if e.get("type") == "tool_repeat"]
    sess = {e["data"].get("sessionId") for e in es if e["data"].get("sessionId")}
    nb = len(batches_of(comp))
    n = max(1, len(chat))
    si = sum(e["data"].get("inputTokens") or 0 for e in chat)
    so = sum(e["data"].get("outputTokens") or 0 for e in chat)
    sc = sum(e["data"].get("cacheReadTokens") or 0 for e in chat)
    avg = lambda k: (sum(e["data"].get(k) or 0 for e in snd) / len(snd)) if snd else 0.0
    # 压缩批次前后:冷启动轮 / 稳态轮
    batches = batches_of(comp)
    cold_ts = set()
    first, second, recover = [], [], []
    for bt in batches:
        end = max(c["t"] for c in bt)
        after = [e for e in wc if e["t"] > end]
        for e in after[:2]:
            cold_ts.add(e["t"])
        if after:
            first.append(after[0]["data"])
            if len(after) > 1:
                second.append(after[1]["data"])
            k = 0
            for e in after:
                if hit(e["data"]) >= 0.8:
                    break
                k += 1
            recover.append(k)
    steady = [e for e in wc if e["t"] not in cold_ts]
    cold = [e for e in wc if e["t"] in cold_ts]
    asc = sum(e["data"].get("cacheReadTokens") or 0 for e in steady)
    asi = sum(e["data"].get("inputTokens") or 0 for e in steady)
    csc = sum(e["data"].get("cacheReadTokens") or 0 for e in cold)
    csi = sum(e["data"].get("inputTokens") or 0 for e in cold)
    folded = [c["data"].get("beforeTokens") or 0 for c in comp if c["data"].get("position") == "tail"]
    llm = sum(c["data"].get("llmCalls") or 0 for c in comp)
    self_in = sum(c["data"].get("selfInputTokens") or 0 for c in comp)
    self_out = sum(c["data"].get("selfOutputTokens") or 0 for c in comp)
    self_ms = sum(c["data"].get("durationMs") or 0 for c in comp)
    miss_first = [d.get("inputTokens") or 0 for d in first]
    w = out.write
    w("### %s\n" % name)
    w("窗口 %s ~ %s | 会话 %d | 轮 %d | 压缩批次 %d | 轮/压缩 %.1f | 每千轮压缩 %.1f\n"
      % (a, b, len(sess), len(chat), nb, len(chat) / max(1, nb), 1000.0 * nb / n))
    w("命中率(整体) %.1f%% | 稳态命中率 %.2f%%(轮 %d 占 %.1f%%) | 冷启动命中率 %.2f%%(轮 %d 占 %.1f%%)\n"
      % (100.0 * sc / max(1, sc + si), 100.0 * asc / max(1, asc + asi), len(steady), 100.0 * len(steady) / n,
         100.0 * csc / max(1, csc + csi), len(cold), 100.0 * len(cold) / n))
    w("稳态未命中 in/轮 %.0f | 冷启动未命中 in/轮 %.0f | 冷启动占总未命中 %.1f%%\n"
      % (asi / max(1, len(steady)), csi / max(1, len(cold)), 100.0 * csi / max(1, asi + csi)))
    w("压缩后首轮:未命中 in=%.0f 命中 CR=%.0f 命中率 %.1f%% | 第 2 轮命中率 %.1f%% | 恢复到 80%% 平均 %.1f 轮\n"
      % (sum(miss_first) / max(1, len(miss_first)),
         100.0 * sum(d.get("cacheReadTokens") or 0 for d in first) / max(1, len(first)),
         100.0 * sum(hit(d) for d in first) / max(1, len(first)),
         100.0 * sum(hit(d) for d in second) / max(1, len(second)),
         sum(recover) / max(1, len(recover))))
    w("每次压缩折叠原文 tokens:中位 %.0f 均值 %.0f | 一次性重放成本(未命中 in)/轮摊销 %.0f\n"
      % (med(folded), sum(folded) / max(1, len(folded)), sum(miss_first) / n))
    w("压缩自身:LLM 调用 %d(%.2f/次) in=%d out=%d 耗时 %.1fs(%.2fs/次);零 LLM 纯裁剪的压缩 %d/%d\n"
      % (llm, llm / max(1, len(comp)), self_in, self_out, self_ms / 1000.0, self_ms / 1000.0 / max(1, len(comp)),
         sum(1 for c in comp if not c["data"].get("llmCalls")), len(comp)))
    w("前缀保留率(压缩后首轮 CR ÷ 压缩前末轮 CR):中位 %.1f%% 均值 %.1f%%(样本 %d)\n"
      % (100 * med(keep), 100 * (sum(keep) / len(keep) if keep else 0), len(keep)))
    w("压缩后命中率曲线(第 0/1/2/3/4/5+ 轮):%s\n"
      % " ".join("%.0f%%" % (100 * sum(curve[i]) / len(curve[i])) if curve[i] else "-" for i in range(6)))
    w("每轮 avgIn %.0f avgOut %.0f avgCR %.0f | effIdx/轮 %.0f | $/轮 %.4f\n"
      % (si / n, so / n, sc / n, (si + 0.1 * sc + so) / n, (3 * si / 1e6 + 15 * so / 1e6 + 0.3 * sc / 1e6) / n))
    w("注入 avgTotal %.0f = block %.0f + tail %.0f | 触发原因 %s\n"
      % (avg("totalTokens"), avg("compactedBlockTokens"), avg("tailTokens"),
         Counter(c["data"].get("reason") for c in comp).most_common()))
    if tsx:
        w("turn_summary %d 条:rounds 中位 %.0f、toolCalls 中位 %.0f、重复浪费 %d/%d、endReason %s\n"
          % (len(tsx), med([x["data"].get("rounds") or 0 for x in tsx]),
             med([x["data"].get("toolCalls") or 0 for x in tsx]),
             sum(x["data"].get("toolRepeatWasteCount") or 0 for x in tsx),
             sum(x["data"].get("toolCalls") or 0 for x in tsx),
             sorted(set(str(x["data"].get("endReason")) for x in tsx))))
    if qa:
        w("压缩质量抽查 answerable %d/%d = %.0f%%\n"
          % (sum(1 for e in qa if e["data"].get("answerable")), len(qa),
             100.0 * sum(1 for e in qa if e["data"].get("answerable")) / len(qa)))
    w("信息回查:context_recall %d 次(%.1f/千轮) tool_repeat %d 次\n\n"
      % (len(rec), 1000.0 * len(rec) / n, len(rep)))


def window_label(name):
    return name.split("(")[0].strip()


def detect_projects(stats_root):
    """扫描 ~/.dsb/stats/*,按事件条数降序返回 [(project, 事件数, 文件数)]。"""
    out = []
    for d in sorted(glob.glob(os.path.join(stats_root, "*"))):
        if not os.path.isdir(d):
            continue
        files = sorted(glob.glob(os.path.join(d, "events-*.jsonl")))
        if not files:
            continue
        n = 0
        for p in files:
            with open(p, encoding="utf-8", errors="replace") as f:
                n += sum(1 for line in f if line.strip())
        out.append((os.path.basename(d), n, len(files)))
    out.sort(key=lambda t: -t[1])
    return out


def budget_label(tot):
    """按 budget.total 生成人类可读的档位标签。"""
    if tot is None:
        return "未知档"
    n = int(tot)
    return ("%dk" % (n // 1000)) if n % 1000 == 0 else ("%d" % n)


def budget_timeline(evs, out):
    """列出本机实际出现过的预算档(budget.total / split)及首现时间,便于跨机器核对配置。"""
    seen = defaultdict(list)
    for e in evs:
        if e.get("type") != "compaction":
            continue
        b = e["data"].get("budget") or {}
        seen[(b.get("total"), b.get("compacted"), b.get("thinking"), b.get("tail"))].append(e["t"])
    out.write("## 预算档自动识别(本机实际生效过的压缩预算)\n")
    if not seen:
        out.write("(本机无 compaction 事件,无法识别)\n\n")
        return
    for key, tss in sorted(seen.items(), key=lambda kv: min(kv[1])):
        tot, tc, th, tl = key
        out.write("%-6s 首现 %s  出现 %4d 次  budget.total=%s (压缩块=%s 思考=%s tail=%s)\n"
                  % (budget_label(tot), datetime.fromtimestamp(min(tss) / 1000).strftime("%Y-%m-%d %H:%M"),
                     len(tss), tot, tc, th, tl))
    out.write("\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=None, help="stats 下的项目目录名;默认自动探测")
    ap.add_argument("--out", default=None, help="输出文件;默认写入仓库 .dsb/docs/budget-windows-report.txt")
    ap.add_argument("--window", action="append", default=[], help="只算名称含该子串的窗口(可重复)")
    ap.add_argument("--list", action="store_true", help="只列出窗口定义与自动探测到的项目")
    ap.add_argument("--stdout", action="store_true", help="同时在终端打印报告")
    args = ap.parse_args()

    stats_root = os.path.join(os.path.expanduser("~"), ".dsb", "stats")
    projects = detect_projects(stats_root)

    if args.list:
        print("stats 根目录:%s" % stats_root)
        print("自动探测到的项目(事件数降序):")
        for p, n, f in projects:
            print("  %-16s 事件 %-6d 文件 %d" % (p, n, f))
        print("\n窗口定义:")
        for name, a, b in WINDOWS:
            print("  %-52s %s ~ %s" % (window_label(name), a, b))
        print("\n可用 --window 关键词:" + ", ".join(sorted({window_label(n).split()[0] for n, _, _ in WINDOWS})))
        return 0

    project = args.project
    if not project:
        if not projects:
            print("未在 %s 下找到任何 events-*.jsonl,请用 --project 显式指定。" % stats_root)
            return 1
        project = projects[0][0]
        print("自动选择项目:%s(可用 --project 指定;--list 查看全部)" % project)

    d = os.path.join(stats_root, project)
    if not os.path.isdir(d):
        print("项目目录不存在:%s" % d)
        return 1

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_path = args.out or os.path.join(repo_root, ".dsb", "docs", "budget-windows-report.txt")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    files = sorted(glob.glob(os.path.join(d, "events-*.jsonl")))
    evs = load_all(d)
    windows = [w for w in WINDOWS if not args.window or any(k in w[0] for k in args.window)]
    if not windows:
        print("--window 未匹配到任何窗口;用 --list 查看可用关键词。")
        return 1

    buf = io.StringIO()

    class Tee:
        """把报告同时写进内存缓冲(落盘)与终端(可选);既支持 w(s) 也支持 out.write(s)。"""

        def __init__(self, dest, echo):
            self._dest = dest
            self._echo = echo

        def write(self, s):
            self._dest.write(s)
            if self._echo:
                sys.stdout.write(s)
            return len(s)

        __call__ = write

    w = Tee(buf, args.stdout)

    w("数据源 %s | 事件 %d 条 | 文件 %s\n"
      % (d, len(evs), ", ".join(sorted(os.path.basename(p) for p in files))))
    host = os.environ.get("COMPUTERNAME") or (os.uname().nodename if hasattr(os, "uname") else "?")
    w("生成时间 %s | 主机 %s | python %s\n\n"
      % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), host,
         ".".join(str(x) for x in sys.version_info[:3])))
    budget_timeline(evs, w)

    for name, a, b in windows:
        if not any(t0 <= e["t"] < t1 for e in evs for t0, t1 in [(ts(a), ts(b))]):
            w("### %s\n(本机该时间窗无事件数据 —— 换机器复现时属正常,跳过)\n\n" % window_label(name))
            continue
        analyze(evs, name, a, b, w)
    # 逐日合计
    byday = defaultdict(list)
    for e in evs:
        if e.get("type") == "provider_round" and e["data"].get("phase") in (None, "chat"):
            byday[datetime.fromtimestamp(e["t"] / 1000).strftime("%Y-%m-%d")].append(e)
    w("## 逐日合计\n")
    for day in sorted(byday):
        rs = byday[day]
        cs = [e for e in rs if e["data"].get("cacheReadTokens") is not None]
        si = sum(e["data"].get("inputTokens") or 0 for e in cs)
        sc = sum(e["data"].get("cacheReadTokens") or 0 for e in cs)
        so = sum(e["data"].get("outputTokens") or 0 for e in cs)
        n = max(1, len(cs))
        w("%s 轮 %-5d 命中率 %.1f%% avgIn %.0f avgOut %.0f avgCR %.0f effIdx/轮 %.0f\n"
          % (day, len(cs), 100.0 * sc / max(1, sc + si), si / n, so / n, sc / n, (si + 0.1 * sc + so) / n))

    with open(out_path, "w", encoding="utf-8", newline="\n") as out:
        out.write(buf.getvalue())
    print("written: %s" % out_path)
    return 0


if __name__ == "__main__":
    main()
