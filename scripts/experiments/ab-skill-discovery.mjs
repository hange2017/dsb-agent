#!/usr/bin/env node
/**
 * A/B 对比实验:技能描述「现状 120 截断」 vs 「标签化压缩」在真实大模型上的技能发现差异。
 *
 * 原理:给模型同一批"用户意图",分别配两种版本的 `## 可用技能` 列表,
 * 让模型选择要加载的技能,对比命中黄金答案的比例。
 *
 * 运行(需要 API key):
 *   DSB_LLM_API_KEY=sk-xxx node scripts/experiments/ab-skill-discovery.mjs
 * 可选:
 *   --model deepseek-chat
 *   --base-url https://api.deepseek.com/anthropic
 *   --runs 2           每个(意图×版本)的重复次数
 *   --skills-dir .dsb/skills   技能目录,默认 .dsb/skills
 * 无 key 时以 dry-run 模式运行:仅验证装配与请求构造,不发网络请求。
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..", "..");

// ---------- 参数 ----------
const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const API_KEY = process.env.DSB_LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";
const MODEL = argVal("--model", "deepseek-chat");
const BASE_URL = argVal("--base-url", "https://api.deepseek.com/anthropic").replace(/\/+$/, "");
const RUNS = parseInt(argVal("--runs", "2"), 10);
const SKILLS_DIR = path.resolve(REPO, argVal("--skills-dir", ".dsb/skills"));
const DRY = !API_KEY;

// ---------- 技能装配(复用项目解析逻辑) ----------
function parseSkillDescription(raw) {
  const lines = raw.split("\n");
  const idx = lines.findIndex((l) => /^description:\s*/.test(l));
  if (idx < 0) return "";
  const first = lines[idx].replace(/^description:\s*/, "").trim();
  const stripQuotes = (s) => s.replace(/^["']|["']$/g, "").trim();
  if (first && !["|", ">", "|-", ">-"].includes(first)) return stripQuotes(first);
  const collected = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s{2,}(.*)$/);
    if (!m) break;
    collected.push(m[1].trim());
  }
  return stripQuotes(collected.join(" "));
}
function scanSkills(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const f = path.join(dir, e.name, "SKILL.md");
    if (!fs.existsSync(f)) continue;
    out.push({ name: e.name, description: parseSkillDescription(fs.readFileSync(f, "utf8")) });
  }
  return out;
}

// ---------- 加载标签化压缩实现(esbuild 构建后 import) ----------
const built = await build({
  entryPoints: [path.join(REPO, "src", "plugins", "skillDescription.ts")],
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "error",
});
const src = built.outputFiles[0].text;
const mod = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
const { summarizeSkillDescription, renderSkillSummary } = mod;

// ---------- 两种列表版本 ----------
function truncate120(desc) {
  const d = desc.replace(/\s+/g, " ").trim();
  return d.length > 120 ? `${d.slice(0, 117)}...` : d;
}
function renderList(version) {
  const skills = scanSkills(SKILLS_DIR);
  const lines = skills.map((s) => {
    if (version === "tagged") {
      const r = summarizeSkillDescription(s.description);
      return `- ${s.name}: ${r ? renderSkillSummary(r) : truncate120(s.description)}`;
    }
    return `- ${s.name}: ${truncate120(s.description)}`;
  });
  return [
    "You are a coding agent with access to a skill library. Given a user request,",
    "pick the ONE most relevant skill to load, and answer with ONLY the skill name.",
    "",
    "## 可用技能",
    ...lines,
  ].join("\n");
}

// ---------- 黄金答案(意图 → 应命中的技能) ----------
const GOLDEN = [
  { intent: "帮我设计一个稳定的模块间 API 接口,并定好类型契约", skill: "as-api-and-interface-design" },
  { intent: "这个需求描述得很含糊,连用户到底要什么都不清楚,帮我通过提问把意图弄清楚", skill: "as-interview-me" },
  { intent: "页面加载太慢,帮我查 Core Web Vitals 和 N+1 查询", skill: "as-performance-optimization" },
  { intent: "我们要把旧的支付系统迁移到新的实现,还要决定是否淘汰老代码", skill: "as-deprecation-and-migration" },
  { intent: "测试失败了,构建也挂了,帮我系统地排查根因,不要瞎猜", skill: "as-debugging-and-error-recovery" },
  { intent: "上线前帮我准备生产发布:预发布清单、监控和回滚策略", skill: "as-shipping-and-launch" },
  { intent: "我要用 TDD 写这个新功能,先写测试再写实现", skill: "as-test-driven-development" },
  { intent: "提交之前帮我审查一下这次代码改动是否满足需求", skill: "sp-requesting-code-review" },
  { intent: "给我这段代码做多维度质量审查,涉及自己写的和别人写的代码", skill: "as-code-review-and-quality" },
  { intent: "生产环境出问题了,我要加日志、指标和告警来观察线上行为", skill: "as-observability-and-instrumentation" },
  { intent: "在真实浏览器里调试这个页面,看 DOM 和控制台报错", skill: "as-browser-testing-with-devtools" },
  { intent: "我的想法还很模糊,帮我先理清假设再决定做不做", skill: "as-idea-refine" },
];

