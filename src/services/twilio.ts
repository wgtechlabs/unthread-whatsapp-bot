import { LogEngine } from "@wgtechlabs/log-engine";
import Twilio from "twilio";
import { config } from "../config";

const client = Twilio(config.twilio.accountSid, config.twilio.authToken);

// Send a WhatsApp message back to the user via Twilio
export async function sendWhatsAppMessage(to: string, body: string): Promise<string> {
  const message = await client.messages.create({
    from: config.twilio.whatsappNumber,
    to,
    body,
  });

  LogEngine.debug("WhatsApp message sent via Twilio", { sid: message.sid, to });
  return message.sid;
}

// Send a WhatsApp media message via Twilio.
// Twilio WhatsApp outbound media requires publicly reachable mediaUrl values.
// Images support an optional caption via body; for other media types Twilio ignores body.
export async function sendWhatsAppMediaMessage(
  to: string,
  mediaUrls: string[],
  body?: string,
): Promise<string> {
  if (mediaUrls.length === 0) {
    throw new Error("sendWhatsAppMediaMessage requires at least one mediaUrl");
  }

  const message = await client.messages.create({
    from: config.twilio.whatsappNumber,
    to,
    mediaUrl: mediaUrls,
    ...(body ? { body } : {}),
  });

  LogEngine.debug("WhatsApp media message sent via Twilio", {
    sid: message.sid,
    to,
    mediaCount: mediaUrls.length,
  });
  return message.sid;
}

// Download a media file from a Twilio media URL using Basic auth credentials.
// Returns a Buffer along with the response Content-Type.
// Validates that the URL belongs to Twilio's API domain before sending credentials.
export async function downloadTwilioMedia(
  mediaUrl: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  // Validate that the URL is a trusted Twilio API origin before attaching credentials.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(mediaUrl);
  } catch {
    throw new Error("Invalid Twilio media URL");
  }

  const allowedHosts = ["api.twilio.com", "media.twiliocdn.com"];
  if (
    !allowedHosts.some(
      (host) => parsedUrl.hostname === host || parsedUrl.hostname.endsWith(`.${host}`),
    )
  ) {
    throw new Error(`Untrusted Twilio media host: ${parsedUrl.hostname}`);
  }

  const credentials = `${config.twilio.accountSid}:${config.twilio.authToken}`;
  const authHeader = `Basic ${Buffer.from(credentials).toString("base64")}`;

  const response = await fetch(parsedUrl.href, {
    headers: { Authorization: authHeader },
  });

  if (!response.ok) {
    throw new Error(`Failed to download Twilio media: HTTP ${response.status}`);
  }

  // Reject early when Content-Length indicates the body will exceed the configured
  // maximum. This avoids buffering the full response only to discard it, which
  // reduces unnecessary memory use and potential DoS exposure.
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > config.media.maxAttachmentSizeBytes) {
      throw new Error(
        `Twilio media Content-Length ${contentLength} exceeds maximum ${config.media.maxAttachmentSizeBytes} bytes`,
      );
    }
  }

  const rawMimeType = response.headers.get("content-type") ?? "application/octet-stream";
  const mimeType = rawMimeType.split(";")[0].trim();

  if (!response.body) {
    throw new Error("Failed to download Twilio media: empty response body");
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = Buffer.from(value);
      totalBytes += chunk.length;

      if (totalBytes > config.media.maxAttachmentSizeBytes) {
        await reader.cancel(
          `Twilio media size exceeds maximum ${config.media.maxAttachmentSizeBytes} bytes`,
        );
        throw new Error(
          `Twilio media download exceeded maximum ${config.media.maxAttachmentSizeBytes} bytes`,
        );
      }

      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = Buffer.concat(chunks, totalBytes);

  return { buffer, mimeType };
}

// Extract phone number from Twilio WhatsApp format
// "whatsapp:+1234567890" -> "+1234567890"
export function extractPhone(twilioFrom: string): string {
  return twilioFrom.replace("whatsapp:", "");
}

// Format phone to Twilio WhatsApp format
// "+1234567890" -> "whatsapp:+1234567890"
export function toWhatsAppFormat(phone: string): string {
  if (phone.startsWith("whatsapp:")) return phone;
  return `whatsapp:${phone}`;
}

// Validate Twilio webhook signature
export function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
): boolean {
  return Twilio.validateRequest(config.twilio.authToken, signature, url, params);
}
