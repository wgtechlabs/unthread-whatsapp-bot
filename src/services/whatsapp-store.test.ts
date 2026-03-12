import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearEmailCollectionState,
  getEmailCollectionState,
  initializeWhatsAppStore,
  storeEmailCollectionState,
} from "./whatsapp-store";

class MockStorageClient {
  private readonly records = new Map<string, unknown>();

  constructor(private readonly options: { failDelete?: boolean } = {}) {}

  async setNamespaced(namespace: string, key: string, value: unknown): Promise<boolean> {
    this.records.set(`${namespace}:${key}`, value);
    return true;
  }

  async getNamespaced(namespace: string, key: string): Promise<unknown> {
    return this.records.get(`${namespace}:${key}`) ?? null;
  }

  async delete(key: string): Promise<boolean> {
    if (this.options.failDelete) {
      return false;
    }

    return this.records.delete(key);
  }

  removeNamespaced(namespace: string, key: string): void {
    this.records.delete(`${namespace}:${key}`);
  }
}

describe("clearEmailCollectionState", () => {
  beforeEach(() => {
    initializeWhatsAppStore(new MockStorageClient() as never);
  });

  test("returns true and removes the pending state after a successful delete", async () => {
    const phone = "+15550000001";

    await storeEmailCollectionState({
      phone,
      initialMessage: "Need help",
      profileName: "Tester",
    });

    await expect(clearEmailCollectionState(phone)).resolves.toBe(true);
    await expect(getEmailCollectionState(phone)).resolves.toBeNull();
  });

  test("returns false when delete fails and the persisted state still exists", async () => {
    const phone = "+15550000002";
    const storage = new MockStorageClient({ failDelete: true });
    initializeWhatsAppStore(storage as never);

    await storeEmailCollectionState({
      phone,
      initialMessage: "Need help",
      profileName: "Tester",
    });

    await expect(clearEmailCollectionState(phone)).resolves.toBe(false);
    await expect(getEmailCollectionState(phone)).resolves.toEqual(
      expect.objectContaining({
        phone,
        initialMessage: "Need help",
      }),
    );
  });

  test("returns true when delete reports false but the record is already absent", async () => {
    const phone = "+15550000003";
    const storage = new MockStorageClient({ failDelete: true });
    initializeWhatsAppStore(storage as never);

    await storeEmailCollectionState({
      phone,
      initialMessage: "Need help",
      profileName: "Tester",
    });

    storage.removeNamespaced("wa:email-collection:phone", phone);

    await expect(clearEmailCollectionState(phone)).resolves.toBe(true);
    await expect(getEmailCollectionState(phone)).resolves.toBeNull();
  });
});
