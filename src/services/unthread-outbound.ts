import { LogEngine } from "@wgtechlabs/log-engine";
import type { UnthreadQueuedEvent } from "../types";
import { findPhoneByConversationId } from "./customer-store";
import { sendWhatsAppMessage, toWhatsAppFormat } from "./twilio";
import { sendStatusChangeMessage, resolveTicketNumber } from "./system-messages";
import { clearSession } from "./session-timer";
import * as unthread from "./unthread";

// Twilio WhatsApp error codes
const TWILIO_ERR_SANDBOX_EXPIRED = 63015;
const TWILIO_ERR_OUTSIDE_24H_WINDOW = 63016;

function normalize(str: unknown): string {
  return typeof str === "string" ? str.trim().toLowerCase() : "";
}

function extractConversationId(event: UnthreadQueuedEvent): string {
  const { data } = event;
  const conversationId = data.conversationId ?? data.id;
  return typeof conversationId === "string" ? conversationId.trim() : "";
}

function extractMessage(event: UnthreadQueuedEvent): string {
  const { data } = event;
  const value = data.body ?? data.content ?? data.text;
  return typeof value === "string" ? value.trim() : "";
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
  const newStatus = normalize(event.data.status);

  if (!conversationId || !newStatus) {
    LogEngine.debug("Skipping conversation_updated: missing conversationId or status");
    return;
  }

  const phone = await findPhoneByConversationId(conversationId);
  if (!phone) {
    LogEngine.warn("No WhatsApp mapping found for conversation update", { conversationId });
    return;
  }

  // Use friendlyId from event payload first, fall back to API call
  let ticketNumber: string;
  if (event.data.friendlyId) {
    ticketNumber = resolveTicketNumber(event.data.friendlyId, conversationId);
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

  // Clear session timer when ticket is closed (no more expiry warnings needed)
  if (newStatus === "closed" || newStatus === "resolved") {
    clearSession(conversationId);
  }

  const previousStatus = normalize(event.data.previousStatus);
  const sent = await sendStatusChangeMessage(phone, ticketNumber, newStatus, previousStatus || undefined);

  if (sent) {
    LogEngine.info("Status change notification sent", { phone, conversationId, newStatus, ticketNumber });
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
