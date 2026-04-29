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

describe("unthread service error handling", () => {
  const originalFetch = globalThis.fetch;
  let unthread: Awaited<typeof import("./unthread")>;

  function withFetchShape(
    implementation: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
  ): typeof fetch {
    return Object.assign(implementation, originalFetch);
  }

  const originalEnv: Record<string, string | undefined> = {};

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
    unthread = await import("./unthread");
  });

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("findCustomerByEmail propagates upstream API failures", async () => {
    globalThis.fetch = withFetchShape(
      async () =>
        new Response("upstream unavailable", {
          status: 503,
        }),
    );

    await expect(unthread.findCustomerByEmail("user@example.com")).rejects.toMatchObject({
      name: "UnthreadApiError",
      status: 503,
    });
  });

  test("findCustomerByPhone retries the alternate lookup path for unsupported queries", async () => {
    const requestedUrls: string[] = [];

    globalThis.fetch = withFetchShape(async (input) => {
      requestedUrls.push(String(input));

      if (requestedUrls.length === 1) {
        return new Response("not found", {
          status: 404,
        });
      }

      return new Response(
        JSON.stringify([
          {
            id: "cust_123",
            name: "Tester",
            email: "user@example.com",
            phoneNumber: "+15550000003",
          },
        ]),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    });

    await expect(unthread.findCustomerByPhone("+15550000003")).resolves.toEqual(
      expect.objectContaining({
        id: "cust_123",
      }),
    );
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[0]).toContain("/customers?phoneNumber=");
    expect(requestedUrls[1]).toContain("/customers?phone=");
  });

  test("findOpenConversationByCustomer propagates upstream API failures", async () => {
    globalThis.fetch = withFetchShape(
      async () =>
        new Response("gateway timeout", {
          status: 504,
        }),
    );

    await expect(unthread.findOpenConversationByCustomer("cust_123")).rejects.toMatchObject({
      name: "UnthreadApiError",
      status: 504,
    });
  });

  test("addMessageWithAttachments sends multipart FormData with json and attachments fields", async () => {
    let capturedRequest: Request | null = null;

    globalThis.fetch = withFetchShape(async (input, init) => {
      capturedRequest = new Request(input as string, init);
      return new Response(
        JSON.stringify({
          id: "msg_001",
          conversationId: "conv_abc",
          body: "test",
          type: "message",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const attachment = {
      buffer: Buffer.from("fake-image-bytes"),
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
      sizeBytes: 16,
    };

    await unthread.addMessageWithAttachments(
      "conv_abc",
      "Here is the file",
      { email: "user@example.com", name: "Test User" },
      [{ ...attachment, originalMediaUrl: "https://api.twilio.com/media/0" }],
    );

    expect(capturedRequest).not.toBeNull();
    const req = capturedRequest as unknown as Request;
    expect(req.method).toBe("POST");
    expect(req.url).toContain("/conversations/conv_abc/messages");
    expect(req.headers.get("X-API-KEY")).toBe("test-unthread-key");

    const contentType = req.headers.get("content-type") ?? "";
    expect(contentType).toContain("multipart/form-data");
  });

  test("addMessageWithAttachments includes onBehalfOf in the json field", async () => {
    let parsedJson: unknown = null;

    globalThis.fetch = withFetchShape(async (_input, init) => {
      const body = init?.body;
      if (body instanceof FormData) {
        const jsonField = body.get("json");
        if (typeof jsonField === "string") {
          parsedJson = JSON.parse(jsonField);
        }
      }
      return new Response(
        JSON.stringify({ id: "msg_002", conversationId: "conv_xyz", body: "", type: "message" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    await unthread.addMessageWithAttachments(
      "conv_xyz",
      "Attachment message",
      { email: "agent@example.com", name: "Agent Name" },
      [
        {
          buffer: Buffer.from("data"),
          mimeType: "application/pdf",
          fileName: "doc.pdf",
          sizeBytes: 4,
          originalMediaUrl: "https://api.twilio.com/media/1",
        },
      ],
    );

    expect(parsedJson).toMatchObject({
      body: { type: "markdown", value: "Attachment message" },
      onBehalfOf: { email: "agent@example.com", name: "Agent Name" },
    });
  });

  test("addMessageWithAttachments throws UnthreadApiError on upstream failure", async () => {
    globalThis.fetch = withFetchShape(
      async () => new Response("internal server error", { status: 500 }),
    );

    await expect(
      unthread.addMessageWithAttachments(
        "conv_fail",
        "test",
        { email: "u@example.com", name: "U" },
        [
          {
            buffer: Buffer.from("x"),
            mimeType: "image/jpeg",
            fileName: "x.jpg",
            sizeBytes: 1,
            originalMediaUrl: "https://api.twilio.com/media/2",
          },
        ],
      ),
    ).rejects.toMatchObject({ name: "UnthreadApiError", status: 500 });
  });
});