// ---------- 模型调用(Anthropic /messages 协议) ----------
async function ask(system, userText) {
  if (DRY) {
    return `[dry-run] would call ${BASE_URL}/v1/messages model=${MODEL}`;
  }
  const resp = await fetch(`${BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 64,
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`API ${resp.status}: ${t.slice(0, 300)}`);
  }
  const data = await resp.json();
  const text = (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
  return text;
}

// ---------- 评分 ----------
function hit(text, golden) {
  return (text ?? "").includes(golden);
}
function fuzzyHit(text, golden) {
  const core = golden.replace(/^(as|sp|using)-/, "").split("-").slice(0, 2).join("-");
  return (text ?? "").includes(core);
}

// ---------- 主流程 ----------
console.log(`技能目录: ${SKILLS_DIR}`);
console.log(`模型: ${MODEL}  base: ${BASE_URL}  runs: ${RUNS}  模式: ${DRY ? "DRY-RUN(未设 DSB_LLM_API_KEY)" : "真实调用"}`);
console.log(`技能数: ${scanSkills(SKILLS_DIR).length}`);
console.log("");

const versions = ["truncated", "tagged"];
const systems = Object.fromEntries(versions.map((v) => [v, renderList(v)]));
for (const v of versions) {
  console.log(`--- 版本 ${v}(前 4 行) ---`);
  console.log(systems[v].split("\n").slice(3, 7).join("\n"));
  console.log("");
}

const stats = Object.fromEntries(versions.map((v) => [v, { exact: 0, fuzzy: 0, total: 0 }]));
const detail = [];
for (const { intent, skill } of GOLDEN) {
  for (const v of versions) {
    for (let r = 0; r < RUNS; r++) {
      let text;
      try {
        text = await ask(systems[v], intent);
      } catch (err) {
        console.error(`调用失败(${v}/${intent.slice(0, 12)}…):`, err.message);
        process.exitCode = 1;
        continue;
      }
      const e = hit(text, skill);
      const f = fuzzyHit(text, skill);
      stats[v].total++;
      if (e) stats[v].exact++;
      if (f) stats[v].fuzzy++;
      detail.push({ intent, skill, v, text, e, f });
    }
  }
}

// ---------- 结果 ----------
console.log("=".repeat(72));
console.log("命中统计(黄金技能名精确匹配 / 模糊核心匹配):");
for (const v of versions) {
  const s = stats[v];
  const pct = (n) => (s.total ? `${((n / s.total) * 100).toFixed(0)}%` : "-");
  console.log(`  ${v.padEnd(9)} 精确 ${s.exact}/${s.total} (${pct(s.exact)})   模糊 ${s.fuzzy}/${s.total} (${pct(s.fuzzy)})`);
}
if (!DRY) {
  console.log("");
  console.log("逐条明细(差异行):");
  const byIntent = new Map();
  for (const d of detail) {
    if (!byIntent.has(d.intent)) byIntent.set(d.intent, []);
    byIntent.get(d.intent).push(d);
  }
  for (const [intent, rows] of byIntent) {
    const [t, g] = [rows.filter((x) => x.v === "truncated"), rows.filter((x) => x.v === "tagged")];
    const te = t.filter((x) => x.e).length;
    const ge = g.filter((x) => x.e).length;
    const marker = ge > te ? "▲标签版更优" : ge < te ? "▼现状版更优" : "=";
    console.log(`  [${marker}] ${intent.slice(0, 30)}… → ${rows[0].skill}`);
    for (const d of rows) {
      console.log(`       ${d.v.padEnd(9)} ${d.e ? "命中" : "未中"} | ${(d.text ?? "").slice(0, 60)}`);
    }
  }
}
console.log("");
console.log(DRY ? "DRY-RUN 完成(未发请求)。设置 DSB_LLM_API_KEY 后运行真实对比。" : "实验完成。");
