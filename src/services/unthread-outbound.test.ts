import { beforeAll, describe, expect, test } from "bun:test";
import type { OutboundAttachmentsMeta, OutboundFileRecord, UnthreadQueuedEvent } from "../types";

function setRequiredEnv(): void {
  process.env.TWILIO_ACCOUNT_SID = "AC00000000000000000000000000000000";
  process.env.TWILIO_AUTH_TOKEN = "test-token";
  process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+14155550123";
  process.env.TWILIO_WEBHOOK_URL = "https://example.com/webhooks/twilio";
  process.env.UNTHREAD_API_KEY = "test-unthread-key";
  process.env.UNTHREAD_SLACK_CHANNEL_ID = "test-channel";
  process.env.POSTGRES_URL = "******localhost:5432/unthread_whatsapp";
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
});
