#!/usr/bin/env node
/**
 * CI 门禁:扫描「瞬时参数省略标记」独立成行形态,防止污染混进 main。
 *
 * 背景:模型在历史里看到被精简掉的工具参数占位标记后,复述进 Write.contents /
 * StrReplace.new_string 会把它当真实内容写盘。运行时已有两道防线(写前守卫
 * isTransientSummaryText + 写后自检回滚),本脚本是第三道:仓库级静态门禁,
 * 拦住任何「标记作为独立一行」进入版本库的情况(守卫抓不到的历史遗留/手工粘贴)。
 *
 * 判定(逐行,trim 后):
 *   1. 形如 `[TRANSIENT-SUMMARY field=... chars=N]`;或
 *   2. 以 `[瞬时参数已省略` 开头且整行长度 <= 320 字符。
 * 只报「独立成行」的标记形态:正文中引用标记(长行/句中引用)不误报。
 *
 * 用法:
 *   node scripts/scan-transient-pollution.mjs            # 扫描仓库(退出码 1 = 发现污染)
 *   node scripts/scan-transient-pollution.mjs --self-test # 自检判定算法
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const ZH_PREFIX = "[" + "\u77ac\u65f6\u53c2\u6570\u5df2\u7701\u7565";
const SUMMARY_RE = /^\[TRANSIENT-SUMMARY field=[^\n]* chars=\d+\]/;

/** 扫描文本,返回命中的行(已 trim,截断到 160 字符)。 */
export function scanText(text) {
  const hits = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (SUMMARY_RE.test(line)) {
      hits.push(line.slice(0, 160));
      continue;
    }
    if (line.length <= 320 && line.startsWith(ZH_PREFIX)) hits.push(line.slice(0, 160));
  }
  return hits;
}

/** 跳过的目录(构建产物 / 依赖 / 快照 / 缓存)。 */
const SKIP_DIRS = new Set([
  "node_modules", "dist", "out", "coverage", "__pycache__", "checkpoints",
]);
/** 只扫文本文件后缀。 */
const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".py", ".sh", ".yml", ".yaml", ".txt",
]);
/**
 * 白名单(相对仓库根的 POSIX 路径前缀):
 *  - 检测器自身:以字符串字面量声明标记前缀,属正常代码;
 *  - tests/:单测需构造标记样本断言「会被拒绝」。
 */
const ALLOW = ["src/agent/toolUsePolicy.ts", "tests/"];

function isAllowed(rel) {
  return ALLOW.some((p) => (p.endsWith("/") ? rel.startsWith(p) : rel === p));
}

function walk(dir, root, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.name === ".git" || e.name === ".vscode-test") continue;
      walk(full, root, out);
      continue;
    }
    if (!TEXT_EXT.has(path.extname(e.name))) continue;
    const rel = path.relative(root, full).split(path.sep).join("/");
    // .dsb/checkpoints 是会话快照(历史现场留痕),不是仓库产物
    if (rel.startsWith(".dsb/checkpoints/")) continue;
    if (isAllowed(rel)) continue;
    out.push({ rel, full });
  }
}

function selfTest() {
  const zh = ZH_PREFIX + ":new_string 500 \u5b57\u7b26;\u5185\u5bb9\u5df2\u5728\u6587\u4ef6\u7cfb\u7edf\u4e2d]";
  const sum = "[TRANSIENT-SUMMARY field=contents chars=999]";
  const cases = [
    ["独立成行的中文标记", ["\u6b63\u5e38\u884c", zh, "\u6b63\u5e38\u884c"].join("\n"), 1],
    ["独立成行的 TRANSIENT-SUMMARY", ["a", sum, "b"].join("\n"), 1],
    ["缩进后的标记仍算独立成行", "    " + zh, 1],
    ["句中引用不算(前缀不在行首)", "\u8bf4\u660e:" + zh, 0],
    ["超长整行引用不算", "\u8bf4\u660e:" + zh + "x".repeat(400), 0],
    ["错误/正常文档为 0", "\u5b8c\u5168\u6b63\u5e38\u7684\u6587\u6863\u5185\u5bb9\n\u7b2c\u4e8c\u884c", 0],
  ];
  let bad = 0;
  for (const [name, text, want] of cases) {
    const got = scanText(text).length;
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? "  \u2713" : "  \u2717"} ${name}: got=${got} want=${want}`);
  }
  if (bad > 0) {
    console.error(`self-test FAILED (${bad} case(s))`);
    return 1;
  }
  console.log("self-test OK");
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) return selfTest();

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = [];
  walk(root, root, files);

  const findings = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f.full, "utf8");
    } catch {
      continue;
    }
    const hits = scanText(text);
    if (hits.length === 0) continue;
    const lines = text.split("\n");
    for (const h of hits) {
      const idx = lines.findIndex((l) => l.trim() === h || l.trim().startsWith(h));
      findings.push({ rel: f.rel, line: idx + 1, sample: h });
    }
  }

  if (findings.length === 0) {
    console.log(`scan-transient-pollution: OK (${files.length} files scanned, 0 pollution)`);
    return 0;
  }
  console.error(`scan-transient-pollution: FOUND ${findings.length} pollution line(s):`);
  for (const f of findings) console.error(`  ${f.rel}:${f.line}  ${f.sample}`);
  console.error("\n这些行是「瞬时参数省略标记」被写入文件的证据(真实内容在文件系统里,标记不是内容)。");
  console.error("修复:用 Read 取回真实内容后重写该段;若属有意保留的样例,请加入脚本白名单并说明理由。");
  return 1;
}

process.exit(main());
