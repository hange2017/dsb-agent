/**
 * DSBAgent benchmark CLI:headless 跑 SWE-bench-Live 实例。
 *
 * 用法:
 *   node dist-benchmark/cli.js --fake --instance <file.json>           冒烟(无需 API key)
 *   node dist-benchmark/cli.js --instance <file.json> --work-dir <dir> 单实例
 *   node dist-benchmark/cli.js --instances-dir <dir> --work-dir <dir>  批量
 *
 * 环境变量:DSB_API_KEY / DSB_BASE_URL / DSB_MODEL / DSB_COST_PER_CALL
 */
import * as fs from "fs";
import * as path from "path";
import type { AgentLoopEvent } from "../src/agent/agentLoop";
import { buildProvider, ScriptedProvider } from "./provider";
import { buildSession } from "./deps";
import { CostTracker } from "./stats";
import { readInstances, buildProblemPrompt, prepareRepo, collectPatch, ensureGit } from "./swebench";
import type { SwebenchInstance } from "./swebench";
/** CLI 参数解析(手写,零依赖)。 */
interface CliOptions {
  instance?: string;
  instancesDir?: string;
  workDir: string;
  outDir: string;
  fake: boolean;
  model: string;
  baseUrl?: string;
  maxRounds: number;
  windowTokens?: number;
  historyBudget?: number;
  costPerCall: number;
  git: string;
  projectInstruction?: string;
  continueOnError: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = {
    workDir: "benchmark/out/work",
    outDir: "benchmark/out",
    fake: false,
    model: process.env.DSB_MODEL ?? "deepseek-chat",
    baseUrl: process.env.DSB_BASE_URL,
    maxRounds: 200,
    costPerCall: Number(process.env.DSB_COST_PER_CALL ?? 0.005),
    git: "git",
    continueOnError: false,
  };
  const next = (i: number): string => argv[i + 1];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--instance": o.instance = next(i); i++; break;
      case "--instances-dir": o.instancesDir = next(i); i++; break;
      case "--work-dir": o.workDir = next(i); i++; break;
      case "--out-dir": o.outDir = next(i); i++; break;
      case "--fake": o.fake = true; break;
      case "--model": o.model = next(i); i++; break;
      case "--base-url": o.baseUrl = next(i); i++; break;
      case "--max-rounds": o.maxRounds = Number(next(i)); i++; break;
      case "--window-tokens": o.windowTokens = Number(next(i)); i++; break;
      case "--history-budget": o.historyBudget = Number(next(i)); i++; break;
      case "--cost-per-call": o.costPerCall = Number(next(i)); i++; break;
      case "--git": o.git = next(i); i++; break;
      case "--project-instruction": o.projectInstruction = next(i); i++; break;
      case "--continue-on-error": o.continueOnError = true; break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        console.error(`Unknown option: ${a}`);
        printHelp();
        process.exit(2);
    }
  }
  return o;
}

function printHelp(): void {
  console.log(`DSBAgent benchmark CLI
Usage:
  node dist-benchmark/cli.js --fake --instance <file.json>
  node dist-benchmark/cli.js --instance <file.json> [--work-dir <dir>] [--model <id>]
  node dist-benchmark/cli.js --instances-dir <dir> [--work-dir <dir>] [--continue-on-error]
Env:
  DSB_API_KEY / DSB_BASE_URL / DSB_MODEL / DSB_COST_PER_CALL (default 0.005 CNY/call)
`);
}
/**
 * 运行单个实例:prepareRepo → buildSession → send → collectPatch。
 * 返回 { patch, summary }。
 */
