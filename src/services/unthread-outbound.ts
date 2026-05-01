import { createHash } from "node:crypto";
import { LogEngine } from "@wgtechlabs/log-engine";
import { config } from "../config";
import type { OutboundFileRecord, UnthreadQueuedEvent } from "../types";
import { sanitizeFileName } from "./attachment-validator";
import { findPhoneByConversationId } from "./customer-store";
import { storeProxyToken } from "./media-proxy-store";
import { resolveTicketNumber, sendStatusChangeMessage } from "./system-messages";
import { sendWhatsAppMediaMessage, sendWhatsAppMessage, toWhatsAppFormat } from "./twilio";
import * as unthread from "./unthread";
import { claimOutboundDelivery, updateTicketStatus } from "./whatsapp-store";

// Twilio WhatsApp error codes
const TWILIO_ERR_SANDBOX_EXPIRED = 63015;
const TWILIO_ERR_OUTSIDE_24H_WINDOW = 63016;
const OUTBOUND_DELIVERY_DEDUPE_TTL_SECONDS = 120;

function normalize(str: unknown): string {
  return typeof str === "string" ? str.trim().toLowerCase() : "";
}

function eventDataRecord(event: UnthreadQueuedEvent): Record<string, unknown> {
  return event.data as Record<string, unknown>;
}

