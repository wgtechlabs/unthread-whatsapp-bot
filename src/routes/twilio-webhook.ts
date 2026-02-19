import { Router } from "express";
import type { Request, Response } from "express";
import type { TwilioIncomingMessage } from "../types.js";
import { extractPhone } from "../services/twilio.js";
import { resolveCustomer, resolveConversation } from "../services/customer-store.js";
import * as unthread from "../services/unthread.js";

export const twilioWebhookRouter = Router();

// POST /webhooks/twilio
// Receives incoming WhatsApp messages from Twilio
twilioWebhookRouter.post("/", async (req: Request, res: Response) => {
  try {
    const message = req.body as TwilioIncomingMessage;
    const phone = extractPhone(message.From);
    const body = message.Body;
    const profileName = message.ProfileName || null;

    console.log(`[whatsapp] Incoming from ${phone} (${profileName}): ${body}`);

    // 1. Resolve or create customer in Unthread
    const customer = await resolveCustomer(phone, profileName);
    console.log(`[whatsapp] Customer resolved: ${customer.customerId}`);

    // 2. Get or create active conversation
    const conversationId = await resolveConversation(customer);
    console.log(`[whatsapp] Conversation: ${conversationId}`);

    // 3. Add message to conversation on behalf of the customer
    const cleanPhone = phone.replace(/[^0-9]/g, "");
    const dummyEmail = `${cleanPhone}@whatsapp.user`;
    const senderName = profileName || phone;

    await unthread.addMessage(conversationId, body, {
      email: dummyEmail,
      name: senderName,
    });

    console.log(`[whatsapp] Message forwarded to Unthread conversation ${conversationId}`);

    // Respond with empty TwiML (no auto-reply, let Unthread handle it)
    res.type("text/xml").send("<Response></Response>");
  } catch (error) {
    console.error("[whatsapp] Error processing incoming message:", error);
    res.type("text/xml").send("<Response></Response>");
  }
});
