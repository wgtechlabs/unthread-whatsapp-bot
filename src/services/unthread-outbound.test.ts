import { beforeAll, describe, expect, test } from "bun:test";
import type { OutboundAttachmentsMeta, OutboundFileRecord, UnthreadQueuedEvent } from "../types";

function setRequiredEnv(): void {
  process.env.TWILIO_ACCOUNT_SID = "AC00000000000000000000000000000000";
  process.env.TWILIO_AUTH_TOKEN = "test-token";
  process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+14155550123";
  process.env.TWILIO_WEBHOOK_URL = "https://example.com/webhooks/twilio";
  process.env.UNTHREAD_API_KEY = "test-unthread-key";
  process.env.UNTHREAD_SLACK_CHANNEL_ID = "test-channel";
  process.env.POSTGRES_URL = "postgresql://localhost:5432/test_db";
}

// These tests validate the shape of outbound webhook events and the expected
// type-level behavior of event classification, without needing to import modules
// that transitively initialize the Twilio SDK client.

describe("UnthreadQueuedEvent outbound event structure", () => {
  test("customer-origin event is identifiable by data.type=customer", () => {
    const event: UnthreadQueuedEvent = {
      type: "message_created",
      sourcePlatform: "whatsapp",
      data: { conversationId: "conv_001", body: "Customer message", type: "customer" },
    };

    // Customer-origin events should be skipped to prevent loops
    expect(event.data.type).toBe("customer");
    expect(event.sourcePlatform).toBe("whatsapp");
  });

  test("dashboard-origin event is identifiable by sourcePlatform=dashboard", () => {
    const event: UnthreadQueuedEvent = {
      type: "message_created",
      sourcePlatform: "dashboard",
      targetPlatform: "whatsapp",
      data: { conversationId: "conv_002", body: "Agent reply" },
    };

    expect(event.sourcePlatform).toBe("dashboard");
    expect(event.targetPlatform).toBe("whatsapp");
    expect(typeof event.data.body).toBe("string");
  });

  test("attachment-only event has files but empty body", () => {
    const files: OutboundFileRecord[] = [
      {
        id: "F123",
        name: "report.pdf",
        size: 10240,
        mimetype: "application/pdf",
        urlPrivateDownload: "https://files.slack.com/report.pdf",
      },
    ];

    const event: UnthreadQueuedEvent = {
      type: "message_created",
      sourcePlatform: "dashboard",
      targetPlatform: "whatsapp",
      data: {
        conversationId: "conv_file",
        body: "",
        files,
      },
      attachments: {
        hasFiles: true,
        fileCount: 1,
        totalSize: 10240,
        types: ["application/pdf"],
        names: ["report.pdf"],
      },
    };

    expect(event.data.body).toBe("");
    expect(Array.isArray(event.data.files)).toBe(true);
    expect(event.data.files?.length).toBe(1);
    expect(event.attachments?.hasFiles).toBe(true);
    expect(event.attachments?.fileCount).toBe(1);
  });

  test("text plus attachment event carries both body and files", () => {
    const event: UnthreadQueuedEvent = {
      type: "message_created",
      sourcePlatform: "dashboard",
      targetPlatform: "whatsapp",
      data: {
        conversationId: "conv_mixed",
        body: "Here is your invoice",
        files: [{ name: "invoice.pdf", size: 5120, mimetype: "application/pdf" }],
      },
    };

    expect(event.data.body).toBe("Here is your invoice");
    expect(event.data.files?.length).toBe(1);
    expect(event.data.files?.[0].name).toBe("invoice.pdf");
  });

  test("status update event is identifiable by type=conversation_updated", () => {
    const event: UnthreadQueuedEvent = {
      type: "conversation_updated",
      data: {
        conversationId: "conv_003",
        status: "closed",
        previousStatus: "open",
        friendlyId: "42",
      },
    };

    expect(event.type).toBe("conversation_updated");
    expect(event.data.status).toBe("closed");
    expect(event.data.previousStatus).toBe("open");
  });

  test("OutboundAttachmentsMeta captures file count and size", () => {
    const meta: OutboundAttachmentsMeta = {
      hasFiles: true,
      fileCount: 2,
      totalSize: 102400,
      types: ["image/jpeg", "application/pdf"],
      names: ["photo.jpg", "doc.pdf"],
    };

    expect(meta.fileCount).toBe(2);
    expect(meta.totalSize).toBe(102400);
    expect(meta.types).toHaveLength(2);
  });

  test("OutboundFileRecord can represent a Slack-style file with direct download URL", () => {
    const file: OutboundFileRecord = {
      id: "F12345ABCDE",
      name: "screenshot.png",
      size: 204800,
      mimetype: "image/png",
      urlPrivate: "https://files.slack.com/files-pri/T0123/F12345ABCDE/screenshot.png",
      urlPrivateDownload:
        "https://files.slack.com/files-pri/T0123/F12345ABCDE/download/screenshot.png",
    };

    expect(file.id).toMatch(/^F/);
    expect(file.urlPrivateDownload).toBeDefined();
    expect(file.mimetype).toBe("image/png");
  });
});

