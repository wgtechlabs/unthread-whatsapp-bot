import { Router } from "express";
import type { Request, Response } from "express";
import { LogEngine } from "@wgtechlabs/log-engine";
import type { UnthreadWebhookEvent } from "../types";
import { sendWhatsAppMessage, toWhatsAppFormat } from "../services/twilio";
import { findPhoneByConversationId } from "../services/customer-store";

export const unthreadWebhookRouter = Router();

// POST /webhooks/unthread
// Receives webhook events from Unthread (agent replies -> send to WhatsApp)
unthreadWebhookRouter.post("/", async (req: Request, res: Response) => {
  try {
    const event = req.body as UnthreadWebhookEvent;

    LogEngine.debug("Unthread webhook event received", { type: event.type });

    // Only handle agent/internal messages that need to go back to WhatsApp
    if (event.type === "message_created" || event.type === "message_added") {
      await handleOutboundMessage(event);
    }

    res.json({ ok: true });
  } catch (error) {
    LogEngine.error("Error processing Unthread webhook", { error });
    res.status(500).json({ error: "Internal server error" });
  }
});

async function handleOutboundMessage(event: UnthreadWebhookEvent): Promise<void> {
  const { data } = event;
  const conversationId = data.conversationId ?? data.id;
  const messageBody = data.body;

  // Skip customer messages (we only want to send agent replies)
  if (data.type === "customer") {
    return;
  }

  if (!conversationId || !messageBody) {
    LogEngine.debug("Skipping Unthread event: missing conversationId or body");
    return;
  }

  // Look up the WhatsApp phone number for this conversation
  const phone = findPhoneByConversationId(conversationId);
  if (!phone) {
    LogEngine.warn("No WhatsApp mapping found for conversation", { conversationId });
    return;
  }

  // Send the reply back via WhatsApp
  const to = toWhatsAppFormat(phone);
  await sendWhatsAppMessage(to, messageBody);
  LogEngine.info("Agent reply sent to WhatsApp", { phone, conversationId });
}