function conversationRecord(event: UnthreadQueuedEvent): Record<string, unknown> {
  const data = eventDataRecord(event);
  const nested = data.conversation;
  return nested && typeof nested === "object" ? (nested as Record<string, unknown>) : data;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readArrayString(values: string[] | undefined, index: number): string {
  const value = values?.[index];
  return typeof value === "string" ? value.trim() : "";
}

function validMimeType(value: string): string {
  return /^[^/\s]+\/[^/\s]+$/.test(value) ? value : "";
}

function extractConversationId(event: UnthreadQueuedEvent): string {
  const conversation = conversationRecord(event);
  const data = eventDataRecord(event);

  return (
    readString(conversation, "conversationId") ||
    readString(conversation, "id") ||
    readString(data, "conversationId") ||
    readString(data, "id")
  );
}

function extractMessage(event: UnthreadQueuedEvent): string {
  const data = eventDataRecord(event);
  const value = data.body ?? data.content ?? data.text;
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOutboundFile(
  file: unknown,
  event: UnthreadQueuedEvent,
  index: number,
): OutboundFileRecord | null {
  if (!file || typeof file !== "object") return null;

  const record = file as Record<string, unknown>;
  const attachments = event.attachments;
  const name =
    readString(record, "name") ||
    readString(record, "title") ||
    readArrayString(attachments?.names, index) ||
    "attachment";

  const id =
    readString(record, "id") || readString(record, "fileId") || readString(record, "file_id");
  const type = readString(record, "type");
  const mimetype =
    readString(record, "mimetype") ||
    readString(record, "mimeType") ||
    validMimeType(type) ||
    readArrayString(attachments?.types, index);
  const urlPrivate = readString(record, "urlPrivate") || readString(record, "url_private");
  const urlPrivateDownload =
    readString(record, "urlPrivateDownload") || readString(record, "url_private_download");

  if (!id && !urlPrivate && !urlPrivateDownload) return null;

  return {
    id: id || undefined,
    name,
    size: readNumber(record, "size"),
    mimetype: mimetype || undefined,
    urlPrivate: urlPrivate || undefined,
    urlPrivateDownload: urlPrivateDownload || undefined,
  };
}

export function extractFiles(event: UnthreadQueuedEvent): OutboundFileRecord[] {
  const data = eventDataRecord(event);
  const conversation = conversationRecord(event);
  let rawFiles: unknown[] = [];
  if (Array.isArray(data.files)) {
    rawFiles = data.files;
  } else if (Array.isArray(conversation.files)) {
    rawFiles = conversation.files;
  }

  return rawFiles
    .map((file, index) => normalizeOutboundFile(file, event, index))
    .filter((file): file is OutboundFileRecord => file !== null);
}

function extractStatus(event: UnthreadQueuedEvent): string {
  const conversation = conversationRecord(event);
  const data = eventDataRecord(event);

  return normalize(conversation.status) || normalize(data.status);
}

function extractPreviousStatus(event: UnthreadQueuedEvent): string {
  const conversation = conversationRecord(event);
  const data = eventDataRecord(event);

  return normalize(conversation.previousStatus) || normalize(data.previousStatus);
}

function extractFriendlyId(event: UnthreadQueuedEvent): unknown {
  const conversation = conversationRecord(event);
  const data = eventDataRecord(event);

  return conversation.friendlyId ?? data.friendlyId;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function buildOutboundDeliveryKey(
  event: UnthreadQueuedEvent,
  conversationId: string,
  message: string,
  files: OutboundFileRecord[],
): string {
  const data = eventDataRecord(event);
  const dataId = readString(data, "id");
  const eventId =
    readString(data, "messageId") ||
    readString(data, "eventId") ||
    (dataId && dataId !== conversationId ? dataId : "");

  if (eventId) {
    return `event:${hashValue({ eventId, type: normalize(event.type) })}`;
  }

  return `fingerprint:${hashValue({
    conversationId,
    files: files.map((file) => ({
      id: file.id,
      mimetype: file.mimetype,
      name: file.name,
      size: file.size,
    })),
    message,
    sourcePlatform: normalize(event.sourcePlatform),
    targetPlatform: normalize(event.targetPlatform),
    type: normalize(event.type),
  })}`;
}

function isMessageEvent(event: UnthreadQueuedEvent): boolean {
  const type = normalize(event.type);
  return type === "message_created" || type === "message_added" || type === "message.created";
}

function isCustomerOrigin(event: UnthreadQueuedEvent): boolean {
  const dataType = normalize(event.data.type);
  if (dataType === "customer") {
    return true;
  }

  const sourcePlatform = normalize(event.sourcePlatform);
  // Dashboard/unknown are treated as agent-facing events. Other platforms are customer-origin.
  if (sourcePlatform && sourcePlatform !== "dashboard" && sourcePlatform !== "unknown") {
    return true;
  }

  return false;
}

function isTargetWhatsApp(event: UnthreadQueuedEvent): boolean {
  const targetPlatform = normalize(event.targetPlatform);
  return !targetPlatform || targetPlatform === "whatsapp";
}

function isConversationUpdateEvent(event: UnthreadQueuedEvent): boolean {
  const type = normalize(event.type);
  return type === "conversation_updated" || type === "conversation.updated";
}

async function processConversationUpdate(event: UnthreadQueuedEvent): Promise<void> {
  const conversationId = extractConversationId(event);
  const newStatus = extractStatus(event);
  const previousStatus = extractPreviousStatus(event);
  const friendlyId = extractFriendlyId(event);

  LogEngine.debug("Processing conversation update event", {
    eventType: event.type,
    sourcePlatform: event.sourcePlatform,
    targetPlatform: event.targetPlatform,
    conversationId,
    newStatus,
    previousStatus,
    hasNestedConversation:
      eventDataRecord(event).conversation &&
      typeof eventDataRecord(event).conversation === "object",
  });

  if (!conversationId || !newStatus) {
    LogEngine.debug("Skipping conversation_updated: missing conversationId or status", {
      eventType: event.type,
      dataKeys: Object.keys(eventDataRecord(event)),
    });
    return;
  }

  const phone = await findPhoneByConversationId(conversationId);
  if (!phone) {
    LogEngine.warn("No WhatsApp mapping found for conversation update", { conversationId });
    return;
  }

  // Use friendlyId from event payload first, fall back to API call
  let ticketNumber: string;
  if (friendlyId) {
    ticketNumber = resolveTicketNumber(friendlyId, conversationId);
  } else {
    try {
      const conversation = await unthread.getConversation(conversationId);
      ticketNumber = resolveTicketNumber(conversation.friendlyId, conversationId);
    } catch (err) {
      LogEngine.warn("Could not fetch conversation details for status notification", {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
      ticketNumber = resolveTicketNumber(undefined, conversationId);
    }
  }

  let sent = false;
  try {
    sent = await sendStatusChangeMessage(
      phone,
      ticketNumber,
      newStatus,
      previousStatus || undefined,
    );
  } catch (error) {
    LogEngine.error("Failed to send WhatsApp status change notification", {
      conversationId,
      ticketNumber,
      newStatus,
      previousStatus,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await updateTicketStatus(
      conversationId,
      newStatus,
      typeof friendlyId === "string" ? friendlyId : null,
    );
  } catch (error) {
    LogEngine.error("Failed to persist WhatsApp ticket status update", {
      conversationId,
      ticketNumber,
      newStatus,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (sent) {
    LogEngine.info("Status change notification sent", {
      phone,
      conversationId,
      newStatus,
      ticketNumber,
    });
  } else {
    LogEngine.debug("Status change notification skipped", {
      phone,
      conversationId,
      newStatus,
      previousStatus,
      ticketNumber,
    });
  }
}

// Returns true when the given URL is on the configured Unthread API origin.
// Only URLs on this exact origin should receive the X-API-KEY credential.
function isUnthreadApiUrl(url: string): boolean {
  try {
    const target = new URL(url);
    const apiOrigin = new URL(config.unthread.apiUrl);
    return target.origin === apiOrigin.origin;
  } catch {
    return false;
  }
}

// Extract the Slack workspace team ID from a files.slack.com private URL.
// Slack private file URLs follow the pattern:
//   https://files.slack.com/files-pri/{teamId}/{fileId}/{filename}
//   https://files.slack.com/files-tmb/{teamId}/{fileId}/{filename}
// Returns null when the URL is not a recognizable Slack file URL.
export function extractSlackTeamId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "files.slack.com") return null;
    const match = parsed.pathname.match(/^\/files-(?:pri|tmb|prv)\/([A-Z0-9]+)\//);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Build a publicly accessible proxy URL for a single outbound file record.
// Returns null if no public base URL is configured or token storage fails.
async function buildProxyUrl(
  conversationId: string,
  file: OutboundFileRecord,
  eventTeamId?: string,
): Promise<string | null> {
  const baseUrl = config.media.publicBaseUrl;
  const fileName = file.name || "attachment";
  const fileId = file.id;
  const mimeType = file.mimetype;
  if (!baseUrl) {
    LogEngine.warn(
      "PUBLIC_BASE_URL not configured — cannot build media proxy URL for outbound file",
      {
        fileName,
      },
    );
    return null;
  }

  // Only store the raw download URL when it is on the Unthread API origin to
  // prevent SSRF and avoid forwarding the API key to a third-party host.
  const rawDownloadUrl = file.urlPrivateDownload ?? file.urlPrivate;
  const safeDownloadUrl =
    rawDownloadUrl && isUnthreadApiUrl(rawDownloadUrl) ? rawDownloadUrl : undefined;

  // Auto-detect the Slack team ID from the file URL so the media proxy can use
  // the /slack/files/{id}/thumb endpoint (the proven approach, as in the
  // unthread-telegram-bot). Fall back to the explicit SLACK_TEAM_ID config value.
  const teamIdFromUrl = rawDownloadUrl ? extractSlackTeamId(rawDownloadUrl) : null;
  const slackTeamId = (teamIdFromUrl ?? eventTeamId ?? config.unthread.slackTeamId) || undefined;

  // Reject early if there is no resolvable download target: neither a safe URL
  // nor a file ID that can be used with the Unthread file download endpoint.
  // Without at least one of these the proxy endpoint will always 404.
  if (!safeDownloadUrl && !fileId) {
    LogEngine.warn(
      "buildProxyUrl: no safe download URL or file ID available — skipping proxy token",
      { fileName },
    );
    return null;
  }

  try {
    const token = await storeProxyToken({
      fileId,
      conversationId,
      slackTeamId,
      fileName: sanitizeFileName(fileName),
      mimeType: mimeType ?? "application/octet-stream",
      fileSize: file.size,
      downloadUrl: safeDownloadUrl,
    });
    return `${baseUrl}/media/${token}`;
  } catch (error) {
    LogEngine.error("Failed to create media proxy token for outbound file", {
      fileName,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function processUnthreadOutboundEvent(event: UnthreadQueuedEvent): Promise<void> {
  if (isConversationUpdateEvent(event)) {
    await processConversationUpdate(event);
    return;
  }

  if (!isMessageEvent(event)) {
    return;
  }

  if (!isTargetWhatsApp(event)) {
    return;
  }

  if (isCustomerOrigin(event)) {
    return;
  }

  const conversationId = extractConversationId(event);
  const message = extractMessage(event);
  const files = extractFiles(event);
  const eventTeamId = readString(eventDataRecord(event), "teamId");

  if (!conversationId) {
    LogEngine.debug("Skipping Unthread event: missing conversationId");
    return;
  }

  if (!message && files.length === 0) {
    LogEngine.debug("Skipping Unthread event: missing message body and files");
    return;
  }

  const phone = await findPhoneByConversationId(conversationId);
  if (!phone) {
    LogEngine.warn("No WhatsApp mapping found for conversation", { conversationId });
    return;
  }

  const twilioTo = toWhatsAppFormat(phone);
  const deliveryKey = buildOutboundDeliveryKey(event, conversationId, message, files);
  const shouldSend = await claimOutboundDelivery(deliveryKey, OUTBOUND_DELIVERY_DEDUPE_TTL_SECONDS);

  if (!shouldSend) {
    LogEngine.info("Skipping duplicate outbound WhatsApp delivery", {
      conversationId,
      deliveryKey,
    });
    return;
  }

  // Handle file attachments
  let textSent = false;
  if (files.length > 0) {
    for (const file of files) {
      const fileName = file.name || "attachment";
      const proxyUrl = await buildProxyUrl(conversationId, file, eventTeamId || undefined);
      if (!proxyUrl) {
        LogEngine.warn("Skipping outbound file: could not build proxy URL", {
          fileName,
          conversationId,
        });
        continue;
      }

      try {
        const caption = !textSent && message ? message : undefined;
        await sendWhatsAppMediaMessage(twilioTo, [proxyUrl], caption);
        if (caption) {
          textSent = true;
        }
        LogEngine.info("Outbound file sent to WhatsApp via media proxy", {
          phone,
          conversationId,
          fileName,
        });
      } catch (err: unknown) {
        handleTwilioSendError(err, phone, conversationId);
      }
    }
  }

  // Handle text portion. When files are present, prefer using the text as the
  // first media caption; fall back to a text-only message if no media send used it.
  if (message && !textSent) {
    try {
      await sendWhatsAppMessage(twilioTo, message);
      LogEngine.info("Agent reply sent to WhatsApp", { phone, conversationId });
    } catch (err: unknown) {
      handleTwilioSendError(err, phone, conversationId);
    }
  }
}

function handleTwilioSendError(err: unknown, phone: string, conversationId: string): void {
  const twilioCode = (err as { code?: number }).code;
  const twilioMessage = (err as { message?: string }).message ?? "Unknown error";

  if (twilioCode === TWILIO_ERR_SANDBOX_EXPIRED) {
    LogEngine.error("Twilio sandbox session expired — user must re-join the sandbox", {
      phone,
      conversationId,
      twilioCode,
    });
  } else if (twilioCode === TWILIO_ERR_OUTSIDE_24H_WINDOW) {
    LogEngine.error("Outside 24-hour messaging window — template message required", {
      phone,
      conversationId,
      twilioCode,
    });
  } else {
    LogEngine.error("Failed to send WhatsApp message via Twilio", {
      phone,
      conversationId,
      twilioCode,
      error: twilioMessage,
    });
  }
}
