# DSBAgent 打榜路线 & 具体执行路线

> 版本:2026-08-12(由工作区根 `dsb_agent_benchmark_roadmap.txt` 归档;链接与提交方式已于 2026-08-12 联网核实)
> 目标:提升 DSBAgent 在专业圈子的知名度

## 一、前置认知

1. **Artificial Analysis (AA) Coding Agent Index 不接受外部自助提交**。AA 是独立第三方评测机构,自己跑测试、自己发榜单。因此,打榜主战场应选择"明确开放 PR 提交"的榜单。
2. **DSBAgent 的核心差异化卖点**:
   - 模型:DeepSeek V4 Flash(极致性价比)
   - 缓存命中率:~95%
   - 未命中输入 : 输出比 ≈ 6.25 : 1
   - 单次调用成本:高峰 ~0.92 分/次,平峰 ~0.46 分/次
   - 叙事:"用 1/100 的成本达到头部 50% 的效果"
3. 打榜的本质不是"露个脸",而是用开放数据证明 DSBAgent 在某个维度(成本效率、终端能力、记忆系统)做到了极致。

## 二、打榜路线总览(三个梯队)

### 第一梯队:最对口、最硬核、最涨粉

#### 1. SWE-bench-Live(编码 Agent 的"奥运会",最推荐)

- 榜单:https://swe-bench-live.github.io/
- 提交仓库:https://github.com/SWE-bench-Live/submission(开放 PR 提交)
- 特点:首个自动更新、多语言、多 OS 的 SWE 任务集;定期更新数据集,支持无污染评测
- 已收录 agent fork:SWE-agent、OpenHands、ClaudeCode、Win-Agent(Windows 任务)

**提交方式(2026-08-12 核实,以仓库 README 为准)**:

1. Fork `SWE-bench-Live/submission`,clone 其 `submission` 分支:
   ```bash
   git clone your_fork --depth 1 -b submission
   ```
2. 建目录:`submissions/{subset}/{agent_name}/{model_name}/`
3. 放入:
   - `preds.json`:每个实例的 patch
   - `results.json`:SWE-bench-Live 评测脚本生成的评测报告
   - 可选 `logs/` / `trajs/`:agent 轨迹
   - `README`:agent scaffold 与实验设置(rollout 次数、采样方式、迭代次数等)
4. push 到 `submission` 分支 → 向主仓库 main 分支开 PR → 审核通过后上榜

**打榜路径**:

1. 选子集先跑(推荐 Lite 子集起步)
2. 把 DSBAgent 包装成 SWE-bench-Live 要求的 agent 接口(参考 SWE-agent、OpenHands、Win-Agent 的开源实现)
3. 跑完生成 `preds.json` 和 `results.json`
4. Fork → 放文件 → 开 PR → 合并后上榜

**预期效果**:DeepSeek V4 Flash 绝对分数可能不高(Claude Opus 4.6 才 63%),但"性价比"维度会非常突出——完成编码任务成本约为 Claude 的 1/100。

#### 2. Terminal-Bench 2.0 / 3.0(终端 Agent 的标杆)

- 榜单:https://www.tbench.ai/leaderboard/terminal-bench/2.0
- 提交仓库(社区榜单):https://github.com/RDI-Foundation/terminal-bench-leaderboard
- 特点:评测终端 Agent 在真实 CLI 与仓库工作流上的任务通过率

**提交方式(2026-08-12 核实,走 agentbeats 自动评测)**:

1. Fork `RDI-Foundation/terminal-bench-leaderboard`
2. 在 `scenario.toml` 中:
   - `[[participants]]` 下设置 `agentbeats_id`(来自 agentbeats.dev 的 agent ID)
   - 设置 `AGENT_LLM` 为 agent 使用的模型标识(LiteLLM 兼容字符串)
   - API keys 以 GitHub Secrets 提供,用 `${SECRET_NAME}` 引用
3. push 触发 GitHub Actions scenario runner(Docker Compose 跑 Terminal-Bench 2.0),结果自动以 PR 提交
4. 可编辑 `.github/workflows/quick-submit.yml` 的 `num_shards` 做分片并行评测

**前提条件**:agent 需接受标准 Terminal-Bench 2.0 接口的终端任务,并可通过 LiteLLM 兼容模型标识接入(这决定了 wrapper 要以"模型端点"或 agentbeats 接口形态暴露)。

