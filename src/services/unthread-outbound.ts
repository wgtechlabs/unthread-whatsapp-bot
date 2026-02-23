import { LogEngine } from "@wgtechlabs/log-engine";
import type { UnthreadQueuedEvent, UnthreadWebhookEvent } from "../types";
import { findPhoneByConversationId } from "./customer-store";
import { sendWhatsAppMessage, toWhatsAppFormat } from "./twilio";

type UnthreadOutboundEvent = UnthreadWebhookEvent | UnthreadQueuedEvent;

function normalize(str: unknown): string {
  return typeof str === "string" ? str.trim().toLowerCase() : "";
}

function extractConversationId(event: UnthreadOutboundEvent): string {
  const { data } = event;
  const conversationId = data.conversationId ?? data.id;
  return typeof conversationId === "string" ? conversationId.trim() : "";
}

function extractMessage(event: UnthreadOutboundEvent): string {
  const { data } = event;
  const value = data.body ?? data.content ?? data.text;
  return typeof value === "string" ? value.trim() : "";
}

function isMessageEvent(event: UnthreadOutboundEvent): boolean {
  const type = normalize(event.type);
  return type === "message_created" || type === "message_added" || type === "message.created";
}

function isCustomerOrigin(event: UnthreadOutboundEvent): boolean {
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

function isTargetWhatsApp(event: UnthreadOutboundEvent): boolean {
  const targetPlatform = normalize(event.targetPlatform);
  return !targetPlatform || targetPlatform === "whatsapp";
}

export async function processUnthreadOutboundEvent(event: UnthreadOutboundEvent): Promise<void> {
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

  await sendWhatsAppMessage(toWhatsAppFormat(phone), message);
  LogEngine.info("Agent reply sent to WhatsApp", { phone, conversationId });
}
