# DSBAgent 打榜工作手册(虚拟机执行版)

> 版本:2026-08-12(由 Windows 工作区生成,同步至虚拟机仓库)
> 目标:**阶段一上榜** —— SWE-bench-Live Lite(300 实例)+ Terminal-Bench 2.0(84 任务 × 5 trial),以"单任务成本全榜最低"为差异化卖点。
> 本手册自包含:进度快照、分步操作、命令、三坑、探针脚本全文。放到虚拟机仓库任意位置即可按章推进。

---

## 一、当前进度快照(2026-08-12)

### ✅ 已完成

| 项 | 状态 | 证据 |
|----|------|------|
| 路线归档 | ✅ | `.dsb/docs/benchmark/benchmark-roadmap.md`(提交方式已联网核实) |
| 执行计划 | ✅ | `.dsb/plans/2026-08-12-benchmark-execution-plan.md`(T1-T8) |
| **T1** headless CLI | ✅ | `benchmark/` 8 文件:`cli.ts / deps.ts / provider.ts / stats.ts / swebench.ts / smoke.test.ts / build.mjs / README.md` |
| T1 冒烟测试 | ✅ | 虚拟机上 5/5 用例通过(agent 循环 + Bash 工具 + patch 提取 + 成本统计,零费用) |
| vitest 配置修复 | ✅ | `vitest.config.ts` include 加入 `benchmark/**/*.test.ts`(此前冒烟报 No test files found) |
| 三个提交坑落地 | ✅ | 轨迹全量落盘 / TB `-k 5` / SWE 3 次回归(文档 + CLI 行为) |

### ⏳ 进行中 / 未完成

| 项 | 说明 |
|----|------|
| **T3 成本探针**(下一步) | 跑 5 个代表性实例,实测调用次数/成本/缓存命中率 |
| T4 批量 300 实例 × 3 回归 | 需在 T3 数据确认后放量 |
| T5 结果生成 + PR 提交 | 官方 evaluation script + submission 仓库 |
| T6-T8 Terminal-Bench 2.0 | 适配 + 结果 + 技术内容 |
| git 同步 | Windows 侧 3 个 commit 未推送(网络不稳),见 §二 |

---

## 二、git 同步状态与处理(先读!)

### 三地状态

| 位置 | HEAD | 说明 |
|------|------|------|
| GitHub `origin/main` | `b1f1fd9` | T1 已推送 |
| 虚拟机本地 | `b1f1fd9` + `a2d5a7c` | `a2d5a7c` = vitest 修复(本地未推送) |
| Windows 本地 | `b1f1fd9` + `a79548a` + `a62c118` | `a79548a` = vitest 修复(**内容与 a2d5a7c 相同**);`a62c118` = probe 脚本(未推送) |

### 重要

- 虚拟机 `a2d5a7c` 与 Windows `a79548a` 改的是同一个文件(`vitest.config.ts`)且**内容完全相同**,只是 commit hash 不同 → 历史会分叉,必须统一。
- **统一方案(推荐)**:等 Windows 网络恢复把 `a79548a + a62c118 + 本手册` 推送后,虚拟机执行:

```bash
cd <仓库目录>
git fetch origin
git reset --hard origin/main    # 丢弃本地 a2d5a7c(内容与远程相同,无损失)
```

- **若 Windows 一直推不上去**(网络被墙):虚拟机手动创建 probe 脚本(全文见 §五附录),本手册即全部所需;历史分叉以后再说,不影响打榜推进。

---

## 三、环境确认(虚拟机一次性)

```bash
cd <仓库目录>
git pull origin main        # 拉到最新(至少要有 benchmark/ 目录)
npm install                 # 若无新依赖会显示 up to date
npm run benchmark:build     # 输出 dist-benchmark/cli.js
npm run benchmark:smoke     # 5/5 全绿(零费用)
```

**通过标准**:`dist-benchmark/cli.js` 生成;冒烟 5/5。

---

## 四、T3 成本探针(现在做,先验证再放量)

> 目的:实测每实例真实调用次数/成本/缓存命中率,外推 300 实例总成本,回填路线文档 §六。

### 步骤 1:确保 probe 脚本存在

```bash
ls benchmark/scripts/probe-instances.mjs
```

- 存在 → 跳过;
- 不存在 → 用 §五附录全文创建。

### 步骤 2:生成 5 个探针实例(按难度取样:最简/1/4/中位/3/4/最难)

