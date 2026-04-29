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

describe("storeEmailCollectionState with pendingAttachments", () => {
  beforeEach(() => {
    initializeWhatsAppStore(new MockStorageClient() as never);
  });

  test("stores and retrieves pending attachment metadata", async () => {
    const phone = "+15550000010";
    const pendingAttachments = [
      {
        mediaUrl: "https://api.twilio.com/Accounts/AC001/Messages/MM001/Media/ME001",
        contentType: "image/jpeg",
        fileName: "image.jpg",
      },
    ];

    await storeEmailCollectionState({
      phone,
      initialMessage: "Check this image",
      profileName: "User",
      pendingAttachments,
    });

    const state = await getEmailCollectionState(phone);
    expect(state).not.toBeNull();
    expect(state?.pendingAttachments).toHaveLength(1);
    expect(state?.pendingAttachments?.[0].contentType).toBe("image/jpeg");
    expect(state?.pendingAttachments?.[0].fileName).toBe("image.jpg");
  });

  test("returns valid state when pendingAttachments is omitted", async () => {
    const phone = "+15550000011";

    await storeEmailCollectionState({
      phone,
      initialMessage: "Text only message",
      profileName: null,
    });

    const state = await getEmailCollectionState(phone);
    expect(state).not.toBeNull();
    expect(state?.pendingAttachments).toBeUndefined();
  });

  test("returns valid state with empty pendingAttachments array", async () => {
    const phone = "+15550000012";

    await storeEmailCollectionState({
      phone,
      initialMessage: "Nothing attached",
      profileName: null,
      pendingAttachments: [],
    });

    const state = await getEmailCollectionState(phone);
    expect(state).not.toBeNull();
    expect(state?.pendingAttachments).toHaveLength(0);
  });
});
