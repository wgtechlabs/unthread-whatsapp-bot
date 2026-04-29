import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

function setRequiredEnv(): void {
  process.env.TWILIO_ACCOUNT_SID = "test-account";
  process.env.TWILIO_AUTH_TOKEN = "test-token";
  process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+14155550123";
  process.env.TWILIO_WEBHOOK_URL = "https://example.com/webhooks/twilio";
  process.env.UNTHREAD_API_KEY = "test-unthread-key";
  process.env.UNTHREAD_SLACK_CHANNEL_ID = "test-channel";
  process.env.POSTGRES_URL = "postgresql://user:pass@localhost:5432/unthread_whatsapp";
}

// Minimal mock that satisfies the NuvexClient interface for these tests
class MockNuvexClient {
  private readonly records = new Map<string, { value: unknown; expiresAt?: number }>();

  async set(key: string, value: unknown, options?: { ttl?: number }): Promise<boolean> {
    const expiresAt = options?.ttl ? Date.now() + options.ttl * 1000 : undefined;
    this.records.set(key, { value, expiresAt });
    return true;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.records.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      this.records.delete(key);
      return null;
    }
    return entry.value as T;
  }

  expireKey(key: string): void {
    const entry = this.records.get(key);
    if (entry) {
      this.records.set(key, { ...entry, expiresAt: Date.now() - 1 });
    }
  }
}

describe("media-proxy-store", () => {
  const originalEnv: Record<string, string | undefined> = {};
  let proxyStore: Awaited<typeof import("./media-proxy-store")>;
  let mockStorage: MockNuvexClient;

  beforeAll(async () => {
    const keys = [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_WHATSAPP_NUMBER",
      "TWILIO_WEBHOOK_URL",
      "UNTHREAD_API_KEY",
      "UNTHREAD_SLACK_CHANNEL_ID",
      "POSTGRES_URL",
    ];
    for (const key of keys) {
      originalEnv[key] = process.env[key];
    }
    setRequiredEnv();
    proxyStore = await import("./media-proxy-store");
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  beforeEach(() => {
    mockStorage = new MockNuvexClient();
    proxyStore.initializeMediaProxyStore(mockStorage as never);
  });

  test("storeProxyToken returns a UUID-shaped token", async () => {
    const token = await proxyStore.storeProxyToken({
      fileName: "document.pdf",
      mimeType: "application/pdf",
      fileSize: 1024,
      downloadUrl: "https://files.example.com/doc.pdf",
    });

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(uuidPattern.test(token)).toBe(true);
  });

  test("getProxyToken retrieves stored metadata by token", async () => {
    const token = await proxyStore.storeProxyToken({
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      fileSize: 51200,
      downloadUrl: "https://files.example.com/photo.jpg",
    });

    const meta = await proxyStore.getProxyToken(token);
    expect(meta).not.toBeNull();
    expect(meta?.token).toBe(token);
    expect(meta?.fileName).toBe("photo.jpg");
    expect(meta?.mimeType).toBe("image/jpeg");
    expect(meta?.fileSize).toBe(51200);
  });

  test("getProxyToken returns null for unknown tokens", async () => {
    const meta = await proxyStore.getProxyToken("00000000-0000-0000-0000-000000000000");
    expect(meta).toBeNull();
  });

  test("getProxyToken returns null for expired tokens", async () => {
    const token = await proxyStore.storeProxyToken({
      fileName: "expired.pdf",
      mimeType: "application/pdf",
    });

    const key = `wa:media-proxy:token:${token}`;
    mockStorage.expireKey(key);

    const meta = await proxyStore.getProxyToken(token);
    expect(meta).toBeNull();
  });

  test("storeProxyToken persists fileId and downloadUrl", async () => {
    const token = await proxyStore.storeProxyToken({
      fileId: "F12345ABC",
      fileName: "report.pdf",
      mimeType: "application/pdf",
      downloadUrl: "https://files.slack.com/files-pri/T0123/F12345ABC/report.pdf",
    });

    const meta = await proxyStore.getProxyToken(token);
    expect(meta?.fileId).toBe("F12345ABC");
    expect(meta?.downloadUrl).toBe("https://files.slack.com/files-pri/T0123/F12345ABC/report.pdf");
  });
});