describe("outbound file extraction", () => {
  let extractFiles: typeof import("./unthread-outbound").extractFiles;

  beforeAll(async () => {
    setRequiredEnv();
    ({ extractFiles } = await import("./unthread-outbound"));
  });

  test("normalizes Dashboard file records that use title and metadata MIME fields", () => {
    const event: UnthreadQueuedEvent = {
      type: "message_created",
      sourcePlatform: "dashboard",
      targetPlatform: "whatsapp",
      data: {
        conversationId: "conv_file",
        teamId: "T0123ABCDE",
        body: "Image from dashboard",
        files: [
          {
            id: "F12345ABCDE",
            title: "screenshot",
            size: 204800,
            urlPrivate: "https://files.slack.com/files-pri/T0123ABCDE/F12345ABCDE/screenshot.png",
          },
        ],
      },
      attachments: {
        hasFiles: true,
        fileCount: 1,
        totalSize: 204800,
        types: ["image/png"],
        names: ["screenshot.png"],
      },
    };

    expect(extractFiles(event)).toEqual([
      {
        id: "F12345ABCDE",
        name: "screenshot",
        size: 204800,
        mimetype: "image/png",
        urlPrivate: "https://files.slack.com/files-pri/T0123ABCDE/F12345ABCDE/screenshot.png",
        urlPrivateDownload: undefined,
      },
    ]);
  });

  test("reads files from nested conversation payloads", () => {
    const event: UnthreadQueuedEvent = {
      type: "message_created",
      sourcePlatform: "dashboard",
      targetPlatform: "whatsapp",
      data: {
        conversationId: "conv_nested",
        body: "Nested image",
        conversation: {
          files: [
            {
              file_id: "F999",
              name: "nested.png",
              mimeType: "image/png",
              url_private: "https://files.slack.com/files-pri/T999/F999/nested.png",
            },
          ],
        },
      },
    };

    expect(extractFiles(event)).toEqual([
      {
        id: "F999",
        name: "nested.png",
        size: undefined,
        mimetype: "image/png",
        urlPrivate: "https://files.slack.com/files-pri/T999/F999/nested.png",
        urlPrivateDownload: undefined,
      },
    ]);
  });

  test("skips file records without a file ID or private URL", () => {
    const event: UnthreadQueuedEvent = {
      type: "message_created",
      sourcePlatform: "dashboard",
      targetPlatform: "whatsapp",
      data: {
        conversationId: "conv_invalid",
        body: "Invalid file",
        files: [{ name: "missing-id.png", mimetype: "image/png" }],
      },
    };

    expect(extractFiles(event)).toEqual([]);
  });

  test("keeps finite numeric sizes, parses string sizes, and ignores non-finite sizes", () => {
    const event: UnthreadQueuedEvent = {
      type: "message_created",
      sourcePlatform: "dashboard",
      targetPlatform: "whatsapp",
      data: {
        conversationId: "conv_sizes",
        body: "Sizes",
        files: [
          { id: "F_VALID", name: "valid.png", size: 1234 },
          { id: "F_NEGATIVE", name: "negative.png", size: -1 },
          { id: "F_NAN", name: "nan.png", size: Number.NaN },
          { id: "F_INFINITY", name: "infinity.png", size: Number.POSITIVE_INFINITY },
          { id: "F_STRING", name: "string.png", size: "1234" as unknown as number },
          { id: "F_INVALID_STRING", name: "invalid.png", size: "abc" as unknown as number },
        ],
      },
    };

    expect(extractFiles(event).map((file) => file.size)).toEqual([
      1234,
      undefined,
      undefined,
      undefined,
      1234,
      undefined,
    ]);
  });

  test("accepts only valid MIME type format fields", () => {
    const event: UnthreadQueuedEvent = {
      type: "message_created",
      sourcePlatform: "dashboard",
      targetPlatform: "whatsapp",
      data: {
        conversationId: "conv_mimes",
        body: "Mimes",
        files: [
          { id: "F_IMAGE", name: "image.png", type: "image/png" },
          { id: "F_INVALID", name: "invalid.png", type: "invalid" },
          { id: "F_EMPTY_SUBTYPE", name: "empty.png", type: "image/" },
          { id: "F_EXTRA", name: "extra.png", type: "image/png/extra" },
        ],
      },
    };

    expect(extractFiles(event).map((file) => file.mimetype)).toEqual([
      "image/png",
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("trims attachment metadata fallback names and MIME types", () => {
    const event: UnthreadQueuedEvent = {
      type: "message_created",
      sourcePlatform: "dashboard",
      targetPlatform: "whatsapp",
      data: {
        conversationId: "conv_metadata",
        body: "Metadata",
        files: [{ id: "F_METADATA" }],
      },
      attachments: {
        hasFiles: true,
        fileCount: 1,
        names: ["  metadata.png  "],
        types: ["  image/png  "],
      },
    };

    expect(extractFiles(event)).toMatchObject([{ name: "metadata.png", mimetype: "image/png" }]);
  });

  test("reads dashboard attachments from metadata event payload when files is null", () => {
    const event: UnthreadQueuedEvent = {
      type: "message_created",
      sourcePlatform: "dashboard",
      targetPlatform: "whatsapp",
      data: {
        id: "T08DF0UA02H-C08DWG00P25-1777700720.083629",
        conversationId: "2e9535d1-6890-4df6-9ca1-02aa98c65383",
        text: "Sending image from dashboard to whatsapp client.",
        files: null,
        teamId: "T08DF0UA02H",
        metadata: {
          event_type: "message_sent_externally",
          event_payload: {
            userId: "4e1cc76a-395e-4f0e-8b37-32ef6484b9ff",
            attachments: [
              {
                id: "2823f8be-c0df-4358-9fa6-bc370ef26057",
                name: "image.png",
                size: "1384113",
                type: "image/png",
              },
            ],
            conversationId: "2e9535d1-6890-4df6-9ca1-02aa98c65383",
            conversationUpdates: {},
          },
        },
      },
    };

    expect(extractFiles(event)).toEqual([
      {
        id: "2823f8be-c0df-4358-9fa6-bc370ef26057",
        name: "image.png",
        size: 1384113,
        mimetype: "image/png",
        urlPrivate: undefined,
        urlPrivateDownload: undefined,
      },
    ]);
  });
});