**预期效果**:终端任务是 DSBAgent 的强项(工具调用架构天然适合),能直接证明"DSBAgent 不只是聊天机器人,而是能真正在终端干活的 Agent"。

### 第二梯队:细分领域,适合建立垂直影响力

#### 3. DataAgentBench(数据 Agent 榜)

- 出品:UC Berkeley
- 特点:专测企业级数据任务,明确欢迎社区 PR 提交
- 提交:收集 5 次 run 的 JSON 结果 → 开 PR
- 当前榜首:MinusX,pass@1 仅 63.10%,空间很大

#### 4. EnterprisePlatform Leaderboard(企业工具调用)

- 出品:AST-FRI,基于 A2A 协议
- 测试:Agent 在企业软件(RocketChat、Plane、OwnCloud)上的工具调用
- 提交:Fork 仓库 → 改 scenario.toml → 提交 Docker 镜像

#### 5. Agent Memory Leaderboard(长期记忆榜)

- 启动时间:2026-07-29(首届 Agent Memory Challenge)
- 特点:正在征集参与者,空白赛道,早入场容易占坑
- 适合:DSBAgent 的 Dream 记忆系统

#### 6. ClawBench(Web Agent 榜)

- 适合:如果计划让 DSBAgent 支持浏览器操作
- 提交:通过交互式 Space 提交结果

### 第三梯队:AA 系榜单(不可直接提交,但可作为"对标")

#### 7. Artificial Analysis Coding Agent Index

- 网址:https://artificialanalysis.ai/agents/coding-agents
- 组成:SWE-Bench-Pro-Hard-AA (150题) + Terminal-Bench v2 (84题) + SWE-Atlas-QnA (124题),每个跑 3 次取 pass@1 平均
- 虽然不能直接提交,但可以作为"对标基准":
  1. 先在 SWE-bench-Live 和 Terminal-Bench 2.0 上跑出真实数据
  2. 整理成技术报告,投到 AA 社区论坛或联系 AA 团队
  3. 同时在 GitHub 发布 `dsb-agent-benchmark-results` 仓库
  4. 在社交媒体发布横向对比技术文章

## 三、具体执行路线(三个阶段)

### 阶段一:1-2 周内(建立存在感)

任务清单:

- [ ] 1. SWE-bench-Live Lite 子集:300 个实例
      - Agent:DSBAgent + DeepSeek-V4-Flash
      - 预期耗时:3-5 天连续跑(按当前 814 次/天调用量估算)
- [ ] 2. Terminal-Bench 2.0:84 个任务,每个 5 次 trial
      - 预期耗时:1-2 天
- [ ] 3. 两份结果分别 PR 提交到对应榜单仓库
- [ ] 4. 预期结果:
      - SWE-bench-Live 上 resolve rate 可能不会特别靠前
      - 但"单任务成本"会是全榜最低 → 这是差异化卖点

前置准备:

- 编写 DSBAgent 适配 SWE-bench-Live 的 agent wrapper
- 编写 DSBAgent 适配 Terminal-Bench 2.0 的 agent wrapper
- 确保 token 消耗埋点正常工作(每次调用成本、缓存命中率)

### 阶段二:1 个月内(建立技术品牌)

任务清单:

- [ ] 1. 发布开源仓库:`dsb-agent-benchmark`
      - 包含:所有原始轨迹(trajectories)、与 Claude Code/Cursor 的横向对比数据、成本拆解报告(token 消耗分析)
- [ ] 2. 撰写深度技术博客
      - 推荐标题:《用 DeepSeek V4 Flash + 95% 缓存命中率,我把编码 Agent 的单任务成本打到 $0.04》
      - 发布渠道:Artificial Analysis 社区、Hacker News、V2EX、掘金、知乎
- [ ] 3. 制作可视化数据卡片
      - 每日 token 消耗趋势图、缓存命中率变化曲线、各榜单得分对比雷达图

### 阶段三:3 个月内(冲击头部)

任务清单:

