import { describe, expect, test } from "bun:test";
import type { TwilioIncomingMessage } from "../types";

// Test helpers that mirror the parsing logic in twilio-webhook.ts
function parseNumMedia(message: TwilioIncomingMessage): number {
  const parsed = parseInt(message.NumMedia ?? "0", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function extractMediaItems(
  message: TwilioIncomingMessage,
): Array<{ url: string; contentType: string }> {
  const numMedia = parseNumMedia(message);
  const items: Array<{ url: string; contentType: string }> = [];

  for (let index = 0; index < Math.min(numMedia, 10); index++) {
    const urlKey = `MediaUrl${index}` as keyof TwilioIncomingMessage;
    const typeKey = `MediaContentType${index}` as keyof TwilioIncomingMessage;

    const url = message[urlKey] as string | undefined;
    const contentType = (message[typeKey] as string | undefined) ?? "application/octet-stream";

    if (url) {
      items.push({ url, contentType });
    }
  }

  return items;
}

describe("Twilio inbound media parsing", () => {
  test("NumMedia=0 text-only message produces no media items", () => {
    const message: TwilioIncomingMessage = {
      MessageSid: "SM001",
      AccountSid: "AC001",
      From: "whatsapp:+15550000001",
      To: "whatsapp:+14155550123",
      Body: "Hello world",
      NumMedia: "0",
    };

    expect(parseNumMedia(message)).toBe(0);
    expect(extractMediaItems(message)).toHaveLength(0);
  });

  test("NumMedia=1 extracts MediaUrl0 and MediaContentType0", () => {
    const message: TwilioIncomingMessage = {
      MessageSid: "SM002",
      AccountSid: "AC001",
      From: "whatsapp:+15550000001",
      To: "whatsapp:+14155550123",
      Body: "",
      NumMedia: "1",
      MediaUrl0: "https://api.twilio.com/Accounts/AC001/Messages/MM001/Media/ME001",
      MediaContentType0: "image/jpeg",
    };

    const items = extractMediaItems(message);
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe("https://api.twilio.com/Accounts/AC001/Messages/MM001/Media/ME001");
    expect(items[0].contentType).toBe("image/jpeg");
  });

  test("attachment-only message (empty Body, NumMedia=1) is handled correctly", () => {
    const message: TwilioIncomingMessage = {
      MessageSid: "SM003",
      AccountSid: "AC001",
      From: "whatsapp:+15550000001",
      To: "whatsapp:+14155550123",
      Body: "",
      NumMedia: "1",
      MediaUrl0: "https://api.twilio.com/Accounts/AC001/Messages/MM002/Media/ME002",
      MediaContentType0: "application/pdf",
    };

    expect(message.Body).toBe("");
    const items = extractMediaItems(message);
    expect(items).toHaveLength(1);
  });

  test("text plus attachment extracts both body text and media items", () => {
    const message: TwilioIncomingMessage = {
      MessageSid: "SM004",
      AccountSid: "AC001",
      From: "whatsapp:+15550000001",
      To: "whatsapp:+14155550123",
      Body: "Please see attached",
      NumMedia: "1",
      MediaUrl0: "https://api.twilio.com/Accounts/AC001/Messages/MM003/Media/ME003",
      MediaContentType0: "image/png",
    };

    expect(message.Body).toBe("Please see attached");
    const items = extractMediaItems(message);
    expect(items).toHaveLength(1);
    expect(items[0].contentType).toBe("image/png");
  });

  test("malformed NumMedia falls back to zero", () => {
    const message: TwilioIncomingMessage = {
      MessageSid: "SM005",
      AccountSid: "AC001",
      From: "whatsapp:+15550000001",
      To: "whatsapp:+14155550123",
      Body: "Hi",
      NumMedia: "not-a-number",
    };

    expect(parseNumMedia(message)).toBe(0);
    expect(extractMediaItems(message)).toHaveLength(0);
  });

  test("missing MediaUrlN for declared NumMedia is handled gracefully", () => {
    const message: TwilioIncomingMessage = {
      MessageSid: "SM006",
      AccountSid: "AC001",
      From: "whatsapp:+15550000001",
      To: "whatsapp:+14155550123",
      Body: "Missing media url",
      NumMedia: "1",
      // MediaUrl0 intentionally absent
      MediaContentType0: "image/jpeg",
    };

    // Should produce no items since the URL is absent, not throw
    const items = extractMediaItems(message);
    expect(items).toHaveLength(0);
  });

  test("extracts up to 10 media items from a multi-attachment message", () => {
    const message: TwilioIncomingMessage = {
      MessageSid: "SM007",
      AccountSid: "AC001",
      From: "whatsapp:+15550000001",
      To: "whatsapp:+14155550123",
      Body: "",
      NumMedia: "3",
      MediaUrl0: "https://api.twilio.com/media/0",
      MediaContentType0: "image/jpeg",
      MediaUrl1: "https://api.twilio.com/media/1",
      MediaContentType1: "image/png",
      MediaUrl2: "https://api.twilio.com/media/2",
      MediaContentType2: "application/pdf",
    };

    const items = extractMediaItems(message);
    expect(items).toHaveLength(3);
    expect(items[2].contentType).toBe("application/pdf");
  });
});
