import { describe, it, expect } from "vitest";
import { SecretStorageApiKeyStore } from "../src/settings/apiKeyStore";

describe("SecretStorageApiKeyStore", () => {
  it("stores and retrieves the key", async () => {
    let stored: string | undefined;
    const store = new SecretStorageApiKeyStore({
      get: async () => stored,
      store: async (_k, v) => {
        stored = v;
      },
    });
    await store.setApiKey("sk-test");
    expect(await store.getApiKey()).toBe("sk-test");
  });

  it("returns undefined when no key set", async () => {
    const store = new SecretStorageApiKeyStore({
      get: async () => undefined,
      store: async () => {},
    });
    expect(await store.getApiKey()).toBeUndefined();
  });
});