- [ ] 1. 如果阶段一数据不错,冲 SWE-bench-Live Full 子集(300 实例完整跑,约 1-2 周连续运行)
- [ ] 2. 尝试 Agent Memory Leaderboard(首届比赛,空白赛道,先发优势明显)
- [ ] 3. 联系 AA 团队,看能否把 DSBAgent 作为"高性价比 agent"案例纳入报告
- [ ] 4. 持续维护榜单 PR(SWE-bench-Live 会定期更新数据集,需要持续跑、持续提交才能保持在榜上)

## 四、三个必须知道的真相(风险提示)

**真相一:打榜会暴露真实能力上限**
- SWE-bench-Live 上 Claude Opus 4.6 也只有 63%
- DSBAgent + DeepSeek V4 Flash 可能只有 20-30%
- 但这没关系——叙事是"用 1/100 的成本达到头部 50% 的效果"
- 专业圈子里,"性价比极致"比"绝对分数高"更有讨论度

**真相二:榜单不是"提交了就完事"**
- SWE-bench-Live 定期更新数据集
- 需要持续跑、持续提交 PR 才能保持在榜上
- 准备好长期投入(建议至少每月跑一次 Lite 子集)

**真相三:人工提交 PR 是一次严肃的工程投入**
- 需要把 DSBAgent 包装成榜单要求的 agent 接口格式
- SWE-bench-Live Full = 300 个实例
- 按当前 814 次/天调用量,约需 3-5 天连续跑
- 还要写清楚 agent 架构说明
- 这不是营销动作,是工程动作

## 四·补、提交前必读:三个坑(防 PR 被拒 / 预算翻倍)

> 2026-08-12 补充。以下三条是打榜实测中的常见翻车点,写文档前务必先读。

### ⚠️ 坑一:不要为了省钱牺牲可复现性
- 榜单要求提交 `preds.json` + `results.json` + **完整的 rollout 轨迹日志**(trajectories / logs)。
- 半夜跑没问题,但**必须把这些日志完整保存下来**,否则 PR 会被拒。
- 因此 CLI/脚本的默认行为必须"全量落盘":
  - 每实例轨迹 JSONL(每次 provider.round、每次工具调用)
  - `preds.json`(每实例 patch)
  - `results.json`(官方评测脚本产出)
  - 运行元信息:模型、system prompt 版本、rollout 次数、采样方式、时间戳
- 压缩、去重、截断日志以"省空间"的优化一律不做——**完整可复现 > 磁盘占用**。

### ⚠️ 坑二:Terminal-Bench 2.0 要求 5 次 trial
- 每个任务至少跑 **5 次**(-k 5),且 `timeout_multiplier = 1.0`,**不能覆盖超时和资源限制**。
- 这意味着:**每个任务的 agent 成本是单次跑的 5 倍**(84 任务 × 5 = 420 runs)。
- 5 次 trial 的每一次都要记录完整轨迹与通过/失败状态,供榜单核验。
- 这也是为什么"半夜跑"重要——420 runs 串行/低并发要跑很久,占用白天资源不划算。

### ⚠️ 坑三:SWE-bench-Live 要求 3 次回归测试
- 官方说明:"evaluated on each language subset after **filtering out invalid instances by running regression tests three times**"。
- 即:每个实例必须跑 **3 次**回归测试,取有效结果(过滤掉不稳定/无效实例)。
- 对打榜者的直接影响:**实例跑量与成本按 ×3 估算**(300 实例 × 3 = 900 runs 量级,即便部分由官方评测侧完成,也建议自己先跑足量取稳定结果)。
- 提交的 `results.json` 应能体现"3 次回归取有效结果"的过程(失败实例、重试记录、筛选说明)。
- 再次强调半夜跑:900 runs 量级的连续跑,半夜段位 API 便宜且不占用白天工作资源。

> 三坑合一的结论:**打榜是"连续跑大作业",预算是按倍数算的**——TB ×5、SWE ×3,再加调试/重跑余量。成本与时间估算见 §六 更新表。

## 五、反直觉的建议

不要一上来就冲 SWE-bench-Live Full(300 实例完整跑)。

正确顺序:

1. 先跑 Lite 子集(更简单,约 300 实例但难度低)
2. 摸清 DSBAgent 在标准化 benchmark 上的真实表现
3. 如果 Lite 上 resolve rate < 15%:先强化 DSBAgent 的"自主任务拆解"能力,再去打榜,否则上去了也是垫底,反而影响口碑
4. 如果 Lite 上 resolve rate >= 20%:直接进阶段一正式打榜

