export interface ApiKeyStore {
  getApiKey(): Promise<string | undefined>;
  setApiKey(key: string): Promise<void>;
}

export class SecretStorageApiKeyStore implements ApiKeyStore {
  private static readonly KEY = "dsbApiKey";
  /** 旧扩展 SecretStorage key,仅读取回退。 */
  private static readonly LEGACY_KEYS = ["cxxxpApiKey", "deepseekApiKey"] as const;

  constructor(private readonly storage: { get(key: string): Thenable<string | undefined>; store(key: string, value: string): Thenable<void> }) {}

  async getApiKey(): Promise<string | undefined> {
    const current = await this.storage.get(SecretStorageApiKeyStore.KEY);
    if (current) return current;
    for (const k of SecretStorageApiKeyStore.LEGACY_KEYS) {
      const v = await this.storage.get(k);
      if (v) return v;
    }
    return undefined;
  }
  async setApiKey(key: string): Promise<void> {
    await this.storage.store(SecretStorageApiKeyStore.KEY, key);
  }
}
