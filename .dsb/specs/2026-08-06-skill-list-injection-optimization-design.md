# 技能列表注入优化(去重 + 分层 + 标签化)— 设计

> 日期:2026-08-06
> 状态:**已实施(2026-08-06)**;实现记录与真实模型 A/B 见文末「§7 实施记录」。
> 关联:`.dsb/specs/2026-08-06-session-memory-project-scope-design.md`(本次"上下文优化"任务的三块之一)

---

## 1. 背景与问题(实测数据)

`## 可用技能` 段每轮全量注入 system prompt,存在两个问题:

1. **重复注入(缺陷)**:项目打开时 scaffold 会把打包技能 seed 到 `.dsb/skills/`,而扩展内置又有一份 `skills/`——两份 **37 个同名技能**;`SkillIndex.add()` 按 **name+path** 去重,同名不同路径不合并 → 实际注入 **74 条**(技能列表完整出现两遍)。
2. **全量等权注入(浪费)**:38 个技能(含 23 个 `as-*` 工程包)每条 120 字描述全量注入,其中大部分轮次用不上。

**数据**:去重前注入 ≈ 74 条 × 120 字 ≈ 8880 字符 ≈ **2.2~3K token/轮**(每轮固定开销);其中 `as-*` 工程包描述总长 6062 字符,是 `sp-*`(1709 字符)的 3.5 倍。

## 2. 目标与非目标

### 目标

1. **去重**:同名技能合并为一条,冲突时按 项目 > 用户 > 扩展 > 插件 优先级保留(允许用户有意覆盖扩展版)。
2. **分层注入**:流程包常驻完整描述;工程包折叠为一行短描述;能力发现不丢(agent 仍知道技能存在,需要时加载全文)。

### 非目标

- 不做全量折叠(所有技能只列名字)——省最多但 agent 选技能信息损失过大,风险不可接受;
- 不改技能内容、不改 `Skill` 工具的全文加载语义;
- 不处理"会话中途 system prompt 热更"(沿用现状,新会话生效)。

## 3. 设计

### 3.1 去重(`SkillIndex.add`)

```
add(info):
  existing = skills.find(s => s.name === info.name)
  if (!existing) push(info)
  else if (priority(info.source) > priority(existing.source)) 替换
  // priority: project=4 > user=3 > extension=2 > plugin=1
```

- 插件技能名带 `<plugin>:` 前缀,天然不冲突,不受影响;
- 同名不同路径(项目版 vs 扩展版):保留高优先级层,尊重项目/用户覆盖;
- `source` 字段已存在于 `SkillInfo`,无需改扫描。

### 3.2 分层(`SkillIndex.listForPrompt` / 渲染层)

**tier 推断规则**(不依赖 SKILL.md 新字段,零改动扫描器):

| 条件 | tier | 注入方式 |
|------|------|----------|
| `source` 为 `project` / `user`(用户自定义) | `full` | 完整 120 字描述(尊重用户内容,不折叠) |
| name 以 `sp-` 或 `using-` 开头(流程包) | `full` | 完整 120 字描述(流程纪律不可折叠) |
| 其余(扩展/插件内置 `as-*` 工程包等) | `compact` | 一行 ≤40 字:截取 description 开头 + `…` |

**渲染格式**(`buildSystemPrompt` 技能段):

```
## 可用技能
- sp-brainstorming: You MUST use this before any creative work...   ← full
- using-dsb-skills: How to find and apply bundled skills...
- as-api-and-interface-design: Guides stable API and interface desi… ← compact(40字)
- as-ci-cd-and-automation: Automates CI/CD pipeline setup. Use wh…
(完整技能描述可用 Skill 工具按需加载;打包技能见 `sp-*` 流程包与 `as-*` 工程包)
```

**紧凑描述截取**:`compact` 描述 = `description` 规范化后 `slice(0, 40)`(含尾 `…`),保留 "Use when..." 场景头,足以触发 agent 的"我需要查一下全文"。

**效果估算**:

| 阶段 | 注入字符 | 相对现状 |
|------|---------|---------|
| 现状(重复) | ~8880 | — |
| 去重后 | ~4440 | -50% |
| 去重 + 分层 | ~2600 | **-70%**(≈ 0.7K token/轮) |

### 3.3 边界与回退

| 场景 | 行为 |
|------|------|
| 用户自定义技能与扩展同名 | 保留用户版(source 优先级),用户版一律 full |
| 无 description 的技能 | 渲染 `- name`(仅名字),不崩溃 |
| 紧凑描述被截断后语义不明 | 属于可接受权衡;agent 可 Skill 加载全文 |
| 插件市场多个同名技能 | 插件名前缀天然隔离,不受影响 |
| 去重后数量变化 | 与 `/su` 命令同一索引源,行为一致(索引本身去重) |

## 4. 影响文件

