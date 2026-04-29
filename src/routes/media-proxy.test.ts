import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MediaProxyTokenRecord } from "../types";

function setRequiredEnv(): void {
  process.env.TWILIO_ACCOUNT_SID = "AC00000000000000000000000000000000";
  process.env.TWILIO_AUTH_TOKEN = "test-token";
  process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+14155550123";
  process.env.TWILIO_WEBHOOK_URL = "https://example.com/webhooks/twilio";
  process.env.UNTHREAD_API_KEY = "test-unthread-key";
  process.env.UNTHREAD_SLACK_CHANNEL_ID = "test-channel";
  process.env.POSTGRES_URL = "postgresql://user:pass@localhost:5432/unthread_whatsapp";
}

describe("media proxy download URL resolution", () => {
  const originalEnv: Record<string, string | undefined> = {};
  let resolveMediaProxyDownloadUrl: typeof import("./media-proxy").resolveMediaProxyDownloadUrl;

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
    ({ resolveMediaProxyDownloadUrl } = await import("./media-proxy"));
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

  function tokenMeta(overrides: Partial<MediaProxyTokenRecord>): MediaProxyTokenRecord {
    return {
      token: "00000000-0000-0000-0000-000000000000",
      fileName: "image.png",
      mimeType: "image/png",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...overrides,
    };
  }

  test("uses stored Unthread download URL when present", () => {
    const meta = tokenMeta({
      downloadUrl: "https://api.unthread.io/api/custom-download/path",
      fileId: "file_123",
      conversationId: "conv_123",
    });

    expect(resolveMediaProxyDownloadUrl(meta)).toBe(
      "https://api.unthread.io/api/custom-download/path",
    );
  });

  test("falls back to conversation-scoped Unthread file endpoint", () => {
    const meta = tokenMeta({ fileId: "file_123", conversationId: "conv_123" });

    expect(resolveMediaProxyDownloadUrl(meta)).toBe(
      "https://api.unthread.io/api/conversations/conv_123/files/file_123/full",
    );
  });

  test("returns null without a direct URL or complete fallback metadata", () => {
    expect(resolveMediaProxyDownloadUrl(tokenMeta({ fileId: "file_123" }))).toBeNull();
    expect(resolveMediaProxyDownloadUrl(tokenMeta({ conversationId: "conv_123" }))).toBeNull();
  });
});