```bash
node benchmark/scripts/probe-instances.mjs
```

预期输出:
```
fetching lite rows 0-99 ...
fetching lite rows 100-199 ...
fetching lite rows 200-299 ...
total 300 instances
probe-01 <id> files=? hunks=? lines=?
... (5 行)
5 probe instances written to benchmark/out/probe
```

### 步骤 3:设置环境变量(真实 API key)

```bash
export DSB_API_KEY=sk-你的key
export DSB_BASE_URL=https://api.deepseek.com
export DSB_MODEL=deepseek-chat
# 可选:export DSB_COST_PER_CALL=0.005   # 默认即 0.005 元/次
```

### 步骤 4:跑 5 个探针实例(真实调用,约几毛钱)

```bash
node dist-benchmark/cli.js --instances-dir benchmark/out/probe --work-dir benchmark/out/work
```

### 步骤 5:判读结果

```bash
cat benchmark/out/progress.jsonl
```

每行包含:`instance_id / patchLen / calls / chatCalls / compactCalls / inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens / costCNY / cacheHitRate / compactions / ts`

**判读标准**:

| 指标 | 合理区间 | 不达标怎么办 |
|------|---------|-------------|
| calls / 实例 | 8-13 次 | 若 >20:精简 system prompt / 调大窗口降压缩 |
| costCNY / 实例 | ≈ 0.005 × calls(几毛钱) | 明显偏高:查 cacheHitRate |
| cacheHitRate | ~95%(预期) | 偏低:检查 baseUrl 是否走 DeepSeek 缓存 |
| patchLen | > 0 | 空 patch = 模型没改到文件,需看轨迹定位 |
| resolve(可选) | 本地跑官方评测确认 | 格式不符 → T5 前修 patch 提取 |

**探针结论要回填**:
- 实测每实例平均调用次数 × 300 × 3(回归)→ 外推总成本,更新路线文档 §六与执行计划 §5.1;
- 实测单价成为 PR README 的成本披露数据("单任务成本全榜最低"的实证)。

---

## 五、T4 批量跑 Lite 300 实例(坑一/坑三)

> **前置**:T3 探针通过且成本可控。⚠️ 三坑见 §八,先读再跑。

### 排期与量级(必须按此规划)

- 300 实例 × **3 次回归**(坑三)= **900 runs**
- 每实例 8-13 次调用 → 总调用 ~7200-12000 次
- 按 0.005 元/次 → **~36-60 元**(阶段一 SWE 部分)
- 机器慢只影响耗时、不影响结果;建议 **4-8 并发、半夜跑**、断点续跑

### 数据准备:下载 Lite 全量 300 实例

```bash
# 用探针脚本同款 API 拉全部 300 行,或下载官方 parquet/json 转成 CLI 格式
# CLI 批量模式读目录下所有 .json,每个文件可以是单实例对象或数组
```

每个实例文件最小字段:`instance_id / repo / base_commit / problem_statement`(参考 probe 脚本的 slim 函数)。

### 跑批命令

```bash
node dist-benchmark/cli.js \
  --instances-dir benchmark/out/instances \
  --work-dir benchmark/out/work \
  --continue-on-error
```

### 坑一落实(已内置)

- 每实例自动生成 `<instance_id>.traj.jsonl`(全量轨迹,不压缩不截断)
- `preds.json`(全部 patch)、`progress.jsonl`(进度+成本)、`manifest.json`(运行元信息)
- **PR 门槛**:`preds.json + results.json + trajs/` 缺一被拒

### 坑三落实(3 次回归)

CLI 目前单次跑 1 个 rollout。**3 次回归**建议:
- 方式 A:同一实例文件放 3 个不同输出目录各跑一遍(`--out-dir out-run1/out-run2/out-run3`),3 次轨迹全留;
- 方式 B:后续给 CLI 加 `--rollouts N` 参数(每实例连跑 N 次,自动标注 trial 序号)——若选 A 更简单就先 A。
- 3 次记录(含失败/重试/筛选)一并归档进 `results.json` 素材。

### 断点续跑

- 已完成实例在 `<work>/<instance_id>/` 已 clone,`prepareRepo` 会跳过重复 clone;
- 失败实例靠 `--continue-on-error` 不中断批次;重跑按 `progress.jsonl` 剔除已完成的。

### 实时监控(可选)

