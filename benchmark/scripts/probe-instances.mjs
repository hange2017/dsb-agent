/**
 * 准备 T3 成本探针实例清单:
 * - 从 HuggingFace 下载 SWE-bench-Live lite split(300 实例)
 * - 按 difficulty.lines 取样:最简 / 1/4 / 中位 / 3/4 / 最难
 * - 输出到 benchmark/out/probe/ 下,每实例一个 JSON(CLI --instances-dir 可直接批量跑)
 *
 * 用法: node benchmark/scripts/probe-instances.mjs
 * 需要: Node 18+ (全局 fetch) + 网络可访问 huggingface.co
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const BASE =
  "https://datasets-server.huggingface.co/rows?dataset=SWE-bench-Live%2FSWE-bench-Live&config=default&split=lite";
const PROBE_N = 5;
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "out", "probe");

async function fetchPage(offset) {
  const url = `${BASE}&offset=${offset}&length=100`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for offset=${offset}`);
  const json = await res.json();
  return json.rows.map((r) => r.row);
}

function pickByDifficulty(all) {
  const sorted = [...all].sort((a, b) => (a.difficulty?.lines ?? 0) - (b.difficulty?.lines ?? 0));
  const n = sorted.length;
  const picks = [
    sorted[0],
    sorted[Math.floor(n * 0.25)],
    sorted[Math.floor(n * 0.5)],
    sorted[Math.floor(n * 0.75)],
    sorted[n - 1],
  ];
  return picks.filter(Boolean);
}

function slim(inst) {
  return {
    instance_id: inst.instance_id,
    repo: inst.repo,
    base_commit: inst.base_commit,
    problem_statement: inst.problem_statement,
  };
}

async function main() {
  const all = [];
  for (let offset = 0; offset < 300; offset += 100) {
    process.stdout.write(`fetching lite rows ${offset}-${offset + 99} ...\n`);
    all.push(...(await fetchPage(offset)));
  }
  process.stdout.write(`total ${all.length} instances\n`);
  if (all.length < PROBE_N) throw new Error(`not enough instances: ${all.length}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const picks = pickByDifficulty(all);
  picks.forEach((inst, i) => {
    const file = path.join(OUT_DIR, `probe-${String(i + 1).padStart(2, "0")}-${inst.instance_id}.json`);
    fs.writeFileSync(file, JSON.stringify(slim(inst), null, 2));
    const d = inst.difficulty ?? {};
    process.stdout.write(
      `probe-${String(i + 1).padStart(2, "0")} ${inst.instance_id} files=${d.files ?? "?"} hunks=${d.hunks ?? "?"} lines=${d.lines ?? "?"}\n`,
    );
  });
  process.stdout.write(`\n5 probe instances written to ${OUT_DIR}\n`);
  process.stdout.write('run all: node dist-benchmark/cli.js --instances-dir benchmark/out/probe --work-dir benchmark/out/work\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
