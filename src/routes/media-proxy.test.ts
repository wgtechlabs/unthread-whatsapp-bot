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

// Set env vars at module load time so all lazy imports (inside beforeAll) find
// the required variables ready, regardless of describe-block execution order.
setRequiredEnv();

describe("media proxy download URL resolution", () => {
  const originalEnv: Record<string, string | undefined> = {};
  let resolveMediaProxyDownloadUrl: typeof import("./media-proxy").resolveMediaProxyDownloadUrl;
  let shouldRetryMediaProxyUpstreamFetch: typeof import("./media-proxy").shouldRetryMediaProxyUpstreamFetch;

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
    ({ resolveMediaProxyDownloadUrl, shouldRetryMediaProxyUpstreamFetch } = await import(
      "./media-proxy"
    ));
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

  test("image with Slack team ID uses /slack/files/{fileId}/thumb endpoint", () => {
    const meta = tokenMeta({
      fileId: "F12345ABCDE",
      slackTeamId: "T0123ABCDE",
      mimeType: "image/png",
    });

    expect(resolveMediaProxyDownloadUrl(meta)).toBe(
      "https://api.unthread.io/api/slack/files/F12345ABCDE/thumb?thumbSize=1024&teamId=T0123ABCDE",
    );
  });

  test("image with UUID attachment ID uses /files/{fileId}/download", () => {
    const meta = tokenMeta({
      fileId: "2823f8be-c0df-4358-9fa6-bc370ef26057",
      slackTeamId: "T0123ABCDE",
      mimeType: "image/png",
    });

    expect(resolveMediaProxyDownloadUrl(meta)).toBe(
      "https://api.unthread.io/api/files/2823f8be-c0df-4358-9fa6-bc370ef26057/download",
    );
  });

  test("image without Slack team ID falls back to /files/{fileId}/download", () => {
    const meta = tokenMeta({ fileId: "F12345ABCDE", mimeType: "image/jpeg" });

    expect(resolveMediaProxyDownloadUrl(meta)).toBe(
      "https://api.unthread.io/api/files/F12345ABCDE/download",
    );
  });

  test("non-image with Slack team ID uses /files/{fileId}/download (not thumb)", () => {
    const meta = tokenMeta({
      fileId: "F12345ABCDE",
      slackTeamId: "T0123ABCDE",
      mimeType: "application/pdf",
    });

    expect(resolveMediaProxyDownloadUrl(meta)).toBe(
      "https://api.unthread.io/api/files/F12345ABCDE/download",
    );
  });

  test("falls back to /files/{fileId}/download when no direct URL or team ID stored", () => {
    const meta = tokenMeta({ fileId: "file_123", conversationId: "conv_123" });

    expect(resolveMediaProxyDownloadUrl(meta)).toBe(
      "https://api.unthread.io/api/files/file_123/download",
    );
  });

  test("fallback uses only fileId — conversationId is not required", () => {
    const meta = tokenMeta({ fileId: "file_123" });

    expect(resolveMediaProxyDownloadUrl(meta)).toBe(
      "https://api.unthread.io/api/files/file_123/download",
    );
  });

  test("returns null when neither a direct URL nor a fileId is available", () => {
    expect(resolveMediaProxyDownloadUrl(tokenMeta({ conversationId: "conv_123" }))).toBeNull();
    expect(resolveMediaProxyDownloadUrl(tokenMeta({}))).toBeNull();
  });

  test("retries transient upstream statuses while dashboard uploads finish", () => {
    expect(shouldRetryMediaProxyUpstreamFetch(404)).toBe(true);
    expect(shouldRetryMediaProxyUpstreamFetch(409)).toBe(true);
    expect(shouldRetryMediaProxyUpstreamFetch(425)).toBe(true);
  });

  test("does not retry permanent upstream failures", () => {
    expect(shouldRetryMediaProxyUpstreamFetch(400)).toBe(false);
    expect(shouldRetryMediaProxyUpstreamFetch(401)).toBe(false);
    expect(shouldRetryMediaProxyUpstreamFetch(403)).toBe(false);
    expect(shouldRetryMediaProxyUpstreamFetch(500)).toBe(false);
  });
});

describe("Slack team ID extraction", () => {
  let extractSlackTeamId: typeof import("../services/unthread-outbound").extractSlackTeamId;

  beforeAll(async () => {
    ({ extractSlackTeamId } = await import("../services/unthread-outbound"));
  });

  test("extracts team ID from files-pri URL", () => {
    expect(
      extractSlackTeamId("https://files.slack.com/files-pri/T0123ABCDE/F12345ABCDE/screenshot.png"),
    ).toBe("T0123ABCDE");
  });

  test("extracts team ID from files-tmb URL", () => {
    expect(
      extractSlackTeamId(
        "https://files.slack.com/files-tmb/T9ZZZZABCDE/F12345ABCDE/screenshot_720.jpg",
      ),
    ).toBe("T9ZZZZABCDE");
  });

  test("returns null for non-Slack URLs", () => {
    expect(extractSlackTeamId("https://api.unthread.io/api/files/F123/download")).toBeNull();
    expect(extractSlackTeamId("https://example.com/files-pri/T123/F456/file.pdf")).toBeNull();
  });

  test("returns null for invalid URLs", () => {
    expect(extractSlackTeamId("not-a-url")).toBeNull();
    expect(extractSlackTeamId("")).toBeNull();
  });
});
