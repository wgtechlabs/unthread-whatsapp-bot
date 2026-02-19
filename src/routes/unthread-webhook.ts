import { Router } from "express";
import type { Request, Response } from "express";
import type { UnthreadWebhookEvent } from "../types";
import { sendWhatsAppMessage, toWhatsAppFormat } from "../services/twilio";
import { findPhoneByConversationId } from "../services/customer-store";

export const unthreadWebhookRouter = Router();

// POST /webhooks/unthread
// Receives webhook events from Unthread (agent replies -> send to WhatsApp)
unthreadWebhookRouter.post("/", async (req: Request, res: Response) => {
  try {
    const event = req.body as UnthreadWebhookEvent;

    console.log(`[unthread] Webhook event: ${event.type}`);

    // Only handle agent/internal messages that need to go back to WhatsApp
    if (event.type === "message_created" || event.type === "message_added") {
      await handleOutboundMessage(event);
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("[unthread] Error processing webhook:", error);
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
    console.log("[unthread] Skipping event: missing conversationId or body");
    return;
  }

  // Look up the WhatsApp phone number for this conversation
  const phone = findPhoneByConversationId(conversationId);
  if (!phone) {
    console.log(`[unthread] No WhatsApp mapping found for conversation ${conversationId}`);
    return;
  }

  // Send the reply back via WhatsApp
  const to = toWhatsAppFormat(phone);
  await sendWhatsAppMessage(to, messageBody);
  console.log(`[unthread] Reply sent to ${phone} for conversation ${conversationId}`);
}