## 六、成本预算参考(打榜期间的 API 消耗)

> **口径更新(2026-08-12)**:原稿按高峰 0.46~0.92 分/次估算;现按项目实测均值 **≈0.005 元/次调用** 重算(DeepSeek V4 Flash,缓存命中率高)。评测验证(evaluation script)在本地跑测试、不产生 API 费用,仅 agent 运行任务才计费。
> **倍数修正(2026-08-12)**:按「四·补」三坑,**Terminal-Bench 每任务必须跑 5 次 trial(-k 5)、SWE-bench-Live 每实例须 3 次回归取有效结果**——以下调用次数与费用已含倍数。

| 项目 | 预估调用次数(含倍数) | 按 0.005 元/次 | 备注 |
|------|-------------|---------------|------|
| SWE-bench-Live Lite(300 实例 × 3 次回归) | ~7200-12000(2400-4000 × 3) | **~36-60 元** | 每实例 8-13 次调用 × 3 |
| Terminal-Bench 2.0(84 任务 × 5 trial = 420 runs) | ~2100-4200(420-840 × 5) | **~10-21 元** | `-k 5`,`timeout_multiplier=1.0` |
| SWE-bench-Live Full(300 实例 × 3,阶段三) | ~19500-39000 | **~97-195 元** | 实例更难,调用更多 |

**阶段一小计(Lite ×3 + TB ×5):~46-81 元**
**三个阶段全部完成:~150-280 元**

> ⚠️ 不确定性提示:
> 1. `0.005 元/次` 是**日常会话平均**口径;打榜任务上下文更长(长 diff、多文件、长轨迹),单次调用 token 可能高于均值,实际成本可能上浮。
> 2. 调试 wrapper、重跑失败实例、评测验证会额外消耗。
> **建议预留 2 倍余量:阶段一实际预算按 ~100-160 元,全部按 ~300-560 元准备。**
> **最准的做法是"成本探针"**:先跑 1-5 个实例,实测每实例调用次数与 token,再外推 300 实例总成本(见执行计划 T3)。

**结论:打榜 API 成本仍属可控(几百元以内),主要投入是工程时间和注意力;但"坑二/坑三"的 ×5/×3 倍数与完整轨迹日志要求,决定了必须一次性跑对、跑足、跑稳,不能省。**

## 七、关键资源链接(2026-08-12 已核实)

- [x] SWE-bench-Live 榜单:https://swe-bench-live.github.io/
- [x] SWE-bench-Live 提交仓库:https://github.com/SWE-bench-Live/submission
- [x] Terminal-Bench 2.0 榜单:https://www.tbench.ai/leaderboard/terminal-bench/2.0
- [x] Terminal-Bench 2.0 提交仓库:https://github.com/RDI-Foundation/terminal-bench-leaderboard
- [ ] DataAgentBench 仓库:[待查]
- [ ] EnterprisePlatform Leaderboard:[待查]
- [ ] Agent Memory Leaderboard:[待查]
- [ ] ClawBench:[待查]
- [x] Artificial Analysis Coding Agent Index:https://artificialanalysis.ai/agents/coding-agents
- [x] DSBAgent 仓库:https://github.com/hange2017/dsb-agent

## 八、每日执行 Checklist(阶段一示例)

**Day 1**:
- [ ] 编写 SWE-bench-Live agent wrapper
- [ ] 本地跑通 1 个实例(端到端验证)
- [ ] 确认 token 埋点正常

**Day 2-5**:
- [ ] 批量跑 Lite 子集(300 实例)
- [ ] 实时监控:缓存命中率、单次成本、失败率
- [ ] 每天记录消耗数据

**Day 6**:
- [ ] 生成 preds.json + results.json
- [ ] Fork 提交仓库,按目录结构放文件
- [ ] 开 PR

**Day 7**:
- [ ] 编写 Terminal-Bench 2.0 agent wrapper
- [ ] 跑通 1 个任务(5 次 trial)
- [ ] 批量跑 84 个任务

**Day 8**:
- [ ] 生成 Terminal-Bench 结果文件
- [ ] Fork + 放文件 + 开 PR

**Day 9-10**:
- [ ] 整理两份结果,写技术博客初稿
- [ ] 发布到 GitHub + 社交媒体
