import { MemoryEntry, MemoryStore } from "./memoryStore";

/**
 * 跨会话记忆整合(Memory dream):把全部记忆条目交给 LLM,让其决定哪些保留、
 * 哪些删除、哪些合并成新条目。任何解析/校验失败都抛错且不改动任何记忆。
 */

export interface DreamResult {
  before: number;
  after: number;
}

/** 双闸门默认值:至少 5 条记忆 且 距上次整合超过 7 天,才提示用户可整合。 */
export const DREAM_MIN_ENTRIES = 5;
export const DREAM_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 是否到了该整合记忆的时候(双闸门):
 * 1. 记忆条数 >= minEntries(太少不值得整合);
 * 2. 距上次整合(lastDreamAt)超过 cooldownMs(刚整合过不反复提示);
 * lastDreamAt 缺失视为「从未整合过」,条数达标即可提示。
 */
export function dreamDue(opts: {
  entryCount: number;
  lastDreamAt?: number;
  now?: number;
  minEntries?: number;
  cooldownMs?: number;
}): boolean {
  const minEntries = opts.minEntries ?? DREAM_MIN_ENTRIES;
  const cooldownMs = opts.cooldownMs ?? DREAM_COOLDOWN_MS;
  const now = opts.now ?? Date.now();
  if (opts.entryCount < minEntries) return false;
  if (opts.lastDreamAt === undefined) return true;
  return now - opts.lastDreamAt >= cooldownMs;
}

/**
 * SessionStart 提示文案:满足 dreamDue 时返回一行建议(注入 system prompt);
 * 不满足(条数不足 / 冷却中)返回 undefined,不打扰。
 */
export function buildDreamHint(memory: MemoryStore, locale: "zh" | "en" = "zh"): string | undefined {
  const count = memory.list().length;
  if (!dreamDue({ entryCount: count, lastDreamAt: memory.readDreamAt() })) return undefined;
  return locale === "en"
    ? `You now have ${count} persistent memories and it's been a while since the last consolidation. When convenient, run /memory dream to merge similar entries, dedupe and summarize (keeps context lean).`
    : `当前持久记忆已有 ${count} 条,且距上次整合( /memory dream )已超过 7 天。可在合适时机运行 /memory dream 合并相似、去重并压缩,控制上下文占用。`;
}

interface DreamPlan {
  keep: string[];
  delete: string[];
  create: Array<{ name: string; description: string; body: string }>;
}

/** 组装 prompt:列出每条记忆的 name/description/body,要求 LLM 只返回 JSON。 */
function buildPrompt(entries: MemoryEntry[]): string {
  const list = entries
    .map(
      (e) =>
        `- name: ${e.name}\n  description: ${e.description}\n  body: ${e.body}`,
    )
    .join("\n");

  return [
    "You are consolidating the agent's cross-session memory. Below are the current memory entries:",
    "",
    list || "(no entries yet)",
    "",
    'Return ONLY a JSON object with exactly this shape (no markdown fence, no extra text):',
    '{',
    '  "keep": ["names of entries to keep unchanged"],',
    '  "delete": ["names of entries to remove"],',
    '  "create": [{"name": "new-name", "description": "short description", "body": "full content"}]',
    '}',
    "",
    "Rules:",
    "- keep/delete names must exactly match existing entry names.",
    '- create names must be non-empty strings; every create item must include a non-empty name, description and body.',
    "- Merge/consolidate related entries into new ones, and delete the entries you folded in.",
  ].join("\n");
}

/** 容忍 ```json 代码围栏(及围栏外杂音),返回最内层 JSON 对象文本。 */
function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) return fenced[1].trim();
  // 没有围栏时,尝试截取第一个 { 到最后一个 } 之间的内容(容忍前后解释性文字)
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

/** 解析 LLM 返回;失败抛错。 */
function parseDreamJson(raw: string): unknown {
  const candidate = extractJsonObject(raw);
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    throw new Error(
      `memory dream: LLM returned invalid JSON — cannot parse. Got:\n${raw}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}

/** 校验 LLM 输出的结构合法性;失败抛错,不改动任何记忆。 */
function validateDreamPlan(value: unknown, existingNames: Set<string>): DreamPlan {
  if (!isRecord(value)) {
    throw new Error("memory dream: LLM output is not a JSON object");
  }
  const { keep, delete: del, create } = value;
  if (!isStringArray(keep)) {
    throw new Error("memory dream: \"keep\" must be an array of strings");
  }
  if (!isStringArray(del)) {
    throw new Error("memory dream: \"delete\" must be an array of strings");
  }
  if (!Array.isArray(create)) {
    throw new Error("memory dream: \"create\" must be an array");
  }
  for (const name of del) {
    if (!existingNames.has(name)) {
      throw new Error(`memory dream: "delete" references unknown memory name: "${name}"`);
    }
  }
  const created = create.map((item, i) => {
    if (!isRecord(item)) {
      throw new Error(`memory dream: "create[${i}]" is not an object`);
    }
    const { name, description, body } = item;
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(`memory dream: "create[${i}].name" must be a non-empty string`);
    }
    if (typeof description !== "string") {
      throw new Error(`memory dream: "create[${i}].description" must be a string`);
    }
    if (typeof body !== "string") {
      throw new Error(`memory dream: "create[${i}].body" must be a string`);
    }
    return { name, description, body };
  });
  return { keep: keep as string[], delete: del as string[], create: created };
}

/**
 * 运行一次记忆整合。
 * 流程:读取全部条目 → 组装 prompt 调用 LLM → 解析并整体校验 → 一次性应用。
 * 任何解析/校验异常都抛错,且保证不改动任何记忆(不允许部分应用)。
 */
export async function dreamMemory(
  memory: MemoryStore,
  llm: (prompt: string) => Promise<string>,
): Promise<DreamResult> {
  const beforeEntries = memory.list();
  const before = beforeEntries.length;

  const prompt = buildPrompt(beforeEntries);
  const raw = await llm(prompt);

  const parsed = parseDreamJson(raw);
  const plan = validateDreamPlan(parsed, new Set(beforeEntries.map((e) => e.name)));

  // 全部校验通过后才应用
  for (const name of plan.delete) memory.delete(name);
  for (const c of plan.create) {
    memory.write({ name: c.name, description: c.description, body: c.body, updatedAt: Date.now() });
  }

  const after = memory.list().length;
  return { before, after };
}
