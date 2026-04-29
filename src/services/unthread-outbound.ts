import { LogEngine } from "@wgtechlabs/log-engine";
import { config } from "../config";
import type { OutboundFileRecord, UnthreadQueuedEvent } from "../types";
import { sanitizeFileName } from "./attachment-validator";
import { findPhoneByConversationId } from "./customer-store";
import { storeProxyToken } from "./media-proxy-store";
import { resolveTicketNumber, sendStatusChangeMessage } from "./system-messages";
import { sendWhatsAppMediaMessage, sendWhatsAppMessage, toWhatsAppFormat } from "./twilio";
import * as unthread from "./unthread";
import { updateTicketStatus } from "./whatsapp-store";

// Twilio WhatsApp error codes
const TWILIO_ERR_SANDBOX_EXPIRED = 63015;
const TWILIO_ERR_OUTSIDE_24H_WINDOW = 63016;

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

function extractFiles(event: UnthreadQueuedEvent): OutboundFileRecord[] {
  const data = eventDataRecord(event);
  if (!Array.isArray(data.files)) return [];
  return data.files.filter(
    (file): file is OutboundFileRecord =>
      file !== null && typeof file === "object" && typeof file.name === "string",
  );
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

// Build a publicly accessible proxy URL for a single outbound file record.
// Returns null if no public base URL is configured or token storage fails.
async function buildProxyUrl(file: OutboundFileRecord): Promise<string | null> {
  const baseUrl = config.media.publicBaseUrl;
  if (!baseUrl) {
    LogEngine.warn(
      "PUBLIC_BASE_URL not configured — cannot build media proxy URL for outbound file",
      {
        fileName: file.name,
      },
    );
    return null;
  }

  try {
    const token = await storeProxyToken({
      fileId: file.id,
      fileName: sanitizeFileName(file.name),
      mimeType: file.mimetype ?? "application/octet-stream",
      fileSize: file.size,
      downloadUrl: file.urlPrivateDownload ?? file.urlPrivate,
    });
    return `${baseUrl}/media/${token}`;
  } catch (error) {
    LogEngine.error("Failed to create media proxy token for outbound file", {
      fileName: file.name,
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

  // Handle text portion
  if (message) {
    try {
      await sendWhatsAppMessage(twilioTo, message);
      LogEngine.info("Agent reply sent to WhatsApp", { phone, conversationId });
    } catch (err: unknown) {
      handleTwilioSendError(err, phone, conversationId);
    }
  }

  // Handle file attachments
  if (files.length > 0) {
    for (const file of files) {
      const proxyUrl = await buildProxyUrl(file);
      if (!proxyUrl) {
        LogEngine.warn("Skipping outbound file: could not build proxy URL", {
          fileName: file.name,
          conversationId,
        });
        continue;
      }

      try {
        await sendWhatsAppMediaMessage(twilioTo, [proxyUrl]);
        LogEngine.info("Outbound file sent to WhatsApp via media proxy", {
          phone,
          conversationId,
          fileName: file.name,
        });
      } catch (err: unknown) {
        handleTwilioSendError(err, phone, conversationId);
      }
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
