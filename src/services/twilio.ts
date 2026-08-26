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

// Download a media file from a Twilio media URL.
// Returns a Buffer along with the response Content-Type.
// Validates that the URL is HTTPS and belongs to a trusted Twilio host.
// Credentials are only forwarded to api.twilio.com; direct CDN URLs and any
// cross-origin redirect destination receive no Authorization header.
export async function downloadTwilioMedia(
  mediaUrl: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  // Parse first so malformed strings ("not-a-url") get a clear, distinct
  // error rather than silently falling through to the scheme/host checks.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(mediaUrl);
  } catch {
    throw new Error("Invalid Twilio media URL");
  }

  // Reject non-HTTPS schemes before any credentials are built or attached.
  if (parsedUrl.protocol !== "https:") {
    throw new Error(`Insecure Twilio media URL scheme: ${parsedUrl.protocol}`);
  }

  // Validate the raw URL string against a fully-qualified origin allowlist
  // (scheme + exact host + "/") using `.startsWith()` on the untrusted value
  // itself. Matching a literal "https://<exact-host>/" prefix guarantees
  // everything after it can only affect the path/query, never the scheme or
  // host, so the URL re-parsed from mediaUrl below can never resolve to an
  // attacker-controlled host — there is no relative-URL-resolution or
  // protocol-relative-reference bypass to worry about against a plain prefix
  // match on the full string.
  const isApiHost = mediaUrl.startsWith("https://api.twilio.com/");
  const isCdnHost = mediaUrl.startsWith("https://media.twiliocdn.com/");
  if (!isApiHost && !isCdnHost) {
    throw new Error(`Untrusted Twilio media host: ${parsedUrl.hostname}`);
  }

  // Re-parse the now-guarded mediaUrl for use at the fetch() call below, so
  // the value passed to fetch() is derived from a reference that only exists
  // after the allowlist prefix check above has already passed.
  const safeUrl = new URL(mediaUrl);

  // Only attach credentials when the request goes directly to api.twilio.com.
  // Direct CDN URLs (media.twiliocdn.com) use pre-signed paths and must not
  // receive the API credentials. When api.twilio.com redirects to the CDN,
  // the Fetch spec automatically strips the Authorization header on the
  // cross-origin hop, so no additional handling is needed for that case.
  const fetchHeaders: Record<string, string> = {};
  if (isApiHost) {
    const credentials = `${config.twilio.accountSid}:${config.twilio.authToken}`;
    fetchHeaders.Authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
  }

  const response = await fetch(safeUrl, {
    headers: fetchHeaders,
    redirect: "follow",
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
