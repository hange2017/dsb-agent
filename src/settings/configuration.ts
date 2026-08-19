import * as os from "os";
import * as path from "path";
import type { PermissionMode } from "../agent/permission";

export interface ConfigReader {
  getString(key: string): string;
  getJson?<T>(key: string): T;
}

export class Configuration {
  constructor(private readonly reader: ConfigReader) {}

  /** 供应商列表(多供应商管理;由 ProviderStore 读写,这里提供只读视图)。 */
  providers<T = unknown>(): T[] {
    if (this.reader.getJson) {
      const v = this.reader.getJson<T[]>("dsbAgent.providers");
      return Array.isArray(v) ? v : [];
    }
    return [];
  }

  /** 当前激活供应商 id。 */
  activeProviderId(): string {
    return this.reader.getString("dsbAgent.activeProviderId");
  }

  baseUrl(): string {
    return this.reader.getString("dsbAgent.baseUrl") || "https://api.deepseek.com/anthropic";
  }
  model(): string {
    return this.reader.getString("dsbAgent.model") || "deepseek-v4-flash";
  }
  fallbackModels(): string[] {
    const raw = this.reader.getString("dsbAgent.fallbackModels");
    return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : ["deepseek-v4-pro"];
  }
  /**
   * 跨会话记忆目录:可用 `dsbAgent.memoryDir` 覆盖(支持 `~/` 前缀展开),
   * 默认 `~/.dsb/memory`。旧记忆目录可用该配置指回。
   */
  memoryDir(): string {
    const v = this.reader.getString("dsbAgent.memoryDir");
    if (v) return v.startsWith("~/") ? path.join(os.homedir(), v.slice(2)) : v;
    return path.join(os.homedir(), ".dsb", "memory");
  }
  /** 权限模式:default=严格(询问),bypassPermissions=宽松(全放行)。非法值回退 default。 */
  permissionMode(): PermissionMode {
    const v = this.reader.getString("dsbAgent.permissionMode");
    return v === "bypassPermissions" || v === "acceptEdits" ? v : "default";
  }
  /** 设置面板选择的语言:""=跟随界面,zh/en=显式指定。 */
  language(): "" | "zh" | "en" {
    const v = this.reader.getString("dsbAgent.language");
    return v === "zh" || v === "en" ? v : "";
  }
  /** 编辑器复制后粘贴是否提升为 chip;默认 true。 */
  autoChipsOnPaste(): boolean {
    const v = this.reader.getString("dsbAgent.autoChipsOnPaste");
    return v !== "false";
  }
  /** 上下文压缩触发阈值(0~1):上下文占用达到该比例时自动压缩;缺省 0.75,非法值回退。 */
  compactionTriggerRatio(): number {
    const v = Number(this.reader.getString("dsbAgent.compaction.triggerRatio"));
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.75;
  }
  /** thinking 独立压缩块开关;缺省 false(仅 "true" 视为开启,其余值关闭)——参数界面默认关闭 thinking 链路。 */
  compactionThinkingEnabled(): boolean {
    return this.reader.getString("dsbAgent.compaction.thinking") === "true";
  }
  /** 历史信息 token 总预算;缺省 64000;0 = 关闭(回退现状固定 tail 4 条 + 压缩块 8K 字符)。非法值回退。 */
  historyTokenBudget(): number {
    const raw = this.reader.getString("dsbAgent.compaction.historyTokenBudget");
    if (!raw) return 64000;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : 64000;
  }

  /** 默认预算比例(压缩块/thinking/tail)。 */
  static readonly kDefaultBudgetSplit = { compacted: 0.45, thinking: 0.2, tail: 0.35 };

  /** 历史预算三块比例;非法(缺项/非数/负数/和≤0)回退默认并归一化。
   *  thinking 允许 0(思考编排关闭时写回的两段配置:compacted/tail 为正)。 */
  budgetSplit(): { compacted: number; thinking: number; tail: number } {
    const def = Configuration.kDefaultBudgetSplit;
    if (!this.reader.getJson) return { ...def };
    const v = this.reader.getJson<Partial<{ compacted: number; thinking: number; tail: number }>>(
      "dsbAgent.compaction.budgetSplit",
    );
    if (!v || typeof v !== "object") return { ...def };
    const c = Number(v.compacted);
    const t = Number(v.thinking);
    const l = Number(v.tail);
    if (![c, t, l].every((n) => Number.isFinite(n) && n >= 0)) return { ...def };
    // compacted/tail 必须为正;thinking 允许 0(两段配置)。
    if (!(c > 0 && l > 0)) return { ...def };
    const sum = c + t + l;
    if (sum <= 0) return { ...def };
    return { compacted: c / sum, thinking: t / sum, tail: l / sum };
  }

  /** 给大模型的输入最大长度(窗口);缺省 600000;0 = 跟随模型能力;>0 覆盖模型默认。非法值回退默认。 */
  contextWindowTokens(): number {
    const raw = this.reader.getString("dsbAgent.contextWindowTokens");
    if (!raw) return 600000;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 600000;
  }

  /** 触发比例(每块 token ≥ 额定×该比例 → 触发压缩);缺省 0.75,(0,1] 有效。 */
  compactionTriggerPct(): number {
    const v = Number(this.reader.getString("dsbAgent.compaction.triggerPct"));
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.75;
  }

  /** 压缩后目标比例(触发后收缩到额定×该比例);缺省 0.5;须满足 0 < target < trigger。 */
  compactionTargetPct(): number {
    const v = Number(this.reader.getString("dsbAgent.compaction.targetPct"));
    const trigger = this.compactionTriggerPct();
    if (!(Number.isFinite(v) && v > 0 && v < 1 && v < trigger)) return 0.5;
    return v;
  }

  /** tail 分级折叠比例(方向 2):tail 预算内较旧的该比例折叠进压缩块;缺省 0.35,[0,1) 有效,非法回退。 */
  compactionTailFoldRatio(): number {
    const raw = this.reader.getString("dsbAgent.compaction.tailFoldRatio");
    if (raw === undefined || raw === "") return 0.35;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 && v < 1 ? v : 0.35;
  }

  /** 统计总开关:false 关闭后不再记录任何统计事件(StatsStore 不落盘);缺省 true。 */
  statsEnabled(): boolean {
    return this.reader.getString("dsbAgent.stats.enabled") !== "false";
  }

  /** 统计详细级别:basic=仅基础轮次统计,full=含压缩逐位置明细与压缩质量抽查;非法值回退 full。 */
  statsDetailLevel(): "basic" | "full" {
    const v = this.reader.getString("dsbAgent.stats.detailLevel");
    return v === "basic" ? "basic" : "full";
  }

  /** 压缩质量抽查(compaction_qa)开关:false 时完全关闭抽查(不触发 provider 请求、不落盘事件);缺省 true。 */
  compactionQaEnabled(): boolean {
    return this.reader.getString("dsbAgent.stats.compactionQa") !== "false";
  }
}
