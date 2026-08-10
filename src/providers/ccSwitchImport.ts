import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import type { ProviderDef } from "./types";
import { apiKeySecretKey } from "./providerStore";
import type { SecretStore, SettingsWriter } from "./providerStore";

export interface CcSwitchDeps {
  secret: SecretStore;
  writer: SettingsWriter;
  homeDir?: string;
  /** 现有已保存的供应商(用于合并写回,避免覆盖)。 */
  existing?: ProviderDef[];
  /** 可注入的 DB 读取实现(默认走 better-sqlite3);返回 providers 原始行。 */
  readDbRows?: (dbPath: string) => Array<{ name: string; settings_config: string }>;
}

export interface CcSwitchImportResult {
  imported: ProviderDef[];
}

const DEFAULT_CAPABILITIES = { supportsVision: false, supportsThinking: true };
const DEFAULT_MODES = ["agent", "plan", "ask"] as const;

/** 解析 cc-switch 的 settings_config(JSON 字符串或对象)中的 env 字段。 */
export function parseCcSwitchEnv(settingsConfig: unknown): {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
} {
  let value = settingsConfig;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (typeof value !== "object" || value === null) return {};
  const env = (value as { env?: Record<string, unknown> }).env;
  if (typeof env !== "object" || env === null) return {};
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
  return {
    baseUrl: str(env["ANTHROPIC_BASE_URL"]),
    apiKey: str(env["ANTHROPIC_AUTH_TOKEN"]),
    model: str(env["ANTHROPIC_MODEL"]),
  };
}

function nextName(name: string, existing: string[]): string {
  let candidate = name;
  let n = 2;
  const taken = new Set(existing);
  while (taken.has(candidate)) {
    candidate = `${name} (${n})`;
    n += 1;
  }
  return candidate;
}

function buildProvider(input: {
  name: string;
  baseUrl: string;
  model?: string;
  existingNames: string[];
}): ProviderDef {
  const def: ProviderDef = {
    id: `p_${Math.random().toString(36).slice(2, 10)}`,
    name: nextName(input.name, input.existingNames),
    baseUrl: input.baseUrl,
    defaultCapabilities: { ...DEFAULT_CAPABILITIES },
    modes: [...DEFAULT_MODES],
    protocol: "anthropic",
    source: "ccswitch",
    createdAt: Date.now(),
  };
  if (input.model) def.pinnedModels = [input.model];
  return def;
}

/** 默认 DB 读取:动态 require better-sqlite3,失败抛错由调用方走兜底。 */
function defaultDbReader(dbPath: string): Array<{ name: string; settings_config: string }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3") as new (p: string) => {
    prepare(sql: string): { all(...params: unknown[]): Array<Record<string, unknown>> };
    close(): void;
  };
  const db = new Database(dbPath);
  try {
    const rows = db
      .prepare("SELECT name, settings_config FROM providers WHERE app_type = 'claude'")
      .all();
    return rows.map((r) => ({
      name: String(r["name"] ?? "CC-Switch 供应商"),
      settings_config: String(r["settings_config"] ?? "{}"),
    }));
  } finally {
    db.close();
  }
}

/** 读 ~/.claude/settings.json 的 env 作为兜底(cc-switch 切换后必然同步此文件)。 */
function readClaudeSettingsFallback(settingsPath: string): { def: ProviderDef; apiKey?: string } | undefined {
  if (!fs.existsSync(settingsPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return undefined;
  }
  const env = (parsed as { env?: Record<string, unknown> } | undefined)?.env;
  if (typeof env !== "object" || env === null) return undefined;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
  const baseUrl = str(env["ANTHROPIC_BASE_URL"]);
  const apiKey = str(env["ANTHROPIC_AUTH_TOKEN"]);
  const model = str(env["ANTHROPIC_MODEL"]);
  if (!baseUrl) return undefined;
  return {
    def: buildProvider({ name: "CC-Switch 当前供应商", baseUrl, model, existingNames: [] }),
    apiKey,
  };
}

/**
 * 从 cc-switch 导入 claude 供应商。
 * 主路径:better-sqlite3 读 ~/.cc-switch/cc-switch.db;
 * 兜底:读 ~/.claude/settings.json 的 env(零依赖,导入当前激活供应商)。
 * API key 一律写入 secretStorage,不落盘明文。
 */
export async function importFromCcSwitch(
  deps: CcSwitchDeps,
): Promise<CcSwitchImportResult> {
  const home = deps.homeDir ?? os.homedir();
  const dbPath = path.join(home, ".cc-switch", "cc-switch.db");
  const existingNames: string[] = (deps.existing ?? []).map((p) => p.name);
  const pending: Array<{ def: ProviderDef; apiKey?: string }> = [];

  let rows: Array<{ name: string; settings_config: string }> | undefined;
  try {
    rows = (deps.readDbRows ?? defaultDbReader)(dbPath);
  } catch {
    rows = undefined; // better-sqlite3 不可用或 DB 打不开 → 走兜底
  }

  if (rows && rows.length > 0) {
    for (const row of rows) {
      const env = parseCcSwitchEnv(row.settings_config);
      if (!env.baseUrl) continue;
      const def = buildProvider({
        name: row.name,
        baseUrl: env.baseUrl,
        model: env.model,
        existingNames,
      });
      existingNames.push(def.name);
      pending.push({ def, apiKey: env.apiKey });
    }
  } else {
    const fallback = readClaudeSettingsFallback(path.join(home, ".claude", "settings.json"));
    if (fallback) pending.push(fallback);
  }

  if (pending.length === 0) return { imported: [] };

  const merged = [...(deps.existing ?? [])];
  for (const { def, apiKey } of pending) {
    if (apiKey) {
      await deps.secret.set(apiKeySecretKey(def.id), apiKey);
    }
    merged.push(def);
  }
  deps.writer.updateSetting("dsbAgent.providers", merged);

  return { imported: pending.map((p) => p.def) };
}
