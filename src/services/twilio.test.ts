import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const VALID_TWILIO_URL = "https://api.twilio.com/Accounts/AC001/Messages/MM001/Media/ME001";
const UNTRUSTED_URL = "https://evil.example.com/media/file.jpg";

function setRequiredEnv(): void {
  process.env.TWILIO_ACCOUNT_SID = "AC00000000000000000000000000000000";
  process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
  process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+14155550123";
  process.env.TWILIO_WEBHOOK_URL = "https://example.com/webhooks/twilio";
  process.env.UNTHREAD_API_KEY = "test-unthread-key";
  process.env.UNTHREAD_SLACK_CHANNEL_ID = "test-channel";
  process.env.POSTGRES_URL = "postgresql://user:pass@localhost:5432/unthread_whatsapp";
}

describe("downloadTwilioMedia", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let downloadTwilioMedia: (url: string) => Promise<{ buffer: Buffer; mimeType: string }>;
  let originalFetch: typeof globalThis.fetch;

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
      savedEnv[key] = process.env[key];
    }
    setRequiredEnv();
    ({ downloadTwilioMedia } = await import("./twilio"));
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("rejects URLs on untrusted hosts", async () => {
    await expect(downloadTwilioMedia(UNTRUSTED_URL)).rejects.toThrow("Untrusted Twilio media host");
  });

  test("rejects non-HTTPS URLs before attaching credentials", async () => {
    await expect(downloadTwilioMedia("http://api.twilio.com/media/ME001")).rejects.toThrow(
      "Insecure Twilio media URL scheme",
    );
  });

  test("rejects malformed URLs", async () => {
    await expect(downloadTwilioMedia("not-a-url")).rejects.toThrow("Invalid Twilio media URL");
  });

  test("uses redirect: follow to handle Twilio CDN redirects", async () => {
    let capturedRedirect: RequestRedirect | undefined;
    const fakeBody = Buffer.from("fake-image-data");

    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedRedirect = init?.redirect as RequestRedirect | undefined;
      return new Response(fakeBody, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;

    await downloadTwilioMedia(VALID_TWILIO_URL);
    expect(capturedRedirect).toBe("follow");
  });

  test("returns buffer and detected mime type on success", async () => {
    const fakeBody = Buffer.from("fake-image-data");

    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(fakeBody, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;

    const result = await downloadTwilioMedia(VALID_TWILIO_URL);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.buffer.length).toBe(fakeBody.length);
  });

  test("strips mime type parameters from content-type header", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(Buffer.from("data"), {
        status: 200,
        headers: { "content-type": "image/jpeg; charset=binary" },
      });
    }) as unknown as typeof fetch;

    const result = await downloadTwilioMedia(VALID_TWILIO_URL);
    expect(result.mimeType).toBe("image/jpeg");
  });

  test("throws when upstream returns a non-OK status", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(null, { status: 403 });
    }) as unknown as typeof fetch;

    await expect(downloadTwilioMedia(VALID_TWILIO_URL)).rejects.toThrow(
      "Failed to download Twilio media: HTTP 403",
    );
  });

  test("throws when Content-Length header exceeds configured size limit", async () => {
    // Import config to read the actual runtime limit — the module may be cached
    // from another test file, so reading from config guarantees consistency.
    const { config } = await import("../config");
    const oversizedBytes = config.media.maxAttachmentSizeBytes + 1;

    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(Buffer.from("x"), {
        status: 200,
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(oversizedBytes),
        },
      });
    }) as unknown as typeof fetch;

    await expect(downloadTwilioMedia(VALID_TWILIO_URL)).rejects.toThrow("exceeds maximum");
  });

  test("throws mid-stream when body exceeds configured size limit", async () => {
    // Import config to read the actual runtime limit. Use a ReadableStream that
    // produces data in small chunks until the total exceeds the limit — this avoids
    // allocating a contiguous buffer of (limit + 1) bytes (which could be 16 MB+).
    const { config } = await import("../config");
    const limit = config.media.maxAttachmentSizeBytes;
    const chunkSize = Math.min(limit, 65536);

    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        let sent = 0;
        while (sent <= limit) {
          controller.enqueue(new Uint8Array(chunkSize));
          sent += chunkSize;
        }
        controller.close();
      },
    });

    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(oversizedStream, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;

    await expect(downloadTwilioMedia(VALID_TWILIO_URL)).rejects.toThrow("exceeded maximum");
  });

  test("allows media.twiliocdn.com as a trusted host and does not send Authorization", async () => {
    const cdnUrl = "https://media.twiliocdn.com/AC001/ME001?v=1";
    let capturedAuth: string | undefined;
    const fakeBody = Buffer.from("cdn-content");

    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return new Response(fakeBody, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as unknown as typeof fetch;

    const result = await downloadTwilioMedia(cdnUrl);
    expect(result.mimeType).toBe("image/png");
    // Credentials must not be forwarded to CDN hosts.
    expect(capturedAuth).toBeUndefined();
  });

  test("sends Basic auth header for Twilio credentials", async () => {
    let capturedAuth: string | undefined;
    const fakeBody = Buffer.from("data");

    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return new Response(fakeBody, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }) as unknown as typeof fetch;

    await downloadTwilioMedia(VALID_TWILIO_URL);
    expect(capturedAuth).toMatch(/^Basic /);
  });
});