```bash
# 每跑一段就看
cat benchmark/out/progress.jsonl
# 统计:成功数 / 平均 calls / 平均成本
```

---

## 六、T5 结果生成 + PR 提交(SWE-bench-Live)

### 1. 本地评测(官方 evaluation script)

- 官方脚本在 clone 的 repo 内应用 `preds.json` 的 patch → 跑 FAIL_TO_PASS / PASS_TO_PASS 测试。
- 3 次回归:每实例跑 3 遍测试,过滤无效实例后取有效结果(坑三)。

### 2. 提交 PR(已核实的真实流程)

1. Fork `SWE-bench-Live/submission`;
2. 在 fork 上建 `submissions/lite/dsb-agent/deepseek-v4-flash/` 目录(具体子集名按官方最新要求);
3. 放入:
   - `preds.json` — `{ instance_id: patch }`
   - `results.json` — 官方评测输出
   - `trajs/` — 每实例轨迹 JSONL(坑一,缺了 PR 被拒)
   - `README.md` — scaffold / rollout 次数(注明 3 次回归)/ 采样方式 / **成本披露**(探针实测数据)
4. 开 PR 到 `SWE-bench-Live/submission`,在 leaderboard 状态核对上榜。

---

## 七、T6-T8 Terminal-Bench 2.0

- 已核实:提交走 `RDI-Foundation/terminal-bench-leaderboard`,`scenario.toml` + `agentbeats_id` + LiteLLM 兼容模型标识,GitHub Actions + Docker Compose 自动评测。
- 两条路径(实现时选通):
  - **a) 模型端点形态**:把 DSBAgent 引擎包成 LiteLLM 兼容"模型"端点(任务作为 user 消息,工具循环在服务端跑)——需在基准仓库侧配 API keys;
  - **b) 本地 runner 形态**:官方 harness + DSBAgent wrapper 本地跑,产出通过率/成本对比报告(适合阶段二技术文章,同时为 a) 铺路)。
- **坑二**:每任务 **5 次 trial**(`-k 5`),`timeout_multiplier = 1.0`,不得覆盖超时与资源限制;5 次轨迹与通过/失败记录都要留。
- 84 任务 × 5 trial = 420 runs,~2100-4200 次调用,**~10-21 元**。

---

## 八、三个坑速查(PR 被拒 / 预算翻倍的头号原因)

1. **坑一(可复现性)**:提交必须含 `preds.json + results.json + 完整 rollout 轨迹`。**禁止**压缩/截断/去重日志省空间。CLI 已默认全量落盘。
2. **坑二(TB 5 trial)**:每任务 ≥5 次(`-k 5`),`timeout_multiplier=1.0` 不得覆盖 → 成本 ×5。
3. **坑三(SWE 3 次回归)**:每实例跑 3 次回归取有效结果 → 成本 ×3。`results.json` 要体现 3 次过程。

---

## 九、成本参考表(2026-08-12 口径,0.005 元/次)

| 项目 | 调用次数 | 费用 | 备注 |
|------|---------|------|------|
| SWE-bench-Live Lite(300 × 3 回归) | ~7200-12000 | **~36-60 元** | 8-13 calls/实例 ×3 |
| Terminal-Bench 2.0(84 × 5 trial) | ~2100-4200 | **~10-21 元** | `-k 5`,timeout=1.0 |
| **阶段一小计** | | **~46-81 元** | 预留 2 倍 → ~100-160 元 |
| SWE-bench-Live Full(阶段三) | ~19500-39000 | ~97-195 元 | 实例更难 |

> ⚠️ `0.005 元/次` 是日常会话均值;打榜上下文更长,单次 token 可能上浮 1.5-2 倍。**以 T3 探针实测为准。**

---

## 十、常用命令速查

```bash
# 构建 + 冒烟
npm run benchmark:build
npm run benchmark:smoke

# 单实例(真实)
node dist-benchmark/cli.js --instance <file.json> --work-dir benchmark/out/work

# 单实例(冒烟,零费用)
node dist-benchmark/cli.js --fake --instance <file.json>

# 批量
node dist-benchmark/cli.js --instances-dir <dir> --work-dir benchmark/out/work --continue-on-error

# 查看进度
cat benchmark/out/progress.jsonl
```

---

## 附录 A:probe-instances.mjs 全文(若仓库缺失则创建)

```bash
mkdir -p benchmark/scripts
```

文件 `benchmark/scripts/probe-instances.mjs`:

```js
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
```
