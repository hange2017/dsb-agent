# 技能列表注入优化(去重 + 分层 + 标签化)验收记录

> 日期:2026-08-06 · 对应计划:Phase A(A1/A2)+ 标签化增量(任务 t29–t30)
> 设计:`.dsb/specs/2026-08-06-skill-list-injection-optimization-design.md`(状态:已实施)

## 交付清单

| 模块 | 文件 | 说明 |
|------|------|------|
| 去重 | `src/plugins/skillIndex.ts` | `add()` 按 name 去重,source 优先级 project(4)>user(3)>extension(2)>plugin(1) |
| 分层 | `src/plugins/skillIndex.ts` `listForPrompt()` | project/user 与 `sp-*`/`using-*` → full;其余 → compact(≤40 字) |
| 标签化 | `src/plugins/skillDescription.ts`(新) | `summarizeSkillDescription`:`Use when/before` 条件 → `#kebab` 标签(≤3/技能);作用句 ≤80 字;无结构回退 null |
| 渲染 | `src/agent/systemPrompt.ts`(既有) | full 走 120 兜底截断;标签化输出标 compact 免二次截断 |
| 实验 | `scripts/experiments/ab-skill-discovery.mjs`(新) | 真实模型 A/B:12 意图 × 2 版本 × N 次,黄金答案标注 |

## 测试证据

```
npx vitest run              → 77 files / 606 tests 全绿(新增 11:skillDescription ×8 + 真实扫描 ×3)
npx tsc --noEmit            → 通过
npm run compile             → 通过
```

新增测试:`tests/skillDescription.test.ts`(单元)、`tests/skillDescriptionReal.test.ts`(真实 37 技能扫描:零幻觉/成本不增/多数可标签化)。既有 `skillIndex.test.ts` 6 个用例**零改动**通过(分层语义不变)。

## 确定性验证数据

| 项 | 数据 |
|----|------|
| 可标签化 | 35/38(3 个无 Use when 结构回退原逻辑) |
| 幻觉标签词 | 0(每个标签词均可回溯原文,测试断言) |
| 注入总字符 | 3974 → 3510(**−12%**) |
| 触发条件覆盖 | 1.5 个/技能 → **3 个/技能** |
| 单条超 120 截断 >10 字 | 10 条(多为 sp-* 纪律型,总量仍 −12%) |

## 真实模型 A/B(deepseek-chat,60 样本/版本)

```
DSB_LLM_API_KEY=… node scripts/experiments/ab-skill-discovery.mjs --runs 5

  truncated 精确 42/60 (70%)   模糊 49/60 (82%)
  tagged    精确 53/60 (88%)   模糊 58/60 (97%)
```

### 差异用例(触发点原位于 120 截断区)

| 意图 | 黄金技能 | 现状 | 标签化 |
|------|---------|------|--------|
| 需求含糊,提问澄清 | as-interview-me | 3/5(2 次 sp-brainstorming) | **5/5** |
| 提交前审查改动 | sp-requesting-code-review | 0/5(全答 as-code-review-and-quality) | **4/5** |
| 想法模糊,理清假设 | as-idea-refine | 1/5(4 次 sp-brainstorming) | **5/5** |

12 用例:**3 胜 0 负 9 平**,无回退。TDD 用例两版均答 `sp-test-driven-development`,属黄金标注歧义(sp-* 亦为合理答案),非版本缺陷。

## 结论

- 标签化在同一 token 预算内信息密度翻倍:可发现性(触发条件)从 1.5 → 3 个/技能,总字符反降 12%;
- 无 Use when 结构技能自动回退,零破坏;分层 tier 语义不变;
- 真实模型技能发现精确命中 **70% → 88%**(+18pp),3 用例显著改善、0 用例回退。

## 遗留(非本次范围)

- sp-* 空 lead 渲染略长(纪律型技能可接受);停用词表启发式,极端句式标签次优但不产生幻觉;
- 未做标签权重/排序优化、技能名→标签语义对齐。