async function runInstance(
  inst: SwebenchInstance,
  o: CliOptions,
): Promise<{ patch: string; tracker: CostTracker }> {
  const repoDir = prepareRepo(o.workDir, inst, o.git);
  const tracker = new CostTracker(o.costPerCall);
  // 坑一:轨迹全量落盘,PR 需要(缺轨迹会被拒)。禁止压缩/截断。
  fs.mkdirSync(o.outDir, { recursive: true });
  const trajFile = path.join(o.outDir, `${inst.instance_id}.traj.jsonl`);
  const provider = o.fake
    ? new ScriptedProvider([
        // 冒烟脚本:第一轮调用 Bash(git status),第二轮报告完成
        () => ({
          blocks: [
            {
              type: "tool_use",
              id: "smoke-bash",
              name: "Bash",
              input: { command: "git status --short" },
            },
          ],
          toolUses: [{ id: "smoke-bash", name: "Bash", input: { command: "git status --short" } }],
          usage: { inputTokens: 120, outputTokens: 30 },
        }),
        () => ({
          blocks: [{ type: "text", text: "Fix applied. Done." }],
          toolUses: [],
          usage: { inputTokens: 220, outputTokens: 40 },
        }),
      ])
    : buildProvider({ apiKey: process.env.DSB_API_KEY, baseUrl: o.baseUrl, model: o.model });

  const session = buildSession({
    provider,
    workspaceRoot: repoDir,
    workDir: o.workDir,
    projectInstruction: o.projectInstruction,
    maxRounds: o.maxRounds,
    windowTokensOverride: o.windowTokens,
    historyTokenBudget: o.historyBudget,
    tracker,
  });

  const prompt = buildProblemPrompt(inst);
  console.log(`\n=== ${inst.instance_id} ===`);
  await session.send(prompt, (ev: AgentLoopEvent) => {
    // 坑一:每个事件全量写入轨迹 JSONL(含 text_delta;不压缩不截断)
    fs.appendFileSync(trajFile, JSON.stringify({ ts: Date.now(), ...ev }) + "\n");
    switch (ev.type) {
      case "text_delta":
        process.stdout.write(ev.text);
        break;
      case "thinking_delta":
        break; // 打榜静默
      case "tool_call":
        console.log(`\n[tool:${ev.name}] ${ev.status}${ev.detail ? ` ${ev.detail}` : ""}`);
        break;
      case "usage":
        console.log(
          `\n[usage] in=${ev.inputTokens ?? "?"} out=${ev.outputTokens ?? "?"}` +
            ` cache_read=${ev.cacheReadTokens ?? 0} cache_write=${ev.cacheWriteTokens ?? 0}`,
        );
        break;
      case "compaction_stats":
        console.log(`\n[compaction] ${JSON.stringify(ev.stats)}`);
        break;
      case "done":
        console.log("\n[done]");
        break;
      case "error":
        console.error(`\n[error] ${ev.message}`);
        break;
      default:
        break;
    }
  });
  const patch = collectPatch(repoDir, o.git);
  return { patch, tracker };
}
/** 批量运行:串行跑完 instances-dir 下所有实例,增量写 progress.jsonl 与 preds.json。 */
async function runBatch(o: CliOptions): Promise<void> {
  const files = fs.readdirSync(o.instancesDir!).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`No .json files in ${o.instancesDir}`);
  const preds: Record<string, string> = {};
  const progress: unknown[] = [];
  const predsFile = path.join(o.outDir, "preds.json");
  const progressFile = path.join(o.outDir, "progress.jsonl");
  fs.mkdirSync(o.outDir, { recursive: true });
  for (const f of files) {
    const insts = readInstances(path.join(o.instancesDir!, f));
    for (const inst of insts) {
      try {
        const { patch, tracker } = await runInstance(inst, o);
        const s = tracker.summary();
        preds[inst.instance_id] = patch;
        progress.push({ instance_id: inst.instance_id, patchLen: patch.length, ...s, ts: Date.now() });
        fs.writeFileSync(predsFile, JSON.stringify(preds, null, 2));
        fs.writeFileSync(progressFile, progress.map((p) => JSON.stringify(p)).join("\n") + "\n");
        console.log(`\n>>> ${inst.instance_id}: patch ${patch.length} chars, ${s.calls} calls, ¥${s.costCNY.toFixed(3)}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\n>>> ${inst.instance_id}: FAILED ${msg}`);
        if (!o.continueOnError) throw err;
      }
    }
  }
  console.log(`\nBatch done. preds -> ${predsFile}`);
}

/** 单实例运行:输出 preds.json(单条)与 cost 摘要到 stdout。 */
async function runSingle(o: CliOptions): Promise<void> {
  if (!o.instance) throw new Error("--instance required");
  const [inst] = readInstances(o.instance);
  const { patch, tracker } = await runInstance(inst, o);
  const s = tracker.summary();
  fs.mkdirSync(o.outDir, { recursive: true });
  fs.writeFileSync(path.join(o.outDir, "preds.json"), JSON.stringify({ [inst.instance_id]: patch }, null, 2));
  fs.writeFileSync(path.join(o.outDir, `${inst.instance_id}.cost.jsonl`), tracker.toJSONL() + "\n");
  fs.writeFileSync(
    path.join(o.outDir, "manifest.json"),
    JSON.stringify(
      {
        model: o.model,
        baseUrl: o.baseUrl ?? null,
        fake: o.fake,
        maxRounds: o.maxRounds,
        costPerCallCNY: o.costPerCall,
        rolloutCount: 1,
        ts: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`\n>>> ${inst.instance_id}: patch ${patch.length} chars`);
  console.log(`>>> calls=${s.calls} chat=${s.chatCalls} compact=${s.compactCalls} in=${s.inputTokens} out=${s.outputTokens} cache_read=${s.cacheReadTokens} cache_write=${s.cacheWriteTokens}`);
  console.log(`>>> cost≈¥${s.costCNY.toFixed(4)} (cacheHitRate=${s.cacheHitRate === undefined ? "n/a" : (s.cacheHitRate * 100).toFixed(1)}%)`);
}

function main(): void {
  const o = parseArgs(process.argv.slice(2));
  if (!o.fake) ensureGit(o.git);
  if (o.instancesDir) return void runBatch(o).then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
  return void runSingle(o).then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}

main();



