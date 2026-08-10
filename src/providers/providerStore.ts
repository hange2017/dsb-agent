import type { ProviderDef } from "./types";
import { normalizeCapabilities, normalizeCapabilityOverrides, toPersistedCapabilities } from "./capabilities";
import { sanitizeProviderUrl } from "./modelCatalog";

export interface SettingsReader {
  getJson<T>(key: string): T;
}

export interface SettingsWriter {
  updateSetting(key: string, value: unknown): void | Promise<void>;
}

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const PROVIDERS_KEY = "dsbAgent.providers";
const ACTIVE_KEY = "dsbAgent.activeProviderId";

export function apiKeySecretKey(providerId: string): string {
  return `dsbAgent.apiKey.${providerId}`;
}

/** 名称占用检测(去首尾空白、大小写不敏感);exceptId 用于编辑时排除自身。 */
export function isProviderNameTaken(
  list: ReadonlyArray<{ id: string; name: string }>,
  name: string,
  exceptId?: string,
): boolean {
  const needle = name.trim().toLowerCase();
  if (!needle) return false;
  return list.some((p) => p.id !== exceptId && p.name.trim().toLowerCase() === needle);
}

function normalizeProviderDef(raw: ProviderDef): ProviderDef {
  return {
    ...raw,
    // 统一清除粘贴/历史配置带入的不可见字符(BOM / 零宽空格等),避免拼接 URL 404
    baseUrl: sanitizeProviderUrl(raw.baseUrl ?? ""),
    modelListUrl: raw.modelListUrl ? sanitizeProviderUrl(raw.modelListUrl) : undefined,
    defaultCapabilities: toPersistedCapabilities(normalizeCapabilities(raw.defaultCapabilities)),
    capabilityOverrides: normalizeCapabilityOverrides(raw.capabilityOverrides),
  };
}

export class ProviderStore {
  /** 同步内存覆盖:VS Code configuration.update 异步落地前,读路径仍返回最新值。 */
  private memoryActiveId: string | undefined;
  /** 供应商列表内存覆盖(与 memoryActiveId 同理,避免 upsert 后 list() 仍读到旧配置)。 */
  private memoryProviders: ProviderDef[] | undefined;

  constructor(
    private readonly deps: {
      reader: SettingsReader;
      writer: SettingsWriter;
      secret: SecretStore;
    },
  ) {}

  list(): ProviderDef[] {
    if (this.memoryProviders) {
      return this.memoryProviders.map((p) => normalizeProviderDef(p));
    }
    const raw = this.deps.reader.getJson<ProviderDef[]>(PROVIDERS_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.map((p) => normalizeProviderDef(p));
  }

  get(id: string): ProviderDef | undefined {
    return this.list().find((p) => p.id === id);
  }

  getActive(): ProviderDef | undefined {
    const id = this.memoryActiveId ?? this.deps.reader.getJson<string>(ACTIVE_KEY);
    const list = this.list();
    if (id) {
      const found = list.find((p) => p.id === id);
      if (found) return found;
    }
    return list[0];
  }

  async setActive(id: string): Promise<void> {
    this.memoryActiveId = id;
    await Promise.resolve(this.deps.writer.updateSetting(ACTIVE_KEY, id));
  }

  upsert(def: ProviderDef): void {
    const normalized = normalizeProviderDef(def);
    const list = this.list();
    const idx = list.findIndex((p) => p.id === normalized.id);
    if (idx >= 0) list[idx] = normalized;
    else list.push(normalized);
    this.memoryProviders = list;
    void Promise.resolve(this.deps.writer.updateSetting(PROVIDERS_KEY, list));
  }

  remove(id: string): void {
    const list = this.list().filter((p) => p.id !== id);
    this.memoryProviders = list;
    void Promise.resolve(this.deps.writer.updateSetting(PROVIDERS_KEY, list));
    const active = this.memoryActiveId ?? this.deps.reader.getJson<string>(ACTIVE_KEY);
    if (active === id) {
      const next = list[0];
      this.memoryActiveId = next ? next.id : undefined;
      void Promise.resolve(this.deps.writer.updateSetting(ACTIVE_KEY, next ? next.id : undefined));
    }
    void this.deps.secret.delete(apiKeySecretKey(id));
  }

  async getApiKey(id: string): Promise<string | undefined> {
    return await this.deps.secret.get(apiKeySecretKey(id));
  }

  async setApiKey(id: string, key: string): Promise<void> {
    await this.deps.secret.set(apiKeySecretKey(id), key);
  }
}