| 文件 | 变更 |
|------|------|
| `src/plugins/skillIndex.ts` | `add()` 按 name + source 优先级去重;`listForPrompt()` 按 tier 输出 full/compact |
| `src/agent/systemPrompt.ts` | 技能段按 `{name, description, compact}` 渲染 compact 分支;提示行补充"按需加载全文" |
| `src/projectContext/skillsScan.ts` | 无需改(不新增 frontmatter 字段) |
| 测试 | `SkillIndex` 去重/优先级/tier 推断单测;`buildSystemPrompt` 渲染长度断言 |

## 5. 测试计划

- 去重:同 source 同名只留 1;project 覆盖 extension 同名;plugin 前缀不误伤;
- tier:project/user → full;sp-*/using-* → full;as-* → compact(≤40 字);
- 渲染:full 与 compact 混排、无 description 退化、提示行存在;
- 回归:74 条重复场景(seed + 内置)下注入条数 = 37;`/su` 技能列表与注入索引一致。

## 6. 修订历史

| 日期 | 说明 |
|------|------|
| 2026-08-06 | 初版:用户确认"去重 + 分层"方案后编写;含实测数据(74 条重复、字符分布) |
| 2026-08-06 | 追加 §7:标签化压缩实施记录(方案演进、A/B 验证、偏差) |

---

## 7. 实施记录(标签化压缩,方案演进)

> 分层落地后,"紧凑描述 ≤40 字 / full 描述 120 截断"仍存在**触发条件丢失**:as-* 工程包描述为 `<作用句>. Use when A. Use when B. …`,120 截断恰好砍在第二个 Use when 中段,后续触发条件(尤其"何时该用")全部不可见。2026-08-06 增补**标签化压缩**方案。

### 7.1 方案:作用句 + `#触发标签`

`src/plugins/skillDescription.ts`(纯函数,无 vscode 依赖):

```
输入:Guides stable API and interface design. Use when designing APIs,
     module boundaries, or any public interface. Use when creating REST …
输出:Guides stable API and interface design. #designing-apis #module-boundaries #public-interface
```

- **切分**:按 `Use when` / `Use before`(兼容 as-code-review 句式)分段;作用句 ≤80 字(超长截断 + `…`);
- **标签**:每个触发子句去停用词(虚词表)后取前 2 实词 → `#kebab-case`;最多 **3 个/技能**(`MAX_TAGS`),预算内优先覆盖前几个触发条件;
- **回退**:无 `Use when/before` 结构(sp-brainstorming、using-dsb-skills、typescript-setup)→ 返回 null,走原 120 截断逻辑,零破坏;
- **接入**:`SkillIndex.listForPrompt()` 对 full tier 优先标签化,输出标 `compact:true` 免去渲染层二次截断。

### 7.2 确定性验证(全部通过)

| 项 | 结果 |
|----|------|
| 单元测试(输出精确/空 lead/Use before/去重/null 回退/截断/限数) | 8 通过 |
| 真实 37 技能扫描:标签词可回溯原文(**零幻觉**) | 通过 |
| 成本:38 技能注入 3974 → 3510 字符 | **−12%**,不增 |
| 触发条件覆盖 | 1.5 个/技能 → **3 个/技能** |
| 既有 SkillIndex 测试零改动 | 通过 |
| 全量 vitest(606)+ tsc + compile | 通过 |

### 7.3 真实模型 A/B(deepseek-chat,60 样本/版本)

实验脚本:`scripts/experiments/ab-skill-discovery.mjs`(12 意图 × 2 版本 × 5 次;黄金答案标注)。

| 版本 | 精确命中 | 模糊命中 |
|------|---------|---------|
| 现状(120 截断) | 42/60(**70%**) | 49/60(82%) |
| 标签化 | 53/60(**88%**) | 58/60(**97%**) |

**差异用例**(触发点原位于 120 截断区):

| 意图 | 现状 | 标签化 | 原因 |
|------|------|--------|------|
| 需求含糊,用提问澄清(`as-interview-me`) | 3/5 | **5/5** | `#ask-underspecified` 可见,现状截断看不到触发词 |
| 提交前审查改动(`sp-requesting-code-review`) | 0/5 | **4/5** | 现状全答 `as-code-review-and-quality`;标签 `#merging-verify` 命中 |
| 想法模糊先理清(`as-idea-refine`) | 1/5 | **5/5** | 现状 4 次误选 `sp-brainstorming` |

12 用例中:**3 胜 0 负 9 平**;无任何用例回退。唯一"未命中"(TDD)为黄金标注歧义(`sp-test-driven-development` 亦为合理答案),非版本缺陷。

### 7.4 偏差与遗留

- **sp-\* 空 lead 处理**:描述以 `Use when` 开头时,作用句取首个条件原文截断(≤80 字)+ 标签,渲染略长于 120 截断(纪律型技能,可接受);总量仍 −12%;
- 停用词表为启发式,缩写残留(doesn't 等)已补表;极端句式可能产生次优标签,但不产生幻觉(可回溯断言兜底);
- 未做:标签权重/排序优化、技能名→标签的语义对齐。`
