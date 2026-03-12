import { LogEngine } from "@wgtechlabs/log-engine";
import type { UnthreadQueuedEvent } from "../types";
import { findPhoneByConversationId } from "./customer-store";
import { resolveTicketNumber, sendStatusChangeMessage } from "./system-messages";
import { sendWhatsAppMessage, toWhatsAppFormat } from "./twilio";
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

  const sent = await sendStatusChangeMessage(
    phone,
    ticketNumber,
    newStatus,
    previousStatus || undefined,
  );
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

  if (!conversationId || !message) {
    LogEngine.debug("Skipping Unthread event: missing conversationId or message body");
    return;
  }

  const phone = await findPhoneByConversationId(conversationId);
  if (!phone) {
    LogEngine.warn("No WhatsApp mapping found for conversation", { conversationId });
    return;
  }

  try {
    await sendWhatsAppMessage(toWhatsAppFormat(phone), message);
    LogEngine.info("Agent reply sent to WhatsApp", { phone, conversationId });
  } catch (err: unknown) {
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
}
