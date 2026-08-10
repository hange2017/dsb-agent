/**
 * 参数修改留痕:budget 参数快照与变更项计算。
 *
 * 需求:每次在设置面板修改压缩/窗口参数时,记录「修改前 → 修改后」快照与变更项,
 * 落盘为 `settings_change` 事件(StatsStore),便于按参数分组统计不同参数下的
 * 压缩频率 / 耗时 / token 用量等指标。
 * 本模块只做纯计算(便于单测),实际写配置与落盘在 extension.ts 宿主侧。
 */

/** 上下文预算相关参数快照(与设置面板 5 项一一对应)。 */
export interface BudgetSettingsSnapshot {
  windowTokens: number;
  budget: number;
  split: { compacted: number; thinking: number; tail: number };
  triggerPct: number;
  targetPct: number;
}

/** 返回发生变化的参数键(JSON 深度比较,split 整体算一个键)。 */
export function changedBudgetKeys(
  before: BudgetSettingsSnapshot,
  after: BudgetSettingsSnapshot,
): Array<keyof BudgetSettingsSnapshot> {
  return (Object.keys(after) as Array<keyof BudgetSettingsSnapshot>).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
}

/** 生成 `settings_change` 事件的 data 负载。 */
export function buildSettingsChangeData(
  before: BudgetSettingsSnapshot,
  after: BudgetSettingsSnapshot,
): { scope: "budget"; before: BudgetSettingsSnapshot; after: BudgetSettingsSnapshot; changed: Array<keyof BudgetSettingsSnapshot> } {
  return {
    scope: "budget",
    before,
    after,
    changed: changedBudgetKeys(before, after),
  };
}
