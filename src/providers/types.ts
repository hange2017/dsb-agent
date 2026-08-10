/** 供应商(持久化定义;API key 不入此结构,存 secretStorage)。 */
export interface ProviderDef {
  id: string; // 稳定 id,如 "p_<rand>";legacy 迁移为 "legacy"
  name: string; // 显示名,如 "默认兼容端点"
  baseUrl: string; // Anthropic 兼容端点
  /** 自定义模型列表 URL(可选),覆盖默认探测(含 /anthropic 基址回退到 API 根 /models)。 */
  modelListUrl?: string;
  /** 供应商级默认能力:未在能力表中匹配的模型采用。 */
  defaultCapabilities: ModelCapabilities;
  /** 模式集合(默认 ["agent","plan","ask"])。 */
  modes: Mode[];
  /** 手动 pin 的模型(可选,优先于远程结果合并)。 */
  pinnedModels?: string[];
  /** 模型 → 能力覆盖表(设置面板可调)。 */
  capabilityOverrides?: Record<string, Partial<ModelCapabilities>>;
  /** 供应商 API 协议。本期扩展仅支持 "anthropic";字段为未来 openai 预留。 */
  protocol?: "anthropic" | "openai";
  /** 来源标记(cc-switch 导入或手动创建)。 */
  source?: "ccswitch" | "manual";
  createdAt: number;
}

export type Mode = "agent" | "plan" | "ask";

/** 运行时模型能力自我介绍(引擎/Client 查询面)。 */
export interface ModelCapabilities {
  /** 支持图片输入(user content image blocks)。 */
  supportsVision: boolean;
  /** 支持思考块;false 时请求显式 thinking.disabled,且 loop 剥历史 thinking。 */
  supportsThinking: boolean;
  /** 上下文窗(tokens),供 compact 触发;缺省由 loop 用 256_000。 */
  contextWindowTokens?: number;
  /** 单轮 max_tokens;缺省由 client/loop 用 8192。 */
  maxOutputTokens?: number;
  /** 正整数;supportsThinking 时 client 发 enabled+budget_tokens。 */
  thinkingBudgetTokens?: number;
  /** 同轮只读批最大并发;缺省 8;<=1 强制串行。 */
  maxParallelTools?: number;
  /** 工具并行策略;缺省 read_safe。 */
  toolParallelMode?: "read_safe" | "serial";
}

/**
 * @deprecated 使用 ModelCapabilities。保留别名仅便于渐进替换 import。
 * 字段已是 supportsVision / supportsThinking。
 */
export type Capabilities = ModelCapabilities;

/** 运行时解析出的模型条目(预设/远程/手动合并后)。 */
export interface ModelInfo {
  id: string;
  /** 已解析:override > builtin/profile > 供应商默认。 */
  capabilities: ModelCapabilities;
  /** 可选子集声明,缺省 = 供应商 modes。 */
  modes?: Mode[];
  source: "builtin" | "remote" | "pinned";
}

/** 供应商管理对外暴露的最小只读视图(webview/命令面板用)。 */
export interface ProviderSummary {
  id: string;
  name: string;
  baseUrl: string;
  defaultCapabilities: ModelCapabilities;
  modes: Mode[];
  /** 供应商 API 协议。本期扩展仅支持 "anthropic";字段为未来 openai 预留。 */
  protocol?: "anthropic" | "openai";
}
